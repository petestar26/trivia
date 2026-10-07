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
function mount(admin = false) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter>
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
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw', exact: true }));
  fireEvent.change(screen.getByLabelText('Withdraw amount (Coins)'), { target: { value: '2017' } });
  fireEvent.change(screen.getByLabelText('Your TRON receiving address'), {
    target: { value: row.address },
  });
  expect(screen.getByText('21.010416 USDT')).toBeInTheDocument();
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
  expect(screen.queryByRole('button', { name: 'Cancel and return Coins' })).toBeNull();
  expect(m.post).not.toHaveBeenCalled();
});
it('formats exact decimal previews and a nonnegative countdown', () => {
  expect(cryptoEstimate('10.010416')).toBe('960 Coins');
  expect(cryptoEstimate('2017', true)).toBe('21.010416 USDT');
  expect(cryptoEstimate('1e9')).toBe('');
  expect(timeRemaining(new Date(0).toISOString(), 100)).toBe('0:00');
});
