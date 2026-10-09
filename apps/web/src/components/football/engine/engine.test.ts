import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThreeModule from 'three';
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
function setup(reduced = false) {
  const host = document.createElement('div');
  const onRenderError = vi.fn();
  engine = createEngine({ host, getElapsed: () => 1000, reduced, onRenderError });
  engine.setMatch(match);
  return { engine, onRenderError };
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
  } as unknown as CanvasRenderingContext2D);
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
