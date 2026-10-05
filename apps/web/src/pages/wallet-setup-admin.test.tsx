import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: m,
}));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'admin' } }) }));
import { WalletSetupAdmin } from './wallet-setup-admin';
import { WalletAgentSetupPage } from './wallet-agent-setup';
const country = {
  id: 'et',
  name: 'Ethiopia',
  code: 'ET',
  currencyCode: 'ETB',
  isActive: true,
  agentPaymentEnabled: false,
};
const setup = {
  country: { ...country, paymentMethods: [] },
  agents: [
    {
      id: 'agent-1',
      displayName: 'Test agent',
      status: 'ACTIVE',
      user: { status: 'ACTIVE' },
      availableCoins: 0,
      inventory: null,
      approvedPaymentAccounts: 0,
      paymentAccounts: [],
      fiatLiquidity: [],
    },
  ],
  rateId: null,
  rateStatus: 'Rate missing',
  crypto: [],
  admissionNotice: 'Eligibility applies',
};
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  m.get.mockImplementation(async (path: string) => ({
    success: true,
    data:
      path === '/agent-config/admin/countries'
        ? [country]
        : path === '/agent-config/admin/setup/et'
          ? setup
          : path === '/agents/me/setup'
            ? null
            : path === '/agent-config/countries'
              ? [country]
              : [],
  }));
  m.post.mockResolvedValue({ success: true });
});
afterEach(cleanup);
function mount(agent = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{agent ? <WalletAgentSetupPage /> : <WalletSetupAdmin />}</MemoryRouter>
    </QueryClientProvider>
  );
  return { ...view, client };
}
it('prefills Ethiopia as inactive setup and prevents enabling payments without rate/methods', async () => {
  mount();
  await screen.findByRole('option', { name: 'Ethiopia · ETB' });
  expect(screen.getByLabelText('Country code')).toHaveValue('ET');
  fireEvent.change(screen.getByLabelText('Manage country'), { target: { value: 'et' } });
  expect(await screen.findByRole('button', { name: 'Enable new agent payments' })).toBeDisabled();
  expect(m.post).not.toHaveBeenCalled();
  expect(m.patch).not.toHaveBeenCalled();
});
it('requires confirmation and sends fiat major amounts as exact minor-unit strings', async () => {
  mount();
  await screen.findByRole('option', { name: 'Ethiopia · ETB' });
  fireEvent.change(screen.getByLabelText('Manage country'), { target: { value: 'et' } });
  await screen.findByRole('option', { name: 'Test agent' });
  fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'agent-1' } });
  fireEvent.change(screen.getByLabelText('Funding balance'), { target: { value: 'liquidity' } });
  fireEvent.change(screen.getByLabelText('Amount (ETB)'), { target: { value: '123.45' } });
  fireEvent.click(screen.getByText('Agents, Coin inventory & fiat liquidity'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm backed allocation' }));
  expect(m.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /^Confirm$/ }));
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
  expect(m.post.mock.calls[0].slice(0, 2)).toEqual([
    '/agents/agent-1/liquidity/fund',
    { fiatCurrency: 'ETB', amountMinor: '12345', idempotencyKey: expect.any(String) },
  ]);
});
it('offers agent application for a nullable own profile and sends only entered details', async () => {
  mount(true);
  await screen.findByLabelText('Agent country');
  fireEvent.change(screen.getByLabelText('Agent country'), { target: { value: 'et' } });
  fireEvent.change(screen.getByLabelText('Agent display name'), { target: { value: 'My desk' } });
  fireEvent.change(screen.getByLabelText('Contact email'), {
    target: { value: 'agent@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Submit agent application' }));
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
  expect(m.post.mock.calls[0][0]).toBe('/agents/applications');
  expect(m.post.mock.calls[0][1]).toMatchObject({
    countryId: 'et',
    displayName: 'My desk',
    contactEmail: 'agent@example.test',
  });
});
it('does not offer an application when profile lookup failed', async () => {
  m.get.mockRejectedValue(new Error('Unavailable'));
  mount(true);
  await screen.findByText(/Could not check your agent status/);
  expect(
    screen.queryByRole('button', { name: 'Submit agent application' })
  ).not.toBeInTheDocument();
});

it.each([{ success: true }, { success: false, data: null, error: { message: 'Access denied' } }])(
  'does not turn a malformed or failed profile response into a new application: %j',
  async (response) => {
    m.get.mockResolvedValue(response);
    mount(true);
    await screen.findByText(/Could not check your agent status/);
    expect(
      screen.queryByRole('button', { name: 'Submit agent application' })
    ).not.toBeInTheDocument();
  }
);

const reviewVersion = '2026-10-05T10:00:00.000Z';
const paymentReview = {
  id: 'payment-account',
  updatedAt: reviewVersion,
  agent: { displayName: 'Fixture agent', countryId: 'et' },
  accountDetails: { accountName: 'Fixture recipient', accountNumber: 'destination-a' },
};
function mockPaymentReviews(read: () => unknown[]) {
  const original = m.get.getMockImplementation()!;
  m.get.mockImplementation((path: string, ...args) =>
    path === '/agents/payment-accounts/pending'
      ? Promise.resolve({ success: true, data: read() })
      : original(path, ...args)
  );
}
async function openPaymentReview() {
  fireEvent.click(screen.getByText('Payment account approvals'));
  return within(
    await screen.findByRole('article', { name: 'Payment account review payment-account' })
  );
}
it.each(['approve', 'reject'] as const)(
  'sends the displayed payment-account version when confirming %s',
  async (action) => {
    mockPaymentReviews(() => [paymentReview]);
    m.post.mockResolvedValue({ success: true, data: { status: 'APPROVED' } });
    mount();
    const card = await openPaymentReview();
    const note = 'Verified receiving-account documentation';
    fireEvent.change(screen.getByLabelText('Review / adjustment reason'), {
      target: { value: note },
    });
    fireEvent.click(
      card.getByRole('button', {
        name: action === 'approve' ? 'Approve verified record' : 'Reject with reason',
      })
    );
    expect(m.post).not.toHaveBeenCalled();
    fireEvent.click(card.getByRole('button', { name: /^Confirm$/ }));
    await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
    expect(m.post.mock.calls[0].slice(0, 2)).toEqual([
      `/agents/payment-accounts/payment-account/${action}`,
      { expectedUpdatedAt: reviewVersion, ...(action === 'reject' ? { reviewNote: note } : {}) },
    ]);
  }
);
it('refreshes a stale-review 409 without retrying approval and requires reviewing the new destination again', async () => {
  let records = [paymentReview];
  const updatedVersion = '2026-10-05T11:00:00.000Z';
  mockPaymentReviews(() => records);
  m.post.mockImplementationOnce(async () => {
    records = [
      {
        ...paymentReview,
        updatedAt: updatedVersion,
        accountDetails: { ...paymentReview.accountDetails, accountNumber: 'destination-b' },
      },
    ];
    throw new Error(
      JSON.stringify({
        status: 409,
        message:
          'Payment account changed after this review was loaded. Reload and review the current details.',
      })
    );
  });
  mount();
  const card = await openPaymentReview();
  expect(card.getByText(/destination-a/)).toBeInTheDocument();
  fireEvent.click(card.getByRole('button', { name: 'Approve verified record' }));
  fireEvent.click(card.getByRole('button', { name: /^Confirm$/ }));
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Payment account changed after this review was loaded'
  );
  await screen.findByText(/destination-b/);
  const refreshedCard = within(
    screen.getByRole('article', { name: 'Payment account review payment-account' })
  );
  await waitFor(() =>
    expect(refreshedCard.getByRole('button', { name: 'Approve verified record' })).toBeEnabled()
  );
  expect(refreshedCard.queryByRole('button', { name: /^Confirm$/ })).not.toBeInTheDocument();
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(m.post.mock.calls[0][1]).toEqual({ expectedUpdatedAt: reviewVersion });
  m.post.mockResolvedValueOnce({ success: true, data: { status: 'APPROVED' } });
  fireEvent.click(refreshedCard.getByRole('button', { name: 'Approve verified record' }));
  expect(m.post).toHaveBeenCalledTimes(1);
  fireEvent.click(refreshedCard.getByRole('button', { name: /^Confirm$/ }));
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
  expect(m.post.mock.calls[1][1]).toEqual({ expectedUpdatedAt: updatedVersion });
});
it('resets an open confirmation when refetch displays a different account version', async () => {
  let records = [paymentReview];
  mockPaymentReviews(() => records);
  const { client } = mount();
  const card = await openPaymentReview();
  fireEvent.click(card.getByRole('button', { name: 'Approve verified record' }));
  expect(card.getByRole('button', { name: /^Confirm$/ })).toBeInTheDocument();
  records = [
    {
      ...paymentReview,
      updatedAt: '2026-10-05T11:00:00.000Z',
      accountDetails: { ...paymentReview.accountDetails, accountNumber: 'destination-b' },
    },
  ];
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['payments', 'pending-accounts'] });
  });
  await screen.findByText(/destination-b/);
  const refreshedCard = within(
    screen.getByRole('article', { name: 'Payment account review payment-account' })
  );
  expect(refreshedCard.queryByRole('button', { name: /^Confirm$/ })).not.toBeInTheDocument();
  expect(refreshedCard.getByRole('button', { name: 'Approve verified record' })).toBeEnabled();
  expect(m.post).not.toHaveBeenCalled();
});
it.each([
  { ...paymentReview, updatedAt: undefined },
  { ...paymentReview, updatedAt: 'invalid-version' },
  { ...paymentReview, accountDetails: undefined },
])(
  'blocks a payment-account review when its displayed details or version are unavailable: %j',
  async (record) => {
    mockPaymentReviews(() => [record]);
    mount();
    const card = await openPaymentReview();
    fireEvent.change(screen.getByLabelText('Review / adjustment reason'), {
      target: { value: 'A valid review reason' },
    });
    expect(card.getByRole('alert')).toHaveTextContent(
      'Account details or review version are unavailable'
    );
    expect(card.getByRole('button', { name: 'Approve verified record' })).toBeDisabled();
    expect(card.getByRole('button', { name: 'Reject with reason' })).toBeDisabled();
    expect(m.post).not.toHaveBeenCalled();
  }
);
it('keeps agent-application review payloads unchanged without requiring a payment-account version', async () => {
  const original = m.get.getMockImplementation()!;
  m.get.mockImplementation((path: string, ...args) =>
    path === '/agents/applications/pending'
      ? Promise.resolve({
          success: true,
          data: [
            {
              id: 'application',
              agent: paymentReview.agent,
              submittedData: { displayName: 'Fixture desk' },
            },
          ],
        })
      : original(path, ...args)
  );
  m.post.mockResolvedValue({ success: true, data: { status: 'APPROVED' } });
  mount();
  fireEvent.click(screen.getByText('Agent applications'));
  const card = within(
    await screen.findByRole('article', { name: 'Agent application review application' })
  );
  fireEvent.change(screen.getByLabelText('Review / adjustment reason'), {
    target: { value: 'Application checked' },
  });
  fireEvent.click(card.getByRole('button', { name: 'Approve verified record' }));
  fireEvent.click(card.getByRole('button', { name: /^Confirm$/ }));
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
  expect(m.post.mock.calls[0].slice(0, 2)).toEqual([
    '/agents/applications/application/approve',
    { reviewNote: 'Application checked' },
  ]);
});
