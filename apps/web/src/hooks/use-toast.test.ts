import { act, renderHook } from '@testing-library/react';
import { StrictMode, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TOAST_DURATION,
  TOAST_LIMIT,
  __getListenerCountForTests,
  dismissToast,
  toast,
  useToast,
} from './use-toast';

/**
 * Drains the module-level store back to empty after every test, so tests
 * are deterministic and order-independent — `memoryToasts`/`toastId` are a
 * singleton shared across the whole process, not reset automatically
 * between tests the way component state would be.
 */
afterEach(() => {
  const { result, unmount } = renderHook(() => useToast());
  act(() => {
    result.current.toasts.forEach((t) => dismissToast(t.id));
  });
  unmount();
});

describe('use-toast store', () => {
  it('toast() adds a toast and returns a matching id + working dismiss()', () => {
    const { result } = renderHook(() => useToast());

    let handle!: { id: string; dismiss: () => void };
    act(() => {
      handle = toast({ title: 'Group created' });
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]).toMatchObject({ id: handle.id, title: 'Group created' });

    act(() => handle.dismiss());
    expect(result.current.toasts).toHaveLength(0);
  });

  it('preserves optional title, description, action, and variant', () => {
    const { result } = renderHook(() => useToast());
    const action = createElement('button', null, 'Retry');

    act(() => {
      toast({
        title: 'Reward claimed',
        description: 'You earned 50 GP.',
        variant: 'destructive',
        action,
      });
    });

    expect(result.current.toasts[0]).toMatchObject({
      title: 'Reward claimed',
      description: 'You earned 50 GP.',
      variant: 'destructive',
      action,
    });
  });

  it('bounds the queue to TOAST_LIMIT, dropping the oldest first', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      toast({ title: 'First' });
      toast({ title: 'Second' });
      toast({ title: 'Third' });
      toast({ title: 'Fourth' });
    });

    expect(TOAST_LIMIT).toBe(3);
    expect(result.current.toasts).toHaveLength(3);
    expect(result.current.toasts.map((t) => t.title)).toEqual(['Second', 'Third', 'Fourth']);
  });

  it('DEFAULT_TOAST_DURATION sits within the 5-8 second accessible range', () => {
    expect(DEFAULT_TOAST_DURATION).toBeGreaterThanOrEqual(5000);
    expect(DEFAULT_TOAST_DURATION).toBeLessThanOrEqual(8000);
  });

  describe('duration normalization', () => {
    // `toast()` normalizes `duration` before it's ever stored, so a bad
    // value can't reach <ToastProvider> and produce a toast that closes
    // almost instantly (a truthy-but-tiny or negative delay, or a delay
    // past the browser's 32-bit setTimeout limit) or never closes
    // (`Infinity`). Normalizing to `undefined` here — rather than baking
    // in DEFAULT_TOAST_DURATION directly — lets Radix's own
    // `durationProp || context.duration` fallback do the rest, so there's
    // one source of truth for what "the default" actually is.
    const MAX_TOAST_DURATION_MS = 2_147_483_647;

    it('keeps a valid custom duration unchanged', () => {
      const { result } = renderHook(() => useToast());
      act(() => { toast({ title: 'Valid', duration: 3000 }); });
      expect(result.current.toasts[0].duration).toBe(3000);
    });

    it('keeps the maximum safe duration unchanged', () => {
      const { result } = renderHook(() => useToast());
      act(() => { toast({ title: 'Max', duration: MAX_TOAST_DURATION_MS }); });
      expect(result.current.toasts[0].duration).toBe(MAX_TOAST_DURATION_MS);
    });

    it('normalizes an omitted duration to undefined', () => {
      const { result } = renderHook(() => useToast());
      act(() => { toast({ title: 'Omitted' }); });
      expect(result.current.toasts[0].duration).toBeUndefined();
    });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['one past the safe maximum', MAX_TOAST_DURATION_MS + 1],
      ['far past the safe maximum', 3_000_000_000],
    ])('normalizes %s to undefined (falls back to the default)', (_label, duration) => {
      const { result } = renderHook(() => useToast());
      act(() => { toast({ title: 'Invalid', duration }); });
      expect(result.current.toasts[0].duration).toBeUndefined();
    });
  });

  it('dismissToast(id) removes only the targeted toast', () => {
    const { result } = renderHook(() => useToast());
    let first!: { id: string };
    act(() => {
      first = toast({ title: 'Stays' });
      toast({ title: 'Goes' });
    });
    const goesId = result.current.toasts[1].id;

    act(() => dismissToast(goesId));

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].id).toBe(first.id);
    expect(result.current.toasts[0].title).toBe('Stays');
  });

  it('unmounting a subscriber actually removes it from the store (no orphaned listener)', () => {
    // `toast()` not throwing after unmount proves nothing on its own —
    // React 18 doesn't warn on a stale setState from an unmounted
    // function component either way, so a leaked listener would be
    // silently invisible to that kind of check. Assert the store's own
    // subscriber count directly instead.
    const before = __getListenerCountForTests();
    const { unmount } = renderHook(() => useToast());
    expect(__getListenerCountForTests()).toBe(before + 1);

    unmount();
    expect(__getListenerCountForTests()).toBe(before);

    expect(() => act(() => { toast({ title: 'After unmount' }); })).not.toThrow();
  });

  it('multiple simultaneous useToast() subscribers stay in sync with a single shared store', () => {
    const a = renderHook(() => useToast());
    const b = renderHook(() => useToast());

    act(() => {
      toast({ title: 'Broadcast' });
    });

    expect(a.result.current.toasts).toHaveLength(1);
    expect(b.result.current.toasts).toHaveLength(1);
    expect(a.result.current.toasts[0].id).toBe(b.result.current.toasts[0].id);

    const id = a.result.current.toasts[0].id;
    act(() => a.result.current.dismiss(id));

    // Dismissing from one subscriber's `dismiss` (both point at the same
    // module-level `dismissToast`) is reflected in the other subscriber too.
    expect(a.result.current.toasts).toHaveLength(0);
    expect(b.result.current.toasts).toHaveLength(0);

    a.unmount();
    b.unmount();
  });

  it('React Strict Mode does not duplicate a toast or double-count the queue', () => {
    const { result } = renderHook(() => useToast(), { wrapper: StrictMode });

    act(() => {
      toast({ title: 'Once' });
    });

    // Under Strict Mode, effects replay mount→cleanup→mount in dev; if
    // `listeners` were an array instead of a Set, or `toast()` itself were
    // ever invoked per-listener instead of once, this would show up as a
    // length > 1 here despite only one call above.
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].title).toBe('Once');
  });

  it('React Strict Mode subscribe/unsubscribe replay leaves exactly one live listener behind', () => {
    // Strict Mode replays this hook's subscribe effect (mount → cleanup →
    // mount) in dev. Assert the store's actual subscriber count directly
    // through the replay — +1 while mounted, however many times the
    // effect replayed, and back to the baseline after unmount — rather
    // than only inferring it indirectly from toasts array contents, which
    // would look identical whether the replay left one listener or two.
    const before = __getListenerCountForTests();
    const strict = renderHook(() => useToast(), { wrapper: StrictMode });
    expect(__getListenerCountForTests()).toBe(before + 1);

    act(() => {
      toast({ title: 'Replay-safe' });
    });
    expect(strict.result.current.toasts.map((t) => t.title)).toEqual(['Replay-safe']);

    strict.unmount();
    expect(__getListenerCountForTests()).toBe(before);
  });
});
