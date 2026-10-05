import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: transport,
}));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'owner-user' } }) }));
import { WalletAgentSetupPage } from './wallet-agent-setup';

const profile = {
  id: 'own-agent',
  countryId: 'et',
  displayName: 'Fixture agent',
  status: 'ACTIVE',
};
const methods = [
  {
    id: 'mobile',
    name: 'Telebirr',
    fieldSchema: { requiredFields: ['accountName', 'accountNumber'] },
  },
  { id: 'bank', name: 'Bank transfer', fieldSchema: { requiredFields: ['accountName', 'iban'] } },
];
function account(id = 'own-account', status = 'APPROVED') {
  return {
    id,
    countryId: 'et',
    methodDefId: 'mobile',
    status,
    accountDetails: { accountName: `${id} owner`, accountNumber: `${id} number` },
    updatedAt: '2026-10-05T00:00:00Z',
  };
}
let currentAccounts: ReturnType<typeof account>[];
let currentProfile: typeof profile;
beforeEach(() => {
  vi.clearAllMocks();
  currentAccounts = [account()];
  currentProfile = profile;
  transport.get.mockImplementation(async (path: string) => ({
    success: true,
    data:
      path === '/agents/me/setup'
        ? currentProfile
        : path === '/agents/me/payment-accounts'
          ? currentAccounts.map((a) => ({ ...a, accountDetails: { ...a.accountDetails } }))
          : path === '/agent-config/countries'
            ? [{ id: 'et', name: 'Ethiopia' }]
            : methods,
  }));
  transport.post.mockResolvedValue({ success: true, data: { status: 'PENDING_APPROVAL' } });
  transport.patch.mockResolvedValue({ success: true, data: { status: 'PENDING_APPROVAL' } });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WalletAgentSetupPage workspace />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return client;
}
async function loaded() {
  await screen.findByRole('option', { name: 'Telebirr' });
  await waitFor(() => expect(screen.getByLabelText('Account payment method')).toBeEnabled());
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

it('identifies owner destinations with readable labels and meaningful review states', async () => {
  currentAccounts = [
    account('rejected-account', 'REJECTED'),
    account('disabled-account', 'DISABLED'),
  ];
  mount();
  await loaded();
  const rejected = within(
    screen.getByRole('article', { name: 'Receiving account rejected-account' })
  );
  expect(rejected.getByText('Account name')).toBeInTheDocument();
  expect(rejected.getByText('rejected-account number')).toBeInTheDocument();
  expect(rejected.getByText(/Check the administrator’s feedback/)).toBeInTheDocument();
  expect(rejected.getByRole('button', { name: 'Correct and resubmit' })).toBeEnabled();
  expect(rejected.queryByRole('button', { name: 'Disable account' })).not.toBeInTheDocument();
  expect(
    within(screen.getByRole('article', { name: 'Receiving account disabled-account' })).queryByRole(
      'button'
    )
  ).not.toBeInTheDocument();
});

it('edits the selected own account through PATCH and explains approval must be repeated', async () => {
  currentAccounts.push(account('second-account'));
  transport.patch.mockImplementation(async (path, body) => {
    currentAccounts = currentAccounts.map((a) =>
      a.id === 'second-account'
        ? {
            ...a,
            accountDetails: body.accountDetails,
            status: 'PENDING_APPROVAL',
            updatedAt: '2026-10-05T01:00:00Z',
          }
        : a
    );
    return { success: true, data: { status: 'PENDING_APPROVAL' } };
  });
  mount();
  await loaded();
  fireEvent.click(
    within(screen.getByRole('article', { name: 'Receiving account second-account' })).getByRole(
      'button',
      { name: 'Edit account' }
    )
  );
  expect(screen.getByLabelText('Account number')).toHaveValue('second-account number');
  expect(screen.getByText(/Saving changes sends this account back/)).toBeInTheDocument();
  fill('Account number', 'corrected-number');
  fireEvent.click(screen.getByRole('button', { name: 'Save and resubmit for review' }));
  await screen.findByText(/Updated account submitted for administrator review/);
  expect(transport.patch).toHaveBeenCalledTimes(1);
  expect(transport.patch.mock.calls[0].slice(0, 2)).toEqual([
    '/agents/me/payment-accounts/second-account',
    {
      countryId: 'et',
      methodDefId: 'mobile',
      accountDetails: { accountName: 'second-account owner', accountNumber: 'corrected-number' },
    },
  ]);
  expect(transport.post).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByLabelText('Account payment method')).toHaveValue(''));
  expect(
    within(screen.getByRole('article', { name: 'Receiving account second-account' })).getByText(
      'Pending approval'
    )
  ).toBeInTheDocument();
});

it('requires explicit confirmation to disable the selected account and preserves its displayed history', async () => {
  transport.post.mockImplementation(async () => {
    currentAccounts = [account('own-account', 'DISABLED')];
    return { success: true, data: { status: 'DISABLED' } };
  });
  mount();
  await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Disable account' }));
  expect(screen.getByRole('group', { name: 'Confirm account disabling' })).toHaveTextContent(
    'cannot be re-enabled'
  );
  expect(transport.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('button', { name: 'Confirm disable' })).not.toBeInTheDocument();
  expect(transport.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Disable account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm disable' }));
  await screen.findByText(/Receiving account disabled/);
  expect(transport.post).toHaveBeenCalledTimes(1);
  expect(transport.post.mock.calls[0][0]).toBe('/agents/me/payment-accounts/own-account/disable');
  expect(transport.post.mock.calls[0][1]).toBeUndefined();
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Disable account' })).not.toBeInTheDocument()
  );
  expect(screen.getByText('own-account number')).toBeInTheDocument();
});

it('lets a suspended owner disable a verified own destination while blocking creation and editing', async () => {
  currentProfile = { ...profile, status: 'TEMPORARILY_SUSPENDED' };
  mount();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Disable account' })).toBeEnabled()
  );
  expect(screen.getByRole('button', { name: 'Edit account' })).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: 'Submit account for review' })
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Disable account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm disable' }));
  await screen.findByText(/Receiving account disabled/);
  expect(transport.post.mock.calls[0][0]).toBe('/agents/me/payment-accounts/own-account/disable');
  expect(transport.patch).not.toHaveBeenCalled();
});

it('refreshes a timed-out create and clears its draft without automatically creating a duplicate', async () => {
  currentAccounts = [];
  transport.post.mockImplementation(() => {
    // The server committed, but the response never arrived and ignores abort.
    currentAccounts = [account('submitted-account', 'PENDING_APPROVAL')];
    return new Promise(() => {});
  });
  mount();
  await loaded();
  fill('Account payment method', 'mobile');
  fill('Account name', 'Fixture recipient');
  fill('Account number', 'fixture-destination');
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Submit account for review' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  expect(screen.getByRole('alert')).toHaveTextContent(
    'A request may have completed even if its response was lost'
  );
  expect(screen.getByText('submitted-account number')).toBeInTheDocument();
  expect(screen.getByLabelText('Account payment method')).toHaveValue('');
  expect(transport.post.mock.calls[0][3].signal.aborted).toBe(true);
  expect(
    transport.get.mock.calls.filter(([path]) => path === '/agents/me/payment-accounts').length
  ).toBeGreaterThan(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16000);
  });
  expect(transport.post).toHaveBeenCalledTimes(1);
});

it('blocks blank submissions and removes stale destination fields when changing method or cancelling an edit', async () => {
  mount();
  await loaded();
  const create = screen.getByRole('button', { name: 'Submit account for review' });
  expect(create).toBeDisabled();
  fireEvent.submit(create.closest('form')!);
  expect(transport.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Edit account' }));
  fill('Account payment method', 'bank');
  expect(screen.queryByLabelText('Account number')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Account name')).toHaveValue('');
  expect(screen.getByLabelText('IBAN')).toHaveValue('');
  const save = screen.getByRole('button', { name: 'Save and resubmit for review' });
  expect(save).toBeDisabled();
  fireEvent.submit(save.closest('form')!);
  expect(transport.patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
  expect(screen.getByLabelText('Account payment method')).toHaveValue('');
  expect(screen.queryByLabelText('IBAN')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Submit account for review' })).toBeDisabled();
});

it('clears an edit when the refreshed account changed instead of overwriting newer state', async () => {
  const client = mount();
  await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Edit account' }));
  fill('Account number', 'stale-draft');
  currentAccounts = [account('own-account', 'DISABLED')];
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ['payments', 'own-payment-accounts', 'owner-user'],
    });
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('changed while you were editing');
  expect(
    screen.queryByRole('button', { name: 'Save and resubmit for review' })
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText('Account payment method')).toHaveValue('');
  expect(transport.patch).not.toHaveBeenCalled();
});

it.each(['accounts', 'methods'])(
  'fails closed after a %s refresh error even when cached data exists',
  async (failed) => {
    const client = mount();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Edit account' }));
    const original = transport.get.getMockImplementation()!;
    transport.get.mockImplementation((path, ...args) =>
      path ===
      (failed === 'accounts'
        ? '/agents/me/payment-accounts'
        : '/agent-config/countries/et/payment-methods/active')
        ? Promise.reject(new Error('Unavailable'))
        : original(path, ...args)
    );
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ['payments', failed === 'accounts' ? 'own-payment-accounts' : 'agent-methods'],
      });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      failed === 'accounts' ? 'Could not load accounts' : 'Methods could not load'
    );
    const save = screen.getByRole('button', { name: 'Save and resubmit for review' });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest('form')!);
    expect(transport.patch).not.toHaveBeenCalled();
    expect(transport.post).not.toHaveBeenCalled();
  }
);
