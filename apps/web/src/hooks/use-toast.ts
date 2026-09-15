import { useState, useEffect, useCallback } from 'react';

export type ToastActionElement = React.ReactElement;

export interface Toast {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
  variant?: 'default' | 'destructive';
  /**
   * Milliseconds before this toast auto-dismisses. Falls back to
   * `DEFAULT_TOAST_DURATION` (via `<ToastProvider>`'s own default) when
   * omitted OR when the value isn't a finite positive number at most
   * `MAX_TOAST_DURATION_MS` — `toast()` normalizes it before it ever
   * reaches this store, so a bad value (0, negative, `NaN`, `Infinity`,
   * or something past the browser's 32-bit timer limit) can't produce a
   * toast that closes instantly or never closes. The actual timer —
   * including pause-on-hover/keyboard-focus with resume-from-remaining
   * -time — is owned by Radix's `Toast.Root` (see components/ui/toast.tsx),
   * not by this store: this module only ever holds the *list* of toasts
   * that should currently be rendered.
   */
  duration?: number;
}

// Bounds the visible queue so a burst of events (join/finalize/reward
// cascades, etc.) can't cover the page. Enforced in `toast()` itself, by
// dropping the oldest entries — the dropped toast's <Toast> unmounts as a
// direct result, and Radix's own cleanup effect clears its internal
// auto-dismiss timer, so there is nothing here to separately track or
// clean up.
export const TOAST_LIMIT = 3;
// Within the "5-8 seconds" accessible range this hook's callers expect.
export const DEFAULT_TOAST_DURATION = 6000;

// The largest delay `window.setTimeout` honors reliably. Browsers store the
// delay in a 32-bit signed int internally; anything above this overflows
// and the timer fires almost immediately instead of respecting the
// requested delay — the opposite of what a caller passing a huge duration
// would want.
const MAX_TOAST_DURATION_MS = 2_147_483_647;

// `duration` reaches here as whatever a call site passed in — Radix's own
// `durationProp || context.duration` fallback only catches falsy values
// (0, NaN), not a negative number, `Infinity`, or something past
// `MAX_TOAST_DURATION_MS`, all of which would otherwise either dismiss the
// toast almost instantly or never dismiss it at all. Normalizing here,
// once, means `toaster.tsx` can pass whatever's stored straight through
// and get the provider's own default for anything invalid.
function normalizeDuration(duration: number | undefined): number | undefined {
  if (duration === undefined) return undefined;
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_TOAST_DURATION_MS) {
    return undefined;
  }
  return duration;
}

// Module-level singleton: all components share one toast store so that
// `toast(...)` calls from any page reach the single <Toaster /> renderer.
// `listeners` is a Set (not an array), so React 18 Strict Mode's
// mount→unmount→mount effect replay (and any accidental repeat
// subscription from multiple `useToast()` callers) can never register the
// same setState function twice.
type Listener = (toasts: Toast[]) => void;
const listeners: Set<Listener> = new Set();
let memoryToasts: Toast[] = [];

function emit() {
  for (const l of listeners) l(memoryToasts);
}

let toastId = 0;

export function toast(props: Omit<Toast, 'id'>) {
  const id = String(++toastId);
  const newToast: Toast = { ...props, id, duration: normalizeDuration(props.duration) };
  // Keep only the newest TOAST_LIMIT toasts, oldest-first dropped.
  memoryToasts = [...memoryToasts, newToast].slice(-TOAST_LIMIT);
  emit();
  return {
    id,
    dismiss: () => dismissToast(id),
  };
}

export function dismissToast(id: string) {
  memoryToasts = memoryToasts.filter((t) => t.id !== id);
  emit();
}

/**
 * Test-only: the number of components currently subscribed to store
 * updates. Not part of the public hook API — it exists so a test can
 * directly prove that unmounting removes a subscriber, rather than only
 * checking that a stale `toast()` call doesn't throw (React 18 doesn't
 * warn on a stale setState from an unmounted function component either
 * way, so that alone proves nothing about whether cleanup ran).
 */
export function __getListenerCountForTests(): number {
  return listeners.size;
}

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>(memoryToasts);

  useEffect(() => {
    listeners.add(setToasts);
    setToasts(memoryToasts);
    return () => {
      listeners.delete(setToasts);
    };
  }, []);

  const dismiss = useCallback((id: string) => dismissToast(id), []);

  return {
    toasts,
    toast,
    dismiss,
  };
}
