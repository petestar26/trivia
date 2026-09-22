import { QueryClient, QueryClientProvider, isCancelledError } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NotificationInfo } from '@socialplay/shared';
import { NotificationBell } from './notification-bell';
import { TestAuthProvider, type TestUser } from '@/test/test-auth';
import { deferred, makeRows, serveInboxPage, type Deferred } from '@/test/notification-fixtures';
import { notificationsInboxKey, purgeForeignNotificationScopes } from '@/lib/notifications-query-keys';

// Cross-account isolation of the notification inbox.
//
// Every test here moves between accounts on ONE QueryClient that is NEVER
// cleared — unlike the real AuthProvider, which clears the whole cache at each
// identity boundary. The point is that the bell's isolation must not depend on
// that clear (see notification-bell-auth.test.tsx for the composed system).
//
// The fake server answers with the inbox of whoever holds the session AT THE
// MOMENT THE REQUEST IS MADE, exactly as a cookie-authenticated API does, and
// every request can be held open and released later — so "account A's response
// arrives after account B has taken over" is a real, ordered event here.

vi.mock('@/lib/api', () => ({
  api: {
    listNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
  },
}));

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

const A: TestUser = { id: 'userA', username: 'a' };
const B: TestUser = { id: 'userB', username: 'b' };

interface HeldRequest {
  seq: number;
  user: string;
  page: number;
  signal: AbortSignal | undefined;
  gate: Deferred<void>;
}

const world = {
  session: 'userA',
  inboxes: {} as Record<string, NotificationInfo[]>,
  /** Requests are held open when `hold` says so for (user, page); otherwise answered at once. */
  hold: (_user: string, _page: number): boolean => false,
  requests: [] as HeldRequest[],
  marks: [] as { user: string; id: string; gate: Deferred<void> | null }[],
  holdMarks: false,
};

function installServer() {
  let seq = 0;
  mocked.listNotifications.mockImplementation(async (params: { page?: number; limit?: number }, opts?: { signal?: AbortSignal }) => {
    const user = world.session; // decided at request time, like a cookie
    const page = params.page ?? 1;
    const response = serveInboxPage(world.inboxes[user] ?? [], params);
    const held: HeldRequest = { seq: seq++, user, page, signal: opts?.signal, gate: deferred<void>() };
    world.requests.push(held);
    if (world.hold(user, page)) await held.gate.promise;
    return response;
  });
  mocked.markNotificationRead.mockImplementation(async (id: string) => {
    const entry = { user: world.session, id, gate: world.holdMarks ? deferred<void>() : null };
    world.marks.push(entry);
    if (entry.gate) await entry.gate.promise;
    return { success: true, data: { id } };
  });
  mocked.markAllNotificationsRead.mockImplementation(async () => {
    const entry = { user: world.session, id: '*', gate: world.holdMarks ? deferred<void>() : null };
    world.marks.push(entry);
    if (entry.gate) await entry.gate.promise;
    return { success: true, data: { updated: 0 } };
  });
}

const requestsOf = (user: string, page?: number) =>
  world.requests.filter((r) => r.user === user && (page === undefined || r.page === page));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 25)); });

function Harness({ client, user }: { client: QueryClient; user: TestUser | null }) {
  return (
    <TestAuthProvider user={user}>
      <QueryClientProvider client={client}>
        <NotificationBell />
      </QueryClientProvider>
    </TestAuthProvider>
  );
}

// gcTime is long on purpose: an account's cached inbox is STILL IN the cache
// when the next account arrives, which is the condition under test.
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } } });

/** Everything an account-B viewer can see or observe through the cache. */
function cacheSnapshot(client: QueryClient) {
  return client
    .getQueryCache()
    .getAll()
    .map((q) => ({ key: q.queryKey as readonly unknown[], data: JSON.stringify(q.state.data ?? null), error: q.state.error }));
}

beforeEach(() => {
  world.session = 'userA';
  world.inboxes = {
    userA: makeRows('userA', 25, () => true), // two pages
    userB: makeRows('userB', 3, () => true), // one page
  };
  world.hold = () => false;
  world.requests = [];
  world.marks = [];
  world.holdMarks = false;
  installServer();
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const bell = () => screen.getByRole('button', { name: /^Notifications/ });

/** A is signed in, has opened the panel, and has a page-2 request held open. */
async function startAWithHeldPageTwo(client: QueryClient) {
  const view = render(<Harness client={client} user={A} />);
  const user = userEvent.setup();
  await screen.findByRole('button', { name: 'Notifications, 25 unread' });
  await user.click(bell());
  await screen.findByText('userA notification 01');
  world.hold = (u, p) => u === 'userA' && p === 2;
  await user.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(requestsOf('userA', 2)).toHaveLength(1));
  return { ...view, user, held: requestsOf('userA', 2)[0] };
}

/** Nothing that belongs to account A may be observable anywhere account B can look. */
function expectNoTraceOf(client: QueryClient, who: string) {
  expect(document.body.textContent ?? '').not.toContain(who);
  for (const entry of cacheSnapshot(client)) {
    expect(entry.data, `cache entry ${JSON.stringify(entry.key)} carries ${who} data`).not.toContain(who);
    expect(entry.key[1], 'a cache entry is scoped to the wrong account').not.toBe(who);
  }
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
}

describe('NotificationBell — cross-account isolation on a QueryClient that is never cleared', () => {
  it('A starts a delayed page 2, signs out, B signs in and settles — then A\'s page 2 arrives: nothing of A enters B\'s UI or cache', async () => {
    const client = newClient();
    const { rerender, user, held } = await startAWithHeldPageTwo(client);

    // A signs out (the header unmounts), B signs in on the same QueryClient.
    world.session = 'userB';
    rerender(<Harness client={client} user={null} />);
    rerender(<Harness client={client} user={B} />);
    await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    await user.click(bell());
    await screen.findByText('userB notification 01');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-busy', 'false'));

    // A's request was aborted at the network level when A's inbox was torn down...
    expect(held.signal?.aborted).toBe(true);

    // ...and even if a late response is delivered anyway, it lands nowhere.
    held.gate.resolve();
    await flush();

    expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Notifications' })).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument(); // no pagination metadata from A
    expect(screen.getByRole('status')).toHaveTextContent(''); // no "Loaded 5 more notifications." from A
    expectNoTraceOf(client, 'userA');
    // B's own entry is B's alone: one page, cursor at 1.
    const b = client.getQueryCache().find({ queryKey: notificationsInboxKey('userB', 20) })!;
    expect((b.state.data as { pages: unknown[]; pageParams: number[] }).pages).toHaveLength(1);
    expect((b.state.data as { pageParams: number[] }).pageParams).toEqual([1]);
  });

  it('the same, when A\'s held page-2 request FAILS late: no error, alert or "Failed to load more" reaches B', async () => {
    const client = newClient();
    const { rerender, user, held } = await startAWithHeldPageTwo(client);

    world.session = 'userB';
    rerender(<Harness client={client} user={null} />);
    rerender(<Harness client={client} user={B} />);
    await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    await user.click(bell());
    await screen.findByText('userB notification 01');

    // Make the held request fail the way a dropped connection would.
    world.requests.find((r) => r.seq === held.seq)!.gate.reject(new Error('A connection lost'));
    await flush();

    expect(screen.queryByText(/Failed to load more/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
    expectNoTraceOf(client, 'userA');
    for (const entry of cacheSnapshot(client)) expect(entry.error).toBeNull();
  });

  it('switching accounts with no signed-out gap in between behaves the same', async () => {
    const client = newClient();
    const { rerender, user, held } = await startAWithHeldPageTwo(client);

    world.session = 'userB';
    rerender(<Harness client={client} user={B} />); // A -> B in a single render
    await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    await user.click(bell());
    await screen.findByText('userB notification 01');

    held.gate.resolve();
    await flush();
    expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
    expectNoTraceOf(client, 'userA');
  });

  it("A -> B -> A: A's second session shows only A's data, and B's late response never reaches it", async () => {
    const client = newClient();
    const { rerender, held: heldA1 } = await startAWithHeldPageTwo(client);

    // B signs in; B's first page request is held open.
    world.session = 'userB';
    world.hold = (u) => u === 'userB';
    rerender(<Harness client={client} user={B} />);
    await waitFor(() => expect(requestsOf('userB', 1)).toHaveLength(1));
    const heldB1 = requestsOf('userB', 1)[0];

    // A signs back in before B's request has answered.
    world.session = 'userA';
    world.hold = () => false;
    rerender(<Harness client={client} user={A} />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Notifications, 25 unread' });
    await user.click(bell());
    await screen.findByText('userA notification 01');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-busy', 'false'));

    // Both stale requests now answer, oldest first and then newest first.
    heldB1.gate.resolve();
    heldA1.gate.resolve();
    await flush();

    expect(screen.getByRole('button', { name: 'Notifications, 25 unread' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Notifications' })).getAllByRole('listitem')).toHaveLength(20);
    expectNoTraceOf(client, 'userB');
    // A's cursor is A's own fresh one: page 2 has not been fetched in this session.
    const a = client.getQueryCache().find({ queryKey: notificationsInboxKey('userA', 20) })!;
    expect((a.state.data as { pageParams: number[] }).pageParams).toEqual([1]);
  });

  it('rapid A -> B -> A -> B -> signed out -> B, every request answering in scrambled order: the final UI is B\'s alone', async () => {
    const client = newClient();
    world.hold = () => true; // every request is held until the test releases it
    const view = render(<Harness client={client} user={A} />);
    const sequence: Array<[string, TestUser | null]> = [
      ['userB', B],
      ['userA', A],
      ['userB', B],
      ['userB', null],
      ['userB', B],
    ];
    for (const [session, who] of sequence) {
      world.session = session;
      view.rerender(<Harness client={client} user={who} />);
    }
    await waitFor(() => expect(world.requests.length).toBeGreaterThanOrEqual(5));

    // Release in an order that puts the OLDEST accounts' answers last.
    const mine = world.requests.slice();
    const order = [...mine].sort((x, y) => y.seq - x.seq);
    world.hold = () => false;
    for (const r of order) r.gate.resolve();
    await flush();

    await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    const user = userEvent.setup();
    await user.click(bell());
    await screen.findByText('userB notification 01');
    expect(within(screen.getByRole('region', { name: 'Notifications' })).getAllByRole('listitem')).toHaveLength(3);
    expectNoTraceOf(client, 'userA');
  });

  describe('mutations are bound to the identity that started them', () => {
    async function aClicksMarkReadThenBTakesOver(client: QueryClient) {
      const view = render(<Harness client={client} user={A} />);
      const user = userEvent.setup();
      await screen.findByRole('button', { name: 'Notifications, 25 unread' });
      await user.click(bell());
      await screen.findByText('userA notification 01');
      world.holdMarks = true;
      return { ...view, user };
    }

    it("A's late 'mark as read' response does not touch B's inbox: no refetch, no count change, no announcement", async () => {
      const client = newClient();
      const { rerender, user } = await aClicksMarkReadThenBTakesOver(client);
      const row = screen.getByText('userA notification 01').closest('li') as HTMLElement;
      await user.click(within(row).getByRole('button', { name: 'Mark as read' }));
      await waitFor(() => expect(world.marks).toHaveLength(1));

      world.session = 'userB';
      rerender(<Harness client={client} user={null} />);
      rerender(<Harness client={client} user={B} />);
      await screen.findByRole('button', { name: 'Notifications, 3 unread' });
      await user.click(bell());
      await screen.findByText('userB notification 01');
      await waitFor(() => expect(screen.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-busy', 'false'));

      const beforeCalls = mocked.listNotifications.mock.calls.length;
      world.marks[0].gate!.resolve();
      await flush();

      // B's inbox was neither invalidated (no refetch) nor patched.
      expect(mocked.listNotifications.mock.calls.length).toBe(beforeCalls);
      expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
      expect(within(screen.getByRole('region', { name: 'Notifications' })).getAllByRole('button', { name: 'Mark as read' })).toHaveLength(3);
      expect(screen.getByRole('status')).toHaveTextContent(''); // A's "Notification marked as read." is not B's
      expectNoTraceOf(client, 'userA');
    });

    it("A's late 'mark ALL read' response does not mark B's notifications read", async () => {
      const client = newClient();
      const { rerender, user } = await aClicksMarkReadThenBTakesOver(client);
      await user.click(screen.getByRole('button', { name: 'Mark all read' }));
      await waitFor(() => expect(world.marks).toHaveLength(1));

      world.session = 'userB';
      rerender(<Harness client={client} user={B} />);
      await screen.findByRole('button', { name: 'Notifications, 3 unread' });
      await user.click(bell());
      await screen.findByText('userB notification 01');
      await waitFor(() => expect(screen.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-busy', 'false'));

      const beforeCalls = mocked.listNotifications.mock.calls.length;
      world.marks[0].gate!.resolve();
      await flush();

      expect(mocked.listNotifications.mock.calls.length).toBe(beforeCalls);
      expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
      expect(within(screen.getByRole('region', { name: 'Notifications' })).getAllByRole('button', { name: 'Mark as read' })).toHaveLength(3);
    });
  });
});

describe('NotificationBell — identity is part of every query key, and the bell fails closed', () => {
  it('every notification query key is [\'notifications\', <the signed-in user id>, ...] — there is no shared inbox key', async () => {
    const client = newClient();
    render(<Harness client={client} user={A} />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Notifications, 25 unread' });
    await user.click(bell());
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('userA notification 25');

    const keys = client.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key[0]).toBe('notifications');
      expect(key[1]).toBe('userA');
    }
    // No identity-free key exists at all.
    expect(client.getQueryCache().find({ queryKey: ['notifications'], exact: true })).toBeUndefined();
    expect(client.getQueryCache().find({ queryKey: ['notifications', 'inbox'] })).toBeUndefined();
  });

  it('an account\'s queries are removed and cancelled when another account\'s bell is established', async () => {
    const client = newClient();
    const { rerender, held } = await startAWithHeldPageTwo(client);
    expect(client.getQueryCache().find({ queryKey: notificationsInboxKey('userA', 20) })).toBeDefined();

    world.session = 'userB';
    rerender(<Harness client={client} user={B} />);
    await screen.findByRole('button', { name: 'Notifications, 3 unread' });

    expect(client.getQueryCache().find({ queryKey: notificationsInboxKey('userA', 20) })).toBeUndefined();
    expect(held.signal?.aborted).toBe(true);
  });

  it("cancels an account's in-flight inbox fetch that was started ELSEWHERE and never touches the abort signal — when its bell is torn down", async () => {
    // Nothing but an explicit cancel can stop this one: the request is not the
    // bell's, its queryFn ignores the AbortSignal (so React Query's own
    // cancel-on-last-unsubscribe does not apply), and no other bell is
    // mounted to purge it.
    const client = newClient();
    const keyA = notificationsInboxKey('userA', 20);
    const gate = deferred<{ items: []; page: number; hasNextPage: boolean; unreadCount: number }>();
    void client
      .fetchInfiniteQuery({ queryKey: keyA, queryFn: () => gate.promise, initialPageParam: 1 })
      .catch(() => undefined);

    const { unmount } = render(<Harness client={client} user={A} />);
    await flush();
    expect(client.getQueryState(keyA)?.fetchStatus).toBe('fetching');

    unmount(); // the header is gone: sign-out
    gate.resolve({ items: [], page: 1, hasNextPage: false, unreadCount: 99 });
    await flush();

    expect(client.getQueryData(keyA)).toBeUndefined();
    expect(client.getQueryState(keyA)?.fetchStatus).not.toBe('fetching');
  });

  it('fails closed while the identity is unresolved: renders nothing and sends no request', async () => {
    const client = newClient();
    const { container, rerender } = render(<Harness client={client} user={null} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
    expect(mocked.listNotifications).not.toHaveBeenCalled();
    expect(client.getQueryCache().getAll()).toHaveLength(0);

    // An id that is present but empty is not an identity either.
    rerender(<Harness client={client} user={{ id: '', username: 'nobody' }} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
    expect(mocked.listNotifications).not.toHaveBeenCalled();

    // Once resolved, it loads — under that identity's key.
    rerender(<Harness client={client} user={A} />);
    await screen.findByRole('button', { name: 'Notifications, 25 unread' });
    expect(mocked.listNotifications).toHaveBeenCalledTimes(1);
  });

  it('signing out leaves nothing rendered and cancels the account\'s in-flight request', async () => {
    const client = newClient();
    const { rerender, held } = await startAWithHeldPageTwo(client);
    rerender(<Harness client={client} user={null} />);
    await flush();
    expect(screen.queryByRole('button', { name: /^Notifications/ })).not.toBeInTheDocument();
    expect(held.signal?.aborted).toBe(true);
  });

  describe('mark-read invalidation and patching reach ONLY the signed-in identity\'s key', () => {
    it('marking read leaves another account\'s cached inbox untouched — not invalidated, not patched, not refetched', async () => {
      const client = newClient();
      const user = userEvent.setup();
      render(<Harness client={client} user={A} />);
      await screen.findByRole('button', { name: 'Notifications, 25 unread' });
      await user.click(bell());
      await screen.findByText('userA notification 01');

      // Something else in the app has account B's inbox cached under B's key.
      const foreignKey = notificationsInboxKey('userB', 20);
      const foreignData = { pages: [{ items: [], page: 1, hasNextPage: false, unreadCount: 7 }], pageParams: [1] };
      client.setQueryData(foreignKey, foreignData);
      const before = client.getQueryState(foreignKey)!;
      const beforeCalls = mocked.listNotifications.mock.calls.length;

      const row = screen.getByText('userA notification 01').closest('li') as HTMLElement;
      await user.click(within(row).getByRole('button', { name: 'Mark as read' }));
      await waitFor(() => expect(mocked.markNotificationRead).toHaveBeenCalled());
      await flush();
      await user.click(screen.getByRole('button', { name: 'Mark all read' }));
      await waitFor(() => expect(mocked.markAllNotificationsRead).toHaveBeenCalled());
      await flush();

      const after = client.getQueryState(foreignKey)!;
      expect(after.data).toBe(foreignData);
      expect(after.isInvalidated).toBe(false);
      expect(after.dataUpdatedAt).toBe(before.dataUpdatedAt);
      // Every list request made since was for the signed-in account (server-side: A's session).
      expect(mocked.listNotifications.mock.calls.length).toBeGreaterThan(beforeCalls);
      expect(world.requests.every((r) => r.user === 'userA')).toBe(true);
    });
  });
});

describe('purgeForeignNotificationScopes', () => {
  it('removes (and cancels) every notification query except the kept identity\'s; null removes them all; other queries are untouched', async () => {
    const client = newClient();
    const signal = { current: undefined as AbortSignal | undefined };
    const started = deferred<void>();
    // A query for A that is genuinely in flight.
    const inFlight = client
      .fetchQuery({
        queryKey: notificationsInboxKey('userA', 20),
        queryFn: async ({ signal: s }) => {
          signal.current = s;
          started.resolve();
          await new Promise(() => {});
        },
      })
      .then(() => 'settled', (e: unknown) => (isCancelledError(e) ? 'cancelled' : 'failed'));
    await started.promise;
    client.setQueryData(notificationsInboxKey('userB', 20), { pages: [], pageParams: [] });
    client.setQueryData(['groups', 'g1'], { name: 'unrelated' });

    purgeForeignNotificationScopes(client, 'userB');
    expect(client.getQueryCache().find({ queryKey: notificationsInboxKey('userA', 20) })).toBeUndefined();
    expect(signal.current?.aborted).toBe(true);
    await expect(inFlight).resolves.toBe('cancelled'); // its caller is released, not left hanging
    expect(client.getQueryData(notificationsInboxKey('userB', 20))).toBeDefined();
    expect(client.getQueryData(['groups', 'g1'])).toBeDefined();

    purgeForeignNotificationScopes(client, null);
    expect(client.getQueryData(notificationsInboxKey('userB', 20))).toBeUndefined();
    expect(client.getQueryData(['groups', 'g1'])).toBeDefined();
  });
});
