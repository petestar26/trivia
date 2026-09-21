import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType, type MemoryRouterProps } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '@/providers/auth-provider';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { LoginPage } from './login';
import { RegisterPage } from './register';

// The whole invitation journey for someone who has no account yet:
//
//   /groups/invite/<token>?ref=email#accept
//     -> ProtectedRoute turns them away -> Login -> "Sign up" -> Register
//     -> account created (and signed in: there is no separate verification
//        page in the web app — AuthProvider signs a new account in at once)
//     -> the ORIGINAL invite URL, query string and fragment intact.
//
// Real AuthProvider, ProtectedRoute, LoginPage and RegisterPage; only the
// network is mocked.

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

import { api } from '@/lib/api';

const mocked = api as unknown as { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

const USER = { id: 'u1', username: 'sam_player', displayName: 'sam_player', email: 'sam@example.test', isVerified: false, createdAt: '2024-01-01T00:00:00.000Z' };
const INVITE_URL = '/groups/invite/tok123?ref=email#accept';

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
            <Route path="/register" element={<RegisterPage />} />
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

async function fillAndSubmitRegistration(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Username'), 'sam_player');
  await user.type(screen.getByLabelText('Email'), 'sam@example.test');
  await user.type(screen.getByLabelText('Password'), 'Str0ng!Passw0rd');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
}

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Email'), 'sam@example.test');
  await user.type(screen.getByLabelText('Password'), 'pw');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

const destination = () => screen.getByTestId('destination');

beforeEach(() => {
  mocked.get.mockRejectedValue(new Error('401')); // the initial /auth/me probe: anonymous
  mocked.post.mockImplementation(async (url: string) => {
    if (url === '/auth/register' || url === '/auth/login') return { success: true, data: { user: USER } };
    throw new Error(`unexpected POST ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('invitation link -> Login -> Sign up -> Register -> the original invite URL', () => {
  it('the complete flow ends on the ORIGINAL invite URL — pathname, query string and fragment — by REPLACING history', async () => {
    const user = userEvent.setup();
    renderApp([INVITE_URL]);

    // Turned away to the sign-in page; the invite page is not showing.
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByTestId('destination')).not.toBeInTheDocument();

    // No account yet: Sign up.
    await user.click(screen.getByRole('link', { name: 'Sign up' }));
    expect(await screen.findByRole('button', { name: 'Create account' })).toBeInTheDocument();

    await fillAndSubmitRegistration(user);

    await waitFor(() => expect(destination().textContent).toBe(INVITE_URL));
    expect(mocked.post).toHaveBeenCalledWith('/auth/register', expect.objectContaining({ username: 'sam_player', email: 'sam@example.test' }));
    // Replaced, not pushed: the registration page must not stay behind as a Back target.
    expect(destination()).toHaveAttribute('data-navigation', 'REPLACE');
  });

  it('carries the destination BOTH ways: Login -> Sign up -> Sign in (back) -> sign in -> the invite URL', async () => {
    const user = userEvent.setup();
    renderApp([INVITE_URL]);

    await user.click(await screen.findByRole('link', { name: 'Sign up' }));
    await screen.findByRole('button', { name: 'Create account' });
    await user.click(screen.getByRole('link', { name: 'Sign in' })); // changed their mind: back to sign-in
    await signIn(user);

    await waitFor(() => expect(destination().textContent).toBe(INVITE_URL));
    expect(mocked.post).toHaveBeenCalledWith('/auth/login', expect.anything());
    expect(mocked.post).not.toHaveBeenCalledWith('/auth/register', expect.anything());
  });

  it('survives several hops between the two pages', async () => {
    const user = userEvent.setup();
    renderApp([INVITE_URL]);

    await user.click(await screen.findByRole('link', { name: 'Sign up' }));
    await user.click(await screen.findByRole('link', { name: 'Sign in' }));
    await user.click(await screen.findByRole('link', { name: 'Sign up' }));
    await fillAndSubmitRegistration(user);

    await waitFor(() => expect(destination().textContent).toBe(INVITE_URL));
  });

  it('a failed registration stays on the form, shows the reason, and navigates nowhere — the destination is kept for the retry', async () => {
    mocked.post.mockRejectedValueOnce(new Error(JSON.stringify({ status: 409, code: 'ALREADY_EXISTS', message: 'Email already registered' })));
    const user = userEvent.setup();
    renderApp([INVITE_URL]);
    await user.click(await screen.findByRole('link', { name: 'Sign up' }));
    await fillAndSubmitRegistration(user);

    expect(await screen.findByText('Email already registered')).toBeInTheDocument();
    expect(screen.queryByTestId('destination')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create account' })); // retry (values are still in the form)
    await waitFor(() => expect(destination().textContent).toBe(INVITE_URL));
  });
});

describe('registration with no return state, or a safe internal destination', () => {
  it('direct registration (nothing to return to) lands on the home page', async () => {
    const user = userEvent.setup();
    renderApp(['/register']);
    await fillAndSubmitRegistration(user);
    await waitFor(() => expect(destination().textContent).toBe('/'));
    expect(destination()).toHaveAttribute('data-navigation', 'REPLACE');
  });

  it('opening Login directly and choosing Sign up leaves nothing to return to: the home page', async () => {
    const user = userEvent.setup();
    renderApp(['/login']);
    await user.click(await screen.findByRole('link', { name: 'Sign up' }));
    await fillAndSubmitRegistration(user);
    await waitFor(() => expect(destination().textContent).toBe('/'));
  });

  it.each([
    ['a plain path', { pathname: '/wallet' }, '/wallet'],
    ['a path with a query string', { pathname: '/competitions/g-1', search: '?tab=open' }, '/competitions/g-1?tab=open'],
    ['a path with a fragment', { pathname: '/groups/g-1', hash: '#members' }, '/groups/g-1#members'],
    ['path, query and fragment', { pathname: '/groups/invite/t', search: '?ref=email', hash: '#accept' }, '/groups/invite/t?ref=email#accept'],
    ['a full router location object', { pathname: '/rewards', search: '', hash: '', state: null, key: 'abc' }, '/rewards'],
  ])('a safe internal destination is honoured: %s', async (_name, from, expected) => {
    const user = userEvent.setup();
    renderApp([{ pathname: '/register', state: { from } }]);
    await fillAndSubmitRegistration(user);
    await waitFor(() => expect(destination().textContent).toBe(expected));
  });
});

describe('a hostile or malformed destination is never followed — from Register directly, or carried through Login', () => {
  const hostile: Array<[string, unknown]> = [
    ['an external URL', { pathname: 'https://evil.example/steal' }],
    ['a protocol-relative URL', { pathname: '//evil.example/steal' }],
    ['a backslash host', { pathname: '/\\evil.example' }],
    ['an encoded protocol-relative URL', { pathname: '/%2F%2Fevil.example' }],
    ['a double-encoded protocol-relative URL', { pathname: '/%252F%252Fevil.example' }],
    ['an encoded backslash', { pathname: '/%5Cevil.example' }],
    ['a javascript: URL', { pathname: 'javascript:alert(1)' }],
    ['a javascript: path', { pathname: '/javascript:alert(1)' }],
    ['a data: URL', { pathname: 'data:text/html,hi' }],
    ['a malformed escape', { pathname: '/%ZZ' }],
    ['a bare string instead of a location', 'https://evil.example/'],
    ['a non-string pathname', { pathname: { evil: true } }],
    ['a query that does not start with ?', { pathname: '/wallet', search: 'evil' }],
    ['a path that collapses to //', { pathname: '/a/..//evil.example' }],
    ['the login page (a loop)', { pathname: '/login' }],
    ['the register page (a loop)', { pathname: '/register' }],
  ];

  it.each(hostile)('%s -> Register lands on the home page', async (_name, from) => {
    const user = userEvent.setup();
    renderApp([{ pathname: '/register', state: { from } }]);
    await fillAndSubmitRegistration(user);
    await waitFor(() => expect(destination().textContent).toBe('/'));
  });

  it.each(hostile)('%s -> carried through Login "Sign up", it still lands on the home page', async (_name, from) => {
    const user = userEvent.setup();
    renderApp([{ pathname: '/login', state: { from } }]);
    await user.click(await screen.findByRole('link', { name: 'Sign up' }));
    await fillAndSubmitRegistration(user);
    await waitFor(() => expect(destination().textContent).toBe('/'));
  });
});
