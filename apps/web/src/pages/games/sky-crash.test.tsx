import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  act,
  configure,
  getConfig,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { SkyCrashPage, readSkyCrashReceipt } from './sky-crash';
import type { SkyCrashSnapshot } from '@socialplay/shared';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/components/casino/CasinoProvider', () => ({
  useCasino: () => ({ coinsBalance: 50, walletLoading: false, walletError: null }),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: { get, post },
}));
let snapshot: SkyCrashSnapshot;
let client: QueryClient;
let elapsedTime = 0;
const originalAsyncTimeout = getConfig().asyncUtilTimeout;
beforeAll(() => {
  configure({ asyncUtilTimeout: 5000 });
  vi.setConfig({ testTimeout: 15000 });
});
afterAll(() => {
  configure({ asyncUtilTimeout: originalAsyncTimeout });
  vi.resetConfig();
});
function setup() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SkyCrashPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}
beforeEach(() => {
  elapsedTime = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsedTime);
  sessionStorage.clear();
  const now = Date.now();
  snapshot = {
    rulesId: 'sky-crash-practice90-v1',
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
  vi.restoreAllMocks();
  sessionStorage.clear();
});
it('submits only a validated amount and locked auto target', async () => {
  setup();
  const button = await screen.findByRole('button', { name: /Confirm ticket/ });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(post).toHaveBeenCalled());
  expect(post.mock.calls[0].slice(0, 2)).toEqual([
    '/games/sky-crash/tickets',
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
  expect(post.mock.calls[0].slice(0, 2)).toEqual(['/games/sky-crash/cashout', { roundId: 'r1' }]);
  await screen.findByText(/Cash-out confirmed at 1.10x/);
});
it('shows impact only after server reveal, preserves it on refresh, and resets for the next round', async () => {
  snapshot.rounds[0].startsAt = snapshot.serverTime - 1000;
  setup();
  await screen.findByText('ROUND RUNNING');
  expect(screen.queryByTestId('sky-crash-impact')).toBeNull();
  // A stalled connection/local clock cannot invent a crash result.
  elapsedTime = 5000;
  await screen.findByText('SYNCHRONIZING');
  expect(screen.queryByTestId('sky-crash-impact')).toBeNull();
  snapshot = {
    ...snapshot,
    serverTime: snapshot.serverTime + 5000,
    rounds: [{ ...snapshot.rounds[0], crashCents: 150, seed: 'b'.repeat(64) }],
  };
  await act(async () => {
    client.setQueryData(['sky-crash', 'u1'], { snapshot, sent: 5000, received: 5000 });
  });
  const impact = await screen.findByTestId('sky-crash-impact');
  expect(screen.getByText('CRASHED')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Cash out/ })).toBeNull();
  await act(async () => {
    client.setQueryData(['sky-crash', 'u1'], {
      snapshot: { ...snapshot, serverTime: snapshot.serverTime + 100 },
      sent: 5000,
      received: 5000,
    });
  });
  expect(screen.getByTestId('sky-crash-impact')).toBe(impact);
  snapshot = {
    ...snapshot,
    rounds: [
      {
        ...snapshot.rounds[0],
        id: 'r2',
        opensAt: snapshot.serverTime - 1000,
        startsAt: snapshot.serverTime + 14000,
        endsAt: snapshot.serverTime + 59000,
        crashCents: null,
        seed: null,
      },
    ],
  };
  await act(async () => {
    client.setQueryData(['sky-crash', 'u1'], { snapshot, sent: 5000, received: 5000 });
  });
  await screen.findByText('ENTRY OPEN');
  expect(screen.queryByTestId('sky-crash-impact')).toBeNull();
  expect(post).not.toHaveBeenCalled();
});
it('restores a confirmed ticket and presents its server return', async () => {
  snapshot.rounds[0].crashCents = 150;
  snapshot.rounds[0].ticket = { stake: 25, autoCents: 120, payout: 30, paidCents: 120 };
  snapshot.rounds[0].startsAt = snapshot.serverTime - 10000;
  setup();
  await screen.findByText('Confirmed return · 30 credits at 1.20x');
  expect(screen.queryByRole('button', { name: /Cash out/ })).toBeNull();
  expect(screen.getByLabelText('Bet amount')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Decrease bet amount' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Increase bet amount' })).toBeDisabled();
});
it('preserves an interrupted entry so retry uses the same round and amount', async () => {
  post.mockRejectedValue(new Error('Interrupted'));
  setup();
  const button = await screen.findByRole('button', { name: /Confirm ticket/ });
  fireEvent.click(button);
  await screen.findByRole('button', { name: 'Retry saved ticket' });
  expect(readSkyCrashReceipt('u1')).toEqual({ roundId: 'r1', stake: 25, autoCents: 200 });
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved ticket' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[0][1]).toEqual(post.mock.calls[1][1]);
});
it('blocks malformed saved receipts and pauses entry on API errors', async () => {
  sessionStorage.setItem(
    'playqube.sky-crash.pending.u1',
    JSON.stringify({ roundId: 'r1', stake: 25, autoCents: 100 })
  );
  expect(() => readSkyCrashReceipt('u1')).toThrow();
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
        (call) => call[0] === '/games/sky-crash/activity' && call[1]?.roundId === 'previous'
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
  await act(async () => {
    snapshot = {
      ...snapshot,
      rounds: [
        {
          ...snapshot.rounds[0],
          tickets: [{ slot: 1, stake: 25, autoCents: 200, payout: null, paidCents: null }],
        },
      ],
    };
    client.setQueryData(['sky-crash', 'u1'], {
      snapshot,
      sent: performance.now(),
      received: performance.now(),
    });
  });
  expect(within(panel).getByRole('button', { name: /Stop autoplay/ })).toBeEnabled();
  fireEvent.click(within(panel).getByRole('button', { name: /Stop autoplay/ }));
  expect(within(panel).getByText(/Autoplay stopped/)).toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0][1]).toEqual({ roundId: 'r1', stake: 25, autoCents: 200 });
});
it.each([1, 2])(
  'does not start autoplay from a hidden draft behind a confirmed slot %s ticket',
  async (slot) => {
    snapshot.maxTickets = 2;
    snapshot.rounds[0].tickets = [
      { slot, stake: 30, autoCents: 300, payout: null, paidCents: null },
    ];
    setup();
    const panel = await screen.findByRole('complementary', { name: `Bet ${slot} controls` });
    const start = await within(panel).findByRole('button', { name: 'Start autoplay · 10 rounds' });
    expect(within(panel).getByLabelText('Bet amount')).toHaveValue('30');
    expect(within(panel).getByLabelText('Auto cash-out multiplier')).toHaveValue('3.00');
    expect(start).toBeDisabled();
    const otherPanel = screen.getByRole('complementary', {
      name: `Bet ${slot === 1 ? 2 : 1} controls`,
    });
    expect(
      within(otherPanel).getByRole('button', { name: 'Start autoplay · 10 rounds' })
    ).toBeEnabled();
    fireEvent.click(start);
    expect(within(panel).queryByRole('button', { name: /Stop autoplay/ })).toBeNull();
    expect(post).not.toHaveBeenCalled();

    await act(async () => {
      snapshot = {
        ...snapshot,
        rounds: [{ ...snapshot.rounds[0], id: 'next', ticket: null, tickets: [] }],
      };
      client.setQueryData(['sky-crash', 'u1'], {
        snapshot,
        sent: performance.now(),
        received: performance.now(),
      });
    });
    await waitFor(() => expect(start).toBeEnabled());
    expect(within(panel).getByLabelText('Bet amount')).toHaveValue('25');
    expect(within(panel).getByLabelText('Auto cash-out multiplier')).toHaveValue('2.00');
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(within(panel).getByLabelText('Bet amount'), { target: { value: '40' } });
    fireEvent.change(within(panel).getByLabelText('Auto cash-out multiplier'), {
      target: { value: '4.00' },
    });
    fireEvent.click(start);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toEqual({
      roundId: 'next',
      stake: 40,
      autoCents: 400,
      ...(slot === 2 ? { slot } : {}),
    });
  }
);
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
        client.setQueryData(['sky-crash', 'u1'], {
          snapshot,
          sent: performance.now(),
          received: performance.now(),
        });
      });
  }
  await waitFor(() =>
    expect(within(panel).queryByRole('button', { name: /Stop autoplay/ })).toBeNull()
  );
  expect(new Set(post.mock.calls.map((c) => c[1].roundId)).size).toBe(10);
});
it('stops autoplay on admission errors and preserves the exact retry payload', async () => {
  snapshot.maxTickets = 2;
  post.mockRejectedValue(new Error('Network interrupted'));
  setup();
  const panel = await screen.findByRole('complementary', { name: 'Bet 2 controls' });
  fireEvent.click(await within(panel).findByRole('button', { name: 'Start autoplay · 10 rounds' }));
  await within(panel).findByRole('button', { name: 'Retry saved ticket' });
  await waitFor(() =>
    expect(within(panel).queryByRole('button', { name: /Stop autoplay/ })).toBeNull()
  );
  expect(readSkyCrashReceipt('u1', 2)).toEqual({
    roundId: 'r1',
    stake: 25,
    autoCents: 200,
    slot: 2,
  });
});
it('stops autoplay when the tab is hidden without cancelling confirmed bets', async () => {
  snapshot.maxTickets = 2;
  setup();
  const panel = await screen.findByRole('complementary', { name: 'Bet 1 controls' });
  fireEvent.click(await within(panel).findByRole('button', { name: 'Start autoplay · 10 rounds' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() =>
    expect(within(panel).queryByRole('button', { name: /Stop autoplay/ })).toBeNull()
  );
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
  const resultCard = await screen.findByRole('group', { name: 'Bet 2 result' });
  expect(within(resultCard).getByText('48 credits returned')).toBeInTheDocument();
  expect(within(resultCard).getByText('Confirmed at 1.20× · includes stake')).toBeInTheDocument();
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
    await client.refetchQueries({ queryKey: ['sky-crash', 'u1'] });
  });
  await waitFor(() =>
    expect(within(panel).queryByRole('button', { name: /Stop autoplay/ })).toBeNull()
  );
  await act(async () => {
    snapshot = { ...snapshot, rounds: [{ ...snapshot.rounds[0], id: 'after-reconnect' }] };
    client.setQueryData(['sky-crash', 'u1'], {
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

it('allows preparing amount and target during a running round but cannot submit early', async () => {
  snapshot.rounds[0].startsAt = snapshot.serverTime - 1000;
  setup();
  const amount = await screen.findByLabelText('Bet amount');
  await waitFor(() => expect(amount).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '50' }));
  fireEvent.click(screen.getByText('Quick targets'));
  fireEvent.click(screen.getByRole('button', { name: '3.00×' }));
  expect(amount).toHaveValue('50');
  expect(screen.getByLabelText('Auto cash-out multiplier')).toHaveValue('3.00');
  const waiting = screen.getByRole('button', { name: /Wait for next round/ });
  expect(waiting).toBeDisabled();
  fireEvent.click(waiting);
  expect(post).not.toHaveBeenCalled();
  snapshot = {
    ...snapshot,
    serverTime: Date.now(),
    rounds: [
      {
        ...snapshot.rounds[0],
        id: 'r2',
        opensAt: Date.now() - 1000,
        startsAt: Date.now() + 14000,
        endsAt: Date.now() + 59000,
      },
    ],
  };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['sky-crash', 'u1'] });
  });
  const confirm = await screen.findByRole('button', { name: /Confirm ticket/ });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  await waitFor(() => expect(post).toHaveBeenCalled());
  expect(post.mock.calls[0][1]).toEqual({ roundId: 'r2', stake: 50, autoCents: 300 });
});
it('target presets enable automatic cash-out and stay locked for a saved ticket', async () => {
  setup();
  await waitFor(() => expect(screen.getByLabelText('Bet amount')).toBeEnabled());
  fireEvent.click(screen.getByLabelText('Auto cash-out', { exact: true }));
  expect(screen.getByLabelText('Auto cash-out multiplier')).toBeDisabled();
  fireEvent.click(screen.getByText('Quick targets'));
  fireEvent.click(screen.getByRole('button', { name: '1.50×' }));
  expect(screen.getByLabelText('Auto cash-out', { exact: true })).toBeChecked();
  expect(screen.getByLabelText('Auto cash-out multiplier')).toHaveValue('1.50');
  post.mockRejectedValue(new Error('Interrupted'));
  fireEvent.click(screen.getByRole('button', { name: /Confirm ticket/ }));
  await screen.findByRole('button', { name: 'Retry saved ticket' });
  expect(screen.getByRole('button', { name: '3.00×' })).toBeDisabled();
  expect(readSkyCrashReceipt('u1')).toEqual({ roundId: 'r1', stake: 25, autoCents: 150 });
});

function addHistoryRound() {
  snapshot.rounds.push({
    ...snapshot.rounds[0],
    id: 'older',
    opensAt: snapshot.serverTime - 61000,
    startsAt: snapshot.serverTime - 46000,
    endsAt: snapshot.serverTime - 1000,
    crashCents: 297,
    seed: 'b'.repeat(64),
    tickets: [
      { slot: 1, stake: 25, autoCents: 200, payout: 50, paidCents: 200 },
      { slot: 2, stake: 40, autoCents: null, payout: 0, paidCents: null },
    ],
    ticket: null,
  });
}
it('opens completed round details with both receipts without changing the draft or placing a bet', async () => {
  addHistoryRound();
  setup();
  await waitFor(() => expect(screen.getByLabelText('Bet amount')).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '50' }));
  fireEvent.click(screen.getByText('Quick targets'));
  fireEvent.click(screen.getByRole('button', { name: '3.00×' }));
  expect(screen.queryByRole('button', { name: /View completed round r1:/ })).toBeNull();
  const history = screen.getByRole('button', { name: 'View completed round older: 2.97×' });
  fireEvent.click(history);
  const dialog = await screen.findByRole('dialog', { name: 'Round details' });
  expect(within(dialog).getByText('2.97×')).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Past bet 1 receipt')).toHaveTextContent('50 credits');
  expect(within(dialog).getByLabelText('Past bet 2 receipt')).toHaveTextContent('0 credits');
  fireEvent.click(within(dialog).getByText('Round verification'));
  expect(within(dialog).getByText(/Revealed seed:/)).toHaveTextContent('b'.repeat(64));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close round details' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByLabelText('Bet amount')).toHaveValue('50');
  expect(screen.getByLabelText('Auto cash-out multiplier')).toHaveValue('3.00');
  await waitFor(() => expect(history).toHaveFocus());
  expect(post).not.toHaveBeenCalled();
});
it('supports opening history with the keyboard and Escape returns focus to its button', async () => {
  addHistoryRound();
  setup();
  const history = await screen.findByRole('button', { name: 'View completed round older: 2.97×' });
  const user = userEvent.setup();
  history.focus();
  await act(async () => {
    await user.keyboard('{Enter}');
  });
  await screen.findByRole('dialog', { name: 'Round details' });
  await act(async () => {
    await user.keyboard('{Escape}');
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(history).toHaveFocus());
  expect(post).not.toHaveBeenCalled();
});
it('history keeps saved ticket locks and the exact retry payload intact', async () => {
  addHistoryRound();
  const receipt = { roundId: 'r1', stake: 50, autoCents: 150 };
  sessionStorage.setItem('playqube.sky-crash.pending.u1', JSON.stringify(receipt));
  post.mockRejectedValue(new Error('Interrupted'));
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'View completed round older: 2.97×' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close round details' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByLabelText('Bet amount')).toBeDisabled();
  fireEvent.click(screen.getByText('Quick targets'));
  expect(screen.getByRole('button', { name: '3.00×' })).toBeDisabled();
  expect(readSkyCrashReceipt('u1')).toEqual(receipt);
  expect(screen.getByRole('button', { name: 'Decrease bet amount' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Increase bet amount' })).toBeDisabled();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved ticket' }));
  await waitFor(() => expect(post.mock.calls[0][1]).toEqual(receipt));
});
it('cash-out remains bound to the live second ticket after viewing a past round', async () => {
  snapshot.maxTickets = 2;
  snapshot.rounds[0].startsAt = snapshot.serverTime - 1000;
  snapshot.rounds[0].tickets = [
    { slot: 2, stake: 25, autoCents: null, payout: null, paidCents: null },
  ];
  addHistoryRound();
  post.mockResolvedValue({ success: true, data: { payout: 27, paidCents: 110 } });
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'View completed round older: 2.97×' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close round details' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const panel = screen.getByRole('complementary', { name: 'Bet 2 controls' });
  expect(within(panel).getByLabelText('Bet amount')).toBeDisabled();
  fireEvent.click(within(panel).getByRole('button', { name: /Cash out/ }));
  await waitFor(() => expect(post.mock.calls[0][1]).toEqual({ roundId: 'r1', slot: 2 }));
});
it('bet navigation reaches the real controls while entry remains closed', async () => {
  snapshot.rounds[0].startsAt = snapshot.serverTime - 1000;
  const scroll = vi.fn();
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    setup();
    await waitFor(() => expect(screen.getByLabelText('Bet amount')).toBeEnabled());
    fireEvent.click(screen.getByRole('link', { name: 'Choose your bet' }));
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    expect(screen.getByRole('heading', { name: 'Choose your bet' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '100' }));
    fireEvent.click(screen.getByText('Quick targets'));
    fireEvent.click(screen.getByRole('button', { name: '5.00×' }));
    expect(screen.getByLabelText('Bet amount')).toHaveValue('100');
    expect(screen.getByLabelText('Auto cash-out multiplier')).toHaveValue('5.00');
    expect(screen.getByRole('button', { name: '100' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Wait for next round/ })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScroll;
  }
});
it('handles a selected round leaving the snapshot without showing another result', async () => {
  addHistoryRound();
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'View completed round older: 2.97×' }));
  await act(async () => {
    snapshot = { ...snapshot, rounds: [snapshot.rounds[0]] };
    client.setQueryData(['sky-crash', 'u1'], {
      snapshot,
      sent: performance.now(),
      received: performance.now(),
    });
  });
  const dialog = screen.getByRole('dialog', { name: 'Round details' });
  expect(await within(dialog).findByText(/This round has left recent history/)).toBeInTheDocument();
  expect(within(dialog).queryByText('2.97×')).toBeNull();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close round details' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Round history' })).toHaveFocus());
});

it('places completed history before the live chart and betting controls in reading order', async () => {
  addHistoryRound();
  setup();
  await screen.findByRole('button', { name: 'View completed round older: 2.97×' });
  const history = screen.getByRole('region', { name: 'Round history' });
  const graph = screen.getByRole('region', { name: 'Live flight arena' });
  const betting = screen.getByRole('region', { name: 'Choose your bet' });
  expect(history.compareDocumentPosition(graph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(graph.compareDocumentPosition(betting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
});
it('adjusts only the selected slot amount within stake limits and the available balance', async () => {
  snapshot.maxTickets = 2;
  snapshot.balance = 27;
  setup();
  const first = await screen.findByRole('complementary', { name: 'Bet 1 controls' });
  const second = await screen.findByRole('complementary', { name: 'Bet 2 controls' });
  await waitFor(() => expect(within(first).getByLabelText('Bet amount')).toBeEnabled());
  fireEvent.click(within(first).getByRole('button', { name: 'Increase bet amount' }));
  expect(within(first).getByLabelText('Bet amount')).toHaveValue('27');
  expect(within(first).getByRole('button', { name: 'Increase bet amount' })).toBeDisabled();
  fireEvent.click(within(first).getByRole('button', { name: 'Decrease bet amount' }));
  expect(within(first).getByLabelText('Bet amount')).toHaveValue('22');
  expect(within(second).getByLabelText('Bet amount')).toHaveValue('25');
  fireEvent.click(within(first).getByRole('button', { name: '10' }));
  expect(within(first).getByRole('button', { name: 'Decrease bet amount' })).toBeDisabled();
  await act(async () => {
    snapshot = { ...snapshot, balance: 1000 };
    client.setQueryData(['sky-crash', 'u1'], {
      snapshot,
      sent: performance.now(),
      received: performance.now(),
    });
  });
  fireEvent.change(within(first).getByLabelText('Bet amount'), { target: { value: '500' } });
  expect(within(first).getByRole('button', { name: 'Increase bet amount' })).toBeDisabled();
  fireEvent.change(within(first).getByLabelText('Bet amount'), { target: { value: 'invalid' } });
  expect(within(first).getByRole('button', { name: 'Decrease bet amount' })).toBeDisabled();
  expect(within(first).getByRole('button', { name: 'Increase bet amount' })).toBeDisabled();
  expect(post).not.toHaveBeenCalled();
});

it('keeps entry and autoplay disabled when a snapshot arrives too slowly', async () => {
  snapshot.maxTickets = 2;
  const normalGet = get.getMockImplementation()!;
  get.mockImplementation(async (...args) => {
    const response = await normalGet(...args);
    if (args[0] === '/games/sky-crash') elapsedTime += 1500;
    return response;
  });
  setup();
  const panel = await screen.findByRole('complementary', { name: 'Bet 2 controls' });
  expect(within(panel).getByLabelText('Bet amount')).toBeDisabled();
  expect(within(panel).getByRole('button', { name: /Wait for next round/ })).toBeDisabled();
  expect(within(panel).getByRole('button', { name: 'Start autoplay · 10 rounds' })).toBeDisabled();
  expect(post).not.toHaveBeenCalled();
});
it('blocks entry and draft edits when cached server data becomes stale', async () => {
  setup();
  await waitFor(() => expect(screen.getByRole('button', { name: /Confirm ticket/ })).toBeEnabled());
  get.mockImplementation(() => new Promise(() => {}));
  elapsedTime = 4000;
  await act(async () => {
    client.setQueryData(['sky-crash', 'u1'], { snapshot, sent: 0, received: 0 });
  });
  await waitFor(() => expect(screen.getByLabelText('Bet amount')).toBeDisabled());
  expect(screen.getByRole('button', { name: /Wait for next round/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Increase bet amount' })).toBeDisabled();
  expect(post).not.toHaveBeenCalled();
});

it('does not replay a Crash Point receipt into Sky Crash', async () => {
  sessionStorage.setItem(
    'playqube.crash-point.pending.u1',
    JSON.stringify({ roundId: 'crash-minute-1', stake: 50, autoCents: 200 })
  );
  expect(readSkyCrashReceipt('u1')).toBeNull();
  setup();
  await screen.findByRole('button', { name: /Confirm ticket/ });
  expect(post).not.toHaveBeenCalled();
});
it('keeps controls disabled when the practice gate is off', async () => {
  get.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 403 }));
  setup();
  await waitFor(() => expect(screen.getByLabelText('Bet amount')).toBeDisabled());
  expect(post).not.toHaveBeenCalled();
});
