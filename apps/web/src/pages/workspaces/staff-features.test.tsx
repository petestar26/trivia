import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), logout: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'admin' }, logout: m.logout }),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<any>()), api: m }));
import { ExistingMemberAgentForm } from './existing-member-agent';
import { AdminAgents } from './agents';
import { AgentOverview } from './agent-overview';
import { ChangePassword } from '@/components/security/change-password';
function show(child: React.ReactNode) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={['/agent/profile']}>
        <Routes>
          <Route path="/agent/profile" element={child} />
          <Route path="/agent/login" element={<p>Agent sign in after password change</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return cache;
}
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const failure = (status: number, message: string) => new Error(JSON.stringify({ status, message }));
beforeEach(() => {
  vi.resetAllMocks();
  m.logout.mockResolvedValue(undefined);
});
function approvalForm() {
  show(
    <ExistingMemberAgentForm
      countries={[
        { id: 'et', name: 'Ethiopia', isActive: true },
        { id: 'off', name: 'Disabled country', isActive: false },
      ]}
      countriesUnavailable={false}
    />
  );
  fill('Member email', 'member@fixture.invalid');
  fill('Agent display name', 'Member');
  fill('Agent country', 'et');
}
it('approves an existing account without accepting a password or duplicate clicks', async () => {
  let finish!: (v: unknown) => void;
  m.post.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  approvalForm();
  expect(screen.queryByRole('option', { name: 'Disabled country' })).not.toBeInTheDocument();
  const submit = screen.getByRole('button', { name: 'Approve agent access' });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(m.post.mock.calls[0][1]).toEqual({
    email: 'member@fixture.invalid',
    displayName: 'Member',
    countryId: 'et',
  });
  await act(async () =>
    finish({ success: true, data: { email: 'member@fixture.invalid', username: 'member' } })
  );
  expect(await screen.findByText('Agent access approved')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Agent sign in' })).toHaveAttribute(
    'href',
    '/agent/login'
  );
});
it('shows a correctable approval error and requires renewed confirmation after editing the member', async () => {
  m.post.mockRejectedValue(failure(404, 'No member was found with that email.'));
  approvalForm();
  fireEvent.click(screen.getByRole('checkbox'));
  fill('Member email', 'second@fixture.invalid');
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Approve agent access' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No member was found');
  expect(screen.getByRole('checkbox')).not.toBeChecked();
});
it('binds an agent status action to the displayed version and never silently retries conflicts', async () => {
  m.get.mockResolvedValue({
    success: true,
    data: {
      rows: [
        {
          id: 'agent',
          displayName: 'Fixture Agent',
          status: 'ACTIVE',
          updatedAt: '2026-11-05T00:00:00.000Z',
          availableDepositFunding: 12000,
          country: { name: 'Ethiopia' },
          user: {
            id: 'member',
            username: 'member',
            email: 'member@fixture.invalid',
            status: 'ACTIVE',
          },
          _count: { paymentAccounts: 1, orders: 0, withdrawals: 0 },
        },
      ],
      total: 1,
      pageSize: 30,
    },
  });
  m.post.mockRejectedValue(failure(409, 'Agent status changed. Refresh before trying again.'));
  show(<AdminAgents />);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause agent' }));
  fill('Reason', 'Review payment handling');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm pause agent' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Agent status changed'));
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(m.post.mock.calls[0].slice(0, 2)).toEqual([
    '/agents/agent/suspend',
    { reason: 'Review payment handling', expectedUpdatedAt: '2026-11-05T00:00:00.000Z' },
  ]);
  expect(screen.getByRole('checkbox')).not.toBeChecked();
});
it('shows real agent work counts and distinguishes missing funding from enabled access', async () => {
  m.get.mockResolvedValue({
    success: true,
    data: {
      agent: { displayName: 'Fixture Agent', contactEmail: 'agent@fixture.invalid' },
      country: { name: 'Ethiopia', currencyCode: 'ETB' },
      deposits: { PAYMENT_SUBMITTED: 3, COMPLETED: 7 },
      payouts: { HELD: 2, PAYOUT_IN_PROGRESS: 1 },
      inventory: { total: 0, reserved: 0, available: 0 },
      liquidity: [],
      setup: {
        countryActive: true,
        paymentsEnabled: false,
        rateReady: true,
        approvedAccounts: 0,
        pendingAccounts: 2,
        hasDepositFunding: false,
        hasPayoutLiquidity: false,
      },
      recentDeposits: [],
      recentPayouts: [],
      asOf: '2026-11-05T00:00:00Z',
    },
  });
  show(<AgentOverview />);
  expect(await screen.findByText('Welcome, Fixture Agent')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Deposits to verify 3' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Payouts to process 3' })).toBeInTheDocument();
  expect(screen.getAllByText('Needs setup')).toHaveLength(4);
  expect(screen.getByText('No assigned payments yet.')).toBeInTheDocument();
});
it('clears password fields before waiting, then signs out and returns to the matching staff sign-in', async () => {
  let finish!: (v: unknown) => void;
  m.post.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const cache = show(<ChangePassword />);
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  fill('Current password', 'OldFixture!42');
  fill('New password', 'PrivateFixture!43');
  fill('Confirm new password', 'PrivateFixture!43');
  const submit = screen.getByRole('button', { name: 'Save new password' });
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(m.post).toHaveBeenCalledTimes(1);
  for (const label of ['Current password', 'New password', 'Confirm new password'])
    expect(screen.getByLabelText(label)).toHaveValue('');
  await act(async () => finish({ success: true, data: { changed: true } }));
  expect(await screen.findByText('Agent sign in after password change')).toBeInTheDocument();
  expect(m.logout).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(
      cache
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data)
    )
  ).not.toContain('PrivateFixture');
});
it('does not sign out after an incorrect current password', async () => {
  m.post.mockRejectedValue(failure(401, 'Your current password is incorrect.'));
  show(<ChangePassword />);
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  fill('Current password', 'WrongFixture!42');
  fill('New password', 'PrivateFixture!43');
  fill('Confirm new password', 'PrivateFixture!43');
  fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your current password is incorrect.');
  expect(m.logout).not.toHaveBeenCalled();
});
