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
  /**
   * CSS pixels covered by page overlays along the top (scoreboard) and bottom (caption) of the
   * view. The broadcast framing is composed for the clear band between them; the covered strips
   * still render (stand above, near pitch below) through an off-centre projection.
   */
  insetTop?: number;
  insetBottom?: number;
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
  /**
   * Furthest ground toward the camera (world z, metres) that any part of the canvas may show.
   * Beyond the near advertising boards the turf runs off to the main-stand wall; past this line
   * only the concourse under the camera remains, so the frame must stop short of it.
   */
  nearGround: 36,
  /** Never let overlays leave less than this share of the view for the framed band. */
  minClearShare: 0.38,
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** The clear band between overlays, in CSS pixels, never thinner than `minClearShare`. */
export function clearBand(stage: Stage) {
  const height = Math.max(1, stage.height);
  let top = Math.max(0, stage.insetTop ?? 0);
  let bottom = Math.max(0, stage.insetBottom ?? 0);
  const covered = top + bottom;
  const allowed = height * (1 - FRAMING.minClearShare);
  if (covered > allowed) {
    top *= allowed / covered;
    bottom *= allowed / covered;
  }
  return { top, bottom, height: height - top - bottom };
}

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

/**
 * Furthest world z (toward the camera) where the canvas's bottom edge meets the ground, for a
 * camera at (x, y, z) panned along (ux, uz) and tilted down by `tilt`. `ndcBottom` is the canvas
 * bottom in the framed band's normalised coordinates (-1 without a bottom overlay).
 */
function bottomReach(
  cam: { x: number; y: number; z: number },
  ux: number,
  uz: number,
  tilt: number,
  tanHalf: number,
  aspect: number,
  ndcBottom: number
) {
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  let worst = -Infinity;
  for (const sx of [-1, -0.5, 0, 0.5, 1]) {
    // forward (ux c, -s, uz c) + up (ux s, c, uz s) * ndcBottom * tanHalf + right (-uz, 0, ux) * ...
    const v = ndcBottom * tanHalf;
    const h = sx * tanHalf * aspect;
    const dy = -s + c * v;
    if (dy >= -1e-6) return Infinity;
    const dz = uz * c + uz * s * v + ux * h;
    worst = Math.max(worst, cam.z + (dz * cam.y) / -dy);
  }
  return worst;
}

/** Margin (framed-band NDC) kept between focus points and the edge of the clear band. */
const FOCUS_EDGE = 0.86;

/**
 * Range of tilts for which a world point projects inside the clear band (|ndc| <= FOCUS_EDGE).
 * Vertical position rises monotonically with tilt; the horizontal limit (set by pan and lens)
 * does not depend on tilt to first order, so a point outside it makes the range empty.
 */
function focusInterval(
  cam: { x: number; y: number; z: number },
  ux: number,
  uz: number,
  p: { x: number; y: number; z: number },
  tanHalf: number,
  aspect: number
): [number, number] {
  const dx = p.x - cam.x;
  const dy = p.y - cam.y;
  const dz = p.z - cam.z;
  const ndc = (t: number) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    const depth = dx * ux * c - dy * s + dz * uz * c;
    if (depth <= 0.1) return { x: Infinity, y: -Infinity };
    const up = dx * ux * s + dy * c + dz * uz * s;
    const right = -dx * uz + dz * ux;
    return { x: right / depth / (tanHalf * aspect), y: up / depth / tanHalf };
  };
  const at = (pred: (t: number) => boolean, lo: number, hi: number) => {
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) / 2;
      if (pred(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const MIN = 0.03;
  const MAX = 1.5;
  // Smallest tilt that lifts the point above the band's lower edge; largest that keeps it below
  // the upper edge.
  const lo = ndc(MAX).y < -FOCUS_EDGE ? Infinity : at((t) => ndc(t).y >= -FOCUS_EDGE, MIN, MAX);
  const hi = ndc(MIN).y > FOCUS_EDGE ? -Infinity : at((t) => ndc(t).y > FOCUS_EDGE, MIN, MAX);
  const mid = (Math.max(lo, MIN) + Math.min(hi, MAX)) / 2;
  if (Math.abs(ndc(Number.isFinite(mid) ? mid : 0.4).x) > FOCUS_EDGE) return [Infinity, -Infinity];
  return [Math.max(MIN, lo === Infinity ? Infinity : lo), Math.min(MAX, hi)];
}

/** Furthest ground toward the camera that a framed shot shows on the full canvas (for tests). */
export function frameGroundReach(shot: CameraShot, stage: Stage) {
  const band = clearBand(stage);
  const dx = shot.lx - shot.x;
  const dz = shot.lz - shot.z;
  const ground = Math.hypot(dx, dz) || 1;
  const tilt = Math.atan2(shot.y - shot.ly, ground);
  return bottomReach(
    shot,
    dx / ground,
    dz / ground,
    tilt,
    Math.tan((shot.fov * Math.PI) / 360),
    Math.max(1, stage.width) / band.height,
    -1 - (2 * band.bottom) / band.height
  );
}

export function frameShot(shot: Frame['camera'], stage: Stage): CameraShot {
  const band = clearBand(stage);
  const virtual = { width: Math.max(1, stage.width), height: band.height };
  const { aspect, compact, portrait } = stageWeights(virtual);
  const height = band.height;
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
  let half = Math.atan(Math.max(Math.min(tanDesktop, tanReadable), tanMinSpan));

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
  // Constraints, in priority order: (1) every focus point the director names (the ball; the
  // goalkeeper and posts near a goal) sits inside the clear band; (2) the canvas's real bottom
  // edge never shows ground beyond the dressed near side; (3) stay as close as possible to the
  // preferred tilt above. If (1) and (2) cannot both hold, the shot widens until they do.
  const ndcBottom0 = -1 - (2 * band.bottom) / band.height;
  const cam = { x, y, z };
  const focus = shot.focus ?? [];
  const solve = (halfAngle: number) => {
    const tanHalf = Math.tan(halfAngle);
    let lo = 0.03;
    let hi = 1.5;
    for (const p of focus) {
      const [pLo, pHi] = focusInterval(cam, ux, uz, p, tanHalf, aspect);
      lo = Math.max(lo, pLo);
      hi = Math.min(hi, pHi);
    }
    if (!focus.length) {
      lo = Math.max(lo, aim - FRAMING.actionLimit * halfAngle);
      hi = Math.min(hi, aim + FRAMING.actionLimit * halfAngle);
    }
    const groundAt = (t: number) => bottomReach(cam, ux, uz, t, tanHalf, aspect, ndcBottom0);
    let voidHi = hi;
    if (groundAt(hi) > FRAMING.nearGround) {
      let a = lo;
      let b = hi;
      if (groundAt(a) > FRAMING.nearGround) voidHi = -Infinity;
      else {
        for (let i = 0; i < 24; i++) {
          const mid = (a + b) / 2;
          if (groundAt(mid) > FRAMING.nearGround) b = mid;
          else a = mid;
        }
        voidHi = a;
      }
    }
    return { lo, hi, voidHi };
  };
  let solved = solve(half);
  for (let i = 0; i < 16 && (solved.lo > solved.hi || solved.voidHi < solved.lo); i++) {
    half = Math.min(1.2, half * 1.08);
    solved = solve(half);
  }
  if (solved.lo <= solved.hi)
    tilt = clamp(
      tilt,
      solved.lo,
      solved.voidHi >= solved.lo ? Math.min(solved.hi, solved.voidHi) : solved.hi
    );
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
