import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'admin' } }) }));
vi.mock('@/lib/api', async (original) => ({ ...(await original<any>()), api: m }));
import { CreateAgentPage, ActivateAgentPage } from './create-agent';
function show(child: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{child}</MemoryRouter>
    </QueryClientProvider>
  );
  return client;
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockImplementation(async (path: string) => ({
    success: true,
    data: path.includes('countries') ? [{ id: 'country', name: 'Ethiopia', isActive: true }] : [],
  }));
});
afterEach(() => {
  vi.useRealTimers();
});
it('creates multiple individual accounts and clears credentials before awaiting a response', async () => {
  let finish!: (v: any) => void;
  m.post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const client = show(<CreateAgentPage />);
  await screen.findByRole('option', { name: 'Ethiopia' });
  fill('Username', 'fixture_agent');
  fill('Email', 'agent@fixture.invalid');
  fill('Display name', 'Fixture');
  fill('Country', 'country');
  fill('Temporary password', 'SyntheticFixture!42');
  const button = screen.getByRole('button', { name: 'Create agent account' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Temporary password')).toHaveValue('');
  expect(m.post.mock.calls[0][1]).not.toHaveProperty('role');
  finish({
    success: true,
    data: {
      username: 'fixture_agent',
      email: 'agent@fixture.invalid',
      expiresAt: '2026-10-06T00:00:00Z',
    },
  });
  await screen.findByText('Agent account created');
  expect(screen.getByLabelText('Username')).toHaveValue('');
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data)
    )
  ).not.toContain('SyntheticFixture!42');
  expect(screen.getByRole('button', { name: 'Create agent account' })).toBeEnabled();
});
it('does not retain temporary credentials after a failed creation', async () => {
  m.post.mockRejectedValue(new Error('network'));
  show(<CreateAgentPage />);
  await screen.findByRole('option', { name: 'Ethiopia' });
  fill('Username', 'fixture_agent');
  fill('Email', 'agent@fixture.invalid');
  fill('Display name', 'Fixture');
  fill('Country', 'country');
  fill('Temporary password', 'SyntheticFixture!42');
  fireEvent.click(screen.getByRole('button', { name: 'Create agent account' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Temporary password')).toHaveValue('');
});
it('requires matching new passwords, then activates without creating a session', async () => {
  m.post.mockResolvedValue({ success: true, data: { message: 'Done' } });
  show(<ActivateAgentPage />);
  fill('Email', 'agent@fixture.invalid');
  fill('Temporary password', 'SyntheticFixture!42');
  fill('New password', 'PrivateFixture!43');
  fill('Confirm new password', 'DifferentFixture!44');
  fireEvent.click(screen.getByRole('button', { name: 'Set private password' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('must match');
  expect(m.post).not.toHaveBeenCalled();
  fill('Confirm new password', 'PrivateFixture!43');
  fireEvent.click(screen.getByRole('button', { name: 'Set private password' }));
  await screen.findByText('Password set successfully');
  expect(m.post).toHaveBeenCalledWith(
    '/agents/activate-account',
    {
      email: 'agent@fixture.invalid',
      temporaryPassword: 'SyntheticFixture!42',
      newPassword: 'PrivateFixture!43',
    },
    undefined,
    { signal: expect.any(AbortSignal) }
  );
  expect(screen.getByRole('link', { name: /Sign in to agent workspace/ })).toHaveAttribute(
    'href',
    '/agent/login'
  );
});
it('reissues only a selected pending credential and clears it on failure', async () => {
  m.get.mockImplementation(async (path: string) => ({
    success: true,
    data: path.includes('countries')
      ? []
      : [
          {
            userId: 'pending-id',
            expiresAt: '2026-10-06T00:00:00Z',
            user: { username: 'pending', email: 'pending@fixture.invalid' },
          },
        ],
  }));
  m.post.mockRejectedValue(new Error('offline'));
  show(<CreateAgentPage />);
  await screen.findByRole('option', { name: /pending@fixture.invalid/ });
  fill('Pending agent', 'pending-id');
  fill('Replacement temporary password', 'ReplacementFixture!42');
  fireEvent.click(screen.getByRole('button', { name: 'Replace temporary password' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('Could not confirm replacement')
  );
  expect(screen.getByLabelText('Replacement temporary password')).toHaveValue('');
  expect(m.post).toHaveBeenCalledWith(
    '/agents/admin/accounts/pending-id/reissue',
    { temporaryPassword: 'ReplacementFixture!42' },
    undefined,
    { signal: expect.any(AbortSignal) }
  );
});
it('bounds a stalled creation, requires refreshed accounts before retry, and ignores a late response', async () => {
  let finish!: (value: unknown) => void;
  m.post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const client = show(<CreateAgentPage />);
  await screen.findByRole('option', { name: 'Ethiopia' });
  await screen.findByText('No pending activations.');
  fill('Username', 'fixture_agent');
  fill('Email', 'agent@fixture.invalid');
  fill('Display name', 'Fixture');
  fill('Country', 'country');
  fill('Temporary password', 'SyntheticFixture!42');
  m.get.mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Create agent account' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  const mutationSignal = m.post.mock.calls[0][3].signal;
  expect(mutationSignal.aborted).toBe(true);
  expect(screen.getByRole('alert')).toHaveTextContent('account may already exist');
  expect(screen.getByRole('button', { name: 'Checking pending accounts…' })).toBeDisabled();
  expect(m.post).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  expect(screen.getByRole('button', { name: 'Create agent account' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Refresh pending accounts' })).toBeEnabled();
  expect(screen.getByLabelText('Temporary password')).toHaveValue('');
  await act(async () => {
    finish({
      success: true,
      data: {
        username: 'fixture_agent',
        email: 'agent@fixture.invalid',
        expiresAt: '2026-10-06T00:00:00Z',
      },
    });
  });
  expect(screen.queryByText('Agent account created')).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pending accounts' }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole('button', { name: 'Create agent account' })).toBeEnabled();
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data)
    )
  ).not.toContain('SyntheticFixture!42');
});
it('bounds a stalled activation and directs the agent to verify sign-in without resubmitting credentials', async () => {
  m.post.mockImplementationOnce(() => new Promise(() => {}));
  show(<ActivateAgentPage />);
  fill('Email', 'agent@fixture.invalid');
  fill('Temporary password', 'SyntheticFixture!42');
  fill('New password', 'PrivateFixture!43');
  fill('Confirm new password', 'PrivateFixture!43');
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Set private password' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  expect(m.post.mock.calls[0][3].signal.aborted).toBe(true);
  expect(screen.getByRole('alert')).toHaveTextContent('password may already have been set');
  expect(screen.getByRole('link', { name: 'Sign in to check activation' })).toHaveAttribute(
    'href',
    '/agent/login'
  );
  expect(screen.getByRole('button', { name: 'Set private password' })).toBeEnabled();
  for (const label of ['Temporary password', 'New password', 'Confirm new password']) {
    expect(screen.getByLabelText(label)).toHaveValue('');
  }
  expect(m.post).toHaveBeenCalledTimes(1);
});
it('bounds a stalled reissue and prevents replacement after refresh finds the account no longer pending', async () => {
  const pendingAccount = {
    userId: 'pending-id',
    expiresAt: '2026-10-06T00:00:00Z',
    user: { username: 'pending', email: 'pending@fixture.invalid' },
  };
  m.get.mockImplementation(async (path: string) => ({
    success: true,
    data: path.includes('countries') ? [] : [pendingAccount],
  }));
  m.post.mockImplementationOnce(() => new Promise(() => {}));
  show(<CreateAgentPage />);
  await screen.findByRole('option', { name: /pending@fixture.invalid/ });
  fill('Pending agent', 'pending-id');
  fill('Replacement temporary password', 'ReplacementFixture!42');
  m.get.mockResolvedValueOnce({ success: true, data: [] });
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Replace temporary password' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(m.post.mock.calls[0][3].signal.aborted).toBe(true);
  expect(screen.getByRole('status')).toHaveTextContent(
    'previous temporary password may no longer work'
  );
  expect(screen.getByLabelText('Replacement temporary password')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Replace temporary password' })).toBeDisabled();
  expect(screen.getByText('No pending activations.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Replace temporary password' }));
  expect(m.post).toHaveBeenCalledTimes(1);
});
