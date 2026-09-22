import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType, type MemoryRouterProps } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '@/providers/auth-provider';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { LoginPage } from './login';

// ProtectedRoute -> login -> back to where the visitor was headed, through the
// REAL AuthProvider, ProtectedRoute and LoginPage. Only the network is mocked.

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from '@/lib/api';

const mocked = api as unknown as { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

const USER = { id: 'u1', username: 'sam', displayName: 'Sam', email: 'sam@example.test', isVerified: true, createdAt: '2024-01-01T00:00:00.000Z' };

function Destination() {
  const l = useLocation();
  const navigationType = useNavigationType();
  return (
    <div data-testid="destination" data-navigation={navigationType}>
      {`${l.pathname}${l.search}${l.hash}`}
    </div>
  );
}

function renderApp(initialEntries: NonNullable<MemoryRouterProps['initialEntries']>) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={initialEntries}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/*"
              element={
                <ProtectedRoute>
                  <Destination />
                </ProtectedRoute>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Email'), 'sam@example.test');
  await user.type(screen.getByLabelText('Password'), 'pw');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => {
  mocked.get.mockRejectedValue(new Error('401')); // the initial /auth/me probe: anonymous
  mocked.post.mockResolvedValue({ success: true, data: { user: USER } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('ProtectedRoute -> login -> return', () => {
  it.each([
    ['a plain path', '/wallet', '/wallet'],
    ['an invite link', '/groups/invite/tok123', '/groups/invite/tok123'],
    ['a path with a query string', '/groups/invite/tok123?ref=email&x=1', '/groups/invite/tok123?ref=email&x=1'],
    ['a path with a fragment', '/groups/g-1#members', '/groups/g-1#members'],
    ['a path with query AND fragment', '/competitions/g-1?tab=open#rules', '/competitions/g-1?tab=open#rules'],
  ])('%s: an unauthenticated visit is sent to sign-in and comes back to the FULL location', async (_name, visited, expected) => {
    const user = userEvent.setup();
    renderApp([visited]);

    // Turned away: the sign-in form is showing, the protected page is not.
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByTestId('destination')).not.toBeInTheDocument();

    await signIn(user);
    await waitFor(() => expect(screen.getByTestId('destination')).toHaveTextContent(expected));
    expect(screen.getByTestId('destination').textContent).toBe(expected);
    // Replaced, not pushed: the sign-in page must not stay behind as a Back target.
    expect(screen.getByTestId('destination')).toHaveAttribute('data-navigation', 'REPLACE');
  });

  it('opening the sign-in page directly (nothing to return to) lands on the home page', async () => {
    const user = userEvent.setup();
    renderApp(['/login']);
    await signIn(user);
    await waitFor(() => expect(screen.getByTestId('destination').textContent).toBe('/'));
  });

  it('a failed sign-in stays on the form and does not navigate anywhere', async () => {
    mocked.post.mockRejectedValue(new Error(JSON.stringify({ status: 401, code: 'INVALID', message: 'Wrong password' })));
    const user = userEvent.setup();
    renderApp(['/groups/invite/tok123?ref=email']);
    await signIn(user);

    expect(await screen.findByText('Wrong password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByTestId('destination')).not.toBeInTheDocument();
  });

  describe('a hostile or malformed return target is never followed', () => {
    const hostile: Array<[string, unknown]> = [
      ['a protocol-relative URL', { pathname: '//evil.example/steal' }],
      ['a backslash host', { pathname: '/\\evil.example' }],
      ['an absolute URL in pathname', { pathname: 'https://evil.example/' }],
      ['a javascript: URL', { pathname: 'javascript:alert(1)' }],
      ['a bare string', 'https://evil.example/'],
      ['a non-string pathname', { pathname: { evil: true } }],
      ['a path that collapses to //', { pathname: '/a/..//evil.example' }],
      ['the login page itself', { pathname: '/login', search: '?x=1' }],
      ['a malformed query', { pathname: '/wallet', search: 'no-question-mark' }],
    ];

    it.each(hostile)('%s -> home', async (_name, from) => {
      const user = userEvent.setup();
      renderApp([{ pathname: '/login', state: { from } }]);
      await signIn(user);
      await waitFor(() => expect(screen.getByTestId('destination').textContent).toBe('/'));
    });
  });
});
