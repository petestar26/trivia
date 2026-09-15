import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';
import { DEFAULT_TOAST_DURATION, useToast } from '@/hooks/use-toast';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';

/**
 * Radix keeps its "is close paused" flag as a ref created once, inside
 * `<ToastProvider>` itself (`const isClosePausedRef = React.useRef(false)`),
 * and only ever clears it from the viewport's own pointerleave/focusout
 * /window-focus handlers — which are attached only while it has toasts to
 * show. The toast's close button is invisible until hovered/focused, so a
 * mouse or keyboard user closing the LAST toast necessarily pauses the
 * viewport first; the moment that toast is removed, those resume handlers
 * are torn down before the pointerleave/blur that was about to fire them
 * can do so, leaving the flag stuck `true`. Every subsequently-added toast
 * then skips `startTimer` (`if (open && !context.isClosePausedRef.current)`)
 * and never auto-dismisses until an unrelated hover or window-focus cycle
 * happens to flip the flag back.
 *
 * The fix: force a fresh `<ToastProvider>` — and therefore a fresh,
 * never-paused ref — whenever a new toast session starts after the queue
 * was genuinely empty. Bumping `sessionKey` only happens on a wasEmpty →
 * !isEmpty transition (never mid-session, never twice for one transition —
 * see the note below on why this is Strict-Mode safe), so it can't
 * duplicate an in-flight timer or announcement: there is nothing mounted
 * under the old provider for it to duplicate.
 */
function useToastSession(isEmpty: boolean, viewportRef: RefObject<HTMLOListElement | null>) {
  const [wasEmpty, setWasEmpty] = useState(true);
  const [sessionKey, setSessionKey] = useState(0);
  const restoreFocusRef = useRef(false);

  // Calling setState directly in the render body (rather than an effect)
  // is React's own documented pattern for "adjust state when a prop
  // changes": if this branch runs, React immediately re-renders this
  // component with the updated state before doing anything else, so by
  // the time (in dev) Strict Mode's duplicate render pass happens,
  // `wasEmpty === isEmpty` already holds and the branch is a no-op —
  // the transition, and the focus check below, only ever happen once.
  if (isEmpty !== wasEmpty) {
    setWasEmpty(isEmpty);
    if (wasEmpty && !isEmpty) {
      // Reading `document.activeElement` only happens on this exact
      // transition — never for an ordinary toast add within a session
      // that already has one, and never during module load or SSR.
      if (typeof document !== 'undefined' && viewportRef.current?.contains(document.activeElement)) {
        restoreFocusRef.current = true;
      }
      setSessionKey((key) => key + 1);
    }
  }

  return { sessionKey, restoreFocusRef };
}

/**
 * Wraps a single rendered `<Toast>` so that if it's removed from under
 * currently-focused content, focus lands on the viewport instead of
 * falling through to `<body>`.
 *
 * Ordinary user-driven dismissal (close button, Escape, swipe) already
 * moves focus to the viewport *before* removal — synchronously, inside
 * Radix's own `handleClose` — so by the time this wrapper's cleanup runs
 * for that path, focus has already left the toast and this is a no-op.
 * It only does real work for the two paths that bypass `handleClose`
 * entirely, because they remove a toast directly from the store's array
 * rather than through Radix's close flow: a programmatic `dismiss(id)` /
 * the handle `toast()` returns, and silent eviction when a fourth toast
 * pushes the oldest out of the TOAST_LIMIT-bounded queue.
 */
function FocusSafeToast({
  viewportRef,
  children,
  ...toastProps
}: ComponentProps<typeof Toast> & {
  viewportRef: RefObject<HTMLOListElement | null>;
  children?: ReactNode;
}) {
  const nodeRef = useRef<HTMLLIElement | null>(null);

  useLayoutEffect(() => {
    // A layout-effect cleanup for a fiber being unmounted runs while its
    // DOM node is still attached — before React detaches it — so reading
    // both refs fresh, right here inside the cleanup rather than captured
    // earlier in the effect body, is what correctly reflects state right
    // up to the moment this toast is actually removed (capturing either
    // one early was tried and measurably wrong: it missed a real
    // eviction case in testing, since this toast can be added, focused,
    // and evicted all without this effect ever re-running in between —
    // deps stay `[]` on purpose, so "early" and "at unmount" are not the
    // same moment here).
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately fresh read, see comment above
      const node = nodeRef.current;
      if (typeof document !== 'undefined' && node?.contains(document.activeElement)) {
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately fresh read, see comment above
        viewportRef.current?.focus();
      }
    };
    // `viewportRef` is a stable ref object from the parent (its identity
    // never changes), so listing it here doesn't change how often this
    // effect runs — it only satisfies the "value from outside the effect"
    // check for the one place above that isn't a ref read.
  }, [viewportRef]);

  return (
    <Toast ref={nodeRef} {...toastProps}>
      {children}
    </Toast>
  );
}

export function Toaster() {
  const { toasts, dismiss } = useToast();
  const isEmpty = toasts.length === 0;

  // The <ol> Radix forwards ToastViewport's ref to. Used both to restore
  // focus after a session remount and to redirect focus away from a toast
  // that's about to be removed from under the active element — the same
  // "move focus to the viewport first" strategy Radix's own close
  // button/Escape/swipe already use internally.
  const viewportRef = useRef<HTMLOListElement | null>(null);
  const { sessionKey, restoreFocusRef } = useToastSession(isEmpty, viewportRef);

  useLayoutEffect(() => {
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      viewportRef.current?.focus();
    }
    // Only re-run when a remount actually just happened (or on mount) —
    // not on every ordinary toast add/remove within a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  return (
    <ToastProvider key={sessionKey} duration={DEFAULT_TOAST_DURATION}>
      {toasts.map(({ id, title, description, action, variant, duration, ...props }) => (
        <FocusSafeToast
          key={id}
          viewportRef={viewportRef}
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
          onOpenChange={(open: boolean) => {
            if (!open) dismiss(id);
          }}
          {...props}
        >
          <div className="grid gap-1">
            {title && <ToastTitle>{title}</ToastTitle>}
            {/* Radix's hidden announcer flattens this toast's own text
                nodes with no separator of its own — without something
                here, "Group created" + "Everyone can join now." reads as
                one run-on word ("createdEveryone"). This span is
                screen-reader-only (not `hidden`/`aria-hidden`/`display:
                none`, all of which the announcer explicitly skips) so it
                joins the announced text without changing anything
                visible. */}
            {title && description && <span className="sr-only">. </span>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          {action}
          <ToastClose />
        </FocusSafeToast>
      ))}
      <ToastViewport ref={viewportRef} />
    </ToastProvider>
  );
}
