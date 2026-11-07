import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EngineOptions } from '@/components/football/engine/engine';
import { FootballPreview } from './football-preview';

const f = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/components/football/engine/engine', () => ({ createEngine: f.create }));
let enter: IntersectionObserverCallback;
let clock = 100;
let reduced = false;
let hidden = false;
let motionChange: () => void;
let options: EngineOptions;
let scene: ReturnType<typeof makeScene>;
function makeScene() {
  return { setMatch: vi.fn(), start: vi.fn(), stop: vi.fn(), dispose: vi.fn() };
}
function visible(value: boolean) {
  act(() =>
    enter([{ isIntersecting: value } as IntersectionObserverEntry], {} as IntersectionObserver)
  );
}
beforeEach(() => {
  clock = 100;
  reduced = hidden = false;
  scene = makeScene();
  f.create.mockImplementation((input: EngineOptions) => {
    options = input;
    return scene;
  });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.mocked(window.matchMedia).mockImplementation(
    (query) =>
      ({
        matches: query.includes('reduced-motion') && reduced,
        media: query,
        addEventListener: vi.fn((_event, listener) => {
          motionChange = listener;
        }),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        enter = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  f.create.mockReset();
});

it('loads one isolated decorative scene only when visible and disposes it on leave', async () => {
  const view = render(<FootballPreview />);
  expect(f.create).not.toHaveBeenCalled();
  visible(true);
  await waitFor(() => expect(scene.start).toHaveBeenCalledOnce());
  expect(scene.setMatch).toHaveBeenCalledWith({
    matchKey: 'salem-sports-football-preview-v1',
    homeClub: 1,
    awayClub: 2,
    goals: [],
    fullTime: null,
  });
  expect(options.maxFps).toBe(30);
  view.unmount();
  expect(scene.dispose).toHaveBeenCalledOnce();
});

it('stops offscreen and in a hidden tab, without fast-forwarding when it becomes visible', async () => {
  render(<FootballPreview />);
  visible(true);
  await waitFor(() => expect(scene.start).toHaveBeenCalledOnce());
  clock = 1100;
  visible(false);
  const held = options.getElapsed();
  clock = 61_100;
  expect(options.getElapsed()).toBe(held);
  visible(true);
  expect(f.create).toHaveBeenCalledOnce();
  expect(scene.start).toHaveBeenCalledTimes(2);
  hidden = true;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(scene.stop).toHaveBeenCalled();
  clock = 99_000;
  expect(options.getElapsed()).toBe(held);
});

it('starts with a still image for reduced motion and supports an explicit play/pause choice', async () => {
  reduced = true;
  render(<FootballPreview />);
  visible(true);
  expect(f.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Resume animation' }));
  await waitFor(() => expect(scene.start).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Pause animation' }));
  expect(scene.stop).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Resume animation' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  act(() => motionChange());
  expect(f.create).toHaveBeenCalledOnce();
});

it('falls back without a retry loop after a graphics failure and allows a manual retry', async () => {
  render(<FootballPreview />);
  visible(true);
  await waitFor(() => expect(scene.start).toHaveBeenCalledOnce());
  act(() => options.onContextLost?.());
  expect(scene.dispose).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  visible(false);
  visible(true);
  expect(f.create).toHaveBeenCalledOnce();
  scene = makeScene();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(f.create).toHaveBeenCalledTimes(2));
  expect(scene.start).toHaveBeenCalledOnce();
});

it('contains an unavailable renderer and retains the still artwork', async () => {
  f.create.mockImplementation(() => {
    throw new Error('No WebGL');
  });
  const { container } = render(<FootballPreview />);
  visible(true);
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
  expect(container.querySelector('img')).toHaveAttribute(
    'src',
    '/art/ruby-grand/football-stadium.webp'
  );
  expect(container.querySelector('.sports-football')).toHaveAttribute('data-state', 'still');
});
