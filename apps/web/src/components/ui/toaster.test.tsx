import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/toaster';
import { dismissToast, toast, useToast } from '@/hooks/use-toast';

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
});

function regionWrapper() {
  return document.querySelector('[role="region"]') as HTMLElement | null;
}

function viewportOl() {
  return document.querySelector('ol') as HTMLOListElement | null;
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
  it('announces a default toast politely and a destructive one assertively, with title+description together and no duplicate live region on the visible toast', async () => {
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

    await waitFor(() => {
      const status = document.querySelector('[role="status"]');
      expect(status).not.toBeNull();
      expect(status!.getAttribute('aria-live')).toBe('polite');
      // Atomic: title and description are both present in the ONE
      // announced status region, not split across two.
      expect(status!.textContent).toMatch(/Group created/);
      expect(status!.textContent).toMatch(/Everyone can join now\./);
    });

    // Exactly one live region exists for this one toast (no overlap).
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('announces a destructive toast assertively', async () => {
    render(<Toaster />);
    act(() => {
      toast({ title: 'Failed to create group', variant: 'destructive' });
    });
    await screen.findByText('Failed to create group');

    await waitFor(() => {
      const status = document.querySelector('[role="status"]');
      expect(status).not.toBeNull();
      expect(status!.getAttribute('aria-live')).toBe('assertive');
      expect(status!.textContent).toMatch(/Failed to create group/);
    });
  });

  it('does not move keyboard focus when a toast appears', async () => {
    render(<Toaster />);
    const outsideButton = document.createElement('button');
    outsideButton.textContent = 'outside';
    document.body.appendChild(outsideButton);
    outsideButton.focus();
    expect(document.activeElement).toBe(outsideButton);

    act(() => {
      toast({ title: 'Reward claimed' });
    });
    await screen.findByText('Reward claimed');

    expect(document.activeElement).toBe(outsideButton);
    outsideButton.remove();
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

  it('close and action buttons are type="button" (cannot accidentally submit a form)', async () => {
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

  it('manual dismissal clears the pending expiration (no late removal/side effects)', async () => {
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
    act(() => handle.dismiss());
    expect(screen.queryByText('Dismissed early')).not.toBeInTheDocument();

    // Advancing well past the original duration must not throw, warn, or
    // resurrect/affect anything — its timer was already cleared on unmount.
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

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      toast({ title: 'Survivor A', duration: 5000 });
      toast({ title: 'Survivor B', duration: 5000 });
      toast({ title: 'Survivor C', duration: 5000 });
    });

    // "Bumped" is evicted by the TOAST_LIMIT=3 cap — its <Toast> unmounts,
    // and Radix's own cleanup effect clears its internal close timer.
    expect(screen.queryByText('Bumped')).not.toBeInTheDocument();

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

describe('Toaster — Strict Mode and multiple subscribers', () => {
  it('does not duplicate a toast or its DOM node under React Strict Mode', async () => {
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
