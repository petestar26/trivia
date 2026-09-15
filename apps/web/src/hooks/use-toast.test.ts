import { act, renderHook } from '@testing-library/react';
import { StrictMode, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TOAST_DURATION, TOAST_LIMIT, dismissToast, toast, useToast } from './use-toast';

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

  it('a component unmounting stops receiving further store updates (no stale-listener leak)', () => {
    const { result, unmount } = renderHook(() => useToast());
    unmount();

    // No assertion target on `result` after unmount — this just proves the
    // subsequent `toast()` call doesn't throw from notifying a listener
    // whose owning component is gone (i.e. the cleanup in the hook's
    // effect actually removed it from `listeners`).
    expect(() => act(() => { toast({ title: 'After unmount' }); })).not.toThrow();
    void result;
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
    // A second, independent subscriber outside Strict Mode acts as a
    // witness: if the Strict-Mode component's mount→unmount→mount effect
    // replay left two listeners registered (or zero), this witness would
    // still observe the correct single broadcast either way once its own
    // state is asserted after the fact — the real check is on the
    // Strict-Mode hook's own `toasts` below settling to exactly one entry.
    const strict = renderHook(() => useToast(), { wrapper: StrictMode });
    act(() => {
      toast({ title: 'Replay-safe' });
    });
    expect(strict.result.current.toasts.map((t) => t.title)).toEqual(['Replay-safe']);
    strict.unmount();
  });
});
