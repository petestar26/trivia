import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
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
  get.mockImplementation(async (path: string, params?: { roundId: string }) => ({
    success: true,
    data: path.endsWith('/leaderboard')
      ? { period: '24h', tickets: [] }
      : path.endsWith('/activity')
        ? { roundId: params?.roundId, totalTickets: 0, tickets: [] }
        : snapshot,
  }));
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
it('shows the commitment before reveal without claiming automatic cash-out for a manual ticket', async () => {
  snapshot.rounds[0].startsAt = snapshot.serverTime - 1000;
  snapshot.rounds[0].ticket = { stake: 25, autoCents: null, payout: null, paidCents: null };
  setup();
  await screen.findByText('Your ticket is live · manual cash-out requires a connection');
  expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
  expect(screen.queryByText(/Revealed seed:/)).toBeNull();
});
it('shows personal returns and distinguishes pending receipts in the history views', async () => {
  snapshot.rounds.push({
    ...snapshot.rounds[0],
    id: 'older',
    opensAt: snapshot.serverTime - 61000,
    startsAt: snapshot.serverTime - 46000,
    endsAt: snapshot.serverTime - 1000,
    crashCents: 250,
    seed: 'b'.repeat(64),
    ticket: { stake: 25, autoCents: 200, payout: 50, paidCents: 200 },
  });
  snapshot.rounds[0].ticket = { stake: 10, autoCents: null, payout: null, paidCents: null };
  setup();
  await screen.findAllByText('10 credits');
  fireEvent.click(screen.getByRole('button', { name: 'My bets' }));
  expect(screen.getAllByText('Pending')).toHaveLength(2);
  expect(screen.getByRole('table')).toHaveTextContent('50');
  fireEvent.click(screen.getByRole('button', { name: 'Top · 24h' }));
  expect(screen.queryByText('Pending')).toBeNull();
  await screen.findByText('No confirmed returns in the last 24 hours.');
  expect(post).not.toHaveBeenCalled();
});
it('does not describe a settled ticket as locked', async () => {
  snapshot.rounds[0].startsAt = snapshot.serverTime - 10000;
  snapshot.rounds[0].crashCents = 150;
  snapshot.rounds[0].ticket = { stake: 25, autoCents: 120, payout: 30, paidCents: 120 };
  setup();
  expect(
    await screen.findByRole('button', { name: /Cashed out 30 credits returned/ })
  ).toBeDisabled();
  expect(screen.queryByText('25 credits locked')).toBeNull();
});

it('switches the public feed to the previous round without submitting a ticket', async () => {
  snapshot.rounds.push({
    ...snapshot.rounds[0],
    id: 'previous',
    opensAt: snapshot.serverTime - 61000,
    startsAt: snapshot.serverTime - 46000,
    endsAt: snapshot.serverTime - 1000,
    crashCents: 150,
  });
  setup();
  await screen.findByText('No tickets in this round.');
  fireEvent.click(screen.getByRole('button', { name: 'Previous round' }));
  await waitFor(() =>
    expect(
      get.mock.calls.some(
        (call) => call[0] === '/games/crash-point/activity' && call[1]?.roundId === 'previous'
      )
    ).toBe(true)
  );
  expect(screen.getByRole('button', { name: 'Back to current' })).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
});
it('submits and cashes out the second slot independently', async () => {
  snapshot.maxTickets = 2;
  setup();
  const panel = await screen.findByRole('complementary', { name: 'Bet 2 controls' });
  fireEvent.click(within(panel).getByRole('button', { name: /Confirm ticket/ }));
  await waitFor(() =>
    expect(post.mock.calls[0][1]).toEqual({ roundId: 'r1', stake: 25, autoCents: 200, slot: 2 })
  );
});
it('autoplay stops future admission when stopped, retaining the submitted ticket', async () => {
  snapshot.maxTickets = 2;
  setup();
  const panel = await screen.findByRole('complementary', { name: 'Bet 1 controls' });
  fireEvent.click(await within(panel).findByRole('button', { name: 'Start autoplay · 10 rounds' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  fireEvent.click(within(panel).getByRole('button', { name: /Stop autoplay/ }));
  expect(within(panel).getByText(/Autoplay stopped/)).toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0][1]).toEqual({ roundId: 'r1', stake: 25, autoCents: 200 });
});
it('autoplay admits at most ten distinct rounds and never repeats the current round', async () => {
  snapshot.maxTickets = 2;
  setup();
  const panel = await screen.findByRole('complementary', { name: 'Bet 1 controls' });
  fireEvent.click(await within(panel).findByRole('button', { name: 'Start autoplay · 10 rounds' }));
  for (let i = 1; i <= 10; i++) {
    await waitFor(() => expect(post).toHaveBeenCalledTimes(i));
    if (i < 10)
      await act(async () => {
        snapshot = { ...snapshot, rounds: [{ ...snapshot.rounds[0], id: `auto-${i + 1}` }] };
        client.setQueryData(['crash-point', 'u1'], {
          snapshot,
          sent: performance.now(),
          received: performance.now(),
        });
      });
  }
  await waitFor(() => expect(within(panel).queryByRole('button', { name: /Stop autoplay/ })).toBeNull());
  expect(new Set(post.mock.calls.map((c) => c[1].roundId)).size).toBe(10);
});
it('stops autoplay on admission errors and preserves the exact retry payload', async () => {
  snapshot.maxTickets = 2;
  post.mockRejectedValue(new Error('Network interrupted'));
  setup();
  const panel = await screen.findByRole('complementary', { name: 'Bet 2 controls' });
  fireEvent.click(await within(panel).findByRole('button', { name: 'Start autoplay · 10 rounds' }));
  await within(panel).findByRole('button', { name: 'Retry saved ticket' });
  await waitFor(() => expect(within(panel).queryByRole('button', { name: /Stop autoplay/ })).toBeNull());
  expect(readCrashReceipt('u1', 2)).toEqual({ roundId: 'r1', stake: 25, autoCents: 200, slot: 2 });
});
it('stops autoplay when the tab is hidden without cancelling confirmed bets', async () => {
  snapshot.maxTickets = 2;
  setup();
  const panel = await screen.findByRole('complementary', { name: 'Bet 1 controls' });
  fireEvent.click(await within(panel).findByRole('button', { name: 'Start autoplay · 10 rounds' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(within(panel).queryByRole('button', { name: /Stop autoplay/ })).toBeNull());
  visibility.mockRestore();
  expect(post).toHaveBeenCalledTimes(1);
});
it('sends the slot when manually cashing out the second ticket', async () => {
  snapshot.maxTickets = 2;
  snapshot.rounds[0].startsAt = snapshot.serverTime - 1000;
  snapshot.rounds[0].tickets = [
    { slot: 2, stake: 25, autoCents: null, payout: null, paidCents: null },
  ];
  post.mockResolvedValue({ success: true, data: { payout: 27, paidCents: 110 } });
  setup();
  const panel = await screen.findByRole('complementary', { name: 'Bet 2 controls' });
  fireEvent.click(await within(panel).findByRole('button', { name: /Cash out/ }));
  await waitFor(() => expect(post.mock.calls[0][1]).toEqual({ roundId: 'r1', slot: 2 }));
});

it('shows the second ticket in the shared result, summary and labelled history', async () => {
  snapshot.maxTickets = 2;
  snapshot.rounds[0].startsAt = snapshot.serverTime - 10000;
  snapshot.rounds[0].crashCents = 150;
  snapshot.rounds[0].tickets = [{ slot: 2, stake: 40, autoCents: 120, payout: 48, paidCents: 120 }];
  setup();
  await screen.findByText('Bet 2: 48 credits returned at 1.20×');
  const receipt = screen.getByRole('region', { name: 'Bet 2 receipt' });
  expect(within(receipt).getByText('40 credits')).toBeInTheDocument();
  expect(within(receipt).getByText('48 credits')).toBeInTheDocument();
  expect(screen.queryByText('No tickets')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'My bets' }));
  const table = screen.getByRole('table');
  expect(within(table).getByRole('columnheader', { name: 'Bet' })).toBeInTheDocument();
  expect(within(table).getByRole('cell', { name: '2' })).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
});
it('stops autoplay on disconnection and does not restart it when fresh data returns', async () => {
  snapshot.maxTickets = 2;
  setup();
  const panel = await screen.findByRole('complementary', { name: 'Bet 2 controls' });
  fireEvent.click(await within(panel).findByRole('button', { name: 'Start autoplay · 10 rounds' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  get.mockRejectedValue(new Error('Offline'));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['crash-point', 'u1'] });
  });
  await waitFor(() => expect(within(panel).queryByRole('button', { name: /Stop autoplay/ })).toBeNull());
  await act(async () => {
    snapshot = { ...snapshot, rounds: [{ ...snapshot.rounds[0], id: 'after-reconnect' }] };
    client.setQueryData(['crash-point', 'u1'], {
      snapshot,
      sent: performance.now(),
      received: performance.now(),
    });
  });
  expect(post).toHaveBeenCalledTimes(1);
  expect(
    within(panel).getByRole('button', { name: 'Start autoplay · 10 rounds' })
  ).toBeInTheDocument();
});
