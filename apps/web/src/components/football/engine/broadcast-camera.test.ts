import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { frameShot, type Stage } from './broadcast-framing';
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

/** Real 3D stage sizes (CSS px) from the page/group/preview styles, plus lab shapes. */
const STAGES = [
  { name: 'desktop 1280x720', width: 1280, height: 720 },
  { name: 'phone game page 390x292 (4:3)', width: 390, height: 292 },
  { name: 'phone group game 390x222', width: 390, height: 222 },
  { name: 'phone sports card 362x254', width: 362, height: 254 },
  { name: 'landscape phone game page 844x265', width: 844, height: 265 },
  { name: 'landscape phone full 844x390', width: 844, height: 390 },
  { name: 'portrait expanded 390x844', width: 390, height: 844 },
  { name: 'tablet portrait 768x1024', width: 768, height: 1024 },
];
function lens(shot: Frame['camera'], stage: Stage) {
  const framed = frameShot(shot, stage);
  const aspect = stage.width / stage.height;
  const camera = new THREE.PerspectiveCamera(framed.fov, aspect, 0.5, 700);
  camera.position.set(framed.x, framed.y, framed.z);
  camera.lookAt(framed.lx, framed.ly, framed.lz);
  camera.updateMatrixWorld(true);
  return camera;
}
const inFrame = (camera: THREE.PerspectiveCamera, p: THREE.Vector3, margin = 0.97) => {
  const q = p.clone().project(camera);
  return Math.abs(q.x) <= margin && Math.abs(q.y) <= margin && q.z > -1 && q.z < 1;
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
    const phone = { width: 390, height: 292 };
    expect(playerPx(lens(goal.camera, phone), phone, goal.ball.x, goal.ball.z)).toBeGreaterThan(36);
  });

  it('fills small and portrait stages with pitch rather than stand', () => {
    for (const t of [3.2, 16, 37]) {
      const play = frameAt(t, [], 'vf-s1-w01-f05');
      for (const stage of STAGES.filter((s) => s.height < 300 || s.width < s.height)) {
        const camera = lens(play.camera, stage);
        // The far advertising boards (top of the far touchline) sit in the top 18 % of the frame.
        const boards = new THREE.Vector3(play.camera.lx, 0.9, -(PITCH.halfWidth + 3.2)).project(
          camera
        );
        expect(boards.y, `${stage.name} t=${t}`).toBeGreaterThan(0.64);
        expect(inFrame(camera, new THREE.Vector3(play.ball.x, 0.11, play.ball.z))).toBe(true);
      }
    }
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
