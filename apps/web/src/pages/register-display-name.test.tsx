import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const registerUser = vi.fn();

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ login: vi.fn(), register: registerUser }),
}));

import { RegisterPage } from './register';

afterEach(() => {
  cleanup();
  registerUser.mockReset();
});

function renderRegister() {
  return render(
    <MemoryRouter>
      <RegisterPage />
    </MemoryRouter>,
  );
}

/** Fills only the three genuinely required fields. Display Name is left untouched. */
async function fillRequiredOnly(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('johndoe'), 'smoketester');
  await user.type(screen.getByPlaceholderText('you@example.com'), 'someone@example.com');
  await user.type(screen.getByPlaceholderText('••••••••'), 'Password123!');
}

describe('RegisterPage — Display Name is genuinely optional', () => {
  // Regression: the schema was `.min(1).optional()`, but `.optional()` only
  // permits undefined while react-hook-form submits '' for an untouched input.
  // Blank therefore failed `.min(1)` and blocked submission entirely — and
  // because this field rendered no error element, nothing was shown at all.
  // Clicking "Create account" simply did nothing.
  it('A: submits with a blank Display Name and calls registerUser exactly once', async () => {
    registerUser.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderRegister();

    // Deliberately does NOT touch the Display Name field.
    await fillRequiredOnly(user);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(registerUser).toHaveBeenCalledTimes(1));

    // A blank display name must be omitted, not sent as '': the API declares
    // displayName with minLength 1 and would reject an empty string.
    expect(registerUser).toHaveBeenCalledWith({
      username: 'smoketester',
      email: 'someone@example.com',
      password: 'Password123!',
      displayName: undefined,
    });
  });

  it('B: shows no validation error for a blank Display Name', async () => {
    registerUser.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderRegister();

    await fillRequiredOnly(user);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(registerUser).toHaveBeenCalled());
    expect(screen.queryByText(/display name is required/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/display name must be at most/i)).not.toBeInTheDocument();
  });

  it('C: shows a visible error for an over-long Display Name and does not submit', async () => {
    const user = userEvent.setup();
    renderRegister();

    await fillRequiredOnly(user);
    await user.type(screen.getByPlaceholderText('John Doe'), 'x'.repeat(101));
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('Display name must be at most 100 characters')).toBeInTheDocument();
    expect(registerUser).not.toHaveBeenCalled();
  });

  it('D: still submits a filled Display Name unchanged', async () => {
    registerUser.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderRegister();

    await fillRequiredOnly(user);
    await user.type(screen.getByPlaceholderText('John Doe'), 'Smoke Tester');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(registerUser).toHaveBeenCalledTimes(1));
    expect(registerUser).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Smoke Tester' }),
    );
  });

  it('D2: leaves username and password validation untouched', async () => {
    const user = userEvent.setup();
    renderRegister();

    // Email is deliberately valid: it is a `type="email"` input, so a malformed
    // value trips native constraint validation and the submit event never
    // reaches react-hook-form — which would prove nothing about the schema.
    await user.type(screen.getByPlaceholderText('johndoe'), 'ab'); // too short
    await user.type(screen.getByPlaceholderText('you@example.com'), 'someone@example.com');
    await user.type(screen.getByPlaceholderText('••••••••'), 'weak'); // too short
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('Username must be at least 3 characters')).toBeInTheDocument();
    expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();
    expect(registerUser).not.toHaveBeenCalled();
  });
});
