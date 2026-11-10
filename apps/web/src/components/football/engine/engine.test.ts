import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type * as ThreeModule from 'three';
import { BROADCAST_RIG, PITCH, GOAL_SEQUENCE, directorFrame, type ReleasedGoal } from './director';
import { createEngine, type Engine, type MatchInput } from './engine';
import { statusAt } from '@/lib/football/reveal';

const rosterState = vi.hoisted(() => ({ details: [] as string[] }));
const rendererState = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), detail: vi.fn() }));
vi.mock('three', async (original) => {
  const three = await original<typeof ThreeModule>();
  return {
    ...three,
    WebGLRenderer: class {
      domElement = document.createElement('canvas');
      shadowMap = {};
      info = { render: { triangles: 0, calls: 0 }, memory: { geometries: 0, textures: 0 } };
      setPixelRatio() {}
      setSize() {}
      render = rendererState.render;
      dispose = rendererState.dispose;
      forceContextLoss() {}
    },
  };
});
vi.mock('./players', async () => {
  const { Group } = await import('three');
  return {
    createPlayerPool: () => ({
      group: new Group(),
      rigs: rosterState.details.map((detail) => {
        const root = new Group();
        root.userData.playerDetail = detail;
        return { root };
      }),
      setTeams: vi.fn(),
      apply: vi.fn(),
      setDetail: rendererState.detail,
      dispose: vi.fn(),
    }),
  };
});
vi.mock('./stadium', async () => {
  const { Group, Texture } = await import('three');
  return {
    skyTexture: () => new Texture(),
    buildStadium: () => ({
      group: new Group(),
      nets: { '-1': { impact: vi.fn() }, '1': { impact: vi.fn() } },
      update: vi.fn(),
      dispose: vi.fn(),
    }),
  };
});

const match: MatchInput = {
  matchKey: 'vf-s1-w05-f01',
  homeClub: 1,
  awayClub: 2,
  goals: [],
  fullTime: null,
};
let engine: Engine | undefined;
let nextFrame: number;
const frames = new Map<number, FrameRequestCallback>();

function runFrame(time: number) {
  const [id, callback] = [...frames][0];
  frames.delete(id);
  callback(time);
}
function setup(reduced = false, width = 1440, height = 810) {
  const host = document.createElement('div');
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
  const onGoalMoment = vi.fn();
  const onRenderError = vi.fn();
  engine = createEngine({ host, getElapsed: () => 1000, reduced, onRenderError, onGoalMoment });
  engine.setMatch(match);
  return { engine, onRenderError, onGoalMoment, host };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  rosterState.details = [];
  rendererState.render.mockReset();
  nextFrame = 1;
  frames.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
  } as unknown as ReturnType<HTMLCanvasElement['getContext']>);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    })
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => frames.delete(id))
  );
});
afterEach(() => {
  engine?.dispose();
  engine = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('scheduled render failures', () => {
  it('contains an animation-frame exception, cancels its successor and reports it once', () => {
    const { engine, onRenderError } = setup();
    const failure = new Error('GPU render failed');
    rendererState.render.mockImplementation(() => {
      throw failure;
    });
    engine.start();
    const staleCallback = [...frames][0][1];
    expect(() => runFrame(1000)).not.toThrow();
    expect(onRenderError).toHaveBeenCalledTimes(1);
    expect(onRenderError).toHaveBeenCalledWith(failure);
    expect(frames.size).toBe(0);
    staleCallback(2000);
    engine.start();
    expect(rendererState.render).toHaveBeenCalledTimes(1);
    expect(onRenderError).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it('contains a reduced-motion timer exception and cancels further refreshes', () => {
    const { engine, onRenderError } = setup(true);
    engine.start();
    expect(rendererState.render).toHaveBeenCalledTimes(1);
    const failure = new Error('GPU refresh failed');
    rendererState.render.mockImplementation(() => {
      throw failure;
    });
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(onRenderError).toHaveBeenCalledTimes(1);
    expect(onRenderError).toHaveBeenCalledWith(failure);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    engine.setReduced(false);
    engine.start();
    expect(rendererState.render).toHaveBeenCalledTimes(2);
    expect(onRenderError).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it('does not create an interval when the first reduced-motion refresh fails', () => {
    const { engine, onRenderError } = setup(true);
    rendererState.render.mockImplementation(() => {
      throw new Error('Initial refresh failed');
    });
    expect(() => engine.start()).not.toThrow();
    expect(onRenderError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps deterministic direct rendering throwing for lab callers', () => {
    const { engine, onRenderError } = setup();
    rendererState.render.mockImplementation(() => {
      throw new Error('Direct render failed');
    });
    expect(() => engine.renderAt(1000)).toThrow('Direct render failed');
    expect(onRenderError).not.toHaveBeenCalled();
  });
});
it('holds a fixed broadcast camera in reduced motion while refreshing released match facts', () => {
  const { engine } = setup(true);
  engine.renderAt(1000);
  const camera = rendererState.render.mock.calls.at(-1)![1] as ThreeModule.PerspectiveCamera;
  const position = camera.position.clone(),
    rotation = camera.quaternion.clone();
  engine.renderAt(15000);
  expect(camera.position.distanceTo(position)).toBeLessThan(1e-8);
  expect(camera.quaternion.toArray()).toEqual(rotation.toArray());
});

it.each([false, true])(
  'draws the 0.11 m contact sphere without changing released match facts (reduced=%s)',
  (reduced) => {
    const { engine } = setup(reduced);
    for (const side of ['H', 'A'] as const) {
      const input: MatchInput = { ...match, goals: [{ n: 1, side, atMs: 6000 }] };
      engine.setMatch(input);
      for (const elapsedMs of [1000, 5999, 6700, 6730, 8051, 10001]) {
        const frame = engine.renderAt(elapsedMs);
        expect(frame).toEqual(
          directorFrame({
            matchKey: input.matchKey,
            elapsedMs,
            status: statusAt(elapsedMs),
            goals: input.goals,
            fullTime: input.fullTime,
          })
        );
        const scene = rendererState.render.mock.calls.at(-1)![0] as THREE.Scene;
        const spheres = scene.children.filter(
          (child): child is THREE.Mesh<THREE.SphereGeometry> =>
            child instanceof THREE.Mesh && child.geometry instanceof THREE.SphereGeometry
        );
        expect(spheres).toHaveLength(1);
        const ball = spheres[0];
        ball.updateMatrixWorld(true);
        const center = ball.getWorldPosition(new THREE.Vector3());
        expect(center.toArray()).toEqual([frame.ball.x, frame.ball.y, frame.ball.z]);
        const positions = ball.geometry.getAttribute('position');
        let renderedRadius = 0;
        const vertex = new THREE.Vector3();
        for (let i = 0; i < positions.count; i++) {
          vertex.fromBufferAttribute(positions, i).applyMatrix4(ball.matrixWorld);
          renderedRadius = Math.max(renderedRadius, vertex.distanceTo(center));
        }
        // Inspect the actual world-space mesh rather than only the geometry's
        // constructor radius: the former 1.4x display scale hid a 44 mm mismatch.
        expect(renderedRadius).toBeCloseTo(0.11, 7);
      }
    }
  }
);

const viewports = [
  { name: 'desktop', width: 1440, height: 810 },
  { name: 'portrait', width: 390, height: 600 },
];
const scoringGoals: ReleasedGoal[] = [
  { n: 1, side: 'H', atMs: 6000 },
  { n: 1, side: 'A', atMs: 6000 },
  { n: 1, side: 'H', atMs: 38000 },
  { n: 1, side: 'A', atMs: 38000 },
];
function renderedCamera() {
  const camera = rendererState.render.mock.calls.at(-1)![1] as ThreeModule.PerspectiveCamera;
  camera.updateMatrixWorld(true);
  return camera;
}
function inside(camera: ThreeModule.PerspectiveCamera, point: THREE.Vector3, label: string) {
  const projected = point.clone().project(camera);
  expect(Math.abs(projected.x), `${label}: x=${projected.x}`).toBeLessThan(1);
  expect(Math.abs(projected.y), `${label}: y=${projected.y}`).toBeLessThan(1);
  expect(Math.abs(projected.z), `${label}: z=${projected.z}`).toBeLessThan(1);
}
describe.each(viewports)('fixed reduced camera coverage at $name', ({ width, height }) => {
  it.each(scoringGoals)(
    'contains released $side goal at $atMs and preserves reveal timing',
    (goal) => {
      const { engine, onGoalMoment } = setup(true, width, height);
      const moment = goal.atMs + GOAL_SEQUENCE.moment * 1000;
      const absent = engine.renderAt(moment);
      expect(absent.goal).toBeNull();
      expect(onGoalMoment).not.toHaveBeenCalled();
      const initialCamera = renderedCamera();
      const initialPosition = initialCamera.position.toArray(),
        initialRotation = initialCamera.quaternion.toArray(),
        initialFov = initialCamera.fov;
      engine.setMatch({ ...match, goals: [goal] });
      expect(engine.renderAt(goal.atMs - 1).goal).toBeNull();
      expect(onGoalMoment).not.toHaveBeenCalled();
      expect(engine.renderAt(moment - 1).goal?.scored).toBe(false);
      expect(onGoalMoment).not.toHaveBeenCalled();
      // Keep the exact 8050 ms repro; later releases can subtract to just below
      // 2.05 in floating-point seconds, so sample their first following millisecond.
      const frame = engine.renderAt(goal.atMs === 6000 ? moment : moment + 1);
      expect(frame.goal?.scored).toBe(true);
      expect(onGoalMoment).toHaveBeenCalledTimes(1);
      expect(onGoalMoment).toHaveBeenCalledWith(goal.n);
      const camera = renderedCamera();
      expect(camera.position.toArray()).toEqual(initialPosition);
      expect(camera.quaternion.toArray()).toEqual(initialRotation);
      expect(camera.fov).toBe(initialFov);
      inside(camera, new THREE.Vector3(frame.ball.x, frame.ball.y, frame.ball.z), 'scoring ball');
      const position = camera.position.toArray(),
        rotation = camera.quaternion.toArray(),
        fov = camera.fov;
      for (const elapsed of [-1000, 1000, 27999, 29000, 33000, 59000, 65000]) {
        engine.renderAt(elapsed);
        expect(camera.position.toArray()).toEqual(position);
        expect(camera.quaternion.toArray()).toEqual(rotation);
        expect(camera.fov).toBe(fov);
      }
    }
  );
  it('fits every pitch corner and both goal/net volumes independently of events', () => {
    const { engine } = setup(true, width, height);
    engine.renderAt(1000);
    const camera = renderedCamera();
    for (const x of [-PITCH.halfLength, PITCH.halfLength])
      for (const z of [-PITCH.halfWidth, PITCH.halfWidth])
        inside(camera, new THREE.Vector3(x, 0, z), 'pitch corner');
    for (const side of [-1, 1])
      for (const depth of [0, PITCH.goalDepth + 0.55])
        for (const z of [-PITCH.goalHalfWidth - 0.2, PITCH.goalHalfWidth + 0.2])
          for (const y of [0, PITCH.goalHeight + 0.2])
            inside(
              camera,
              new THREE.Vector3(side * (PITCH.halfLength + depth), y, z),
              'goalmouth/net'
            );
  });
});
it('refits immediately on reduced-motion resize and stays fixed between resize events', () => {
  const { engine, host } = setup(true, 1440, 810);
  engine.renderAt(8050);
  const camera = renderedCamera();
  const initial = camera.position.toArray();
  Object.defineProperties(host, { clientWidth: { value: 390 }, clientHeight: { value: 600 } });
  engine.resize();
  camera.updateMatrixWorld(true);
  expect(camera.aspect).toBeCloseTo(390 / 600);
  expect(camera.position.toArray()).not.toEqual(initial);
  for (const side of [-1, 1])
    inside(
      camera,
      new THREE.Vector3(side * (PITCH.halfLength + PITCH.goalDepth), PITCH.goalHeight, 0),
      'resized net'
    );
  const resized = camera.position.toArray(),
    rotation = camera.quaternion.toArray();
  engine.renderAt(15000);
  expect(camera.position.toArray()).toEqual(resized);
  expect(camera.quaternion.toArray()).toEqual(rotation);
  Object.defineProperties(host, { clientWidth: { value: 844 }, clientHeight: { value: 390 } });
  engine.resize();
  camera.updateMatrixWorld(true);
  for (const side of [-1, 1])
    inside(
      camera,
      new THREE.Vector3(side * (PITCH.halfLength + PITCH.goalDepth), 0, 0),
      'landscape net'
    );
});

it('fits immediately when reduced motion is enabled on a stopped, narrow view', () => {
  const { engine } = setup(false, 100, 600);
  engine.renderAt(1000);
  const camera = renderedCamera();
  engine.setReduced(true);
  expect(camera.far).toBeGreaterThan(700);
  for (const x of [-PITCH.halfLength, PITCH.halfLength])
    for (const z of [-PITCH.halfWidth, PITCH.halfWidth])
      inside(camera, new THREE.Vector3(x, 0, z), 'toggle pitch corner');
  const position = camera.position.toArray(),
    rotation = camera.quaternion.toArray();
  engine.renderAt(8050);
  expect(camera.position.toArray()).toEqual(position);
  expect(camera.quaternion.toArray()).toEqual(rotation);
  engine.setReduced(false);
  expect(camera.far).toBe(700);
});

it.each([600, 292])('gives the fixed portrait pitch readable depth at 390×%i', (height) => {
  const { engine } = setup(true, 390, height);
  engine.renderAt(8050);
  const camera = renderedCamera();
  const corners = [-PITCH.halfLength, PITCH.halfLength].flatMap((x) =>
    [-PITCH.halfWidth, PITCH.halfWidth].map((z) => new THREE.Vector3(x, 0, z).project(camera))
  );
  // A measurable minimum footprint prevents returning to the old horizon-strip
  // camera; the separate volume/goal tests continue to require full containment.
  const screenHeight =
    (Math.max(...corners.map((p) => p.y)) - Math.min(...corners.map((p) => p.y))) / 2;
  const screenWidth =
    (Math.max(...corners.map((p) => p.x)) - Math.min(...corners.map((p) => p.x))) / 2;
  expect(screenHeight).toBeGreaterThan(0.18);
  expect(screenWidth).toBeGreaterThan(0.6);
});

it('selects player detail using the established camera and CSS viewport before every draw', () => {
  const { engine } = setup(false, 390, 293);
  rendererState.render.mockImplementation((_scene, camera) => {
    const call = rendererState.detail.mock.calls.at(-1)!;
    expect(call[0]).toBe(camera);
    expect(call[1]).toBe(293);
    expect(camera.matrixWorldInverse.elements.every(Number.isFinite)).toBe(true);
  });
  engine.renderAt(8050);
  engine.renderAt(8060);
  expect(rendererState.detail).toHaveBeenCalledTimes(2);
});

it('reports the actually selected roster detail counts without changing renderer work statistics', () => {
  rosterState.details = ['high', 'high', 'mid', 'low', 'low', 'unknown'];
  const { engine } = setup();
  expect(engine.info()).toEqual({
    triangles: 0,
    calls: 0,
    geometries: 0,
    textures: 0,
    reviewPlayers: 0,
    playerDetails: { high: 2, mid: 1, low: 2 },
  });
});

describe.each([...viewports, { name: 'phone', width: 390, height: 844 }])(
  'live broadcast camera at $name',
  ({ width, height }) => {
    it.each(scoringGoals)(
      'stays on the gantry and keeps the ball on screen through the $side goal at $atMs',
      (goal) => {
        const { engine } = setup(false, width, height);
        engine.setMatch({ ...match, goals: [goal] });
        const start = goal.atMs;
        let checked = 0;
        // Live play into the sequence and through the finish, at 30 fps with operator lag.
        for (
          let ms = start - 3000;
          ms <= start + GOAL_SEQUENCE.moment * 1000 + 300;
          ms += 1000 / 30
        ) {
          const frame = engine.renderAt(ms, 1 / 30);
          const camera = renderedCamera();
          expect(camera.position.toArray()).toEqual([
            BROADCAST_RIG.x,
            BROADCAST_RIG.y,
            BROADCAST_RIG.z,
          ]);
          if (frame.mode === 'GOAL') {
            inside(
              camera,
              new THREE.Vector3(frame.ball.x, frame.ball.y, frame.ball.z),
              `ball ${ms}`
            );
            checked++;
          }
        }
        expect(checked).toBeGreaterThan(60);
      }
    );
  }
);

it('eases between live framings instead of jumping, and cuts only into and out of goals', () => {
  const { engine, host } = setup(false);
  const cuts = vi.fn();
  host.addEventListener('football-cut', cuts);
  engine.setMatch({ ...match, goals: [{ n: 1, side: 'H', atMs: 6000 }] });
  let previous: THREE.Vector3 | null = null;
  let largest = 0;
  for (let ms = 1000; ms < 5900; ms += 1000 / 30) {
    engine.renderAt(ms, 1 / 30);
    const camera = renderedCamera();
    const aim = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    if (previous) largest = Math.max(largest, aim.angleTo(previous));
    previous = aim;
  }
  // Under about 0.7 degrees of pan per 30 fps frame during live play.
  expect(largest).toBeLessThan(0.012);
  expect(cuts).not.toHaveBeenCalled();
  engine.renderAt(6100, 1 / 30);
  expect(cuts).toHaveBeenCalledTimes(1);
});

it('keeps the shadow map at 1024² unless the high graphics setting is chosen', () => {
  const sizes: number[] = [];
  for (const maxPixelRatio of [undefined, 1, 1.15, 1.5, 1.75]) {
    const host = document.createElement('div');
    const e = createEngine({ host, getElapsed: () => 1000, maxPixelRatio });
    e.setMatch(match);
    e.renderAt(1000);
    const scene = rendererState.render.mock.calls.at(-1)![0] as ThreeModule.Scene;
    const key = scene.children.find(
      (o): o is ThreeModule.DirectionalLight =>
        (o as ThreeModule.DirectionalLight).isDirectionalLight === true &&
        (o as ThreeModule.DirectionalLight).castShadow
    )!;
    sizes.push(key.shadow.mapSize.x);
    e.dispose();
  }
  expect(sizes).toEqual([1024, 1024, 1024, 1024, 2048]);
});
