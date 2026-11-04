import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SystemKenoSnapshot } from '@socialplay/shared';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks, unwrapData: (v: { data: unknown }) => v.data }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'tester' } }) }));
vi.mock('@/components/casino/CasinoProvider', () => ({
  useCasino: () => ({ coinsBalance: 88, walletLoading: false, walletError: false }),
}));
import { SystemKenoPage } from './keno-system';
let s: SystemKenoSnapshot;
beforeEach(() => {
  sessionStorage.clear();
  mocks.get.mockReset();
  mocks.post.mockReset();
  const now = Date.now();
  s = {
    enabled: true,
    serverTime: now,
    balance: 1000,
    rounds: [
      {
        id: 'minute',
        opensAt: now - 5000,
        closesAt: now + 40000,
        endsAt: now + 55000,
        outcome: null,
        ticket: null,
      },
    ],
  };
  mocks.get.mockImplementation(async () => ({ data: structuredClone(s) }));
});
afterEach(cleanup);
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter>
        <SystemKenoPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it('uses the server countdown and confirms the explicit stake once', async () => {
  mount();
  expect(await screen.findByRole('timer', { name: 'Betting closes in' })).toHaveTextContent('40s');
  fireEvent.click(screen.getByRole('button', { name: 'Number 7' }));
  fireEvent.change(screen.getByLabelText('Bet amount per number'), { target: { value: '10' } });
  mocks.post.mockImplementation(async () => {
    s.balance = 990;
    s.rounds[0].ticket = { picks: [7], stakePerNumber: 10, stake: 10, payout: null };
    return { data: { accepted: true } };
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm ticket · 10 ETB' }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole('button', { name: 'Ticket confirmed' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Number 7' })).toBeDisabled();
  expect(screen.getByText('88 Coins')).toBeInTheDocument();
});
it('polling recovers a held confirmation, and refresh restores its persisted result', async () => {
  mocks.post.mockImplementation(() => {
    s.rounds[0].ticket = { picks: [7], stakePerNumber: 5, stake: 5, payout: null };
    return new Promise(() => {});
  });
  const view = mount();
  await screen.findByRole('timer', { name: 'Betting closes in' });
  fireEvent.click(screen.getByRole('button', { name: 'Number 7' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm ticket · 5 ETB' }));
  expect(
    await screen.findByText('Confirmed by the server. Your ticket is saved.', {}, { timeout: 3500 })
  ).toBeInTheDocument();
  view.unmount();
  s.serverTime = s.rounds[0].endsAt - 2000;
  s.rounds[0].outcome = Array.from({ length: 20 }, (_, i) => i + 1);
  s.rounds[0].ticket!.payout = 18;
  s.balance = 1013;
  mount();
  expect((await screen.findAllByText('1 matches · 18 ETB returned')).length).toBeGreaterThan(0);
  expect(screen.getByRole('timer', { name: 'Next round in' })).toHaveTextContent('2s');
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
it('disables entry on a failed server refresh', async () => {
  mount();
  await screen.findByRole('timer', { name: 'Betting closes in' });
  mocks.get.mockRejectedValue(new Error('offline'));
  await screen.findByRole('alert', {}, { timeout: 3500 });
  expect(screen.getByRole('button', { name: 'Number 7' })).toBeDisabled();
});
it.each([403, 404])('shows an unavailable table for HTTP %s', async (status) => {
  mocks.get.mockRejectedValue(new Error(JSON.stringify({ status })));
  mount();
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('This Keno table is currently unavailable')
  );
  expect(screen.getByRole('button', { name: 'Number 7' })).toBeDisabled();
});

it('confirms independent Bet 1 and Bet 2 picks and amounts in the same round', async () => {
  s.maxTickets = 10;
  s.rounds[0].tickets = [];
  mocks.post.mockImplementation(async (_path, e) => {
    const t = {
      slot: e.slot ?? 1,
      picks: e.picks,
      stakePerNumber: e.stakePerNumber,
      stake: e.picks.length * e.stakePerNumber,
      payout: null,
    };
    s.rounds[0].tickets!.push(t);
    s.balance -= t.stake;
    return { data: { accepted: true } };
  });
  mount();
  await screen.findByRole('timer', { name: 'Betting closes in' });
  fireEvent.click(screen.getByRole('button', { name: 'Number 7' }));
  fireEvent.change(screen.getByLabelText('Bet amount per number'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm ticket · 10 ETB' }));
  await screen.findByRole('button', { name: 'Ticket confirmed' });
  fireEvent.click(screen.getByRole('button', { name: '+ Add bet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Number 9' }));
  fireEvent.click(screen.getByRole('button', { name: 'Number 12' }));
  fireEvent.change(screen.getByLabelText('Bet amount per number'), { target: { value: '15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm ticket · 30 ETB' }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  expect(mocks.post.mock.calls.map((c) => c[1])).toEqual([
    { roundId: 'minute', picks: [7], stakePerNumber: 10 },
    { roundId: 'minute', picks: [9, 12], stakePerNumber: 15, slot: 2 },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Bet 1 Confirmed' }));
  expect(screen.getByRole('button', { name: 'Number 7' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Number 9' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByLabelText('Bet amount per number')).toHaveValue('10');
  expect(screen.getByRole('button', { name: 'Number 7' })).toBeDisabled();
});
it('keeps unconfirmed drafts independent when switching between numbered bets', async () => {
  s.maxTickets = 10;
  mount();
  await screen.findByRole('timer', { name: 'Betting closes in' });
  fireEvent.click(screen.getByRole('button', { name: 'Number 4' }));
  fireEvent.change(screen.getByLabelText('Bet amount per number'), { target: { value: '20' } });
  fireEvent.click(screen.getByRole('button', { name: '+ Add bet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Number 8' }));
  fireEvent.click(screen.getByRole('button', { name: 'Bet 1 Draft' }));
  expect(screen.getByRole('button', { name: 'Number 4' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByLabelText('Bet amount per number')).toHaveValue('20');
  expect(mocks.post).not.toHaveBeenCalled();
});
it('restores ten confirmed tickets and keeps the ticket cap visible', async () => {
  s.maxTickets = 10;
  s.rounds[0].tickets = Array.from({ length: 10 }, (_, i) => ({
    slot: i + 1,
    picks: [i + 1],
    stakePerNumber: 5,
    stake: 5,
    payout: null,
  }));
  mount();
  await screen.findByRole('button', { name: 'Bet 10 Confirmed' });
  expect(screen.queryByRole('button', { name: '+ Add bet' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Bet 10 Confirmed' }));
  expect(screen.getByRole('button', { name: 'Number 10' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Ticket confirmed' })).toBeDisabled();
  expect(mocks.post).not.toHaveBeenCalled();
});
it('restores an uncertain second ticket and retries its exact saved payload', async () => {
  s.maxTickets = 10;
  const e = { roundId: 'minute', picks: [3, 8], stakePerNumber: 10, slot: 2 };
  sessionStorage.setItem('playqube.keno.pending.v1.tester', JSON.stringify(e));
  mocks.post.mockRejectedValue(new Error('offline'));
  mount();
  const retry = await screen.findByRole('button', { name: 'Retry unconfirmed ticket' });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  expect(mocks.post.mock.calls[0][1]).toEqual(e);
  expect(JSON.parse(sessionStorage.getItem('playqube.keno.pending.v1.tester')!)).toEqual(e);
  expect(screen.getByRole('button', { name: '+ Add bet' })).toBeDisabled();
});
it('reconciles a saved second ticket from polling without submitting again', async () => {
  s.maxTickets = 10;
  sessionStorage.setItem(
    'playqube.keno.pending.v1.tester',
    JSON.stringify({ roundId: 'minute', picks: [3], stakePerNumber: 5, slot: 2 })
  );
  s.rounds[0].tickets = [{ slot: 2, picks: [3], stakePerNumber: 5, stake: 5, payout: null }];
  mount();
  await screen.findByText('Confirmed by the server. Your ticket is saved.');
  expect(sessionStorage.getItem('playqube.keno.pending.v1.tester')).toBeNull();
  expect(mocks.post).not.toHaveBeenCalled();
});
it('refuses entry if pending-ticket storage cannot be written', async () => {
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked');
  });
  try {
    mount();
    await screen.findByRole('timer', { name: 'Betting closes in' });
    fireEvent.click(screen.getByRole('button', { name: 'Number 7' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm ticket · 5 ETB' }));
    expect(await screen.findByText(/Could not save your ticket safely/)).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  } finally {
    save.mockRestore();
  }
});
it('shows the selected ticket return and only the currently revealed ball', async () => {
  s.maxTickets = 10;
  s.serverTime = s.rounds[0].closesAt + 600;
  s.rounds[0].outcome = Array.from({ length: 20 }, (_, i) => i + 1);
  s.rounds[0].tickets = [
    { slot: 1, picks: [1], stakePerNumber: 5, stake: 5, payout: 18 },
    { slot: 2, picks: [80], stakePerNumber: 10, stake: 10, payout: 0 },
  ];
  mount();
  await screen.findByRole('img', { name: 'Latest drawn ball 1' });
  expect(screen.queryByRole('img', { name: 'Latest drawn ball 20' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Bet 2 Confirmed' }));
  expect(screen.getByRole('button', { name: 'Number 80' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Number 1' })).not.toHaveClass('is-hit');
  expect(mocks.post).not.toHaveBeenCalled();
});
