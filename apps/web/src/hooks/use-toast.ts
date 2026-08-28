import { useState, useCallback } from 'react';

export type ToastActionElement = React.ReactElement;

export interface Toast {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
  variant?: 'default' | 'destructive';
}

interface ToastState {
  toasts: Toast[];
}

const initialState: ToastState = { toasts: [] };

export function useToast() {
  const [state, setState] = useState<ToastState>(initialState);

  const toast = useCallback((props: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).substring(2, 9);
    const newToast = { ...props, id };
    setState((prev) => ({ toasts: [...prev.toasts, newToast] }));
    return { id, dismiss: () => dismiss(id) };
  }, []);

  const dismiss = useCallback((id: string) => {
    setState((prev) => ({ toasts: prev.toasts.filter((t) => t.id !== id) }));
  }, []);

  return { ...state, toast, dismiss };
}