import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter>{agent ? <WalletAgentSetupPage /> : <WalletSetupAdmin />}</MemoryRouter>
    </QueryClientProvider>
  );
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
