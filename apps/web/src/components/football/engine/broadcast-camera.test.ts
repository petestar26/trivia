import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { broadcastFov } from './broadcast-fov';
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

const VIEWPORTS = [
  { name: 'desktop 16:9', aspect: 16 / 9 },
  { name: 'phone portrait', aspect: 390 / 844 },
  { name: 'phone landscape', aspect: 844 / 390 },
];
function lens(shot: Frame['camera'], aspect: number) {
  const camera = new THREE.PerspectiveCamera(broadcastFov(shot.fov, aspect), aspect, 0.5, 700);
  camera.position.set(shot.x, shot.y, shot.z);
  camera.lookAt(shot.lx, shot.ly, shot.lz);
  camera.updateMatrixWorld(true);
  return camera;
}
const inFrame = (camera: THREE.PerspectiveCamera, p: THREE.Vector3, margin = 0.97) => {
  const q = p.clone().project(camera);
  return Math.abs(q.x) <= margin && Math.abs(q.y) <= margin && q.z > -1 && q.z < 1;
};

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
      const camera = lens(shot, 16 / 9);
      const a = new THREE.Vector3(x, 0, 0).project(camera);
      const b = new THREE.Vector3(x, 1.8, 0).project(camera);
      return Math.abs(b.y - a.y);
    };
    const centre = height(broadcastCamera({ x: 0, z: 0 }), 0);
    const end = height(broadcastCamera({ x: 38, z: 0 }), 38);
    expect(end / centre).toBeGreaterThan(0.93);
    expect(end / centre).toBeLessThan(1.07);
  });

  describe.each(VIEWPORTS)('goal sequences at $name', ({ aspect }) => {
    it('keeps the ball, then both posts, inside the director framing', () => {
      let checked = 0;
      for (const { key, goal } of CASES) {
        const start = goal.atMs / 1000;
        const gx =
          Math.sign(frameAt(start + GOAL_SEQUENCE.moment + 0.2, [goal], key).ball.x) *
          PITCH.halfLength;
        for (let t = start; t <= start + GOAL_SEQUENCE.moment + 0.3; t += 0.05) {
          const f = frameAt(t, [goal], key);
          expect(f.mode).toBe('GOAL');
          const camera = lens(f.camera, aspect);
          expect(inFrame(camera, new THREE.Vector3(f.ball.x, f.ball.y, f.ball.z))).toBe(true);
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
