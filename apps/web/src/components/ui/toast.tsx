import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactElement } from 'react';
import * as ToastPrimitives from '@radix-ui/react-toast';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

// Everything below is a thin styling/typing wrapper around the real
// `@radix-ui/react-toast` primitives (already a project dependency, no new
// one added). Radix owns the parts that are hard to get right by hand:
//   - Each <Toast> is portaled into <ToastViewport>'s own DOM node
//     (ToastImpl renders via `ReactDOM.createPortal(..., context.viewport)`),
//     so rendered toasts are genuine DOM *descendants* of the viewport, not
//     siblings positioned to merely look that way.
//   - A visually-hidden, single `role="status"` announcer (decoupled from
//     the visible toast, which itself carries no role/aria-live) renders
//     the toast's combined title+description text as one atomic update —
//     `aria-live="assertive"` when `type="foreground"`, `"polite"` when
//     `type="background"` — with no separate live region on the visible
//     element to double-announce.
//   - Per-toast auto-dismiss `duration`, with hover/keyboard-focus pausing
//     the whole viewport's timers and resuming from the remaining time
//     (not restarting), plus Escape-to-close and swipe-to-dismiss.
//   - Mounting a toast never moves keyboard focus.
const ToastProvider = ToastPrimitives.Provider;

const ToastViewport = forwardRef<
  ElementRef<typeof ToastPrimitives.Viewport>,
  ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Viewport
    ref={ref}
    className={cn(
      // pointer-events-none on the viewport (it has no visible content of
      // its own outside its toasts) keeps it from intercepting clicks over
      // the page in the gaps around/between toasts; toastVariants below
      // re-enables pointer-events-auto on each individual toast.
      'pointer-events-none fixed top-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col md:max-w-[420px]',
      className
    )}
    {...props}
  />
));
ToastViewport.displayName = ToastPrimitives.Viewport.displayName;

const toastVariants = cva(
  'group pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-md border p-6 pr-8 shadow-lg transition-all data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-top-full data-[state=open]:sm:slide-in-from-bottom-full',
  {
    variants: {
      variant: {
        default: 'border bg-background text-foreground',
        destructive: 'destructive group border-red-500 bg-red-50 text-red-900 dark:bg-red-900 dark:text-red-50',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

const Toast = forwardRef<
  ElementRef<typeof ToastPrimitives.Root>,
  ComponentPropsWithoutRef<typeof ToastPrimitives.Root> & VariantProps<typeof toastVariants>
>(({ className, variant, ...props }, ref) => {
  return (
    <ToastPrimitives.Root
      ref={ref}
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  );
});
Toast.displayName = ToastPrimitives.Root.displayName;

const ToastAction = forwardRef<
  ElementRef<typeof ToastPrimitives.Action>,
  ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Action
    ref={ref}
    type="button"
    className={cn(
      'inline-flex h-8 shrink-0 items-center justify-center rounded-md border bg-transparent px-3 text-sm font-medium ring-offset-background transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-red-400 group-[.destructive]:hover:border-red-300 group-[.destructive]:hover:bg-red-50 group-[.destructive]:focus:ring-red-400 group-[.destructive]:focus:ring-offset-red-600',
      className
    )}
    {...props}
  />
));
ToastAction.displayName = ToastPrimitives.Action.displayName;

const ToastClose = forwardRef<
  ElementRef<typeof ToastPrimitives.Close>,
  ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, 'aria-label': ariaLabel, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    type="button"
    aria-label={ariaLabel ?? 'Dismiss notification'}
    className={cn(
      'absolute right-2 top-2 rounded-md p-1 text-foreground/50 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 group-hover:opacity-100 group-[.destructive]:text-red-300 group-[.destructive]:hover:text-red-50 group-[.destructive]:focus:ring-red-400 group-[.destructive]:focus:ring-offset-red-600',
      className
    )}
    {...props}
  >
    <X className="h-4 w-4" aria-hidden="true" />
  </ToastPrimitives.Close>
));
ToastClose.displayName = ToastPrimitives.Close.displayName;

const ToastTitle = forwardRef<
  ElementRef<typeof ToastPrimitives.Title>,
  ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Title ref={ref} className={cn('text-sm font-semibold', className)} {...props} />
));
ToastTitle.displayName = ToastPrimitives.Title.displayName;

const ToastDescription = forwardRef<
  ElementRef<typeof ToastPrimitives.Description>,
  ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description ref={ref} className={cn('text-sm opacity-90', className)} {...props} />
));
ToastDescription.displayName = ToastPrimitives.Description.displayName;

type ToastProps = ComponentPropsWithoutRef<typeof Toast>;
type ToastActionElement = ReactElement<typeof ToastAction>;
type ToastCloseProps = ComponentPropsWithoutRef<typeof ToastClose>;
type ToastTitleProps = ComponentPropsWithoutRef<typeof ToastTitle>;
type ToastDescriptionProps = ComponentPropsWithoutRef<typeof ToastDescription>;
type ToastActionProps = ComponentPropsWithoutRef<typeof ToastAction>;

export {
  type ToastProps,
  type ToastActionElement,
  type ToastActionProps,
  type ToastCloseProps,
  type ToastTitleProps,
  type ToastDescriptionProps,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
};
