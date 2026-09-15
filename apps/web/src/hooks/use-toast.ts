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
   * omitted. The actual timer — including pause-on-hover/keyboard-focus
   * with resume-from-remaining-time — is owned by Radix's `Toast.Root`
   * (see components/ui/toast.tsx), not by this store: this module only
   * ever holds the *list* of toasts that should currently be rendered.
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
  const newToast: Toast = { ...props, id };
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
