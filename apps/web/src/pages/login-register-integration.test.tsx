import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

/* Real AuthProvider contract wired to the mocked API client, so a rejected
 * /auth/login or /auth/register must propagate through the provider to the
 * page, render the server message, and never navigate to the home route. */
const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
  },
}));

import { AuthProvider } from '@/providers/auth-provider';
import { LoginPage } from './login';
import { RegisterPage } from './register';

const authError = (status: number, code: string, message: string) =>
  new Error(JSON.stringify({ status, code, message }));

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  apiPost.mockReset();
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