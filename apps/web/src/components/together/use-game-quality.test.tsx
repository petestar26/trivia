import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useGameQuality } from './use-game-quality';

beforeEach(() => {
  const saved = new Map<string, string>();
  vi.spyOn(localStorage, 'getItem').mockImplementation((key) => saved.get(key) ?? null);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    saved.set(key, value);
  });
  vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
    saved.delete(key);
  });
});

afterEach(() => {
  cleanup();
  localStorage.removeItem('salem-game-quality');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('adapts to sustained slow frames after a fast loading period', () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let next: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    next = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const { result } = renderHook(() => useGameQuality(false));
  let now = 1;
  const tick = (ms: number) =>
    act(() => {
      now += ms;
      const frame = next;
      next = undefined;
      frame?.(now);
    });
  for (let i = 0; i < 125; i++) tick(16);
  expect(result.current.tier).toBe('balanced');
  for (let i = 0; i < 20; i++) tick(333);
  expect(result.current.tier).toBe('low');
});

it('does not replace the rich scene merely because a device reports few CPU cores', () => {
  vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(1);
  const { result } = renderHook(() => useGameQuality(false));
  expect(result.current.quality).toBe('auto');
  expect(result.current.tier).toBe('balanced');
});

it('honors and persists the player’s explicit graphics choice across a remount', () => {
  const first = renderHook(() => useGameQuality(false));
  act(() => first.result.current.choose('low'));
  expect(first.result.current.tier).toBe('low');
  first.unmount();
  const second = renderHook(() => useGameQuality(false));
  expect(second.result.current.quality).toBe('low');
  act(() => second.result.current.choose('high'));
  expect(second.result.current.tier).toBe('high');
});

it('uses the accessible light presentation when reduced motion is requested', () => {
  localStorage.setItem('salem-game-quality', 'high');
  const { result } = renderHook(() => useGameQuality(true));
  expect(result.current.tier).toBe('low');
});
