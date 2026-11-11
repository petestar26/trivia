import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as ApiModule from '@/lib/api';
import { AuthProvider } from '@/providers/auth-provider';
import { App } from './App';
import { createLaunchIntent } from '@/lib/launch-intent';
import { installMemoryStorage } from '@/test/memory-storage';
const { get, post, launch, leave } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  launch: vi.fn(),
  leave: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: { get, post },
}));
vi.mock('@/lib/sports-launch', () => ({
  requestSportsLaunch: launch,
  navigateToSportsbook: leave,
}));
vi.mock('@/pages/sports', () => ({ SportsPage: () => <h1>Member sports lobby</h1> }));
vi.mock('@/pages/casino', () => ({ CasinoPage: () => <h1>Member casino lobby</h1> }));
vi.mock('@/pages/group-detail', () => ({ GroupDetailPage: () => <h1>Member group detail</h1> }));
vi.mock('@/pages/groups', () => ({ GroupsPage: () => <h1>Member groups</h1> }));
vi.mock('@/pages/messages', () => ({ MessagesPage: () => <h1>Member messages</h1> }));
vi.mock('@/pages/play-together', () => ({ PlayTogetherPage: () => <h1>Member game lobby</h1> }));
vi.mock('@/pages/wallet-routes', () => ({ WalletRoutes: () => <h1>Member wallet</h1> }));
vi.mock('@/pages/group-invite-accept', () => ({
  GroupInviteAcceptPage: () => <h1>Member invitation</h1>,
}));
vi.mock('@/components/notifications/notification-bell', () => ({
  NotificationBell: () => <span>Member notifications</span>,
}));
// Keep the real identity transition/remount and redirect timing, without real credentials.
vi.mock('@/pages/login', async () => {
  const { useAuth } = await import('@/providers/auth-provider');
  const { useLocation, useNavigate } = await import('react-router-dom');
  const { safeReturnTo } = await import('@/lib/safe-return-to');
  return {
    LoginPage: () => {
      const { login } = useAuth();
      const location = useLocation();
      const navigate = useNavigate();
      return (
        <button
          onClick={async () => {
            await login('test@example.test', 'synthetic-password');
            navigate(safeReturnTo(location.state?.from), { replace: true });
          }}
        >
          Simulate successful sign-in
        </button>
      );
    },
  };
});
let back: () => void;
let visit: ReturnType<typeof useNavigate>;
function Address() {
  const location = useLocation();
  const navigate = useNavigate();
  visit = navigate;
  back = () => navigate(-1);
  return (
    <div data-testid="path">
      {location.pathname}
      {location.search}
      {location.hash}
    </div>
  );
}
function setup(path: string) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Address />
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const member = { id: 'synthetic-member', username: 'Member' };
beforeEach(() => {
  vi.clearAllMocks();
  launch.mockResolvedValue('https://sportsbook.example.test/synthetic-launch');
  post.mockImplementation(async (path: string) => ({
    success: true,
    data: path === '/auth/login' ? { user: member } : {},
  }));
});
afterEach(cleanup);
it.each(['/sports/open', '/Sports/open', '/%73ports/open'])(
  'preserves %s for an existing member and launches the clicked new tab only after the probe resolves',
  async (base) => {
    // "Browse sports" created this one-time intent in the member's original tab.
    const storage = installMemoryStorage();
    const path = `${base}?intent=${createLaunchIntent('sports', member.id)}`;
    let resolveProbe!: (data: unknown) => void;
    get.mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve;
      })
    );
    setup(path);
    expect(screen.getByTestId('path').textContent).toBe(path);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(launch).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
    await act(async () => {
      resolveProbe({ success: true, data: { user: member } });
    });
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith('https://sportsbook.example.test/synthetic-launch');
    expect(screen.getByTestId('path').textContent).toBe(path);
    storage.restore();
  }
);
it('keeps a bare /sports/open link for a restored member but waits for a click', async () => {
  let resolveProbe!: (data: unknown) => void;
  get.mockReturnValue(
    new Promise((resolve) => {
      resolveProbe = resolve;
    })
  );
  setup('/sports/open');
  await act(async () => {
    resolveProbe({ success: true, data: { user: member } });
  });
  expect(await screen.findByRole('button', { name: 'Browse sports' })).toBeVisible();
  expect(screen.getByTestId('path').textContent).toBe('/sports/open');
  expect(launch).not.toHaveBeenCalled();
  expect(leave).not.toHaveBeenCalled();
});
it.each([
  ['/groups/member-group?tab=members#chat', 'Member group detail'],
  ['/messages/member-thread', 'Member messages'],
  ['/play-together/rounds/member-round', 'Member game lobby'],
  ['/wallet/withdraw', 'Member wallet'],
  ['/casino?game=provider-selection', 'Member casino lobby'],
])('preserves member deep link %s after a successful initial probe', async (path, heading) => {
  let resolveProbe!: (data: unknown) => void;
  get.mockReturnValue(
    new Promise((resolve) => {
      resolveProbe = resolve;
    })
  );
  setup(path);
  expect(screen.getByTestId('path').textContent).toBe(path);
  expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  await act(async () => {
    resolveProbe({ success: true, data: { user: member } });
  });
  expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  expect(screen.getByTestId('path').textContent).toBe(path);
  expect(launch).not.toHaveBeenCalled();
});
it.each([
  ['/sports/open', '/sports', 'Member sports lobby'],
  ['/Sports/open', '/sports', 'Member sports lobby'],
  ['/%73ports/open', '/sports', 'Member sports lobby'],
  ['/casino?game=provider-selection', '/casino', 'Member casino lobby'],
  ['/groups/member-group', '/groups', 'Member groups'],
  ['/messages/member-thread', '/messages', 'Member messages'],
  ['/play-together/rounds/member-round', '/play-together', 'Member game lobby'],
  ['/wallet/withdraw', '/wallet', 'Member wallet'],
])(
  'sanitizes confirmed guest %s and keeps Back safe after explicit sign-in',
  async (path, safePath, heading) => {
    let rejectProbe!: (error: unknown) => void;
    get.mockReturnValue(
      new Promise((_, reject) => {
        rejectProbe = reject;
      })
    );
    setup(path);
    expect(screen.getByTestId('path').textContent).toBe(path);
    await act(async () => {
      rejectProbe(new Error(JSON.stringify({ status: 401, message: 'Unauthorized' })));
    });
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe(safePath));
    fireEvent.click(document.querySelector('.salem-guest-signin')!);
    fireEvent.click(screen.getByRole('button', { name: 'Simulate successful sign-in' }));
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    await act(async () => {
      back();
    });
    expect(screen.getByTestId('path').textContent).toBe(safePath);
    expect(launch).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  }
);
it.each(['restore-session', 'explicit-sign-in'])(
  'does not queue a guest action during a pending probe: %s',
  async (mode) => {
    let resolveProbe!: (data: unknown) => void;
    get.mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve;
      })
    );
    setup('/sports');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to open sports' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('path').textContent).toBe('/sports');
    if (mode === 'explicit-sign-in') {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Sign in' }));
      fireEvent.click(screen.getByRole('button', { name: 'Simulate successful sign-in' }));
      expect(
        await screen.findByRole('heading', { name: 'Member sports lobby' })
      ).toBeInTheDocument();
    }
    await act(async () => {
      resolveProbe({ success: true, data: { user: member } });
    });
    expect(await screen.findByRole('heading', { name: 'Member sports lobby' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('path').textContent).toBe('/sports');
    await act(async () => {
      back();
    });
    expect(screen.getByTestId('path').textContent).toBe('/sports');
    expect(launch).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  }
);
it('respects newer navigation instead of restoring a stale action URL', async () => {
  let resolveProbe!: (data: unknown) => void;
  get.mockReturnValue(
    new Promise((resolve) => {
      resolveProbe = resolve;
    })
  );
  setup('/sports/open');
  await act(async () => {
    visit('/sports', { replace: true });
  });
  await act(async () => {
    resolveProbe({ success: true, data: { user: member } });
  });
  expect(await screen.findByRole('heading', { name: 'Member sports lobby' })).toBeInTheDocument();
  expect(screen.getByTestId('path').textContent).toBe('/sports');
  expect(launch).not.toHaveBeenCalled();
});
it('does not erase a deep link or mount private effects when the session check fails', async () => {
  get.mockRejectedValue(new Error(JSON.stringify({ status: 503, message: 'Unavailable' })));
  setup('/sports/open');
  expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t check your session.');
  expect(screen.getByTestId('path').textContent).toBe('/sports/open');
  expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  expect(launch).not.toHaveBeenCalled();
});
it.each([
  ['/admin/accounts', 'Administrator access required'],
  ['/Admin/accounts', 'Administrator access required'],
  ['/%61dmin/accounts', 'Administrator access required'],
  ['/agent/accounts', 'Approved agent access required'],
  ['/Agent/accounts', 'Approved agent access required'],
  ['/%61gent/accounts', 'Approved agent access required'],
])(
  'preserves unresolved staff path %s before applying server role checks',
  async (path, heading) => {
    let resolveProbe!: (data: unknown) => void;
    get.mockImplementation((url: string) =>
      url === '/auth/me'
        ? new Promise((resolve) => {
            resolveProbe = resolve;
          })
        : Promise.resolve({
            success: true,
            data: { admin: false, agent: false, role: 'USER', agentStatus: null },
          })
    );
    setup(path);
    expect(screen.getByTestId('path').textContent).toBe(path);
    expect(screen.getByRole('status')).toHaveTextContent('Checking workspace access…');
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveProbe({ success: true, data: { user: member } });
    });
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByTestId('path').textContent).toBe(path);
    expect(get).toHaveBeenCalledWith('/workspaces/access');
  }
);

const INVITE = '/groups/invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566';
// Signing in, and the member layout's existing automatic activity reward once a
// member is signed in, are the only expected writes: no acceptance or entry.
const writesOtherThanSignIn = () =>
  post.mock.calls
    .map(([path]) => path)
    .filter((path) => path !== '/auth/login' && path !== '/member-rewards/activity');
async function asConfirmedGuest(path: string) {
  let rejectProbe!: (error: unknown) => void;
  get.mockReturnValue(
    new Promise((_, reject) => {
      rejectProbe = reject;
    })
  );
  setup(path);
  await act(async () => {
    rejectProbe(new Error(JSON.stringify({ status: 401, message: 'Unauthorized' })));
  });
}
it('keeps a visitor’s invitation through sign-in and accepts nothing until clicked', async () => {
  await asConfirmedGuest(`${INVITE}?accept=1#join`);
  await waitFor(() => expect(screen.getByTestId('path').textContent).toBe(INVITE));
  expect(screen.getByRole('heading', { level: 1, name: 'Group invitation' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Member invitation' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Accept invite/ }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Sign in' }));
  fireEvent.click(screen.getByRole('button', { name: 'Simulate successful sign-in' }));
  expect(await screen.findByRole('heading', { name: 'Member invitation' })).toBeInTheDocument();
  expect(screen.getByTestId('path').textContent).toBe(INVITE);
  expect(writesOtherThanSignIn()).toEqual([]);
});
it('returns a visitor to their chosen Play Together game, shown but not entered', async () => {
  await asConfirmedGuest('/games/dice');
  await waitFor(() =>
    expect(screen.getByTestId('path').textContent).toBe('/play-together?game=dice')
  );
  fireEvent.click(screen.getByRole('button', { name: /Find a room/ }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Sign in' }));
  fireEvent.click(screen.getByRole('button', { name: 'Simulate successful sign-in' }));
  expect(await screen.findByRole('heading', { name: 'Member game lobby' })).toBeInTheDocument();
  expect(screen.getByTestId('path').textContent).toBe('/play-together?game=dice');
  await act(async () => {
    back();
  });
  expect(screen.getByTestId('path').textContent).toBe('/play-together?game=dice');
  expect(writesOtherThanSignIn()).toEqual([]);
  expect(launch).not.toHaveBeenCalled();
});
