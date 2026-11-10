import { broadcastFov } from './broadcast-fov';
import { PITCH, type Frame } from './director';
import type { CameraShot } from './camera-operator';

/**
 * Stage-aware broadcast framing. The director decides where the operator looks and how far the
 * shot is zoomed; this turns that intent into a lens for the actual stage the match is drawn in.
 *
 * - Desktop-sized stages keep the director's framing exactly (wide, with the far stand visible).
 * - Small stages (phone pages, group-game panels, the sports card) zoom in until players reach a
 *   readable height in CSS pixels, never narrower than a minimum width of view, and tilt so the
 *   far stand is mostly cropped and the pitch fills the frame.
 * - Portrait stages use a higher position on the same gantry axis, whose steeper view puts the
 *   width of the pitch along the tall axis of the screen, and crop the stand the same way.
 *
 * Everything here is a pure function of the shot and the stage size, so the camera stays fixed
 * for a given stage and the operator spring smooths any change (pan, zoom, resize).
 */
export interface Stage {
  /** CSS pixel size of the 3D view. */
  width: number;
  height: number;
}

export const FRAMING = Object.freeze({
  /** Live-play players should be at least this tall in CSS pixels (scaled by zoom intent). */
  readablePlayerPx: 24,
  playerHeight: 1.8,
  /** Never narrower than this many metres across at the look-at point. */
  minSpan: 14,
  /** Stage heights (CSS px) between which the compact treatment fades in. */
  compactHeight: [520, 280] as const,
  /** Aspect ratios between which the portrait treatment fades in. */
  portraitAspect: [1.0, 0.55] as const,
  /** Portrait raises the camera on the same gantry axis (metres). */
  portraitLift: Object.freeze({ y: 15, z: -8 }),
  /** Fraction of the frame left above the far boards when the stand is cropped. */
  standMargin: 0.07,
  /** When tilting, keep the director's look-at point within this fraction of the half-frame. */
  actionLimit: 0.72,
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

export function stageWeights(stage: Stage) {
  const width = Math.max(1, stage.width);
  const height = Math.max(1, stage.height);
  const aspect = width / height;
  const [tallH, shortH] = FRAMING.compactHeight;
  const [wideA, narrowA] = FRAMING.portraitAspect;
  return {
    aspect,
    compact: clamp01((tallH - height) / (tallH - shortH)),
    portrait: clamp01((wideA - aspect) / (wideA - narrowA)),
  };
}

export function frameShot(shot: Frame['camera'], stage: Stage): CameraShot {
  const { aspect, compact, portrait } = stageWeights(stage);
  const height = Math.max(1, stage.height);
  const zoom = shot.zoom ?? 1;
  const x = shot.x;
  const y = shot.y + FRAMING.portraitLift.y * portrait;
  const z = shot.z + FRAMING.portraitLift.z * portrait;
  // Pan direction toward the director's look-at point; the look-at height is kept.
  const dx = shot.lx - x;
  const dz = shot.lz - z;
  const ground = Math.hypot(dx, dz) || 1;
  const ux = dx / ground;
  const uz = dz / ground;
  const drop = y - shot.ly;
  const distance = Math.hypot(ground, drop);

  // Vertical lens: the desktop rule (expressed for this distance), then readability, then a
  // minimum width of view so a tight zoom can never lose the action on a narrow stage.
  const baseDistance = Math.hypot(shot.lx - shot.x, shot.y - shot.ly, shot.lz - shot.z) || 1;
  const tanDesktop =
    (Math.tan((broadcastFov(shot.fov, aspect) * Math.PI) / 360) * baseDistance) / distance;
  const tanReadable =
    (height * FRAMING.playerHeight) / (2 * distance * FRAMING.readablePlayerPx * zoom);
  const span = Math.max(FRAMING.minSpan, shot.span ?? 0);
  const tanMinSpan = span / (2 * distance) / aspect;
  const half = Math.atan(Math.max(Math.min(tanDesktop, tanReadable), tanMinSpan));

  // Tilt: small and portrait stages aim a little nearer so the far boards sit at the top of the
  // frame and the stand is cropped, while the action stays well inside the frame.
  const aim = Math.atan2(drop, ground);
  let tilt = aim;
  const crop = Math.max(compact, portrait);
  if (crop > 0 && uz < -1e-3) {
    const boardZ = -(PITCH.halfWidth + 3.2);
    const toBoards = (boardZ - z) / uz;
    if (toBoards > 0) {
      const boards = Math.atan2(y - 0.9, toBoards);
      const wanted = boards - FRAMING.standMargin * 2 * half + half;
      const limit = FRAMING.actionLimit * half;
      tilt = aim + (clamp(wanted, aim - limit, aim + limit) - aim) * crop;
    }
  }
  const reach = drop / Math.tan(Math.max(0.05, tilt));
  return {
    x,
    y,
    z,
    lx: x + ux * reach,
    ly: shot.ly,
    lz: z + uz * reach,
    fov: (2 * half * 180) / Math.PI,
  };
}
