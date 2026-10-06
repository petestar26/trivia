import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CrashPointPage, readCrashReceipt } from './crash-point';
import type { CrashPointSnapshot } from '@socialplay/shared';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/components/casino/CasinoProvider', () => ({
  useCasino: () => ({ coinsBalance: 50, walletLoading: false, walletError: null }),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: { get, post },
}));
let snapshot: CrashPointSnapshot;
let client: QueryClient;
function setup() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <CrashPointPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}
beforeEach(() => {
  sessionStorage.clear();
  const now = Date.now();
  snapshot = {
    rulesId: 'crash-point-practice90-v1',
    serverTime: now,
    balance: 1000,
    rounds: [
      {
        id: 'r1',
        opensAt: now - 1000,
        startsAt: now + 14000,
        endsAt: now + 59000,
        commitment: 'a'.repeat(64),
        seed: null,
        crashCents: null,
        ticket: null,
      },
    ],
  };
  get.mockImplementation(async () => ({ success: true, data: snapshot }));
  post.mockResolvedValue({ success: true, data: { accepted: true } });
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.clearAllMocks();
  sessionStorage.clear();
});
it('submits only a validated amount and locked auto target', async () => {
  setup();
  const button = await screen.findByRole('button', { name: /Confirm ticket/ });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(post).toHaveBeenCalled());
  expect(post.mock.calls[0].slice(0, 2)).toEqual([
    '/games/crash-point/tickets',
    { roundId: 'r1', stake: 25, autoCents: 200 },
  ]);
});
it('manual cash-out sends no client multiplier or payout', async () => {
  snapshot.rounds[0].startsAt = snapshot.serverTime - 1000;
  snapshot.rounds[0].ticket = { stake: 25, autoCents: null, payout: null, paidCents: null };
  post.mockResolvedValue({ success: true, data: { payout: 27, paidCents: 110 } });
  setup();
  const button = await screen.findByRole('button', { name: /Cash out/ });
  fireEvent.click(button);
  await waitFor(() => expect(post).toHaveBeenCalled());
  expect(post.mock.calls[0].slice(0, 2)).toEqual(['/games/crash-point/cashout', { roundId: 'r1' }]);
  await screen.findByText(/Cash-out confirmed at 1.10x/);
});
it('restores a confirmed ticket and presents its server return', async () => {
  snapshot.rounds[0].crashCents = 150;
  snapshot.rounds[0].ticket = { stake: 25, autoCents: 120, payout: 30, paidCents: 120 };
  snapshot.rounds[0].startsAt = snapshot.serverTime - 10000;
  setup();
  await screen.findByText('Confirmed return · 30 credits at 1.20x');
  expect(screen.queryByRole('button', { name: /Cash out/ })).toBeNull();
  expect(screen.getByLabelText('Bet amount')).toBeDisabled();
});
it('preserves an interrupted entry so retry uses the same round and amount', async () => {
  post.mockRejectedValue(new Error('Interrupted'));
  setup();
  const button = await screen.findByRole('button', { name: /Confirm ticket/ });
  fireEvent.click(button);
  await screen.findByRole('button', { name: 'Retry saved ticket' });
  expect(readCrashReceipt('u1')).toEqual({ roundId: 'r1', stake: 25, autoCents: 200 });
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved ticket' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[0][1]).toEqual(post.mock.calls[1][1]);
});
it('blocks malformed saved receipts and pauses entry on API errors', async () => {
  sessionStorage.setItem(
    'playqube.crash-point.pending.u1',
    JSON.stringify({ roundId: 'r1', stake: 25, autoCents: 100 })
  );
  expect(() => readCrashReceipt('u1')).toThrow();
  get.mockRejectedValue(new Error('Offline'));
  setup();
  await screen.findByText(/Connection interrupted/);
  expect(screen.getByRole('button', { name: /Wait for next round/ })).toBeDisabled();
});
