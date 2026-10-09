import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

const perf = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The only time source for selection windows and match clocks. It is the server's clock
 * (carried by every snapshot) advanced by this browser's monotonic timer. The browser's
 * wall clock is never consulted, so a wrong system date cannot open or close anything.
 */
export interface ServerClock {
  /** Records a snapshot's server time, compensating half of the request round trip. */
  sync(serverTime: number, requestStartedAt: number, responseReceivedAt: number): void;
  /** Server milliseconds now, or null before the first snapshot. */
  now(): number | null;
  /** Milliseconds since the last confirmed snapshot; Infinity if none or after invalidate(). */
  age(): number;
  /** The monotonic timer may have stalled (sleep, tab freeze): trust nothing until resynced. */
  invalidate(): void;
  subscribe(listener: () => void): () => void;
}

export function createServerClock(clockSource: () => number = perf): ServerClock {
  let base: { serverTime: number; at: number } | null = null;
  let lastSync = -Infinity;
  let invalid = false;
  const listeners = new Set<() => void>();
  return {
    sync(serverTime, start, end) {
      const candidate = { serverTime: serverTime + Math.max(0, end - start) / 2, at: end };
      // Never let the clock run backwards because of one slow response.
      const current = base ? base.serverTime + (clockSource() - base.at) : -Infinity;
      const projected = candidate.serverTime + (clockSource() - candidate.at);
      // After invalidate() the old base cannot be trusted at all, so the new one always wins.
      base = invalid || projected >= current ? candidate : base;
      lastSync = end;
      invalid = false;
      listeners.forEach((l) => l());
    },
    now: () => (base ? base.serverTime + (clockSource() - base.at) : null),
    age: () => (invalid ? Infinity : clockSource() - lastSync),
    invalidate() {
      invalid = true;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const ClockContext = createContext<ServerClock | null>(null);
export function ServerClockProvider({
  clock,
  children,
}: {
  clock: ServerClock;
  children: ReactNode;
}) {
  return createElement(ClockContext.Provider, { value: clock }, children);
}
export function useServerClock(): ServerClock {
  const clock = useContext(ClockContext);
  if (!clock) throw new Error('ServerClockProvider is missing');
  return clock;
}

/**
 * Server time quantised to `quantumMs`, so a component only re-renders when its own display
 * could change. A pure timer re-render is driven by an interval that is paused when hidden.
 */
export function useServerNow(quantumMs = 250): number | null {
  const clock = useServerClock();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribe = clock.subscribe(onChange);
      const id = window.setInterval(
        () => {
          if (!document.hidden) onChange();
        },
        Math.max(50, quantumMs / 2)
      );
      return () => {
        unsubscribe();
        window.clearInterval(id);
      };
    },
    [clock, quantumMs]
  );
  const get = useCallback(() => {
    const now = clock.now();
    return now === null ? -1 : Math.floor(now / quantumMs) * quantumMs;
  }, [clock, quantumMs]);
  const value = useSyncExternalStore(subscribe, get, get);
  return value < 0 ? null : value;
}
