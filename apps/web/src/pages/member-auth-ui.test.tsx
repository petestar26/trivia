import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './login';
import { RegisterPage } from './register';

const { auth } = vi.hoisted(() => ({ auth: { login: vi.fn(), register: vi.fn() } }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => auth }));

const selectedDestination = { pathname: '/games/dice', search: '?table=2', hash: '#rules' };
function RouteState() {
  const location = useLocation();
  return <output data-testid="route-state">{JSON.stringify(location.state)}</output>;
}
function mount(path = '/login', workspace?: 'admin' | 'agent') {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state: { from: selectedDestination } }]}>
      <Routes>
        <Route
          path="/login"
          element={
            <>
              <LoginPage workspace={workspace} />
              <RouteState />
            </>
          }
        />
        <Route
          path="/register"
          element={
            <>
              <RegisterPage />
              <RouteState />
            </>
          }
        />
        <Route path="/explore" element={<p>Public collection</p>} />
        <Route path="*" element={<p>Destination</p>} />
      </Routes>
    </MemoryRouter>
  );
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
}
function validForm(mode: 'login' | 'register') {
  if (mode === 'register') change('Username', 'member_example');
  change('Email', 'member@example.test');
  change('Password', 'Example!Pass123');
}
function submit() {
  const form = screen.getByLabelText('Password', { exact: true }).closest('form');
  expect(form).not.toBeNull();
  fireEvent.submit(form!);
}
function describedText(input: HTMLElement) {
  return (input.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}
beforeEach(() => {
  auth.login.mockReset().mockResolvedValue(undefined);
  auth.register.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe.each(['login', 'register'] as const)('%s member form', (mode) => {
  it('reveals and re-hides the same native password value without submitting', () => {
    mount('/' + mode);
    const input = screen.getByLabelText('Password', { exact: true });
    change('Password', 'Example!Pass123');
    expect(input).toHaveAttribute('type', 'password');
    const show = screen.getByRole('button', { name: 'Show password' });
    expect(show).toHaveAttribute('type', 'button');
    expect(show).toHaveAttribute('aria-controls', input.id);
    fireEvent.click(show);
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveValue('Example!Pass123');
    const hide = screen.getByRole('button', { name: 'Hide password' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(hide);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('Example!Pass123');
    expect(auth.login).not.toHaveBeenCalled();
    expect(auth.register).not.toHaveBeenCalled();
  });

  it('disables fields and password reveal while the real form submission is pending', async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<void>((_resolve, rejection) => {
      reject = rejection;
    });
    const operation = mode === 'login' ? auth.login : auth.register;
    operation.mockReturnValue(pending);
    mount('/' + mode);
    validForm(mode);
    submit();
    await waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Email', { exact: true })).toBeDisabled();
    expect(screen.getByLabelText('Password', { exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
    expect(
      screen.getByRole('button', {
        name: mode === 'login' ? 'Signing in...' : 'Creating account...',
      })
    ).toBeDisabled();
    if (mode === 'login') {
      expect(operation).toHaveBeenCalledWith('member@example.test', 'Example!Pass123');
    } else {
      expect(screen.getByLabelText('Username', { exact: true })).toBeDisabled();
      expect(screen.getByLabelText('Display Name (optional)', { exact: true })).toBeDisabled();
      expect(operation).toHaveBeenCalledWith({
        username: 'member_example',
        email: 'member@example.test',
        password: 'Example!Pass123',
        displayName: undefined,
      });
    }
    await act(async () => reject(new Error('Please try again')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please try again');
    expect(screen.getByLabelText('Password', { exact: true })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show password' })).not.toBeDisabled();
  });

  it('offers public browsing and an accessible pause/resume control', () => {
    const view = mount('/' + mode);
    expect(screen.getByRole('link', { name: 'PlayQube home' })).toHaveAttribute('href', '/');
    const browse = screen.getByRole('link', { name: 'Browse the collection' });
    expect(browse).toHaveAttribute('href', '/explore');
    fireEvent.click(screen.getByRole('button', { name: 'Pause animation' }));
    expect(screen.getByRole('button', { name: 'Resume animation' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(view.container.querySelector('.pq-auth-shell')).toHaveClass('is-paused');
    fireEvent.click(screen.getByRole('button', { name: 'Resume animation' }));
    expect(view.container.querySelector('.pq-auth-shell')).not.toHaveClass('is-paused');
    expect(view.container.querySelector('.pq-auth-art')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(browse);
    expect(screen.getByText('Public collection')).toBeInTheDocument();
    expect(auth.login).not.toHaveBeenCalled();
    expect(auth.register).not.toHaveBeenCalled();
  });
});

it('associates sign-in validation errors with their inputs and keeps invalid values away from auth', async () => {
  mount();
  submit();
  expect(await screen.findByText('Invalid email address')).toHaveAttribute('role', 'alert');
  expect(screen.getByText('Password is required')).toHaveAttribute('role', 'alert');
  const email = screen.getByLabelText('Email', { exact: true });
  const password = screen.getByLabelText('Password', { exact: true });
  expect(email).toHaveAttribute('aria-invalid', 'true');
  expect(password).toHaveAttribute('aria-invalid', 'true');
  expect(describedText(email)).toBe('Invalid email address');
  expect(describedText(password)).toBe('Password is required');
  expect(auth.login).not.toHaveBeenCalled();
});

it('associates registration errors and persistent password guidance without weakening validation', async () => {
  mount('/register');
  const password = screen.getByLabelText('Password', { exact: true });
  expect(describedText(password)).toMatch(/at least 8 characters/);
  change('Username', 'a');
  change('Email', 'not-an-email');
  change('Password', 'short');
  change('Display Name (optional)', 'x'.repeat(101));
  submit();
  await screen.findByText('Username must be at least 3 characters');
  for (const [label, expected] of [
    ['Username', /at least 3 characters/],
    ['Email', /Invalid email address/],
    ['Display Name (optional)', /at most 100 characters/],
    ['Password', /at least 8 characters/],
  ] as const) {
    const input = screen.getByLabelText(label, { exact: true });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(describedText(input)).toMatch(expected);
    const errorId = input.getAttribute('aria-describedby')!.split(' ')[0];
    expect(document.getElementById(errorId)).toHaveAttribute('role', 'alert');
  }
  expect(describedText(password)).toMatch(/uppercase, lowercase, number, and special/);
  expect(auth.register).not.toHaveBeenCalled();
});

it('announces a registration server refusal without losing the submitted fields', async () => {
  auth.register.mockRejectedValue(
    new Error(JSON.stringify({ status: 409, message: 'Email already registered' }))
  );
  mount('/register');
  validForm('register');
  submit();
  expect(await screen.findByRole('alert')).toHaveTextContent('Email already registered');
  expect(screen.getByLabelText('Email', { exact: true })).toHaveValue('member@example.test');
  expect(screen.getByLabelText('Password', { exact: true })).toHaveAttribute('type', 'password');
});

it('retains the native autocomplete contracts for login and account creation', () => {
  const login = mount();
  expect(screen.getByLabelText('Email', { exact: true })).toHaveAttribute(
    'autocomplete',
    'username'
  );
  expect(screen.getByLabelText('Password', { exact: true })).toHaveAttribute(
    'autocomplete',
    'current-password'
  );
  login.unmount();
  mount('/register');
  expect(screen.getByLabelText('Username', { exact: true })).toHaveAttribute(
    'autocomplete',
    'username'
  );
  expect(screen.getByLabelText('Email', { exact: true })).toHaveAttribute('autocomplete', 'email');
  expect(screen.getByLabelText('Display Name (optional)', { exact: true })).toHaveAttribute(
    'autocomplete',
    'nickname'
  );
  expect(screen.getByLabelText('Password', { exact: true })).toHaveAttribute(
    'autocomplete',
    'new-password'
  );
});

it('keeps the chosen game location while switching between the styled member forms', () => {
  mount();
  fireEvent.click(screen.getByRole('link', { name: 'Sign up' }));
  expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
  expect(JSON.parse(screen.getByTestId('route-state').textContent!)).toEqual({
    from: selectedDestination,
  });
  fireEvent.click(screen.getByRole('link', { name: 'Sign in' }));
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  expect(JSON.parse(screen.getByTestId('route-state').textContent!)).toEqual({
    from: selectedDestination,
  });
});

it.each(['admin', 'agent'] as const)(
  'keeps %s sign-in outside the member marketing shell',
  (workspace) => {
    const view = mount('/login', workspace);
    expect(
      screen.getByText(workspace === 'admin' ? 'Administrator sign in' : 'Agent sign in')
    ).toBeInTheDocument();
    expect(view.container.querySelector('.pq-auth-shell')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause animation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show password' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Password', { exact: true })).toHaveAttribute('type', 'password');
    expect(screen.getByRole('link', { name: 'Member sign in' })).toHaveAttribute('href', '/login');
  }
);
