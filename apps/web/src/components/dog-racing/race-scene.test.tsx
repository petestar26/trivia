import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Scene, Camera } from 'three';
import type * as ThreeModule from 'three';
import type { RaceFrame } from './world';
import type * as WorldModule from './world';

const state = { fail: false, renderFail: false };
const renderers: Array<{
  render: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  forceContextLoss: ReturnType<typeof vi.fn>;
  pixelRatio: number;
}> = [];
const worlds: Array<{
  update: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}> = [];
vi.doMock('three', async (original) => {
  const three = await original<typeof ThreeModule>();
  return {
    ...three,
    WebGLRenderer: class {
      domElement = document.createElement('canvas');
      shadowMap = {};
      pixelRatio = 1;
      constructor() {
        if (state.fail) throw Error('No WebGL');
        renderers.push(this as never);
      }
      setPixelRatio(value: number) {
        this.pixelRatio = value;
      }
      setSize() {}
      forceContextLoss = vi.fn();
      render = vi.fn((_scene: Scene, _camera: Camera) => {
        if (state.renderFail) throw Error('Draw lost');
      });
      dispose = vi.fn();
    },
  };
});
vi.doMock('./world', async (original) => {
  const actual = await original<typeof WorldModule>();
  const { trackPoint } = await import('./track');
  return {
    ...actual,
    createRaceWorld: () => {
      const world = {
        dogs: [],
        update: vi.fn((frame: RaceFrame) => {
          const views = Array.from({ length: 8 }, (_, index) => {
            const at = trackPoint(frame.laps[index] ?? 0, actual.laneOffset(index, frame.field));
            return { index, visible: index < frame.field, ...at, lap: frame.laps[index] ?? 0 };
          });
          const laps = frame.laps.slice(0, frame.field);
          return { views, lead: Math.max(...laps), trail: Math.min(...laps), centre: null };
        }),
        view: vi.fn(),
        reset: vi.fn(),
        dispose: vi.fn(),
      };
      worlds.push(world as never);
      return world;
    },
  };
});
const { trackPoint } = await import('./track');
const { default: DogRaceScene, pixelRatioFor } = await import('./race-scene');
const round = (p = 0.4, id = 'fixture') => ({
  id,
  field: 8 as const,
  positions: Array.from({ length: 8 }, (_, i) => p - i * 0.004),
  order: null,
});
const props = {
  round: round(),
  running: true,
  reduced: false,
  synchronized: true,
  progressMode: 'shared' as const,
  quality: 'balanced' as const,
};
const frame = (time = 1000) =>
  act(() => vi.mocked(requestAnimationFrame).mock.calls.at(-1)![0](time));
const lastFrame = (world = worlds.at(-1)!) => world.update.mock.calls.at(-1)![0] as RaceFrame;
beforeEach(() => {
  state.fail = state.renderFail = false;
  renderers.length = worlds.length = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
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

it('passes published progress to the course unchanged and maps both finishes to the line', () => {
  const view = render(<DogRaceScene {...props} round={round(0.37)} />);
  frame();
  expect(lastFrame().laps).toEqual(round(0.37).positions);
  expect(lastFrame().running).toBe(true);
  view.unmount();
  render(<DogRaceScene {...props} round={round(1)} />);
  frame();
  expect(lastFrame().laps[0]).toBe(1);
  // Solo publishes 1.06 for its winner and keeps its own display scale.
  render(<DogRaceScene round={round(1.06)} running={false} reduced={false} />);
  frame(2000);
  expect(lastFrame().laps[0]).toBeCloseTo(1, 12);
  expect(trackPoint(lastFrame().laps[0]).x).toBeCloseTo(-48, 9);
});

it('never shows a solo runner beyond its latest published position', () => {
  const view = render(<DogRaceScene round={round(0.2)} running reduced={false} />);
  for (let i = 0; i < 6; i++) frame(1000 + i * 40);
  view.rerender(<DogRaceScene round={round(0.25)} running reduced={false} />);
  for (let i = 0; i < 80; i++) {
    frame(1300 + i * 40);
    lastFrame().laps.forEach((lap, k) =>
      expect(lap).toBeLessThanOrEqual(round(0.25).positions[k] / 1.06 + 1e-12)
    );
  }
});

it('forwards reduced motion and the stopped state, and restarts the course on a new round', () => {
  const view = render(<DogRaceScene {...props} reduced running={false} />);
  frame();
  expect(lastFrame()).toMatchObject({ reduced: true, running: false });
  view.rerender(<DogRaceScene {...props} round={round(0.5, 'next')} />);
  frame(2000);
  expect(worlds[0].reset).toHaveBeenCalledTimes(2);
});

it('shows published runner markers when WebGL cannot be constructed', () => {
  state.fail = true;
  const view = render(<DogRaceScene {...props} round={round(1)} />);
  expect(screen.getByText(/3D graphics unavailable/)).toBeVisible();
  expect(view.container.querySelector('svg g')!.getAttribute('transform')).toBe(
    `translate(-48 ${23 - 3.5 * 0.87})`
  );
  expect(worlds).toHaveLength(0);
});

it('contains draw failures and permits a rebuild through the existing quality control', () => {
  const view = render(<DogRaceScene {...props} />);
  state.renderFail = true;
  frame();
  expect(screen.getByText(/3D graphics unavailable/)).toBeVisible();
  state.renderFail = false;
  view.rerender(<DogRaceScene {...props} quality="low" />);
  frame(2000);
  expect(screen.queryByText(/3D graphics unavailable/)).not.toBeInTheDocument();
  expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
  expect(worlds[0].dispose).toHaveBeenCalledOnce();
});

it('falls back on graphics loss, rebuilds once on recovery and detaches old listeners', () => {
  const view = render(<DogRaceScene {...props} />);
  frame();
  const old = view.container.querySelector('canvas')!;
  fireEvent(old, new Event('webglcontextlost', { cancelable: true }));
  expect(screen.getByText(/3D graphics unavailable/)).toBeVisible();
  fireEvent(old, new Event('webglcontextrestored'));
  expect(screen.queryByText(/3D graphics unavailable/)).not.toBeInTheDocument();
  expect(renderers[0].dispose).toHaveBeenCalledOnce();
  expect(renderers[0].forceContextLoss).toHaveBeenCalledOnce();
  expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
  fireEvent(old, new Event('webglcontextrestored'));
  expect(renderers).toHaveLength(2);
  frame(3000);
  expect(renderers[1].render).toHaveBeenCalled();
  // Number chips come back with the rebuilt scene.
  expect(view.container.querySelectorAll('.hounds-scene-tags span')).toHaveLength(8);
});

it('releases every scene and context through repeated mount and unmount', () => {
  for (let i = 0; i < 3; i++) {
    const view = render(<DogRaceScene {...props} />);
    frame(1000);
    view.unmount();
    expect(view.container.querySelector('canvas')).toBeNull();
  }
  worlds.forEach((w) => expect(w.dispose).toHaveBeenCalledOnce());
  renderers.forEach((r) => {
    expect(r.dispose).toHaveBeenCalledOnce();
    expect(r.forceContextLoss).toHaveBeenCalledOnce();
  });
});

it('draws nothing while the page is hidden and slows to an idle rate when nothing moves', () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  render(<DogRaceScene {...props} running={false} round={round(1)} />);
  const calls = vi.mocked(requestAnimationFrame).mock.calls.length;
  expect(renderers[0].render).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(vi.mocked(requestAnimationFrame).mock.calls.length).toBeGreaterThan(calls);
  frame(1000);
  frame(1040);
  frame(1080);
  expect(renderers[0].render).toHaveBeenCalledTimes(1);
  frame(1110);
  expect(renderers[0].render).toHaveBeenCalledTimes(2);
});

it('labels each visible runner with a sharp number chip in its jacket colour', () => {
  const view = render(<DogRaceScene {...props} round={{ ...round(0.3), field: 6 }} />);
  frame();
  const chips = [...view.container.querySelectorAll<HTMLElement>('.hounds-scene-tags span')];
  expect(chips.map((c) => c.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  expect(view.container.querySelector('.hounds-scene-tags')!.getAttribute('aria-hidden')).toBe(
    'true'
  );
  expect(chips[0].style.background).toBe('rgb(216, 68, 72)');
  expect(chips.slice(6).every((c) => c.style.visibility === 'hidden')).toBe(true);
  expect(chips.slice(0, 6).some((c) => c.style.visibility === 'visible')).toBe(true);
});

it('spends a fixed pixel budget: sharp on small phones, capped on large screens', () => {
  expect(pixelRatioFor('balanced', 360, 215, 3)).toBeCloseTo(Math.sqrt(360000 / (360 * 215)), 9);
  expect(pixelRatioFor('balanced', 360, 215, 3)).toBeGreaterThan(2.1);
  expect(pixelRatioFor('balanced', 900, 460, 2)).toBe(1);
  expect(pixelRatioFor('balanced', 1400, 700, 2)).toBe(1);
  expect(pixelRatioFor('low', 1600, 900, 2)).toBe(0.75);
  expect(pixelRatioFor('high', 390, 255, 3)).toBe(2.5);
  render(<DogRaceScene {...props} />);
  expect(renderers[0].pixelRatio).toBe(1);
});

it.each([
  [900, 400],
  [330, 215],
])('keeps every chip of a bunched field inside a %ix%i view without overlaps', (w, h) => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(w);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(h);
  const bunched = {
    id: 'bunched',
    field: 8 as const,
    positions: Array.from({ length: 8 }, () => 0.21),
    order: null,
  };
  const view = render(<DogRaceScene {...props} round={bunched} />);
  for (let i = 0; i < 40; i++) frame(1000 + i * 40);
  const boxes = [...view.container.querySelectorAll<HTMLElement>('.hounds-scene-tags span')].map(
    (chip) => {
      const [x, y] = /translate3d\(([-\d.]+)px, ([-\d.]+)px/
        .exec(chip.style.transform)!
        .slice(1)
        .map(Number);
      return { x, y };
    }
  );
  expect(boxes).toHaveLength(8);
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(11);
    expect(b.x).toBeLessThanOrEqual(w - 11);
    expect(b.y - 20).toBeGreaterThanOrEqual(1.5);
    expect(b.y).toBeLessThanOrEqual(h);
  }
  for (let a = 0; a < 8; a++)
    for (let b = a + 1; b < 8; b++)
      expect(
        Math.abs(boxes[a].x - boxes[b].x) >= 20.5 || Math.abs(boxes[a].y - boxes[b].y) >= 18.5
      ).toBe(true);
});

it('in Automatic, lowers resolution from measured frame times, then reports overload once', () => {
  const onSlow = vi.fn();
  const view = render(<DogRaceScene {...props} adaptive onSlow={onSlow} />);
  const host = view.container.querySelector<HTMLElement>('.hounds-scene')!;
  expect(host.dataset.renderScale).toBe('1.00');
  let t = 1000;
  for (let i = 0; i < 60; i++) frame((t += 33.4));
  expect(host.dataset.renderScale).toBe('1.00');
  for (let i = 0; i < 160; i++) frame((t += 70));
  expect(Number(host.dataset.renderScale)).toBeLessThan(1);
  expect(renderers[0].pixelRatio).toBeCloseTo(Number(host.dataset.renderScale), 2);
  for (let i = 0; i < 300; i++) frame((t += 70));
  expect(host.dataset.renderScale).toBe('0.60');
  expect(onSlow).toHaveBeenCalled();
  // An explicit choice is respected: full resolution again and no further reports.
  onSlow.mockClear();
  view.rerender(<DogRaceScene {...props} adaptive={false} onSlow={onSlow} />);
  for (let i = 0; i < 300; i++) frame((t += 70));
  expect(host.dataset.renderScale).toBe('1.00');
  expect(onSlow).not.toHaveBeenCalled();
});

it('does not measure idle, reduced-motion or resumed frames as slowness', () => {
  const onSlow = vi.fn();
  const view = render(
    <DogRaceScene {...props} running={false} round={round(1)} adaptive onSlow={onSlow} />
  );
  let t = 1000;
  for (let i = 0; i < 400; i++) frame((t += 100));
  view.rerender(<DogRaceScene {...props} reduced adaptive onSlow={onSlow} />);
  for (let i = 0; i < 400; i++) frame((t += 100));
  expect(onSlow).not.toHaveBeenCalled();
  expect(view.container.querySelector<HTMLElement>('.hounds-scene')!.dataset.renderScale).toBe(
    '1.00'
  );
});

it('marks each number chip with the published lap it is drawn at', () => {
  const view = render(<DogRaceScene {...props} round={round(0.4321)} />);
  frame();
  const chips = [...view.container.querySelectorAll<HTMLElement>('.hounds-scene-tags span')];
  chips.forEach((chip, i) => expect(chip.dataset.lap).toBe((0.4321 - i * 0.004).toFixed(4)));
});
