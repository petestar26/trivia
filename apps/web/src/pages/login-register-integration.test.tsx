import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

/* Real AuthProvider contract wired to the mocked API client, so a rejected
 * /auth/login or /auth/register must propagate through the provider to the
 * page, render the server message, and never navigate to the home route. */
const apiGet = vi.fn();
const apiPost = vi.fn();
const apiGoogleAuth = vi.fn();
const apiGoogleNonce = vi.fn();
const mockGoogleClientId = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    googleAuth: (...a: unknown[]) => apiGoogleAuth(...a),
    googleNonce: (...a: unknown[]) => apiGoogleNonce(...a),
  },
  googleClientId: (...a: unknown[]) => mockGoogleClientId(...a),
}));

import { AuthProvider, useAuth } from '@/providers/auth-provider';
import { LoginPage } from './login';
import { RegisterPage } from './register';

const authError = (status: number, code: string, message: string) =>
  new Error(JSON.stringify({ status, code, message }));

beforeEach(() => {
  // Email-flows default: Google host stays inert so the button renders nothing.
  mockGoogleClientId.mockReturnValue(undefined);
});

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  apiPost.mockReset();
  apiGoogleAuth.mockReset();
  apiGoogleNonce.mockReset();
  mockGoogleClientId.mockReset();
  (globalThis as never as { google?: unknown }).google = undefined;
});

function renderAuthFlow(path: string, element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/" element={<div>HOME_LANDING</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const canonicalGoogleUser = {
  id: 'u_google',
  email: null,
  username: 'gogol_user',
  displayName: 'gogol_user',
  isVerified: false,
  role: 'USER',
};

/* Real Google GIS seam: initialize captures the callback, renderButton inserts
 * the imperative foreign DOM the real integration would produce. */
let gsiCallback: ((response: { credential?: string }) => void) | undefined;
function stubGsi() {
  gsiCallback = undefined;
  (globalThis as never as { google: unknown }).google = {
    accounts: {
      id: {
        initialize: (opts: { callback: (response: { credential?: string }) => void }) => {
          gsiCallback = opts.callback;
        },
        renderButton: (parent: HTMLElement) => {
          const child = document.createElement('div');
          child.dataset.testid = 'google-gsi-host-child';
          parent.appendChild(child);
        },
        prompt: () => {
          throw new Error('One Tap prompt must not be invoked');
        },
      },
    },
  };
}
function triggerGoogleCredential(credential: string) {
  if (!gsiCallback) throw new Error('GIS callback not captured');
  return gsiCallback({ credential });
}

/* Real pages + real GoogleSignInButton + real AuthProvider. MemoryRouter sits
 * ABOVE AuthProvider so the provider's boundary remount on successful identity
 * publication cannot destroy the router and mask the real navigation. */
function HomeProbe() {
  const { user } = useAuth();
  return <div>HOME_LANDING{user ? `|USER:${user.username}` : '|ANON'}</div>;
}

function renderGoogleFlow(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/" element={<HomeProbe />} />
          </Routes>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('AuthProvider + page integration — current failures do NOT navigate as success', () => {
  it('wrong credentials keeps the user on the login page with the server error', async () => {
    // Initial /auth/me resolves anonymous; the subsequent login POST rejects.
    apiGet.mockResolvedValue({ success: true, data: { user: null } });
    apiPost.mockRejectedValue(authError(401, 'UNAUTHORIZED', 'Invalid credentials'));

    renderAuthFlow('/login', <LoginPage />);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('you@example.com'), 'someone@example.com');
    await user.type(screen.getByPlaceholderText('••••••••'), 'Password123!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    // On login failure the provider must reject, so the page must NOT have
    // navigated to the home route.
    expect(screen.queryByText('HOME_LANDING')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    // Submit button exits its loading state (form stays usable).
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled());
  });

  it('registration failure keeps the user on the register page with the server error', async () => {
    apiGet.mockResolvedValue({ success: true, data: { user: null } });
    apiPost.mockRejectedValue(authError(409, 'EMAIL_TAKEN', 'Email already registered'));

    renderAuthFlow('/register', <RegisterPage />);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('johndoe'), 'smoketester');
    await user.type(screen.getByPlaceholderText('you@example.com'), 'someone@example.com');
    await user.type(screen.getByPlaceholderText('John Doe'), 'Smoke Tester');
    await user.type(screen.getByPlaceholderText('••••••••'), 'Password123!');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('Email already registered')).toBeInTheDocument();
    expect(screen.queryByText('HOME_LANDING')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('johndoe')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /create account/i })).toBeEnabled());
  });
});

describe('Real AuthProvider + real pages + real GoogleSignInButton — Google success navigates to /', () => {
  it('login: a returning Google identity publishes the user and navigates home', async () => {
    stubGsi();
    mockGoogleClientId.mockReturnValue('client-123');
    apiGet.mockResolvedValue({ success: true, data: { user: null } });
    apiGoogleNonce.mockResolvedValue({ success: true, data: { nonce: 'NONCE-VALUE' } });
    apiGoogleAuth.mockResolvedValue({ success: true, data: { user: canonicalGoogleUser, accessToken: 't', refreshToken: 'r' } });

    renderGoogleFlow('/login');
    await waitFor(() => expect(gsiCallback).toBeTruthy());

    triggerGoogleCredential('returning-cred');

    // Real AuthProvider published the authenticated user AND the real button's
    // onSuccess navigated to home — proven by the rendered destination component.
    expect(await screen.findByText(/USER:gogol_user/)).toBeInTheDocument();
    expect(screen.getByText(/HOME_LANDING/)).toBeInTheDocument();
    expect(apiGoogleAuth).toHaveBeenCalledWith({ credential: 'returning-cred' });
  });

  it('register: first-time Google goes through username onboarding, then navigates home', async () => {
    stubGsi();
    mockGoogleClientId.mockReturnValue('client-123');
    apiGet.mockResolvedValue({ success: true, data: { user: null } });
    apiGoogleNonce.mockResolvedValue({ success: true, data: { nonce: 'NONCE-VALUE' } });
    apiGoogleAuth
      .mockRejectedValueOnce(authError(422, 'USERNAME_REQUIRED', 'Please choose a username'))
      .mockResolvedValueOnce({ success: true, data: { user: canonicalGoogleUser, accessToken: 't', refreshToken: 'r' } });

    renderGoogleFlow('/register');
    await waitFor(() => expect(gsiCallback).toBeTruthy());

    triggerGoogleCredential('new-cred');

    const input = await screen.findByPlaceholderText('username');
    expect(input).toBeInTheDocument();
    // USERNAME_REQUIRED must NOT navigate away yet.
    expect(screen.queryByText(/HOME_LANDING/)).not.toBeInTheDocument();

    await userEvent.type(input, 'gogol_user');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Username completion leads to a successful canonical auth → navigate home.
    expect(await screen.findByText(/USER:gogol_user/)).toBeInTheDocument();
    expect(screen.getByText(/HOME_LANDING/)).toBeInTheDocument();
    expect(apiGoogleAuth).toHaveBeenLastCalledWith({ credential: 'new-cred', username: 'gogol_user' });
  });

  it('invalid Google credentials never navigate', async () => {
    stubGsi();
    mockGoogleClientId.mockReturnValue('client-123');
    apiGet.mockResolvedValue({ success: true, data: { user: null } });
    apiGoogleNonce.mockResolvedValue({ success: true, data: { nonce: 'NONCE-VALUE' } });
    apiGoogleAuth.mockRejectedValue(authError(401, 'INVALID_GOOGLE_CREDENTIAL', 'Invalid Google credential'));

    renderGoogleFlow('/login');
    await waitFor(() => expect(gsiCallback).toBeTruthy());

    triggerGoogleCredential('bad-cred');

    expect(await screen.findByText('Google sign-in failed. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/HOME_LANDING/)).not.toBeInTheDocument();
  });

  it('username conflict during onboarding never navigates', async () => {
    stubGsi();
    mockGoogleClientId.mockReturnValue('client-123');
    apiGet.mockResolvedValue({ success: true, data: { user: null } });
    apiGoogleNonce.mockResolvedValue({ success: true, data: { nonce: 'NONCE-VALUE' } });
    apiGoogleAuth
      .mockRejectedValueOnce(authError(422, 'USERNAME_REQUIRED', 'Please choose a username'))
      .mockRejectedValueOnce(authError(409, 'ALREADY_EXISTS', 'Username already taken'));

    renderGoogleFlow('/register');
    await waitFor(() => expect(gsiCallback).toBeTruthy());

    triggerGoogleCredential('dup-cred');
    const input = await screen.findByPlaceholderText('username');
    await userEvent.type(input, 'taken_name');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(/Username already taken/)).toBeInTheDocument();
    expect(screen.queryByText(/HOME_LANDING/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('username')).toBeInTheDocument();
  });
});