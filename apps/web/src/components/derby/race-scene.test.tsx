import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const RaceScene = (await import('./race-scene')).default;
const round = (field: 6 | 8, id = 'round') =>
  ({ field, id, positions: Array(field).fill(0.1) }) as DerbyRound;
beforeEach(() => {
  state.fail = false;
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    fillText() {},
  } as unknown as CanvasRenderingContext2D);
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
