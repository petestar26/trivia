import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get }, unwrapData: (r: any) => r.data }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'member' } }) }));
import { PracticeWalletPage } from './practice-wallet';
afterEach(() => {
  cleanup();
  get.mockReset();
});
beforeEach(() => {
  get.mockImplementation(async (path) => ({
    data:
      path === '/gift-collection'
        ? { balance: 9500 }
        : { coinsBalance: 480, coinAvailability: { spendable: 384, betOnly: 96 } },
  }));
});
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter>
        <PracticeWalletPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it('separates withdrawable payment units from noncash practice balances', async () => {
  mount();
  const money = screen.getByRole('region', { name: 'Payment balance' });
  const gifts = screen.getByRole('region', { name: 'Gift practice balance' });
  expect(await within(money).findByText('4.80 ETB')).toBeInTheDocument();
  expect(within(money).getByText(/3.84 ETB available/)).toBeInTheDocument();
  expect(await within(gifts).findByText('9,500')).toBeInTheDocument();
  expect(within(gifts).getByText(/Virtual ETB with no cash value/)).toBeInTheDocument();
  expect(within(money).queryByText('9,500')).toBeNull();
  expect(
    screen
      .getAllByRole('link', { name: 'Deposit' })
      .every((a) => a.getAttribute('href') === '/wallet/deposit')
  ).toBe(true);
  expect(
    screen
      .getAllByRole('link', { name: 'Withdraw' })
      .every((a) => a.getAttribute('href') === '/wallet/withdraw')
  ).toBe(true);
  expect(screen.queryByText(/unavailable in practice mode/)).toBeNull();
});
it('keeps payment actions and gift balance available when payment balance fails', async () => {
  get.mockImplementation(async (path) => {
    if (path === '/wallet') throw Error('offline');
    return { data: { balance: 9500 } };
  });
  mount();
  await screen.findByText('Could not load your payment balance.');
  expect(screen.getAllByRole('link', { name: 'Withdraw' })).toHaveLength(2);
  expect(await screen.findByText('9,500')).toBeInTheDocument();
  get.mockResolvedValue({ data: { coinsBalance: 480 } });
  fireEvent.click(screen.getByRole('button', { name: 'Retry payment balance' }));
  expect(await screen.findByText('4.80 ETB')).toBeInTheDocument();
});
it('does not replace a missing gift balance with a misleading zero', async () => {
  get.mockImplementation(async (path) => {
    if (path === '/gift-collection') throw Error('offline');
    return { data: { coinsBalance: 480 } };
  });
  mount();
  await screen.findByText('Could not load your gift balance.');
  expect(await screen.findByText('4.80 ETB')).toBeInTheDocument();
  get.mockResolvedValue({ data: { balance: 10000 } });
  fireEvent.click(screen.getByRole('button', { name: 'Retry gift balance' }));
  expect(await screen.findByText('10,000')).toBeInTheDocument();
});
