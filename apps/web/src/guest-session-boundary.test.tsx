import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as ApiModule from '@/lib/api';
import { AuthProvider } from '@/providers/auth-provider';
import { App } from './App';
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
function Address() {
  const location = useLocation();
  const navigate = useNavigate();
  back = () => navigate(-1);
  return (
    <output data-testid="path">
      {location.pathname}
      {location.search}
    </output>
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
  post.mockImplementation(async (path: string) => ({
    success: true,
    data: path === '/auth/login' ? { user: member } : {},
  }));
});
afterEach(cleanup);
it.each(['/sports/open', '/Sports/open', '/%73ports/open'])(
  'replaces %s before the real AuthProvider restores a session',
  async (path) => {
    let resolveProbe!: (data: unknown) => void;
    get.mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve;
      })
    );
    setup(path);
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(/^\/sports$/));
    await act(async () => {
      resolveProbe({ success: true, data: { user: member } });
    });
    expect(await screen.findByRole('heading', { name: 'Member sports lobby' })).toBeInTheDocument();
    expect(launch).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  }
);
it('keeps Back safe across the real sign-in identity remount', async () => {
  get.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
  setup('/sports/open');
  await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(/^\/sports$/));
  fireEvent.click(document.querySelector('.salem-guest-signin')!);
  fireEvent.click(screen.getByRole('button', { name: 'Simulate successful sign-in' }));
  expect(await screen.findByRole('heading', { name: 'Member sports lobby' })).toBeInTheDocument();
  await act(async () => {
    back();
  });
  expect(screen.getByTestId('path')).toHaveTextContent(/^\/sports$/);
  expect(launch).not.toHaveBeenCalled();
  expect(leave).not.toHaveBeenCalled();
});
