import { useState, useEffect, useCallback } from 'react';

export type ToastActionElement = React.ReactElement;

export interface Toast {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
  variant?: 'default' | 'destructive';
}

// Module-level singleton: all components share one toast store so that
// `toast(...)` calls from any page reach the single <Toaster /> renderer.
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
  memoryToasts = [...memoryToasts, newToast];
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
