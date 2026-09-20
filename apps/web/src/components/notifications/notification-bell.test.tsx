import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationBell } from './notification-bell';
import { TestAuthProvider, type TestUser } from '@/test/test-auth';
import { createInbox, deferred, makeRows, type InboxResponse } from '@/test/notification-fixtures';

vi.mock('@/lib/api', () => ({
  api: {
    listNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
  },
}));

// The identity comes from the authenticated user; the real AuthProvider is
// exercised separately (notification-bell-auth.test.tsx). Here it is a plain
// stand-in so a test can hold the identity fixed.
vi.mock('@/providers/auth-provider', async () => {
  const m = await import('@/test/test-auth');
  return { useAuth: m.useTestAuth };
});

import { api } from '@/lib/api';

const mocked = api as unknown as {
  listNotifications: ReturnType<typeof vi.fn>;
  markNotificationRead: ReturnType<typeof vi.fn>;
  markAllNotificationsRead: ReturnType<typeof vi.fn>;
};

const USER: TestUser = { id: 'u1', username: 'user-one' };

function page(items: unknown[], unreadCount: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    success: true,
    data: items,
    meta: { page: 1, limit: 20, total: items.length, totalPages: 1, hasNextPage: false, hasPrevPage: false, unreadCount, ...overrides },
  };
}

function renderBell(opts: { staleTime?: number; client?: QueryClient; user?: TestUser | null } = {}) {
  const client =
    opts.client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: opts.staleTime ?? 0 } },
    });
  const user = 'user' in opts ? (opts.user ?? null) : USER;
  const utils = render(
    <TestAuthProvider user={user}>
      <QueryClientProvider client={client}>
        <NotificationBell />
      </QueryClientProvider>
    </TestAuthProvider>
  );
  return { ...utils, client };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const UNREAD_A = { id: 'n1', type: 'GROUP_INVITE', title: 'Group invitation', body: 'You were invited', isRead: false, createdAt: '2024-01-01T00:00:00.000Z' };
const UNREAD_B = { id: 'n2', type: 'MODERATION', title: 'Banned from group', body: 'You were banned', isRead: false, createdAt: '2024-01-02T00:00:00.000Z' };
const READ_ONE = { id: 'n3', type: 'SYSTEM', title: 'Welcome', body: 'Thanks for joining', isRead: true, createdAt: '2024-01-03T00:00:00.000Z' };

describe('NotificationBell', () => {
  it('shows no badge and a plain "Notifications" label when there is nothing unread', async () => {
    mocked.listNotifications.mockResolvedValue(page([], 0));
    renderBell();

    const button = await screen.findByRole('button', { name: 'Notifications' });
    expect(button).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows an unread badge and count in the accessible label', async () => {
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A, UNREAD_B, READ_ONE], 2));
    renderBell();

    expect(await screen.findByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('caps the visible badge at "9+" for large unread counts', async () => {
    mocked.listNotifications.mockResolvedValue(page([], 15));
    renderBell();

    expect(await screen.findByRole('button', { name: 'Notifications, 15 unread' })).toBeInTheDocument();
    expect(screen.getByText('9+')).toBeInTheDocument();
  });

  it('shows a loading state while the panel\'s data is in flight, then the list once it resolves', async () => {
    let resolvePage!: (v: unknown) => void;
    mocked.listNotifications.mockImplementation(() => new Promise((resolve) => { resolvePage = resolve; }));

    renderBell();
    const button = await screen.findByRole('button', { name: 'Notifications' });
    fireEvent.click(button);

    expect(await screen.findByText('Loading notifications…')).toBeInTheDocument();

    resolvePage(page([UNREAD_A], 1));

    expect(await screen.findByText('Group invitation')).toBeInTheDocument();
    expect(screen.queryByText('Loading notifications…')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no notifications', async () => {
    mocked.listNotifications.mockResolvedValue(page([], 0));
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));

    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
  });

  it('shows an accessible error state with a working Retry', async () => {
    mocked.listNotifications.mockRejectedValue(new Error('network down'));
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load notifications.');

    mocked.listNotifications.mockResolvedValueOnce(page([UNREAD_A], 1));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Group invitation')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a failed background refetch keeps the cached list visible and shows a non-destructive banner', async () => {
    mocked.listNotifications.mockResolvedValueOnce(page([UNREAD_A, UNREAD_B], 2));
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    expect(await screen.findByText('Group invitation')).toBeInTheDocument();
    expect(screen.getByText('Banned from group')).toBeInTheDocument();

    // Close and reopen with the next fetch failing — a background refetch,
    // not the initial load, because data is already cached from the first
    // successful fetch above.
    mocked.listNotifications.mockRejectedValueOnce(new Error('network blip'));
    fireEvent.click(screen.getByRole('button', { name: 'Notifications, 2 unread' })); // close
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' })); // reopen -> refetch

    // 3 calls total: the initial mount fetch, the first open's refetch
    // (fix #3 — both succeed), and this reopen's refetch (the one queued to fail).
    await waitFor(() => expect(mocked.listNotifications).toHaveBeenCalledTimes(3));

    // The list must still be there — a transient failure must never blank
    // a panel the user was already reading.
    expect(screen.getByText('Group invitation')).toBeInTheDocument();
    expect(screen.getByText('Banned from group')).toBeInTheDocument();
    // The failure is represented, but as a dismissible banner alongside the
    // list, never as the destructive "Failed to load" full-panel state.
    expect(screen.queryByText('Failed to load notifications.')).not.toBeInTheDocument();
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/refresh/i);
    // The badge (read from the same cache the list renders from) must stay
    // consistent with what's visibly on screen — not silently reset to 0.
    expect(screen.getByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
  });

  it('the initial-load error state is unaffected when there is no cached data to fall back on', async () => {
    mocked.listNotifications.mockRejectedValue(new Error('down'));
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));

    expect(await screen.findByText('Failed to load notifications.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load notifications.');
  });

  it('opening the panel refetches; a second open while one is already in flight does not duplicate the request', async () => {
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    const calls: Array<Promise<unknown>> = [];
    mocked.listNotifications.mockImplementation(() => {
      const p = new Promise((resolve) => {
        if (calls.length === 0) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
      calls.push(p);
      return p;
    });

    renderBell();
    await waitFor(() => expect(mocked.listNotifications).toHaveBeenCalledTimes(1)); // mount fetch
    resolveFirst(page([UNREAD_A], 1));
    await screen.findByRole('button', { name: 'Notifications, 1 unread' });

    const button = screen.getByRole('button', { name: 'Notifications, 1 unread' });
    fireEvent.click(button); // open #1 -> triggers a refetch
    await waitFor(() => expect(mocked.listNotifications).toHaveBeenCalledTimes(2));

    // Close and click open again WHILE that refetch is still unresolved.
    fireEvent.click(button); // close
    fireEvent.click(button); // open #2, request #2 still in flight
    await new Promise((r) => setTimeout(r, 20));
    expect(mocked.listNotifications).toHaveBeenCalledTimes(2); // no duplicate fired

    resolveSecond(page([UNREAD_A], 1));
    await waitFor(() => expect(mocked.listNotifications).toHaveBeenCalledTimes(2));
  });

  it('reopening after the in-flight request settles fetches again', async () => {
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 1));
    renderBell();
    const button = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    await waitFor(() => expect(mocked.listNotifications).toHaveBeenCalledTimes(1)); // mount

    fireEvent.click(button); // open -> refetch #2
    await waitFor(() => expect(mocked.listNotifications).toHaveBeenCalledTimes(2));
    fireEvent.click(button); // close

    fireEvent.click(button); // reopen -> refetch #3, prior one already settled
    await waitFor(() => expect(mocked.listNotifications).toHaveBeenCalledTimes(3));
  });

  it('opening does not refetch a fresh cache under production staleTime defaults, but the explicit open-refetch still overrides it', async () => {
    // main.tsx sets a real 5-minute staleTime; this proves the open-driven
    // refetch (`cancelRefetch: false`, unconditional on open) still fires
    // even though the data would otherwise be considered fresh.
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 1));
    renderBell({ staleTime: 5 * 60 * 1000 });
    const button = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    await waitFor(() => expect(mocked.listNotifications).toHaveBeenCalledTimes(1));

    fireEvent.click(button);
    await waitFor(() => expect(mocked.listNotifications).toHaveBeenCalledTimes(2));
  });

  it('renders both read and unread items, with "Mark as read" offered only for unread ones', async () => {
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A, READ_ONE], 1));
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));

    expect(await screen.findByText('Group invitation')).toBeInTheDocument();
    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Mark as read' })).toHaveLength(1);
  });

  it('marking one notification read calls the API with its id and announces the result', async () => {
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 1));
    // Flip what the server returns as a side effect of the mutation, so the
    // assertions hold no matter how many times the list is refetched.
    mocked.markNotificationRead.mockImplementation(async () => {
      mocked.listNotifications.mockResolvedValue(page([{ ...UNREAD_A, isRead: true }], 0));
      return { success: true, data: { ...UNREAD_A, isRead: true } };
    });
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as read' }));

    await waitFor(() => expect(mocked.markNotificationRead).toHaveBeenCalledWith('n1'));
    expect(await screen.findByRole('status')).toHaveTextContent('Notification marked as read.');
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('"Mark all read" is unavailable when nothing is unread — via aria-disabled, never native `disabled`', async () => {
    mocked.listNotifications.mockResolvedValueOnce(page([READ_ONE], 0));
    renderBell();
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    const markAll = await screen.findByRole('button', { name: 'Mark all read' });
    expect(markAll).toHaveAttribute('aria-disabled', 'true');
    // Native `disabled` would blur the button the moment marking succeeds and
    // the unread count drops to zero.
    expect(markAll).not.toBeDisabled();
    fireEvent.click(markAll);
    expect(mocked.markAllNotificationsRead).not.toHaveBeenCalled();
  });

  it('"Mark all read" calls the API and announces the result when there is something unread', async () => {
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A, READ_ONE], 1));
    mocked.markAllNotificationsRead.mockImplementation(async () => {
      mocked.listNotifications.mockResolvedValue(page([{ ...UNREAD_A, isRead: true }, READ_ONE], 0));
      return { success: true, data: { updated: 1 } };
    });
    renderBell();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const markAll = await screen.findByRole('button', { name: 'Mark all read' });
    expect(markAll).not.toHaveAttribute('aria-disabled');
    fireEvent.click(markAll);

    await waitFor(() => expect(mocked.markAllNotificationsRead).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent('All notifications marked as read.');
  });

  it('closes on Escape and returns focus to the bell button', async () => {
    const user = userEvent.setup();
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 1));
    renderBell();

    const button = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    await user.click(button);
    expect(await screen.findByRole('region', { name: 'Notifications' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('closes when clicking outside the panel', async () => {
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 1));
    render(
      <TestAuthProvider user={USER}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
          <div>
            <button>Outside</button>
            <NotificationBell />
          </div>
        </QueryClientProvider>
      </TestAuthProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    expect(await screen.findByRole('region', { name: 'Notifications' })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));

    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('toggles closed when the bell button is clicked again', async () => {
    mocked.listNotifications.mockResolvedValue(page([], 0));
    renderBell();

    const button = await screen.findByRole('button', { name: 'Notifications' });
    fireEvent.click(button);
    expect(await screen.findByRole('region', { name: 'Notifications' })).toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  describe('accessibility semantics', () => {
    it('does not claim to open a menu, and does not dangle aria-controls while closed', async () => {
      mocked.listNotifications.mockResolvedValue(page([], 0));
      renderBell();
      const button = await screen.findByRole('button', { name: 'Notifications' });

      // aria-haspopup="true" is a synonym for "menu"; the popup is a region.
      expect(button).not.toHaveAttribute('aria-haspopup');
      // While closed there is no panel, so aria-controls must not point at
      // an element id that does not exist.
      expect(button).not.toHaveAttribute('aria-controls');
      expect(button).toHaveAttribute('aria-expanded', 'false');
    });

    it('points aria-controls at the real panel once open', async () => {
      mocked.listNotifications.mockResolvedValue(page([], 0));
      renderBell();
      const button = await screen.findByRole('button', { name: 'Notifications' });
      fireEvent.click(button);

      const controls = button.getAttribute('aria-controls');
      expect(controls).toBe('notification-panel');
      expect(document.getElementById(controls!)).not.toBeNull();
      expect(button).toHaveAttribute('aria-expanded', 'true');
      // Still not a menu.
      expect(button).not.toHaveAttribute('aria-haspopup');
      expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
    });

    it('re-announces an identical outcome, so a second mark-read is not silent', async () => {
      mocked.listNotifications.mockResolvedValue(page([UNREAD_A, UNREAD_B], 2));
      mocked.markNotificationRead.mockResolvedValue({ success: true, data: {} });
      renderBell();
      fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
      await screen.findByText('Group invitation');

      const region = screen.getByRole('status');
      let mutations = 0;
      const observer = new MutationObserver((records) => {
        mutations += records.length;
      });
      observer.observe(region, { childList: true, characterData: true, subtree: true });

      fireEvent.click(screen.getAllByRole('button', { name: 'Mark as read' })[0]);
      await waitFor(() => expect(region.textContent).toContain('Notification marked as read.'));
      const afterFirst = mutations;
      expect(afterFirst).toBeGreaterThan(0);

      // Same outcome again. A live region only speaks when its content
      // actually changes, so this must still produce a DOM mutation.
      fireEvent.click(screen.getAllByRole('button', { name: 'Mark as read' })[0]);
      await waitFor(() => expect(mocked.markNotificationRead).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(mutations).toBeGreaterThan(afterFirst));
      observer.disconnect();

      expect(region.textContent).toContain('Notification marked as read.');
    });

    it('re-announces a repeated mark-all-read outcome too', async () => {
      mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 1));
      mocked.markAllNotificationsRead.mockResolvedValue({ success: true, data: { updated: 1 } });
      renderBell();
      fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));

      const region = screen.getByRole('status');
      let mutations = 0;
      const observer = new MutationObserver((records) => {
        mutations += records.length;
      });
      observer.observe(region, { childList: true, characterData: true, subtree: true });

      const markAll = await screen.findByRole('button', { name: 'Mark all read' });
      fireEvent.click(markAll);
      await waitFor(() => expect(region.textContent).toContain('All notifications marked as read.'));
      const afterFirst = mutations;

      fireEvent.click(markAll);
      await waitFor(() => expect(mocked.markAllNotificationsRead).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(mutations).toBeGreaterThan(afterFirst));
      observer.disconnect();
    });

    it('the announcement carries no visible punctuation change for sighted users', async () => {
      mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 1));
      mocked.markNotificationRead.mockResolvedValue({ success: true, data: {} });
      renderBell();
      fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Mark as read' }));

      const region = await screen.findByRole('status');
      await waitFor(() => expect(region.textContent).toContain('Notification marked as read.'));
      // Only a zero-width space may ever be appended.
      expect(region.textContent!.replace(/\u200B/g, '')).toBe('Notification marked as read.');
    });
  });

  it('sets aria-expanded to reflect the open state', async () => {
    mocked.listNotifications.mockResolvedValue(page([], 0));
    renderBell();

    const button = await screen.findByRole('button', { name: 'Notifications' });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });
});

// ─── Infinite pagination ────────────────────────────────────────────────────
//
// The inbox is a single useInfiniteQuery. These pin the behaviours the old
// hand-rolled "load more" (which merged pages into the cache with
// setQueryData) could not give: every loaded page survives every refresh,
// mark-read and failure, and pagination is single-flight.

const rowTitles = () => screen.queryAllByText(/^u1 notification \d+$/);
const pagesRequested = () => mocked.listNotifications.mock.calls.map((c) => (c[0] as { page?: number }).page);
const markReadButtons = () => screen.queryAllByRole('button', { name: 'Mark as read' });

/** 41 notifications (pages of 20, 20, 1); the even-indexed ones — including the oldest — are unread: 21 in all. */
function installInbox(inbox = createInbox(makeRows('u1', 41, (i) => i % 2 === 0))) {
  mocked.listNotifications.mockImplementation(async (params: { page?: number; limit?: number }) => inbox.list(params));
  mocked.markNotificationRead.mockImplementation(async (id: string) => inbox.markRead(id));
  mocked.markAllNotificationsRead.mockImplementation(async () => inbox.markAll());
  return inbox;
}

async function openBell(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Notifications/ }));
  return screen.findByRole('region', { name: 'Notifications' });
}

const loadMoreButton = () => screen.getByRole('button', { name: 'Load more' });

async function loadPages(user: ReturnType<typeof userEvent.setup>, expectedRows: number[]) {
  for (const rows of expectedRows) {
    await user.click(loadMoreButton());
    await waitFor(() => expect(rowTitles()).toHaveLength(rows));
  }
}

describe('NotificationBell — infinite pagination', () => {
  it('41 notifications across three pages: every page is reachable and the OLDEST unread row can be read individually', async () => {
    installInbox();
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');

    expect(rowTitles()).toHaveLength(20);
    await loadPages(user, [40, 41]);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    // Mount, open-refresh, then page 2 and page 3 exactly once each.
    expect(pagesRequested().filter((p) => p === 2)).toHaveLength(1);
    expect(pagesRequested().filter((p) => p === 3)).toHaveLength(1);

    const oldest = screen.getByText('u1 notification 41').closest('li') as HTMLElement;
    await user.click(within(oldest).getByRole('button', { name: 'Mark as read' }));
    await waitFor(() => expect(mocked.markNotificationRead).toHaveBeenCalledWith('u1-n41'));
    await waitFor(() => expect(within(oldest).queryByRole('button', { name: 'Mark as read' })).not.toBeInTheDocument());
    // Nothing collapsed back to page one.
    expect(rowTitles()).toHaveLength(41);
    expect(await screen.findByRole('button', { name: 'Notifications, 20 unread' })).toBeInTheDocument();
  });

  it("the badge shows the SERVER's unread total, not the number of unread rows that are visible", async () => {
    installInbox();
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');

    // Only page 1 is loaded: 10 unread rows are visible, 21 are unread in all.
    expect(markReadButtons()).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Notifications, 21 unread' })).toBeInTheDocument();
    await loadPages(user, [40, 41]);
    expect(markReadButtons()).toHaveLength(21);
    expect(screen.getByRole('button', { name: 'Notifications, 21 unread' })).toBeInTheDocument();
  });

  it('caps the badge at "9+" for a large server total even when few unread rows are loaded', async () => {
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 57));
    renderBell();
    expect(await screen.findByRole('button', { name: 'Notifications, 57 unread' })).toBeInTheDocument();
    expect(screen.getByText('9+')).toBeInTheDocument();
  });

  it('marking ONE notification read keeps every loaded page and the cursor — even while the reconciling refetch is still in flight', async () => {
    const inbox = installInbox();
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');
    await loadPages(user, [40]);

    // Hold the reconciling refetch that follows the mark-read.
    const hold = deferred<InboxResponse>();
    mocked.listNotifications.mockImplementation(async (params: { page?: number }) =>
      params.page === 1 ? hold.promise : inbox.list(params)
    );
    const first = screen.getByText('u1 notification 01').closest('li') as HTMLElement;
    await user.click(within(first).getByRole('button', { name: 'Mark as read' }));

    await waitFor(() => expect(within(first).queryByRole('button', { name: 'Mark as read' })).not.toBeInTheDocument());
    // Patched in the page structure: all 40 rows and the cursor are still there.
    expect(rowTitles()).toHaveLength(40);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications, 20 unread' })).toBeInTheDocument();

    // ...and once the refetch settles, still every loaded page.
    hold.resolve(inbox.list({ page: 1 }));
    await waitFor(() => expect(mocked.listNotifications.mock.calls.filter((c) => c[0].page === 2).length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-busy', 'false'));
    expect(rowTitles()).toHaveLength(40);

    // The cursor is intact: the next Load more fetches page 3, not page 2 again.
    mocked.listNotifications.mockClear();
    await user.click(loadMoreButton());
    await waitFor(() => expect(rowTitles()).toHaveLength(41));
    expect(pagesRequested()).toEqual([3]);
  });

  it('marking ALL read keeps every loaded page and the cursor', async () => {
    const inbox = installInbox();
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');
    await loadPages(user, [40]);

    const hold = deferred<InboxResponse>();
    mocked.listNotifications.mockImplementation(async (params: { page?: number }) =>
      params.page === 1 ? hold.promise : inbox.list(params)
    );
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));

    await waitFor(() => expect(markReadButtons()).toHaveLength(0));
    expect(rowTitles()).toHaveLength(40);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    // Every row on both pages is read, but the badge — a server fact about the
    // whole inbox — is 0 only because the server said so, not because rows ran out.
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();

    hold.resolve(inbox.list({ page: 1 }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-busy', 'false'));
    expect(rowTitles()).toHaveLength(40);

    mocked.listNotifications.mockClear();
    await user.click(loadMoreButton());
    await waitFor(() => expect(rowTitles()).toHaveLength(41));
    expect(pagesRequested()).toEqual([3]);
  });

  it('closing and reopening the panel re-fetches EVERY loaded page, front to back, and never collapses to page one', async () => {
    const inbox = installInbox();
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');
    await loadPages(user, [40, 41]);

    // Hold page 2 of the next refresh.
    const holdPage2 = deferred<InboxResponse>();
    mocked.listNotifications.mockClear();
    mocked.listNotifications.mockImplementation(async (params: { page?: number }) =>
      params.page === 2 ? holdPage2.promise : inbox.list(params)
    );
    await user.click(screen.getByRole('button', { name: /^Notifications/ })); // close
    await user.click(screen.getByRole('button', { name: /^Notifications/ })); // reopen -> refetch
    await waitFor(() => expect(pagesRequested()).toEqual([1, 2]));

    // Mid-refresh, all 41 rows are still on screen.
    expect(rowTitles()).toHaveLength(41);
    holdPage2.resolve(inbox.list({ page: 2 }));
    await waitFor(() => expect(pagesRequested()).toEqual([1, 2, 3]));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-busy', 'false'));
    expect(rowTitles()).toHaveLength(41);
  });

  it('a notification arriving between page fetches shifts a row onto two pages — it is rendered once, and the cache keeps the pages as the server sent them', async () => {
    const inbox = createInbox(makeRows('u1', 25, () => true));
    installInbox(inbox);
    const user = userEvent.setup();
    const { client } = renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');
    expect(rowTitles()).toHaveLength(20);

    // One new notification lands at the top: old row #20 is now first on page 2.
    inbox.prepend({ ...makeRows('u1', 1)[0], id: 'u1-new', title: 'u1 notification NEW' });
    await user.click(loadMoreButton());
    await waitFor(() => expect(rowTitles().length).toBeGreaterThan(20));

    const titles = rowTitles().map((el) => el.textContent);
    expect(new Set(titles).size).toBe(titles.length); // no row twice
    expect(titles).toHaveLength(25);
    expect(screen.getAllByText('u1 notification 20')).toHaveLength(1);

    // Deduplication is a rendering concern only: the stored pages hold 20 + 6.
    const stored = client.getQueryCache().getAll()[0].state.data as { pages: { items: unknown[] }[] };
    expect(stored.pages.map((p) => p.items.length)).toEqual([20, 6]);
  });

  describe('a refresh racing a page request', () => {
    it('while a refresh is in flight Load more is unavailable — the click sends nothing and is not silently absorbed — and it works once the refresh settles', async () => {
      const inbox = installInbox();
      const user = userEvent.setup();
      renderBell();
      await screen.findByRole('button', { name: 'Notifications, 21 unread' });

      const refresh = deferred<InboxResponse>();
      mocked.listNotifications.mockImplementationOnce(() => refresh.promise);
      await user.click(screen.getByRole('button', { name: /^Notifications/ })); // open -> refresh held
      const button = loadMoreButton();
      await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));

      const before = mocked.listNotifications.mock.calls.length;
      await user.click(button);
      expect(mocked.listNotifications.mock.calls.length).toBe(before);
      expect(rowTitles()).toHaveLength(20);

      refresh.resolve(inbox.list({ page: 1 }));
      await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
      await user.click(button);
      await waitFor(() => expect(rowTitles()).toHaveLength(40));
      expect(pagesRequested().filter((p) => p === 2)).toHaveLength(1);
    });

    it('opening the panel while page 2 is in flight joins that request: nothing is cancelled, duplicated or lost', async () => {
      const inbox = installInbox();
      const user = userEvent.setup();
      renderBell();
      await openBell(user);
      await screen.findByText('u1 notification 01');

      const page2 = deferred<InboxResponse>();
      mocked.listNotifications.mockImplementation(async (params: { page?: number }) =>
        params.page === 2 ? page2.promise : inbox.list(params)
      );
      await user.click(loadMoreButton());
      await waitFor(() => expect(pagesRequested().filter((p) => p === 2)).toHaveLength(1));
      const before = mocked.listNotifications.mock.calls.length;

      await user.click(screen.getByRole('button', { name: /^Notifications/ })); // close
      await user.click(screen.getByRole('button', { name: /^Notifications/ })); // reopen -> refetch({cancelRefetch:false})
      await new Promise((r) => setTimeout(r, 30));
      expect(mocked.listNotifications.mock.calls.length).toBe(before);

      page2.resolve(inbox.list({ page: 2 }));
      await waitFor(() => expect(rowTitles()).toHaveLength(40));
      expect(pagesRequested().filter((p) => p === 2)).toHaveLength(1);
    });
  });

  describe('next-page failure and retry', () => {
    it('keeps every loaded row, says so accessibly, and Retry loads the page; announcements track each step', async () => {
      const inbox = installInbox();
      let failPage2 = true;
      mocked.listNotifications.mockImplementation(async (params: { page?: number }) => {
        if (params.page === 2 && failPage2) throw new Error('boom');
        return inbox.list(params);
      });
      const user = userEvent.setup();
      renderBell();
      await openBell(user);
      await screen.findByText('u1 notification 01');

      await user.click(loadMoreButton());
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load more notifications.");
      expect(rowTitles()).toHaveLength(20); // loaded content is kept
      expect(screen.getByRole('status')).toHaveTextContent('Failed to load more notifications.');
      // It is not reported as a failed REFRESH.
      expect(screen.queryByText(/Couldn't refresh/)).not.toBeInTheDocument();

      failPage2 = false;
      await user.click(screen.getByRole('button', { name: 'Retry loading more notifications' }));
      await waitFor(() => expect(rowTitles()).toHaveLength(40));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Loaded 20 more notifications.');
      expect(loadMoreButton()).toBeInTheDocument();
      expect(pagesRequested().filter((p) => p === 2)).toHaveLength(2); // the failure and the retry
    });
  });

  describe('single flight', () => {
    // Both activations happen inside ONE act() so React cannot re-render — and
    // so the button cannot become aria-disabled — between them: the second one
    // reaches the handler with exactly the state the first one saw.
    it('two same-tick activations of Load more send ONE request', async () => {
      installInbox();
      const user = userEvent.setup();
      renderBell();
      await openBell(user);
      await screen.findByText('u1 notification 01');

      const button = loadMoreButton();
      act(() => {
        button.click();
        button.click();
      });
      await waitFor(() => expect(rowTitles()).toHaveLength(40));
      expect(pagesRequested().filter((p) => p === 2)).toHaveLength(1);
      // Two pages' worth of rows, not three: the second click did not page again.
      expect(pagesRequested().filter((p) => p === 3)).toHaveLength(0);
    });

    it('two same-tick activations of the failed-page Retry send ONE request', async () => {
      const inbox = installInbox();
      let failPage2 = true;
      mocked.listNotifications.mockImplementation(async (params: { page?: number }) => {
        if (params.page === 2 && failPage2) throw new Error('boom');
        return inbox.list(params);
      });
      const user = userEvent.setup();
      renderBell();
      await openBell(user);
      await screen.findByText('u1 notification 01');
      await user.click(loadMoreButton());
      const retry = await screen.findByRole('button', { name: 'Retry loading more notifications' });
      expect(pagesRequested().filter((p) => p === 2)).toHaveLength(1);

      failPage2 = false;
      act(() => {
        retry.click();
        retry.click();
      });
      await waitFor(() => expect(rowTitles()).toHaveLength(40));
      expect(pagesRequested().filter((p) => p === 2)).toHaveLength(2); // the failure + ONE retry
    });

    it('Load more immediately followed by Retry in the same tick still sends one request', async () => {
      const inbox = installInbox();
      mocked.listNotifications.mockImplementation(async (params: { page?: number }) => {
        if (params.page === 2) throw new Error('boom');
        return inbox.list(params);
      });
      const user = userEvent.setup();
      renderBell();
      await openBell(user);
      await screen.findByText('u1 notification 01');
      await user.click(loadMoreButton());
      await screen.findByRole('button', { name: 'Retry loading more notifications' });
      mocked.listNotifications.mockClear();

      // The same control, addressed twice under two names: still one in flight.
      const control = screen.getByRole('button', { name: 'Retry loading more notifications' });
      act(() => {
        control.click();
        control.click();
        control.click();
      });
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Failed to load more notifications.'));
      expect(pagesRequested()).toEqual([2]);
    });
  });

  describe('refresh failure', () => {
    it('a failed background refresh keeps EVERY loaded page, warns, and Retry re-fetches them all', async () => {
      const inbox = installInbox();
      const user = userEvent.setup();
      renderBell();
      await openBell(user);
      await screen.findByText('u1 notification 01');
      await loadPages(user, [40]);

      let failRefresh = true;
      mocked.listNotifications.mockImplementation(async (params: { page?: number }) => {
        if (failRefresh) throw new Error('blip');
        return inbox.list(params);
      });
      await user.click(screen.getByRole('button', { name: /^Notifications/ })); // close
      await user.click(screen.getByRole('button', { name: /^Notifications/ })); // reopen -> refresh fails

      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't refresh. Showing the last loaded notifications.");
      expect(rowTitles()).toHaveLength(40);
      expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();

      failRefresh = false;
      mocked.listNotifications.mockClear();
      await user.click(screen.getByRole('button', { name: 'Retry refreshing notifications' }));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(pagesRequested()).toEqual([1, 2]);
      expect(rowTitles()).toHaveLength(40);
    });

    it('an EMPTY cached inbox followed by a failed refresh still shows the warning and a working Retry', async () => {
      mocked.listNotifications.mockResolvedValueOnce(page([], 0));
      const user = userEvent.setup();
      renderBell();
      await screen.findByRole('button', { name: 'Notifications' });

      mocked.listNotifications.mockRejectedValueOnce(new Error('down'));
      await user.click(screen.getByRole('button', { name: 'Notifications' })); // open -> refresh fails

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("Couldn't refresh.");
      // The empty state is not asserted as fact while the refresh is failing.
      expect(screen.queryByText("You're all caught up.")).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry refreshing notifications' })).toBeInTheDocument();

      mocked.listNotifications.mockResolvedValueOnce(page([UNREAD_A], 1));
      await user.click(screen.getByRole('button', { name: 'Retry refreshing notifications' }));
      expect(await screen.findByText('Group invitation')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});

// ─── Keyboard focus ─────────────────────────────────────────────────────────

describe('NotificationBell — keyboard focus', () => {
  it('pending pagination keeps the focused control focused and USABLE: aria-disabled, never native disabled', async () => {
    const inbox = installInbox();
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');

    const page2 = deferred<InboxResponse>();
    mocked.listNotifications.mockImplementation(async (params: { page?: number }) =>
      params.page === 2 ? page2.promise : inbox.list(params)
    );
    const button = loadMoreButton();
    button.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
    expect(button).toHaveFocus();
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('Loading…');

    // Activating it again while pending neither sends a request nor loses focus.
    await user.keyboard('{Enter}');
    expect(pagesRequested().filter((p) => p === 2)).toHaveLength(1);
    expect(button).toHaveFocus();

    page2.resolve(inbox.list({ page: 2 }));
    await waitFor(() => expect(rowTitles()).toHaveLength(40));
    // More pages remain, so the control stays where it was, focused.
    expect(loadMoreButton()).toBe(button);
    expect(button).toHaveFocus();
    expect(button).not.toHaveAttribute('aria-disabled');
  });

  it('when the FINAL Load more disappears, focus moves to the first newly appended actionable notification', async () => {
    installInbox(); // page 3 holds exactly one row, n41 — unread
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');
    await loadPages(user, [40]);

    loadMoreButton().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(rowTitles()).toHaveLength(41));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    const appended = screen.getByText('u1 notification 41').closest('li') as HTMLElement;
    await waitFor(() => expect(within(appended).getByRole('button', { name: 'Mark as read' })).toHaveFocus());
  });

  it('skips already-read new rows: focus lands on the first new row that can be ACTED on', async () => {
    // Page 2 (rows 21-25): only row 24 is unread.
    installInbox(createInbox(makeRows('u1', 25, (i) => i < 20 || i === 23)));
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');

    loadMoreButton().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(rowTitles()).toHaveLength(25));

    const row24 = screen.getByText('u1 notification 24').closest('li') as HTMLElement;
    await waitFor(() => expect(within(row24).getByRole('button', { name: 'Mark as read' })).toHaveFocus());
  });

  it('when nothing new is actionable, focus lands on the first newly appended ROW, a stable place to continue from', async () => {
    installInbox(createInbox(makeRows('u1', 25, (i) => i < 20)));
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');

    loadMoreButton().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(rowTitles()).toHaveLength(25));

    const row21 = screen.getByText('u1 notification 21').closest('li') as HTMLElement;
    await waitFor(() => expect(row21).toHaveFocus());
  });

  it('when the final page adds nothing at all, focus falls back to the panel itself rather than being dropped on <body>', async () => {
    mocked.listNotifications.mockImplementation(async (params: { page?: number }) =>
      params.page === 2
        ? { success: true, data: [], meta: { page: 2, limit: 20, total: 20, totalPages: 1, hasNextPage: false, hasPrevPage: true, unreadCount: 3 } }
        : { ...page(makeRows('u1', 20, () => true), 3), meta: { page: 1, limit: 20, total: 40, totalPages: 2, hasNextPage: true, hasPrevPage: false, unreadCount: 3 } }
    );
    const user = userEvent.setup();
    renderBell();
    const region = await openBell(user);
    await screen.findByText('u1 notification 01');

    loadMoreButton().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument());
    await waitFor(() => expect(region).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('No more notifications to load.');
  });

  it('a POINTER activation never moves focus (only a focused control can have its focus repaired)', async () => {
    installInbox(createInbox(makeRows('u1', 25, () => true)));
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.click(loadMoreButton()); // synthetic click: does not focus the button
    await waitFor(() => expect(rowTitles()).toHaveLength(25));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });

  it('does not pull focus back if the user has already moved elsewhere in the panel while the page loaded', async () => {
    const inbox = installInbox(createInbox(makeRows('u1', 25, () => true)));
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');

    const page2 = deferred<InboxResponse>();
    mocked.listNotifications.mockImplementation(async (params: { page?: number }) =>
      params.page === 2 ? page2.promise : inbox.list(params)
    );
    loadMoreButton().focus();
    await user.keyboard('{Enter}');
    const markAll = screen.getByRole('button', { name: 'Mark all read' });
    markAll.focus();

    page2.resolve(inbox.list({ page: 2 }));
    await waitFor(() => expect(rowTitles()).toHaveLength(25));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument());
    expect(markAll).toHaveFocus();
  });

  it('a failed page keeps focus on the same control, now labelled Retry; a successful retry keeps it there', async () => {
    const inbox = installInbox();
    let failPage2 = true;
    mocked.listNotifications.mockImplementation(async (params: { page?: number }) => {
      if (params.page === 2 && failPage2) throw new Error('boom');
      return inbox.list(params);
    });
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');

    const control = loadMoreButton();
    control.focus();
    await user.keyboard('{Enter}');
    const retry = await screen.findByRole('button', { name: 'Retry loading more notifications' });
    expect(retry).toBe(control); // the same element, so focus never left it
    expect(retry).toHaveFocus();

    failPage2 = false;
    await user.keyboard('{Enter}');
    await waitFor(() => expect(rowTitles()).toHaveLength(40));
    expect(retry).toHaveFocus();
    expect(retry).toHaveAccessibleName('Load more');
  });

  it('Retry on a failed refresh: success moves focus into the refreshed list, failure leaves it on Retry', async () => {
    const inbox = installInbox();
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');

    let failRefresh = true;
    mocked.listNotifications.mockImplementation(async (params: { page?: number }) => {
      if (failRefresh) throw new Error('blip');
      return inbox.list(params);
    });
    await user.click(screen.getByRole('button', { name: /^Notifications/ })); // close
    await user.click(screen.getByRole('button', { name: /^Notifications/ })); // reopen -> fails
    const retry = await screen.findByRole('button', { name: 'Retry refreshing notifications' });

    retry.focus();
    await user.keyboard('{Enter}'); // still failing
    await waitFor(() => expect(mocked.listNotifications.mock.calls.length).toBeGreaterThan(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry refreshing notifications' })).toHaveFocus());

    failRefresh = false;
    await user.keyboard('{Enter}'); // succeeds: the banner (and this button) go away
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    const first = screen.getByText('u1 notification 01').closest('li') as HTMLElement;
    await waitFor(() => expect(within(first).getByRole('button', { name: 'Mark as read' })).toHaveFocus());
  });

  it('a Retry that is still running keeps its banner and its focus: the same element, aria-disabled, labelled "Retrying…"', async () => {
    const inbox = installInbox();
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');

    mocked.listNotifications.mockImplementation(async () => {
      throw new Error('blip');
    });
    await user.click(screen.getByRole('button', { name: /^Notifications/ })); // close
    await user.click(screen.getByRole('button', { name: /^Notifications/ })); // reopen -> refresh fails
    const retry = await screen.findByRole('button', { name: 'Retry refreshing notifications' });

    const hold = deferred<InboxResponse>();
    mocked.listNotifications.mockImplementation(async (params: { page?: number }) =>
      params.page === 1 ? hold.promise : inbox.list(params)
    );
    retry.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(retry).toHaveAttribute('aria-disabled', 'true'));
    expect(retry).toBeInTheDocument();
    expect(retry).toHaveFocus(); // not dropped on <body> while the request runs
    expect(retry).toHaveTextContent('Retrying…');
    expect(retry).not.toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't refresh.");
    expect(rowTitles()).toHaveLength(20); // loaded content stays throughout

    // Pressing it again while it runs sends nothing.
    const before = mocked.listNotifications.mock.calls.length;
    await user.keyboard('{Enter}');
    expect(mocked.listNotifications.mock.calls.length).toBe(before);

    hold.resolve(inbox.list({ page: 1 }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    const first = screen.getByText('u1 notification 01').closest('li') as HTMLElement;
    await waitFor(() => expect(within(first).getByRole('button', { name: 'Mark as read' })).toHaveFocus());
  });

  it('a failed INITIAL load: Retry stays mounted and focused while it retries; it lands focus in the list on success, and announces a repeat failure', async () => {
    mocked.listNotifications.mockRejectedValue(new Error('down'));
    const user = userEvent.setup();
    renderBell();
    await user.click(await screen.findByRole('button', { name: 'Notifications' }));
    const retry = await screen.findByRole('button', { name: 'Retry' });

    const hold = deferred<unknown>();
    mocked.listNotifications.mockImplementation(async () => {
      await hold.promise;
      throw new Error('still down');
    });
    retry.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(retry).toHaveAttribute('aria-disabled', 'true'));
    expect(retry).toBeInTheDocument();
    expect(retry).toHaveFocus();
    expect(retry).toHaveTextContent('Retrying…');
    // Still the error view — not swapped for "Loading notifications…" under the user's focus.
    expect(screen.queryByText('Loading notifications…')).not.toBeInTheDocument();

    hold.resolve(undefined);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Failed to load notifications.'));
    expect(retry).toHaveFocus(); // the failure changed nothing on screen except the label

    mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 1));
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Group invitation')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark as read' })).toHaveFocus());
  });

  it('after a failed NEXT page, opening the panel refreshes without a misleading "Couldn\'t refresh" banner', async () => {
    const inbox = installInbox();
    let failPage2 = true;
    mocked.listNotifications.mockImplementation(async (params: { page?: number }) => {
      if (params.page === 2 && failPage2) throw new Error('boom');
      return inbox.list(params);
    });
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');
    await user.click(loadMoreButton());
    await screen.findByRole('button', { name: 'Retry loading more notifications' });

    // Hold the refresh that reopening triggers: while it runs the retained
    // page error must not be re-labelled as a failed refresh.
    const hold = deferred<InboxResponse>();
    mocked.listNotifications.mockImplementation(async (params: { page?: number }) =>
      params.page === 1 ? hold.promise : inbox.list(params)
    );
    await user.click(screen.getByRole('button', { name: /^Notifications/ })); // close
    await user.click(screen.getByRole('button', { name: /^Notifications/ })); // reopen -> refresh in flight
    await waitFor(() => expect(screen.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-busy', 'true'));
    expect(screen.queryByText(/Couldn't refresh/)).not.toBeInTheDocument();

    failPage2 = false;
    hold.resolve(inbox.list({ page: 1 }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('marking a row read with the keyboard leaves focus on that row instead of dropping it on <body>', async () => {
    installInbox();
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');

    const row = screen.getByText('u1 notification 01').closest('li') as HTMLElement;
    const button = within(row).getByRole('button', { name: 'Mark as read' });
    button.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(within(row).queryByRole('button', { name: 'Mark as read' })).not.toBeInTheDocument());
    await waitFor(() => expect(row).toHaveFocus());
    expect(document.body).not.toHaveFocus();
  });

  it('"Mark all read" keeps focus while its request is pending and after the unread count reaches zero', async () => {
    const inbox = installInbox();
    const user = userEvent.setup();
    renderBell();
    await openBell(user);
    await screen.findByText('u1 notification 01');

    const gate = deferred<unknown>();
    mocked.markAllNotificationsRead.mockImplementation(async () => {
      await gate.promise;
      return inbox.markAll();
    });
    const markAll = screen.getByRole('button', { name: 'Mark all read' });
    markAll.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(markAll).toHaveAttribute('aria-disabled', 'true'));
    expect(markAll).toHaveFocus();

    gate.resolve(undefined);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument());
    expect(markAll).toHaveFocus();
    expect(markAll).toHaveAttribute('aria-disabled', 'true'); // nothing left to mark
    expect(markAll).not.toBeDisabled();
  });

  it('Escape pressed from an UNRELATED control closes the panel but does not steal that control\'s focus', async () => {
    mocked.listNotifications.mockResolvedValue(page([UNREAD_A], 1));
    const user = userEvent.setup();
    render(
      <TestAuthProvider user={USER}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
          <label>
            Unrelated field
            <input />
          </label>
          <NotificationBell />
        </QueryClientProvider>
      </TestAuthProvider>
    );
    await user.click(await screen.findByRole('button', { name: /^Notifications/ }));
    await screen.findByRole('region', { name: 'Notifications' });

    const field = screen.getByLabelText('Unrelated field');
    field.focus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(field).toHaveFocus();
  });
});
