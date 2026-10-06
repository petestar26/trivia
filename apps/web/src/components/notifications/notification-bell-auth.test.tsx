import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationBell } from './notification-bell';
import { AuthProvider, useAuth } from '@/providers/auth-provider';
import { deferred, makeRows, serveInboxPage, type Deferred } from '@/test/notification-fixtures';

// The bell inside the REAL AuthProvider: sign in as A, page, sign out, sign in
// as B, then let A's held request answer. (The isolation that does not lean on
// the provider is in notification-bell-identity.test.tsx.)

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    listNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
  },
}));

import { api } from '@/lib/api';

const mocked = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  listNotifications: ReturnType<typeof vi.fn>;
};

const ACCOUNTS: Record<string, { id: string; username: string; email: string }> = {
  'a@example.test': { id: 'userA', username: 'a', email: 'a@example.test' },
  'b@example.test': { id: 'userB', username: 'b', email: 'b@example.test' },
};

const inboxes: Record<string, ReturnType<typeof makeRows>> = {
  userA: makeRows('userA', 25, () => true),
  userB: makeRows('userB', 3, () => true),
};

let session: string | null = null;
let holdA2: Deferred<void> | null = null;
let heldSignal: AbortSignal | undefined;

function Controls() {
  const { login, logout } = useAuth();
  return (
    <div>
      <button onClick={() => void login('a@example.test', 'pw')}>sign in as A</button>
      <button onClick={() => void login('b@example.test', 'pw')}>sign in as B</button>
      <button onClick={() => void logout()}>sign out</button>
    </div>
  );
}

function App({ client }: { client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Controls />
        <NotificationBell />
      </AuthProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  session = null;
  holdA2 = null;
  heldSignal = undefined;
  mocked.get.mockRejectedValue(new Error('401')); // the initial /auth/me probe: anonymous
  mocked.post.mockImplementation(async (url: string, body?: { email?: string }) => {
    if (url === '/auth/login') {
      const account = ACCOUNTS[body?.email ?? ''];
      session = account.id;
      return { success: true, data: { user: account } };
    }
    if (url === '/auth/logout') {
      session = null;
      return { success: true };
    }
    throw new Error(`unexpected POST ${url}`);
  });
  mocked.listNotifications.mockImplementation(async (params: { page?: number }, opts?: { signal?: AbortSignal }) => {
    const who = session!; // the cookie at the moment of the request
    const response = serveInboxPage(inboxes[who], params);
    if (who === 'userA' && params.page === 2 && holdA2) {
      heldSignal = opts?.signal;
      await holdA2.promise;
    }
    return response;
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('NotificationBell inside the real AuthProvider', () => {
  it('A pages, signs out, B signs in and settles, then A\'s held page 2 answers: no trace of A anywhere B can see', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } } });
    const user = userEvent.setup();
    render(<App client={client} />);

    // Anonymous: the bell is not rendered and nothing is requested.
    await screen.findByRole('button', { name: 'sign in as A' });
    expect(screen.queryByRole('button', { name: /^Notifications/ })).not.toBeInTheDocument();
    expect(mocked.listNotifications).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'sign in as A' }));
    await screen.findByRole('button', { name: 'Notifications, 25 unread' });
    await user.click(screen.getByRole('button', { name: /^Notifications/ }));
    await screen.findByText('userA notification 01');
    holdA2 = deferred<void>();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(heldSignal).toBeDefined());

    await user.click(screen.getByRole('button', { name: 'sign out' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Notifications/ })).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'sign in as B' }));
    await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    await user.click(screen.getByRole('button', { name: /^Notifications/ }));
    await screen.findByText('userB notification 01');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Notifications' })).toHaveAttribute('aria-busy', 'false'));

    holdA2.resolve();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });

    expect(document.body.textContent).not.toContain('userA');
    expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Notifications' })).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    for (const q of client.getQueryCache().getAll()) {
      expect(q.queryKey[1]).toBe('userB');
      expect(JSON.stringify(q.state.data ?? null)).not.toContain('userA');
    }
  });

  it('a fresh sign-in after sign-out starts from an empty inbox: the previous account\'s badge and rows never flash', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } } });
    const user = userEvent.setup();
    render(<App client={client} />);
    await screen.findByRole('button', { name: 'sign in as A' });

    await user.click(screen.getByRole('button', { name: 'sign in as A' }));
    await screen.findByRole('button', { name: 'Notifications, 25 unread' });
    await user.click(screen.getByRole('button', { name: 'sign out' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Notifications/ })).not.toBeInTheDocument());

    // B's first request is held: until it answers, B must see NOTHING of A —
    // not A's badge, not A's rows.
    const hold = deferred<void>();
    const original = mocked.listNotifications.getMockImplementation()!;
    mocked.listNotifications.mockImplementation(async (params: { page?: number }, opts?: { signal?: AbortSignal }) => {
      const response = await original(params, opts);
      if (session === 'userB') await hold.promise;
      return response;
    });
    await user.click(screen.getByRole('button', { name: 'sign in as B' }));
    await screen.findByRole('button', { name: 'Notifications' }); // loading: no count yet
    await user.click(screen.getByRole('button', { name: /^Notifications/ }));
    expect(screen.getByText('Loading notifications…')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('userA');
    expect(screen.queryByText(/25/)).not.toBeInTheDocument();

    hold.resolve();
    await screen.findByText('userB notification 01');
    expect(document.body.textContent).not.toContain('userA');
  });
});
