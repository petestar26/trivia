import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const login = vi.fn();
const registerUser = vi.fn();

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ login, register: registerUser }),
}));

import { LoginPage } from './login';
import { RegisterPage } from './register';

afterEach(() => {
  cleanup();
  login.mockReset();
  registerUser.mockReset();
});

const renderPage = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

async function submitLogin() {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('you@example.com'), 'someone@example.com');
  await user.type(screen.getByPlaceholderText('••••••••'), 'Password123!');
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginPage error display', () => {
  // Regression: ApiClient throws JSON.stringify({ status, ...error }), so the
  // message is top-level. The page read `parsed.error?.message`, which is
  // always undefined against that shape, so every server message collapsed
  // into the generic fallback.
  it('shows the server message from a flattened API error', async () => {
    login.mockRejectedValue(
      new Error(JSON.stringify({ status: 401, code: 'UNAUTHORIZED', message: 'Invalid credentials' })),
    );

    renderPage(<LoginPage />);
    await submitLogin();

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    expect(screen.queryByText('Login failed')).not.toBeInTheDocument();
  });

  // Regression: JSON.parse on plain text threw *inside* the catch block, so no
  // error was rendered and the failure was invisible to the user.
  it('renders a useful error for a plain network failure instead of crashing', async () => {
    login.mockRejectedValue(new TypeError('Failed to fetch'));

    renderPage(<LoginPage />);
    await submitLogin();

    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
    // Form remains usable — the submit button is not stuck in its loading state.
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled());
  });
});

async function submitRegister() {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('johndoe'), 'smoketester');
  await user.type(screen.getByPlaceholderText('you@example.com'), 'someone@example.com');
  // Display Name must be filled for the form to submit at all: its schema is
  // `.min(1).optional()`, and `.optional()` only permits `undefined` — an
  // untouched input submits '' and fails `.min(1)`. Leaving it blank blocks
  // submission entirely (and renders no message, since this field has no error
  // element). That is a separate defect from the error-display fix under test
  // here; filling it keeps this test focused on error presentation.
  await user.type(screen.getByPlaceholderText('John Doe'), 'Smoke Tester');
  await user.type(screen.getByPlaceholderText('••••••••'), 'Password123!');
  await user.click(screen.getByRole('button', { name: /create account/i }));
}

describe('RegisterPage error display', () => {
  it('shows the server message from a flattened API conflict', async () => {
    registerUser.mockRejectedValue(
      new Error(JSON.stringify({ status: 409, code: 'CONFLICT', message: 'Email already registered' })),
    );

    renderPage(<RegisterPage />);
    await submitRegister();

    expect(await screen.findByText('Email already registered')).toBeInTheDocument();
    expect(screen.queryByText('Registration failed')).not.toBeInTheDocument();
  });

  it('renders a useful error for a plain network failure instead of crashing', async () => {
    registerUser.mockRejectedValue(new TypeError('Failed to fetch'));

    renderPage(<RegisterPage />);
    await submitRegister();

    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
  });
});
