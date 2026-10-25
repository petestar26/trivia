import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DerbyRound } from '@socialplay/shared';
const state = { fail: false, disposed: vi.fn(), draw: vi.fn() };
vi.doMock('three', async (original) => {
  const three = await original<typeof import('three')>();
  return {
    ...three,
    WebGLRenderer: class {
      domElement = document.createElement('canvas');
      shadowMap = {};
      constructor() {
        if (state.fail) throw Error('WebGL unavailable');
      }
      setPixelRatio() {}
      setSize() {}
      render = state.draw;
      dispose = state.disposed;
    },
    TextureLoader: class {
      load() {
        return new three.Texture();
      }
    },
  };
});
vi.doMock('./horse-model', async () => {
  const { Group } = await import('three');
  return { createHorse: () => ({ root: new Group(), animate: vi.fn() }) };
});
const pendingAssets: Array<(assets: { dispose: () => void }) => void> = [];
const rigDisposers: Array<ReturnType<typeof vi.fn>> = [];
vi.doMock('./rigged-horse', async () => {
  const { Group } = await import('three');
  return {
    loadHorseAssets: () => new Promise((resolve) => pendingAssets.push(resolve)),
    createRiggedHorse: () => {
      const dispose = vi.fn();
      rigDisposers.push(dispose);
      return { root: new Group(), animate: vi.fn(), dispose };
    },
  };
});
const RaceScene = (await import('./race-scene')).default;
const round = (field: 6 | 8, id = 'round') =>
  ({ field, id, positions: Array(field).fill(0.1) }) as DerbyRound;
beforeEach(() => {
  state.fail = false;
  pendingAssets.length = 0;
  rigDisposers.length = 0;
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    fillText() {},
    createRadialGradient: () => ({ addColorStop() {} }),
  } as unknown as ReturnType<HTMLCanvasElement['getContext']>);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('keeps an accessible fallback when WebGL construction fails', () => {
  state.fail = true;
  const { container } = render(<RaceScene round={round(6)} running reduced={false} />);
  expect(screen.getByText(/3D view unavailable/)).toBeVisible();
  expect(container.querySelector('canvas')).toBeNull();
});
it('reuses the scene for new rounds and disposes it for field switches and unmount', () => {
  const view = render(<RaceScene round={round(6)} running reduced={false} />);
  const canvas = view.container.querySelector('canvas');
  view.rerender(<RaceScene round={round(6, 'next')} running={false} reduced />);
  expect(view.container.querySelector('canvas')).toBe(canvas);
  expect(state.disposed).not.toHaveBeenCalled();
  view.rerender(<RaceScene round={round(8)} running reduced={false} />);
  expect(state.disposed).toHaveBeenCalledTimes(1);
  expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
  view.unmount();
  expect(state.disposed).toHaveBeenCalledTimes(2);
  expect(cancelAnimationFrame).toHaveBeenCalledTimes(2);
});
it('stops the animation loop and presents fallback after context loss', () => {
  const view = render(<RaceScene round={round(6)} running reduced={false} />);
  const scheduled = vi.mocked(requestAnimationFrame).mock.calls[0][0];
  fireEvent(
    view.container.querySelector('canvas')!,
    new Event('webglcontextlost', { cancelable: true })
  );
  expect(screen.getByText(/3D view unavailable/)).toBeVisible();
  const count = vi.mocked(requestAnimationFrame).mock.calls.length;
  scheduled(1000);
  expect(requestAnimationFrame).toHaveBeenCalledTimes(count);
  expect(state.draw).not.toHaveBeenCalled();
  view.rerender(<RaceScene round={round(8)} running reduced={false} />);
  expect(screen.queryByText(/3D view unavailable/)).not.toBeInTheDocument();
  expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
});
it('rebuilds after context restoration on the same field and detaches old listeners', () => {
  const view = render(<RaceScene round={round(8)} running reduced={false} />);
  for (let attempt = 0; attempt < 2; attempt++) {
    const old = view.container.querySelector('canvas')!;
    fireEvent(old, new Event('webglcontextlost', { cancelable: true }));
    expect(screen.getByText(/3D view unavailable/)).toBeVisible();
    fireEvent(old, new Event('webglcontextrestored'));
    expect(screen.queryByText(/3D view unavailable/)).not.toBeInTheDocument();
    const current = view.container.querySelector('canvas')!;
    expect(current).not.toBe(old);
    expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
    expect(state.disposed).toHaveBeenCalledTimes(attempt + 1);
    fireEvent(old, new Event('webglcontextrestored'));
    expect(view.container.querySelector('canvas')).toBe(current);
    const draw = vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0];
    draw(2000);
    expect(state.draw).toHaveBeenCalledTimes(attempt + 1);
  }
  view.unmount();
  expect(state.disposed).toHaveBeenCalledTimes(3);
});

it('disposes late-loading models after unmount without attaching a new scene', async () => {
  const view = render(<RaceScene round={round(6)} running reduced={false} />);
  const resolve = pendingAssets[0],
    dispose = vi.fn();
  view.unmount();
  await act(async () => resolve({ dispose }));
  expect(dispose).toHaveBeenCalledOnce();
  expect(rigDisposers).toHaveLength(0);
});
it('releases each runner rig and its shared asset set on a field change', async () => {
  const view = render(<RaceScene round={round(6)} running reduced={false} />);
  const dispose = vi.fn();
  await act(async () => pendingAssets[0]({ dispose }));
  expect(rigDisposers).toHaveLength(6);
  view.rerender(<RaceScene round={round(8)} running reduced={false} />);
  expect(dispose).toHaveBeenCalledOnce();
  rigDisposers.forEach((d) => expect(d).toHaveBeenCalledOnce());
});
it('contains a scheduled draw failure, stops its loop and can rebuild on explicit retry', () => {
  const view = render(<RaceScene round={round(6)} running reduced={false} />);
  const frame = vi.mocked(requestAnimationFrame).mock.calls[0][0];
  state.draw.mockImplementationOnce(() => {
    throw Error('lost graphics resource');
  });
  act(() => frame(1000));
  expect(screen.getByText(/3D view unavailable/)).toBeVisible();
  expect(cancelAnimationFrame).toHaveBeenCalled();
  const count = vi.mocked(requestAnimationFrame).mock.calls.length;
  act(() => frame(1100));
  expect(requestAnimationFrame).toHaveBeenCalledTimes(count);
  fireEvent.click(screen.getByRole('button', { name: 'Retry 3D view' }));
  expect(screen.queryByText(/3D view unavailable/)).toBeNull();
  expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
});

it('releases scene GPU owners and the sunlight shadow before renderer state is discarded', async () => {
  const three = await import('three');
  const events: string[] = [];
  const geometryDispose = three.BufferGeometry.prototype.dispose,
    materialDispose = three.Material.prototype.dispose,
    textureDispose = three.Texture.prototype.dispose;
  vi.spyOn(three.BufferGeometry.prototype, 'dispose').mockImplementation(function (
    this: import('three').BufferGeometry
  ) {
    events.push('geometry');
    geometryDispose.call(this);
  });
  vi.spyOn(three.Material.prototype, 'dispose').mockImplementation(function (
    this: import('three').Material
  ) {
    events.push('material');
    materialDispose.call(this);
  });
  vi.spyOn(three.Texture.prototype, 'dispose').mockImplementation(function (
    this: import('three').Texture
  ) {
    events.push('texture');
    textureDispose.call(this);
  });
  const shadowPrototype = Object.getPrototypeOf(new three.DirectionalLight().shadow),
    shadowDispose = shadowPrototype.dispose;
  vi.spyOn(shadowPrototype, 'dispose').mockImplementation(function (this: object) {
    events.push('shadow');
    shadowDispose.call(this);
  });
  state.disposed.mockImplementationOnce(() => {
    events.push('renderer');
  });
  const view = render(<RaceScene round={round(8)} running reduced={false} />);
  events.length = 0; // Ignore temporary geometry merges during construction.
  view.unmount();
  const renderer = events.indexOf('renderer');
  expect(renderer).toBeGreaterThan(-1);
  for (const owner of ['geometry', 'material', 'texture', 'shadow']) {
    expect(events).toContain(owner);
    expect(events.every((event, index) => event !== owner || index < renderer)).toBe(true);
  }
  expect(events.filter((event) => event === 'shadow')).toHaveLength(1);
  expect(events.filter((event) => event === 'renderer')).toHaveLength(1);
});

it('keeps the same numbered sprites and leader buffer when deferred authored horses replace the fallback', async () => {
  const three = await import('three');
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(358);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  const view = render(<RaceScene round={round(8)} running reduced={false} />);
  act(() => vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](1000));
  const scene = state.draw.mock.calls.at(-1)![0] as import('three').Scene;
  const labels = Array.from(
    { length: 8 },
    (_, i) => scene.getObjectByName(`runner-number-${i + 1}`) as import('three').Sprite
  );
  const parents = labels.map((label) => label.parent);
  const maps = labels.map((label) => label.material.map);
  const leader = scene.getObjectByName('runner-number-leaders') as import('three').LineSegments;
  const attribute = leader.geometry.getAttribute('position'),
    array = attribute.array;
  const before = labels.map((label) => label.getWorldPosition(new three.Vector3()).toArray());
  const dispose = vi.fn();
  await act(async () => pendingAssets[0]({ dispose }));
  act(() => vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](1100));
  labels.forEach((label, i) => {
    expect(scene.getObjectByName(`runner-number-${i + 1}`)).toBe(label);
    expect(label.parent).not.toBe(parents[i]);
    expect(label.material.map).toBe(maps[i]);
    const position = label.getWorldPosition(new three.Vector3()).toArray();
    position.forEach((value, axis) => expect(value).toBeCloseTo(before[i][axis], 10));
  });
  expect(leader.geometry.getAttribute('position')).toBe(attribute);
  expect(attribute.array).toBe(array);
  view.unmount();
  expect(dispose).toHaveBeenCalledOnce();
});

it('refits the reused camera immediately after orientation resize instead of retaining the old portrait zoom', async () => {
  const three = await import('three'),
    { frameDerbyField } = await import('./field-camera');
  let width = 390,
    height = 844,
    resized!: () => void;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
  const view = render(<RaceScene round={round(8)} running reduced={false} />);
  act(() => vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](1000));
  const camera = state.draw.mock.calls.at(-1)![1] as import('three').PerspectiveCamera;
  width = 844;
  height = 230;
  act(() => resized());
  act(() => vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](1100));
  const expected = new three.PerspectiveCamera(36, width / height, 0.1, 2000);
  frameDerbyField(expected, Array(8).fill(18), 8);
  expect(state.draw.mock.calls.at(-1)![1]).toBe(camera);
  expect(camera.position.distanceTo(expected.position)).toBeLessThan(1e-9);
  view.unmount();
});
