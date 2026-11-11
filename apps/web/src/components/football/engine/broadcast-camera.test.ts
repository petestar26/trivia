import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FRAMING, clearBand, frameGroundReach, frameShot, type Stage } from './broadcast-framing';
import {
  BROADCAST_RIG,
  GOAL_SEQUENCE,
  PITCH,
  broadcastCamera,
  directorFrame,
  type DirectorInput,
  type Frame,
  type ReleasedGoal,
} from './director';
import {
  createCameraOperator,
  OPERATOR_GOAL,
  OPERATOR_PLAY,
  smoothDamp,
  type CameraShot,
} from './camera-operator';

const status = (t: number): DirectorInput['status'] =>
  t < 0
    ? 'SCHEDULED'
    : t < 28
      ? 'FIRST_HALF'
      : t < 32
        ? 'HALFTIME'
        : t < 60
          ? 'SECOND_HALF'
          : 'FULL_TIME';
const frameAt = (t: number, goals: ReleasedGoal[], key: string) =>
  directorFrame({
    matchKey: key,
    elapsedMs: Math.round(t * 1000),
    status: status(t),
    goals: goals.filter((g) => g.atMs <= t * 1000),
    fullTime: null,
  });

/**
 * Real 3D stages measured in the built pages (CSS px) with the overlays that cover them, plus
 * overlay-free lab shapes. Page: scoreboard band on top, caption at the bottom. Group: scoreboard.
 * Sports card: label/pause controls on top, caption at the bottom.
 */
const STAGES: Array<Stage & { name: string }> = [
  { name: 'desktop page 920x518', width: 920, height: 518, insetTop: 86, insetBottom: 79 },
  { name: 'phone page portrait 330x260', width: 330, height: 260, insetTop: 78, insetBottom: 68 },
  { name: 'small phone page 300x260', width: 300, height: 260, insetTop: 78, insetBottom: 68 },
  { name: 'phone page landscape 788x218', width: 788, height: 218, insetTop: 86, insetBottom: 53 },
  { name: 'tablet page portrait 696x522', width: 696, height: 522, insetTop: 86, insetBottom: 79 },
  { name: 'phone group game 352x320', width: 352, height: 320, insetTop: 90, insetBottom: 0 },
  { name: 'phone sports card 360x253', width: 360, height: 253, insetTop: 50, insetBottom: 28 },
  { name: 'sports card 452x410', width: 452, height: 410, insetTop: 56, insetBottom: 37 },
  { name: 'lab desktop 1280x720', width: 1280, height: 720 },
  { name: 'lab portrait 390x844', width: 390, height: 844 },
  { name: 'lab tablet portrait 768x1024', width: 768, height: 1024 },
  { name: 'lab landscape 844x390', width: 844, height: 390 },
];
/** A camera built exactly as the engine builds it: framed band plus off-centre projection. */
function stageCamera(framed: CameraShot, stage: Stage) {
  const band = clearBand(stage);
  const camera = new THREE.PerspectiveCamera(framed.fov, stage.width / band.height, 0.5, 700);
  if (band.top || band.bottom)
    camera.setViewOffset(stage.width, band.height, 0, -band.top, stage.width, stage.height);
  camera.position.set(framed.x, framed.y, framed.z);
  camera.lookAt(framed.lx, framed.ly, framed.lz);
  camera.updateMatrixWorld(true);
  return Object.assign(camera, { band, stage });
}
type StageCamera = ReturnType<typeof stageCamera>;
const lens = (shot: Frame['camera'], stage: Stage) => stageCamera(frameShot(shot, stage), stage);
/** Inside the clear band between overlays (canvas NDC), with a small margin. */
const inFrame = (camera: StageCamera, p: THREE.Vector3, margin = 0.97) => {
  const q = p.clone().project(camera);
  const h = camera.stage.height;
  const top = 1 - (2 * camera.band.top) / h;
  const bottom = -1 + (2 * camera.band.bottom) / h;
  const mid = (top + bottom) / 2;
  const halfBand = ((top - bottom) / 2) * margin;
  return Math.abs(q.x) <= margin && Math.abs(q.y - mid) <= halfBand && q.z > -1 && q.z < 1;
};
/** Projected height of a 1.8 m player at (x, z), in CSS pixels. */
const playerPx = (camera: THREE.PerspectiveCamera, stage: Stage, x: number, z: number) =>
  (Math.abs(
    new THREE.Vector3(x, 1.8, z).project(camera).y - new THREE.Vector3(x, 0, z).project(camera).y
  ) *
    stage.height) /
  2;

// Both halves, both sides and several fixtures cover the cross and through-ball variants.
const CASES: Array<{ key: string; goal: ReleasedGoal }> = [];
for (const key of ['vf-s1-w01-f01', 'vf-s1-w01-f05', 'vf-s2-w17-f03', 'vf-s4-w30-f09'])
  for (const [side, atMs] of [
    ['H', 6000],
    ['A', 19500],
    ['H', 40000],
    ['A', 51000],
  ] as const)
    CASES.push({ key, goal: { n: 1, side, atMs } });

describe('fixed broadcast framing', () => {
  it('never moves the camera position, only its aim and zoom', () => {
    for (const x of [-60, -30, 0, 22, 60])
      for (const z of [-40, 0, 25]) {
        const shot = broadcastCamera({ x, z });
        expect([shot.x, shot.y, shot.z]).toEqual([
          BROADCAST_RIG.x,
          BROADCAST_RIG.y,
          BROADCAST_RIG.z,
        ]);
        expect(Math.abs(shot.lx)).toBeLessThanOrEqual(PITCH.halfLength);
      }
  });

  it('zooms with distance so players keep a steady on-screen size', () => {
    const height = (shot: Frame['camera'], x: number) => {
      const camera = lens(shot, { width: 1280, height: 720 });
      const a = new THREE.Vector3(x, 0, 0).project(camera);
      const b = new THREE.Vector3(x, 1.8, 0).project(camera);
      return Math.abs(b.y - a.y);
    };
    const centre = height(broadcastCamera({ x: 0, z: 0 }), 0);
    const end = height(broadcastCamera({ x: 38, z: 0 }), 38);
    expect(end / centre).toBeGreaterThan(0.93);
    expect(end / centre).toBeLessThan(1.07);
  });

  describe.each(STAGES)('goal sequences at $name', (stage) => {
    it('keeps the ball, the goalkeeper and both posts inside the framing', () => {
      let checked = 0;
      for (const { key, goal } of CASES) {
        const start = goal.atMs / 1000;
        const gx =
          Math.sign(frameAt(start + GOAL_SEQUENCE.moment + 0.2, [goal], key).ball.x) *
          PITCH.halfLength;
        const keeper = goal.side === 'H' ? 11 : 0;
        for (let t = start; t <= start + GOAL_SEQUENCE.moment + 0.3; t += 0.05) {
          const f = frameAt(t, [goal], key);
          expect(f.mode).toBe('GOAL');
          const camera = lens(f.camera, stage);
          expect(inFrame(camera, new THREE.Vector3(f.ball.x, f.ball.y, f.ball.z))).toBe(true);
          if (t >= start + GOAL_SEQUENCE.moment - 1) {
            const k = f.actors[keeper];
            for (const y of [0, 1.8])
              expect(inFrame(camera, new THREE.Vector3(k.x, y, k.z), 0.98)).toBe(true);
          }
          if (t >= start + GOAL_SEQUENCE.moment - 0.5)
            for (const z of [-PITCH.goalHalfWidth, PITCH.goalHalfWidth])
              for (const y of [0, PITCH.goalHeight])
                expect(inFrame(camera, new THREE.Vector3(gx, y, z))).toBe(true);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(500);
    });
  });

  it('keeps desktop framing unchanged and makes players readable on small stages', () => {
    const play = directorFrame({
      matchKey: 'vf-s1-w01-f05',
      elapsedMs: 16000,
      status: 'FIRST_HALF',
      goals: [],
      fullTime: null,
    });
    const desktop = frameShot(play.camera, { width: 1280, height: 720 });
    expect(desktop.fov).toBeCloseTo(play.camera.fov, 6);
    for (const k of ['x', 'y', 'z', 'lx', 'ly', 'lz'] as const)
      expect(desktop[k]).toBeCloseTo(play.camera[k], 6);
    for (const stage of STAGES) {
      const camera = lens(play.camera, stage);
      const px = playerPx(camera, stage, play.ball.x, play.ball.z);
      // Live play: at least ~22 CSS px tall on every stage (desktop is far larger).
      expect(px, stage.name).toBeGreaterThan(21);
    }
    // Goal moment: the push-in roughly doubles player size on the phone page.
    const goal = frameAt(6 + GOAL_SEQUENCE.moment, CASES[0] ? [CASES[0].goal] : [], CASES[0].key);
    const phone = STAGES[1];
    expect(playerPx(lens(goal.camera, phone), phone, goal.ball.x, goal.ball.z)).toBeGreaterThan(36);
  });

  it('fills the clear band of small and portrait stages with pitch rather than stand', () => {
    for (const t of [3.2, 16, 37]) {
      const play = frameAt(t, [], 'vf-s1-w01-f05');
      for (const stage of STAGES.filter((s) => clearBand(s).height < 300 || s.width < s.height)) {
        const camera = lens(play.camera, stage);
        const h = stage.height;
        const bandTop = 1 - (2 * camera.band.top) / h;
        const bandHeight = (2 * camera.band.height) / h;
        // The far advertising boards sit in the top fifth of the clear band, or above it under
        // the scoreboard, so the band itself is mostly pitch.
        const boards = new THREE.Vector3(play.camera.lx, 0.9, -(PITCH.halfWidth + 3.2)).project(
          camera
        );
        expect(boards.y, `${stage.name} t=${t}`).toBeGreaterThan(bandTop - 0.2 * bandHeight);
        expect(inFrame(camera, new THREE.Vector3(play.ball.x, 0.11, play.ball.z))).toBe(true);
      }
    }
  });

  // Every frame of complete matches (live play, every goal variant, half-time, full time).
  const MATCHES = ['vf-s1-w01-f01', 'vf-s1-w01-f05', 'vf-s2-w17-f03'].map((key) => ({
    key,
    goals: [
      { n: 1, side: 'H', atMs: 6000 },
      { n: 2, side: 'A', atMs: 19500 },
      { n: 3, side: 'H', atMs: 40000 },
      { n: 4, side: 'A', atMs: 51000 },
    ] as ReleasedGoal[],
  }));
  const fullMatch = (key: string, goals: ReleasedGoal[], t: number) =>
    directorFrame({
      matchKey: key,
      elapsedMs: Math.round(t * 1000),
      status: status(t),
      goals: goals.filter((g) => g.atMs <= t * 1000),
      fullTime: t >= 60 ? { home: 2, away: 2 } : null,
    });

  it.each(STAGES)(
    'never shows ground beyond the dressed near side at $name, in any frame',
    (stage) => {
      let worst = -Infinity;
      for (const { key, goals } of MATCHES)
        for (let t = -1; t <= 61; t += 0.1) {
          const reach = frameGroundReach(frameShot(fullMatch(key, goals, t).camera, stage), stage);
          worst = Math.max(worst, reach);
        }
      expect(worst).toBeLessThanOrEqual(FRAMING.nearGround + 1e-6);
    }
  );

  it.each(STAGES)('keeps the live ball inside the clear band at $name, in any frame', (stage) => {
    let checked = 0;
    for (const { key, goals } of MATCHES)
      for (let t = 0; t <= 60; t += 0.25) {
        const f = fullMatch(key, goals, t);
        if (f.mode !== 'PLAY' && f.mode !== 'GOAL') continue;
        const camera = lens(f.camera, stage);
        expect(
          inFrame(camera, new THREE.Vector3(f.ball.x, f.ball.y, f.ball.z), 0.99),
          `${key} t=${t.toFixed(2)} ${f.mode}`
        ).toBe(true);
        checked++;
      }
    expect(checked).toBeGreaterThan(500);
  });
});

describe('camera operator', () => {
  const shot = (lx: number, fov = 25): CameraShot => ({
    ...BROADCAST_RIG,
    lx,
    ly: 0.9,
    lz: 1.5,
    fov,
  });

  it('starts and stops a pan gradually, without overshoot, and settles', () => {
    const op = createCameraOperator();
    op.follow(shot(0), 1 / 30, OPERATOR_PLAY); // first call is a cut
    expect(op.shot.lx).toBe(0);
    const xs: number[] = [];
    for (let i = 0; i < 120; i++) {
      op.follow(shot(30), 1 / 30, OPERATOR_PLAY);
      xs.push(op.shot.lx);
    }
    const speeds = xs.map((x, i) => (i ? x - xs[i - 1] : x) * 30);
    // Eases in: the first step is slower than the fastest step.
    expect(speeds[0]).toBeLessThan(Math.max(...speeds) * 0.6);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(OPERATOR_PLAY.maxPanSpeed + 1e-6);
    expect(Math.max(...xs)).toBeLessThanOrEqual(30);
    expect(xs.at(-1)).toBeCloseTo(30, 1);
    // The position never moves for a fixed rig.
    expect([op.shot.x, op.shot.y, op.shot.z]).toEqual([
      BROADCAST_RIG.x,
      BROADCAST_RIG.y,
      BROADCAST_RIG.z,
    ]);
  });

  it('is deterministic for the same targets and time steps and frame-rate tolerant', () => {
    const run = (fps: number) => {
      const op = createCameraOperator();
      op.cut(shot(0));
      for (let i = 0; i < fps * 2; i++) op.follow(shot(20, 20), 1 / fps, OPERATOR_GOAL);
      return op.shot.lx;
    };
    expect(run(30)).toBe(run(30));
    // 24, 30 and 60 fps reach practically the same framing after the same time.
    expect(Math.abs(run(24) - run(60))).toBeLessThan(0.15);
  });

  it('zooms out faster than it zooms in, so widening for the action never lags', () => {
    const settle = (from: number, to: number) => {
      const op = createCameraOperator();
      op.cut(shot(10, from));
      let frames = 0;
      while (Math.abs(op.shot.fov - to) > 0.05 * Math.abs(to - from) && frames < 300) {
        op.follow(shot(10, to), 1 / 30, OPERATOR_GOAL);
        frames++;
      }
      return frames;
    };
    expect(settle(14, 24)).toBeLessThan(settle(24, 14) * 0.5);
  });

  it('cuts immediately and clears motion', () => {
    const op = createCameraOperator();
    op.cut(shot(0));
    for (let i = 0; i < 10; i++) op.follow(shot(40), 1 / 30, OPERATOR_PLAY);
    op.cut(shot(-10, 18));
    expect(op.shot.lx).toBe(-10);
    expect(op.shot.fov).toBe(18);
    op.follow(shot(-10, 18), 1 / 30, OPERATOR_PLAY);
    expect(op.shot.lx).toBeCloseTo(-10, 10);
  });

  it('keeps the spring stable for long frame gaps', () => {
    const v = new Float64Array(1);
    let x = 0;
    for (const dt of [0.1, 0.5, 2, 0.001]) {
      x = smoothDamp(x, 10, v, 0, 0.6, dt);
      expect(x).toBeLessThanOrEqual(10);
      expect(Number.isFinite(v[0])).toBe(true);
    }
  });
});
