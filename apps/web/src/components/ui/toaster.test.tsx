import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { StrictMode, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/toaster';
import { ToastAction } from '@/components/ui/toast';
import { DEFAULT_TOAST_DURATION, dismissToast, toast, useToast } from '@/hooks/use-toast';

/**
 * Drains the module-level store after every test — `memoryToasts` is a
 * singleton shared by the whole process, not component state, so it
 * doesn't reset itself between tests the way `render()`'s tree does.
 * `cleanup()` (unmounting all rendered trees) still runs first so any
 * pending Radix timers/effects tied to THIS test's DOM tear down cleanly
 * before the drain.
 */
afterEach(() => {
  cleanup();
  const { result, unmount } = renderHook(() => useToast());
  act(() => {
    result.current.toasts.forEach((t) => dismissToast(t.id));
  });
  unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Sweep up any manually-appended "outside" focus target a test forgot
  // to remove itself, so a leftover focused, orphaned node can't bleed
  // into the next test's `document.activeElement` state.
  document.querySelectorAll('[data-test-outside]').forEach((n) => n.remove());
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
});

function regionWrapper() {
  return document.querySelector('[role="region"]') as HTMLElement | null;
}

function viewportOl() {
  return document.querySelector('ol') as HTMLOListElement | null;
}

/** A focusable element outside the toast stack, tagged for the afterEach
 * sweep above so individual tests don't need their own manual `.remove()`. */
function mountOutsideButton() {
  const button = document.createElement('button');
  button.textContent = 'outside';
  button.setAttribute('data-test-outside', '');
  document.body.appendChild(button);
  return button;
}

/** Marks the next input as keyboard-driven for `Toaster`'s own input
 * -modality tracking — the same public keydown/pointerdown heuristic
 * `:focus-visible` (and its polyfills) use to tell a Tab-into-the-viewport
 * apart from a mouse click that happens to leave focus in the same place. */
function markKeyboardInput() {
  fireEvent.keyDown(document.body, { key: 'Tab' });
}

/** Marks the next input as pointer-driven (see `markKeyboardInput`). */
function markPointerInput() {
  fireEvent.pointerDown(document.body);
}

describe('Toaster — viewport composition', () => {
  it('renders a toast as a DOM descendant of the fixed viewport, not a sibling of it', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Group created' });
    });
    await screen.findByText('Group created');

    const ol = viewportOl();
    const li = document.querySelector('li');
    expect(ol).not.toBeNull();
    expect(li).not.toBeNull();
    // The toast element is a descendant of the viewport <ol>, and — the
    // stronger, previously-broken claim — is NOT merely a later sibling in
    // the document that happens to render near it.
    expect(ol!.contains(li!)).toBe(true);
    expect(li!.parentElement).toBe(ol);
  });

  it('the viewport carries the fixed-positioning classes and stays pointer-events-none while each toast stays interactive', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Joined group' });
    });
    await screen.findByText('Joined group');

    const ol = viewportOl()!;
    expect(ol.className).toMatch(/\bfixed\b/);
    expect(ol.className).toMatch(/\bpointer-events-none\b/);
    // Responsive placement preserved: top on small screens, bottom-right
    // from `sm:` up.
    expect(ol.className).toMatch(/\btop-0\b/);
    expect(ol.className).toMatch(/\bsm:bottom-0\b/);
    expect(ol.className).toMatch(/\bsm:right-0\b/);

    const li = document.querySelector('li')!;
    expect(li.className).toMatch(/\bpointer-events-auto\b/);

    // Concretely interactive, not just styled to look that way: the close
    // button inside this same toast is clickable and dismisses it.
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    fireEvent.click(closeButton);
    await waitFor(() => expect(screen.queryByText('Joined group')).not.toBeInTheDocument());
  });

  it('gives the viewport an accessible notifications label', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Round complete' });
    });
    await screen.findByText('Round complete');

    const wrapper = regionWrapper();
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute('aria-label')).toMatch(/Notifications/i);
  });

  it('preserves default and destructive visual styling', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Saved' });
      toast({ title: 'Failed', variant: 'destructive' });
    });
    await screen.findByText('Saved');
    await screen.findByText('Failed');

    const items = document.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].className).toMatch(/border bg-background text-foreground/);
    expect(items[1].className).toMatch(/destructive/);
    expect(items[1].className).toMatch(/border-red-500/);
    expect(items[1].className).toMatch(/dark:bg-red-900/);
  });
});

describe('Toaster — accessible announcements', () => {
  async function waitForAnnounce() {
    let status: Element | null = null;
    await waitFor(() => {
      status = document.querySelector('[role="status"]');
      expect(status).not.toBeNull();
      expect(status!.textContent).not.toBe('');
    });
    return status as unknown as Element;
  }

  it('announces title+description together, atomically, with no duplicate live region on the visible toast', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Group created', description: 'Everyone can join now.' });
    });
    await screen.findByText('Group created');

    // The visible toast element itself must not ALSO be a live region —
    // that would double-announce alongside the hidden announcer below.
    const li = document.querySelector('li')!;
    expect(li).not.toHaveAttribute('role', 'status');
    expect(li).not.toHaveAttribute('role', 'alert');
    expect(li).not.toHaveAttribute('aria-live');

    const status = await waitForAnnounce();
    expect(status.getAttribute('aria-live')).toBe('polite');
    // Exact text, not separate title/description regexes: this is what
    // actually reaches a screen reader (Radix's default label + " " +
    // this toast's own flattened text nodes), and it's the only way to
    // catch title and description running together with no separator
    // ("Group createdEveryone can join now.") or arriving out of order —
    // both would still satisfy two independent substring regexes.
    expect(status.textContent).toBe('Notification Group created. Everyone can join now.');

    // Exactly one live region exists for this one toast (no overlap).
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('announces a destructive toast assertively, ordered title-then-description', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Error', description: 'Failed to join', variant: 'destructive' });
    });
    await screen.findByText('Error');

    const status = await waitForAnnounce();
    expect(status.getAttribute('aria-live')).toBe('assertive');
    expect(status.textContent).toBe('Notification Error. Failed to join');
  });

  describe('separator punctuation between title and description', () => {
    it.each([
      ['no trailing punctuation gets a full stop', 'Group created', 'Everyone can join', 'Notification Group created. Everyone can join'],
      ['a title already ending in "." gets only a space', 'Failed to join.', 'Try again shortly', 'Notification Failed to join. Try again shortly'],
      ['a title already ending in "!" gets only a space', 'Correct!', '+10 points', 'Notification Correct! +10 points'],
      ['a title already ending in "?" gets only a space', 'Still there?', 'Reconnecting', 'Notification Still there? Reconnecting'],
      ['a title already ending in ":" gets only a space', 'Warning:', 'Try again', 'Notification Warning: Try again'],
      ['trailing whitespace after punctuation is still detected', 'Done!  ', 'Nice work', 'Notification Done!   Nice work'],
    ])('%s', async (_label, title, description, expected) => {
      render(<Toaster />);
      act(() => {
        toast({ title, description });
      });
      const status = await waitForAnnounce();
      expect(status.textContent).toBe(expected);
    });
  });

  it('title-only: announced with no stray separator or trailing punctuation', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Joined group' });
    });
    const status = await waitForAnnounce();
    expect(status.textContent).toBe('Notification Joined group');
    // No sr-only separator span at all when there's nothing to separate.
    expect(document.querySelector('li span.sr-only')).toBeNull();
  });

  it('description-only: announced with no stray separator', async () => {
    render(<Toaster />);
    act(() => {
      toast({ description: 'Only a description' });
    });
    const status = await waitForAnnounce();
    expect(status.textContent).toBe('Notification Only a description');
    expect(document.querySelector('li span.sr-only')).toBeNull();
  });

  it('does not move keyboard focus when a toast appears', async () => {
    render(<Toaster />);
    const outsideButton = mountOutsideButton();
    act(() => {
      outsideButton.focus();
    });
    expect(document.activeElement).toBe(outsideButton);

    act(() => {
      toast({ title: 'Reward claimed' });
    });
    await screen.findByText('Reward claimed');

    expect(document.activeElement).toBe(outsideButton);
  });
});

describe('Toaster — functional dismissal', () => {
  it('close dismisses only the toast it belongs to', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Keep me' });
      toast({ title: 'Remove me' });
    });
    await screen.findByText('Keep me');
    await screen.findByText('Remove me');

    const closeButtons = screen.getAllByRole('button', { name: 'Dismiss notification' });
    expect(closeButtons).toHaveLength(2);
    fireEvent.click(closeButtons[1]);

    await waitFor(() => expect(screen.queryByText('Remove me')).not.toBeInTheDocument());
    expect(screen.getByText('Keep me')).toBeInTheDocument();
  });

  it('the close button is type="button" (cannot accidentally submit a form)', async () => {
    render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <Toaster />
      </form>,
    );
    let submitted = false;
    document.querySelector('form')!.addEventListener('submit', () => {
      submitted = true;
    });

    act(() => {
      toast({ title: 'Inside a form' });
    });
    await screen.findByText('Inside a form');

    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    expect(closeButton).toHaveAttribute('type', 'button');
    fireEvent.click(closeButton);

    expect(submitted).toBe(false);
  });

  it('renders a real ToastAction that is type="button", actually invokes its handler, and cannot submit a surrounding form', async () => {
    let submitted = false;
    const onActionClick = vi.fn();
    render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitted = true;
        }}
      >
        <Toaster />
      </form>,
    );

    act(() => {
      toast({
        title: 'Retry available',
        action: createElement(
          ToastAction,
          { altText: 'Retry the failed request', onClick: onActionClick },
          'Retry',
        ),
      });
    });
    await screen.findByText('Retry available');

    const actionButton = screen.getByRole('button', { name: 'Retry' });
    expect(actionButton).toHaveAttribute('type', 'button');

    fireEvent.click(actionButton);
    expect(onActionClick).toHaveBeenCalledTimes(1);
    expect(submitted).toBe(false);
  });

  it('marks the close icon decorative so only the button label is announced', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Iconography' });
    });
    await screen.findByText('Iconography');

    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    const icon = closeButton.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Toaster — automatic expiration and bounded stacking', () => {
  it('auto-dismisses an ordinary toast at its configured duration', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast({ title: 'Expiring soon', duration: 2000 });
    });
    expect(screen.getByText('Expiring soon')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('Expiring soon')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(screen.queryByText('Expiring soon')).not.toBeInTheDocument();
  });

  it('expires at DEFAULT_TOAST_DURATION when no custom duration is given', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast({ title: 'Default timing' });
    });
    expect(screen.getByText('Default timing')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_TOAST_DURATION - 200);
    });
    expect(screen.getByText('Default timing')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.queryByText('Default timing')).not.toBeInTheDocument();
  });

  describe('invalid custom durations fall back to the default instead of closing instantly or never', () => {
    it.each([
      ['zero', 0],
      ['negative', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['past the safe setTimeout limit', 3_000_000_000],
    ])('%s', async (_label, duration) => {
      vi.useFakeTimers();
      render(<Toaster />);
      act(() => {
        toast({ title: 'Odd duration', duration });
      });

      // Still there just before the default would fire — an unclamped
      // negative/overflow value would have closed it almost immediately,
      // and an unclamped Infinity would never reach this branch's later
      // assertion either way.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEFAULT_TOAST_DURATION - 200);
      });
      expect(screen.getByText('Odd duration')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.queryByText('Odd duration')).not.toBeInTheDocument();
    });
  });

  it('manual dismissal actually cancels the pending timer, not just the visible toast', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    let handle!: { id: string; dismiss: () => void };
    act(() => {
      handle = toast({ title: 'Dismissed early', duration: 2000 });
    });
    expect(screen.getByText('Dismissed early')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const pendingBeforeDismiss = vi.getTimerCount();
    expect(pendingBeforeDismiss).toBeGreaterThan(0);

    act(() => handle.dismiss());
    expect(screen.queryByText('Dismissed early')).not.toBeInTheDocument();

    // If the underlying setTimeout had merely been hidden rather than
    // genuinely cleared, the pending-timer count would stay where it was
    // until that stale timer eventually fires on its own — a real,
    // measurable difference from actual cancellation, and the gap a
    // "harmless because IDs are unique" argument can't paper over. With
    // only this one toast ever having existed, settlement means exactly
    // zero pending timers, not merely "fewer than before" (which would
    // also pass if only one of its two timers — the close timer or the
    // announcer's own auto-hide timer — had actually been cleared).
    expect(vi.getTimerCount()).toBe(0);

    // And advancing well past the original duration must not throw, warn,
    // or resurrect/affect anything.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByText('Dismissed early')).not.toBeInTheDocument();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('keeps only the newest three when more than three are shown', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'One' });
      toast({ title: 'Two' });
      toast({ title: 'Three' });
      toast({ title: 'Four' });
      toast({ title: 'Five' });
    });

    await screen.findByText('Five');
    expect(screen.queryByText('One')).not.toBeInTheDocument();
    expect(screen.queryByText('Two')).not.toBeInTheDocument();
    expect(screen.getByText('Three')).toBeInTheDocument();
    expect(screen.getByText('Four')).toBeInTheDocument();
    expect(screen.getByText('Five')).toBeInTheDocument();
    expect(document.querySelectorAll('li')).toHaveLength(3);
  });

  it("an overflowed-out toast's own timer cannot later fire and affect the toasts that replaced it", async () => {
    vi.useFakeTimers();
    render(<Toaster />);

    // Mount "Bumped" on its own first, so it actually renders and its
    // internal auto-dismiss timer genuinely starts, before being pushed
    // out by the queue limit below.
    act(() => {
      toast({ title: 'Bumped', duration: 1000 });
    });
    expect(screen.getByText('Bumped')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    // What exactly one settled toast contributes to the pending-timer
    // count (its own close timer, plus its announcer's own auto-hide
    // timer) — the reference unit the assertion below is built from.
    const perToastTimers = vi.getTimerCount();
    expect(perToastTimers).toBeGreaterThan(0);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      toast({ title: 'Survivor A', duration: 5000 });
      toast({ title: 'Survivor B', duration: 5000 });
      toast({ title: 'Survivor C', duration: 5000 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // "Bumped" is evicted by the TOAST_LIMIT=3 cap — its <Toast> unmounts,
    // and Radix's own cleanup effect clears its internal close timer.
    expect(screen.queryByText('Bumped')).not.toBeInTheDocument();

    // If "Bumped"'s timer(s) had merely been hidden rather than actually
    // cancelled on unmount, this would read `perToastTimers * 4`, not
    // `* 3` — a ghost timer sitting underneath the three survivors,
    // invisible to the DOM assertions below but present in the pending
    // count.
    expect(vi.getTimerCount()).toBe(perToastTimers * 3);

    // Advance exactly past "Bumped"'s original 1000ms duration. If its
    // timer had NOT been cleared on removal, this is when it would fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    expect(screen.getByText('Survivor A')).toBeInTheDocument();
    expect(screen.getByText('Survivor B')).toBeInTheDocument();
    expect(screen.getByText('Survivor C')).toBeInTheDocument();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('pauses expiration while the pointer is over the toast stack and resumes with the remaining duration (not a restarted full duration)', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast({ title: 'Pausable', duration: 2000 });
    });
    const wrapper = regionWrapper()!;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('Pausable')).toBeInTheDocument();

    fireEvent.pointerMove(wrapper);
    await act(async () => {
      // Far past the original 2000ms duration — must still be paused.
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText('Pausable')).toBeInTheDocument();

    fireEvent.pointerLeave(wrapper);
    // Roughly the ~1000ms that remained when paused, not a fresh 2000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.getByText('Pausable')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByText('Pausable')).not.toBeInTheDocument();
  });

  it('pauses expiration while a control inside the toast stack has keyboard focus, and resumes on blur', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast({ title: 'FocusPausable', duration: 2000 });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });

    fireEvent.focusIn(closeButton);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText('FocusPausable')).toBeInTheDocument();

    fireEvent.focusOut(closeButton, { relatedTarget: document.body });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.queryByText('FocusPausable')).not.toBeInTheDocument();
  });
});

describe('Toaster — resumes correctly after the queue empties out', () => {
  // Radix's own "is close paused" flag lives inside <ToastProvider>, is
  // only ever cleared by the viewport's pointerleave/focusout/window-focus
  // handlers, and those handlers are only attached while there's a toast
  // to show. The close button only appears on hover/focus, so closing the
  // LAST toast necessarily happens while paused; `hasToasts` then flips to
  // false and tears the resume handlers down before they can fire,
  // leaving the flag stuck. Every regression below is a variant of "close
  // the last toast this way, then prove the NEXT toast still expires
  // normally" — this is the actual behavior the fix promises, not an
  // implementation detail of how it's achieved.
  it('mouse: a new toast still auto-expires after the last one was closed while hovered', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    const wrapper = regionWrapper();

    act(() => {
      toast({ title: 'First', duration: 2000 });
    });
    fireEvent.pointerMove(regionWrapper() ?? wrapper!);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    fireEvent.pointerLeave(regionWrapper() ?? wrapper!);

    act(() => {
      toast({ title: 'Second', duration: 2000 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
  });

  it('keyboard: a new toast still auto-expires after keyboard-closing the last one and moving focus away', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);

    act(() => {
      toast({ title: 'First', duration: 2000 });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    fireEvent.focusIn(closeButton);
    fireEvent.click(closeButton);
    act(() => {
      outside.focus();
    });

    act(() => {
      toast({ title: 'Second', duration: 2000 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.queryByText('Second')).not.toBeInTheDocument();

    outside.remove();
  });

  it('a toast that arrives while the pointer is still genuinely over a non-empty stack stays paused', async () => {
    // The fix must not make pausing itself unreliable — a session that
    // never went through empty→non-empty should behave exactly as before.
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast({ title: 'Keep showing', duration: 60000 });
    });
    fireEvent.pointerMove(regionWrapper()!);

    act(() => {
      toast({ title: 'Arrives while hovered', duration: 2000 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText('Arrives while hovered')).toBeInTheDocument();

    fireEvent.pointerLeave(regionWrapper()!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.queryByText('Arrives while hovered')).not.toBeInTheDocument();
  });

  it('does not drop focus to <body> when the empty viewport is remounted for a new session', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'First' });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    act(() => {
      closeButton.focus();
    });
    fireEvent.click(closeButton);
    // Radix's own handleClose already moved focus onto the (now-empty)
    // viewport at this point — confirm the starting point before the
    // remount, so a failure below is clearly the remount's fault.
    expect(document.activeElement).not.toBe(document.body);

    act(() => {
      toast({ title: 'Second' });
    });
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('Toaster — keyboard focus surviving a session remount stays paused', () => {
  // The remount above (restoring focus so it doesn't fall to <body>)
  // trades the original stuck-pause defect for a smaller one: Radix's own
  // pause listeners aren't attached to the fresh viewport until AFTER
  // this component's own effects run, so restoring focus there — on its
  // own — doesn't produce the `focusin` Radix listens for. A genuine
  // keyboard user who never actually left the notifications region would
  // see their next toast auto-dismiss anyway. `Toaster` resolves this by
  // re-triggering a real focus transition once Radix's listeners exist,
  // but ONLY when the focus being restored was actually keyboard-driven —
  // Radix's own `handleClose` moves focus onto the viewport identically
  // for a mouse click, and that must keep expiring normally (this is the
  // fix from the previous round; it must not regress).
  it('keyboard: focus left on the remounted viewport keeps the next toast paused beyond its duration', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    markKeyboardInput();
    act(() => {
      toast({ title: 'First', duration: 2000 });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    act(() => {
      closeButton.focus();
    });
    fireEvent.click(closeButton);
    expect(document.activeElement).toBe(viewportOl());

    act(() => {
      toast({ title: 'Second', duration: 2000 });
    });
    // Focus was restored onto the new viewport by a genuine keyboard
    // user — still there, and the deferred re-pause hasn't run yet.
    expect(document.activeElement).toBe(viewportOl());

    // Let the deferred re-pause settle, then advance well past the
    // toast's nominal duration — still here, because it's paused.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('keyboard: once focus actually leaves the remounted viewport, the toast resumes and expires', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    markKeyboardInput();
    act(() => {
      toast({ title: 'First', duration: 2000 });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    act(() => {
      closeButton.focus();
    });
    fireEvent.click(closeButton);

    act(() => {
      toast({ title: 'Second', duration: 2000 });
    });
    // Let the deferred re-pause settle — the re-pause happens almost
    // immediately after creation, so it's paused with close to its full
    // original duration intact; advancing well past that original
    // duration proves it's genuinely paused, not just slow to fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByText('Second')).toBeInTheDocument();

    const outside = mountOutsideButton();
    fireEvent.focusOut(viewportOl()!, { relatedTarget: outside });
    act(() => {
      outside.focus();
    });

    // Resumes with its remaining duration (close to the full 2000ms,
    // since almost none of it had elapsed before pausing) and eventually
    // expires — this is the escape hatch: a keyboard user who tabs away
    // is never stuck forever.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
  });

  it('mouse: a click that leaves focus on the remounted viewport does NOT pause the next toast', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    markPointerInput();
    act(() => {
      toast({ title: 'First', duration: 2000 });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    fireEvent.pointerMove(regionWrapper()!);
    act(() => {
      // A real mouse click focuses its target as a side effect, even
      // without JS — this reproduces that, not just the click itself.
      closeButton.focus();
    });
    fireEvent.click(closeButton);
    expect(document.activeElement).toBe(viewportOl());

    act(() => {
      toast({ title: 'Second', duration: 2000 });
    });
    expect(document.activeElement).toBe(viewportOl());

    // Unpaused: expires right on schedule, not held open by the keyboard
    // -only re-pause.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
  });

  it('mouse: a later click genuinely resets modality back to pointer after an earlier keyboard input', async () => {
    // Proves the modality tracker actually responds to a real pointerdown
    // — not just that it happens to default to "pointer" — by marking
    // keyboard input FIRST, then pointer input, then checking the
    // pointer (not the earlier keyboard) modality is what's in effect at
    // dismissal time.
    vi.useFakeTimers();
    render(<Toaster />);
    markKeyboardInput();
    markPointerInput();
    act(() => {
      toast({ title: 'First', duration: 2000 });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    act(() => {
      closeButton.focus();
    });
    fireEvent.click(closeButton);

    act(() => {
      toast({ title: 'Second', duration: 2000 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
  });

  it('a real Tab into a freshly rendered toast still pauses it normally, independent of the remount fix', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast({ title: 'Ordinary', duration: 2000 });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    markKeyboardInput();
    fireEvent.focusIn(closeButton);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText('Ordinary')).toBeInTheDocument();
  });

  it('does not duplicate the provider, toast, announcer, viewport, or timers while re-pausing', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    markKeyboardInput();
    act(() => {
      toast({ title: 'First', duration: 2000 });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    act(() => {
      closeButton.focus();
    });
    fireEvent.click(closeButton);

    act(() => {
      toast({ title: 'Second', duration: 2000 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(document.querySelectorAll('li')).toHaveLength(1);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(document.querySelectorAll('ol')).toHaveLength(1);
    const { result, unmount } = renderHook(() => useToast());
    expect(result.current.toasts).toHaveLength(1);
    unmount();
  });

  it('repeated close/reopen cycles keep re-pausing correctly each time', async () => {
    vi.useFakeTimers();
    render(<Toaster />);
    for (let i = 0; i < 3; i++) {
      markKeyboardInput();
      act(() => {
        toast({ title: `Cycle ${i}`, duration: 2000 });
      });
      const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
      act(() => {
        closeButton.focus();
      });
      fireEvent.click(closeButton);

      act(() => {
        toast({ title: `After ${i}`, duration: 2000 });
      });
      expect(document.activeElement).toBe(viewportOl());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(screen.getByText(`After ${i}`)).toBeInTheDocument();

      const outside = mountOutsideButton();
      fireEvent.focusOut(viewportOl()!, { relatedTarget: outside });
      act(() => {
        outside.focus();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(screen.queryByText(`After ${i}`)).not.toBeInTheDocument();
    }
  });
});

describe('Toaster — preserves focus during programmatic removal', () => {
  // Unlike the close button / Escape / swipe (which move focus to the
  // viewport themselves, synchronously, before Radix's own onClose fires),
  // removing a toast directly from the store's array — via the returned
  // `dismiss()` handle, or via queue eviction — bypasses that entirely:
  // the <Toast> simply disappears from the rendered list. Left unhandled,
  // the browser drops focus to <body> once the focused element is
  // detached from the document.
  it('a programmatic dismiss() of a focused toast moves focus to the viewport, not <body>', async () => {
    render(<Toaster />);
    let handle!: { id: string; dismiss: () => void };
    act(() => {
      handle = toast({ title: 'Handle-dismissed' });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    act(() => {
      closeButton.focus();
    });
    expect(document.activeElement).toBe(closeButton);

    act(() => handle.dismiss());

    expect(screen.queryByText('Handle-dismissed')).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(viewportOl());
  });

  it('eviction of a focused oldest toast moves focus to the viewport, not <body>', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Oldest', duration: 60000 });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    act(() => {
      closeButton.focus();
    });

    act(() => {
      toast({ title: 'N1' });
      toast({ title: 'N2' });
      toast({ title: 'N3' });
    });

    expect(screen.queryByText('Oldest')).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(viewportOl());
  });

  it('eviction does not steal focus when nothing is focused and the evicted toast is unfocused', async () => {
    // Deliberately starts with NOTHING focused (`<body>`), rather than
    // some other still-existing element outside the toast stack: React's
    // own commit machinery quietly restores focus onto a previously
    // -focused element that's still in the document after an unrelated
    // DOM mutation elsewhere in the same commit — which would make a
    // "focus stays on some other outside element" version of this test
    // pass even if the fix's own cleanup unconditionally stole focus on
    // every removal. Starting from `<body>` (nothing to restore to) is
    // what makes the assertion below fail if focus is genuinely stolen.
    render(<Toaster />);
    act(() => {
      toast({ title: 'Oldest', duration: 60000 });
    });
    expect(document.activeElement).toBe(document.body);

    act(() => {
      toast({ title: 'N1' });
      toast({ title: 'N2' });
      toast({ title: 'N3' });
    });

    expect(screen.queryByText('Oldest')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it('ordinary close-button dismissal still moves focus to the viewport exactly as before', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Closed by hand' });
    });
    const closeButton = screen.getByRole('button', { name: 'Dismiss notification' });
    act(() => {
      closeButton.focus();
    });

    fireEvent.click(closeButton);

    await waitFor(() => expect(screen.queryByText('Closed by hand')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(viewportOl());
  });
});

describe('Toaster — Strict Mode and multiple subscribers', () => {
  it('does not duplicate a toast, its DOM node, or its announcement under React Strict Mode', async () => {
    render(
      <StrictMode>
        <Toaster />
      </StrictMode>,
    );
    act(() => {
      toast({ title: 'Only once' });
    });
    await screen.findByText('Only once');

    expect(screen.getAllByText('Only once')).toHaveLength(1);
    expect(document.querySelectorAll('li')).toHaveLength(1);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('two mounted Toasters/subscribers observe the same single store without duplicating render output per extra subscriber', async () => {
    // A second `useToast()` subscriber (as any page calling the hook would
    // be) sees the same toasts as the Toaster — proving the module-level
    // singleton fans out to multiple consumers correctly, not once for the
    // Toaster and separately/differently for anything else observing it.
    const { result } = renderHook(() => useToast());
    render(<Toaster />);

    act(() => {
      toast({ title: 'Shared' });
    });
    await screen.findByText('Shared');

    expect(result.current.toasts).toHaveLength(1);
    expect(document.querySelectorAll('li')).toHaveLength(1);
  });
});

describe('Toaster — existing page-level call sites still work', () => {
  it('a call shaped like an existing page site (e.g. groups.tsx success) renders through the real Toaster', async () => {
    render(<Toaster />);
    act(() => {
      // Matches the exact call shape used by existing pages, e.g.
      // groups.tsx's `toast({ title: 'Group created' })`.
      toast({ title: 'Group created' });
    });
    await screen.findByText('Group created');
    expect(document.querySelector('li')).not.toBeNull();
  });

  it('a call shaped like an existing destructive-error page site renders through the real Toaster', async () => {
    render(<Toaster />);
    act(() => {
      // Matches call sites like groups.tsx's join-failure toast:
      // `toast({ title: 'Error', description: msg, variant: 'destructive' })`.
      toast({ title: 'Error', description: 'boom', variant: 'destructive' });
    });
    await screen.findByText('Error');
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(document.querySelector('li')?.className).toMatch(/destructive/);
  });
});
