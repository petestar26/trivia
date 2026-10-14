import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type * as ThreeModule from 'three';
import { PITCH, GOAL_SEQUENCE, type ReleasedGoal } from './director';
import { createEngine, type Engine, type MatchInput } from './engine';

const rendererState = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn() }));
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
      setTeams: vi.fn(),
      apply: vi.fn(),
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
