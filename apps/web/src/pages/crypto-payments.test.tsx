import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: m, unwrapData: (r: { data: unknown }) => r.data }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'member' } }) }));
import { CryptoPaymentsPage, cryptoEstimate, timeRemaining } from './crypto-payments';
const options = {
  depositEnabled: true,
  withdrawalEnabled: true,
  countries: [{ id: 'country', name: 'Test country' }],
};
const row = {
  id: 'invoice',
  address: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
  amount: '10.000000',
  coinAmount: 960,
  status: 'WAITING',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600000).toISOString(),
};
beforeEach(() => {
  sessionStorage.clear();
  m.post.mockReset();
  m.get.mockReset();
  m.get.mockImplementation(async (p: string) => ({
    data: p.includes('options') ? options : { deposits: [], withdrawals: [], addresses: [] },
  }));
});
afterEach(cleanup);
function mount(admin = false, path = '/wallet/crypto') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter initialEntries={[path]}>
        <CryptoPaymentsPage admin={admin} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it('keeps payment controls disabled when server gates are paused', async () => {
  m.get.mockImplementation(async (p: string) => ({
    data: p.includes('options')
      ? { ...options, depositEnabled: false, withdrawalEnabled: false }
      : { deposits: [], withdrawals: [] },
  }));
  mount();
  await screen.findByText('New crypto deposits are paused.');
  fireEvent.change(screen.getByLabelText('Deposit amount (USDT)'), { target: { value: '10' } });
  expect(screen.getByRole('button', { name: 'Get deposit address' })).toBeDisabled();
  expect(m.post).not.toHaveBeenCalled();
});
it('retains the same deposit request across an uncertain response and retry', async () => {
  m.post
    .mockRejectedValueOnce(new Error('Network timeout'))
    .mockResolvedValueOnce({ success: true });
  mount();
  await screen.findByLabelText('Deposit amount (USDT)');
  fireEvent.change(screen.getByLabelText('Deposit amount (USDT)'), {
    target: { value: '10.000001' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Get deposit address' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry the same request' }));
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
  expect(m.post.mock.calls[0][1]).toEqual(m.post.mock.calls[1][1]);
  expect(m.post.mock.calls[0][1]).toMatchObject({
    amount: '10.000001',
    countryId: 'country',
    idempotencyKey: expect.any(String),
  });
});
it('shows the address, deadline and delayed verification without inviting a second payment', async () => {
  m.get.mockImplementation(async (p: string) => ({
    data: p.includes('options')
      ? options
      : { deposits: [{ ...row, verificationDelayed: true }], withdrawals: [] },
  }));
  mount();
  await screen.findByText(row.address);
  expect(screen.getByText(/Transfer within/)).toBeInTheDocument();
  expect(screen.getByText(/Do not send again/)).toBeInTheDocument();
});
it('withdrawal request includes the member destination and exact Coin amount', async () => {
  m.post.mockResolvedValue({ success: true });
  mount();
  await screen.findByLabelText('Deposit amount (USDT)');
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
  fireEvent.change(screen.getByLabelText('Withdraw amount (Coins)'), { target: { value: '2017' } });
  fireEvent.change(screen.getByLabelText('Your TRON receiving address'), {
    target: { value: row.address },
  });
  expect(screen.getByText('21.010416 USDT')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Review withdrawal' }));
  expect(m.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Request withdrawal' }));
  await waitFor(() => expect(m.post).toHaveBeenCalled());
  expect(m.post.mock.calls[0][1]).toMatchObject({ address: row.address, coinAmount: 2017 });
});
it('admin sees member addresses and must verify transfer evidence before confirmation', async () => {
  m.get.mockResolvedValue({
    data: {
      deposits: [],
      withdrawals: [
        {
          ...row,
          expiresAt: undefined,
          status: 'PAYOUT_IN_PROGRESS',
          userId: 'customer',
          assignedAdminId: 'member',
        },
      ],
      addresses: [],
    },
  });
  mount(true);
  await screen.findByText(row.address);
  fireEvent.click(screen.getByRole('button', { name: 'Record completed transfer' }));
  expect(screen.getByRole('button', { name: 'Confirm withdrawal' })).toBeDisabled();
  expect(screen.getByText(/Never transfer a withdrawal/)).toHaveTextContent(
    'including a retired address'
  );
  expect(screen.queryByRole('button', { name: 'Cancel and return Coins' })).toBeNull();
  expect(m.post).not.toHaveBeenCalled();
});
it('formats exact decimal previews and a nonnegative countdown', () => {
  expect(cryptoEstimate('10.010416')).toBe('960 Coins');
  expect(cryptoEstimate('2017', true)).toBe('21.010416 USDT');
  expect(cryptoEstimate('1e9')).toBe('');
  expect(timeRemaining(new Date(0).toISOString(), 100)).toBe('0:00');
});
it('never invites another transfer after credit and links the verified receipt', async () => {
  m.get.mockImplementation(async (p: string) => ({
    data: p.includes('options')
      ? options
      : {
          deposits: [
            {
              ...row,
              status: 'CREDITED',
              transfers: [
                {
                  txHash: 'ab'.repeat(32),
                  logIndex: 0,
                  amount: '10.000000',
                  blockNumber: '123',
                  blockTime: new Date().toISOString(),
                },
              ],
            },
          ],
          withdrawals: [],
        },
  }));
  mount();
  await screen.findByText(/Your Coins have been credited/);
  expect(screen.queryByText(/Send the exact amount/)).toBeNull();
  expect(screen.getByRole('link', { name: 'View deposit transfer' })).toHaveAttribute(
    'href',
    `https://tronscan.org/#/transaction/${'ab'.repeat(32)}`
  );
});

it('opens crypto withdrawal directly and preserves direction when switching to an agent', async () => {
  mount(false, '/wallet/crypto?direction=withdraw');
  await screen.findByLabelText('Withdraw amount (Coins)');
  expect(screen.queryByLabelText('Deposit amount (USDT)')).toBeNull();
  expect(screen.getByRole('link', { name: /Agent Bank or mobile money/ })).toHaveAttribute(
    'href',
    '/wallet/withdraw'
  );
  expect(m.post).not.toHaveBeenCalled();
});
it('requires a fresh review when the withdrawal amount or address changes', async () => {
  mount(false, '/wallet/crypto?direction=withdraw');
  fireEvent.change(await screen.findByLabelText('Withdraw amount (Coins)'), {
    target: { value: '2017' },
  });
  fireEvent.change(screen.getByLabelText('Your TRON receiving address'), {
    target: { value: row.address },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review withdrawal' }));
  expect(screen.getByRole('region', { name: 'Review withdrawal' })).toHaveTextContent(row.address);
  expect(m.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Withdraw amount (Coins)'), { target: { value: '2500' } });
  expect(screen.queryByRole('button', { name: 'Request withdrawal' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review withdrawal' }));
  fireEvent.change(screen.getByLabelText('Your TRON receiving address'), {
    target: { value: 'wrong-network' },
  });
  expect(screen.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();
  expect(m.post).not.toHaveBeenCalled();
});
it('rejects zero, unrepresentable and unsupported amount inputs before sending', async () => {
  mount();
  const field = await screen.findByLabelText('Deposit amount (USDT)');
  for (const value of ['0', '0.000001', '01.00', '99999999', '1e3', '-10']) {
    fireEvent.change(field, { target: { value } });
    expect(screen.getByRole('button', { name: 'Get deposit address' })).toBeDisabled();
  }
  expect(cryptoEstimate('1000000001', true)).toBe('');
  expect(cryptoEstimate('0', true)).toBe('');
  expect(m.post).not.toHaveBeenCalled();
});
it('retry preserves the original deposit even after opening withdrawal', async () => {
  m.post
    .mockRejectedValueOnce(new Error('Network timeout'))
    .mockResolvedValueOnce({ success: true });
  mount();
  fireEvent.change(await screen.findByLabelText('Deposit amount (USDT)'), {
    target: { value: '10' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Get deposit address' }));
  await screen.findByRole('button', { name: 'Retry the same request' });
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
  expect(screen.getByText(/earlier deposit still needs confirmation/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry the same request' }));
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(2));
  expect(m.post.mock.calls[1][0]).toBe('/crypto-payments/deposits');
  expect(m.post.mock.calls[1][1]).toEqual(m.post.mock.calls[0][1]);
});
