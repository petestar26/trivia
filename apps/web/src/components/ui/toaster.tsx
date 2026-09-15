import { DEFAULT_TOAST_DURATION, useToast } from '@/hooks/use-toast';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';

export function Toaster() {
  const { toasts, dismiss } = useToast();

  return (
    <ToastProvider duration={DEFAULT_TOAST_DURATION}>
      {toasts.map(({ id, title, description, action, variant, duration, ...props }) => (
        <Toast
          key={id}
          variant={variant}
          duration={duration}
          // Default/success notifications are announced politely;
          // destructive/error ones assertively — see toast.tsx for how
          // this maps to the hidden announcer's aria-live value.
          type={variant === 'destructive' ? 'foreground' : 'background'}
          // Controlled, and always `true`: only entries still in `toasts`
          // ever render at all, so a rendered <Toast> is by definition
          // still "open". This is what makes `onOpenChange` below the SOLE
          // path back to a closed toast — Radix's own Presence has no
          // independent way to hide a controlled-open toast, so an auto
          // -dismiss timeout, Escape, swipe, or the close button all funnel
          // through the same `dismiss(id)` call rather than Radix silently
          // hiding it while this store's own state went stale.
          open
          onOpenChange={(open) => {
            if (!open) dismiss(id);
          }}
          {...props}
        >
          <div className="grid gap-1">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          {action}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
