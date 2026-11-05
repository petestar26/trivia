import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RouletteKenoSnapshot, RouletteKenoEntry } from '@socialplay/shared';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks, unwrapData: (v: { data: unknown }) => v.data }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'tester' } }) }));
import { RouletteKenoPage, RouletteKenoView, readRouletteKenoPending } from './roulette-keno';
let s: RouletteKenoSnapshot;
beforeEach(() => {
  sessionStorage.clear();
  mocks.get.mockReset();
  mocks.post.mockReset();
  const now = Date.now();
  s = {
    enabled: true,
    rulesId: 'roulette-keno-90-v1',
    maxTickets: 10,
    serverTime: now,
    balance: 1000,
    rounds: [
      {
        id: 'rk-test',
        opensAt: now - 5000,
        closesAt: now + 55000,
        endsAt: now + 85000,
        revealed: [],
        complete: false,
        tickets: [],
      },
    ],
  };
  mocks.get.mockImplementation(async () => ({ data: structuredClone(s) }));
  mocks.post.mockImplementation(async (_path, e: RouletteKenoEntry) => {
    const t = { ...e, id: 'receipt-' + e.slot, stake: e.picks.length * e.amount, payout: null };
    s.rounds[0].tickets.push(t);
    s.balance -= t.stake;
    return { data: { accepted: true, id: t.id } };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function view(props: Partial<Parameters<typeof RouletteKenoView>[0]> = {}) {
  const submit = vi.fn();
  render(
    <MemoryRouter>
      <RouletteKenoView data={s} onSubmit={submit} {...props} />
    </MemoryRouter>
  );
  return submit;
}
function connected() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter>
        <RouletteKenoPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it('shows all 72 choices, bold selected state and a review before a priced entry', () => {
  const submit = view();
  const board = screen.getByRole('group', { name: '72-number board' });
  expect(within(board).getAllByRole('button')).toHaveLength(72);
  fireEvent.click(screen.getByRole('button', { name: 'Number 12' }));
  fireEvent.click(screen.getByRole('button', { name: 'Number 72' }));
  expect(screen.getByRole('button', { name: 'Number 12' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.change(screen.getByLabelText('ETB per number'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 20 ETB' }));
  expect(submit).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('All 18 drawn balls count.');
  expect(dialog).toHaveTextContent('36 ETB');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm practice bet' }));
  expect(submit).toHaveBeenCalledWith({
    roundId: 'rk-test',
    slot: 1,
    market: 'NUMBERS',
    picks: [12, 72],
    amount: 10,
  });
});
it.each([
  ['Color', 'Red', 36],
  ['Odd / even', 'Even', 36],
  ['Low / high', 'High · 37–72', 36],
  ['Rows', 'Row F · 61–72', 12],
  ['Columns', 'Column 4 · 55–72', 18],
])(
  'highlights the correct coverage for %s and labels first-ball settlement',
  (market, label, count) => {
    view();
    fireEvent.click(screen.getByRole('button', { name: market }));
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(
      within(screen.getByRole('group', { name: '72-number board' })).getAllByRole('button', {
        pressed: true,
      })
    ).toHaveLength(count);
    expect(screen.getByText('Pick one option · first ball only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review bet · 5 ETB' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Only the first drawn ball counts.');
  }
);
it('retains separate drafts and market choices for Bet 1 and Bet 2', () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: 'Number 7' }));
  fireEvent.change(screen.getByLabelText('ETB per number'), { target: { value: '25' } });
  fireEvent.click(screen.getByRole('button', { name: '+ Add bet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Color' }));
  fireEvent.click(screen.getByRole('button', { name: 'Black' }));
  fireEvent.click(screen.getByRole('button', { name: 'Bet 1 Draft' }));
  expect(screen.getByRole('button', { name: 'Number 7' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByLabelText('ETB per number')).toHaveValue('25');
  fireEvent.click(screen.getByRole('button', { name: 'Bet 2 Draft' }));
  expect(screen.getByRole('button', { name: 'Black' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});
it.each(['stale', 'disabled', 'closed', 'wrong-rules', 'storage', 'pending', 'insufficient'])(
  'blocks submission when %s',
  (kind) => {
    if (kind === 'closed') s.rounds[0].closesAt = s.serverTime - 1;
    if (kind === 'disabled') s.enabled = false;
    if (kind === 'wrong-rules') s.rulesId = 'unknown';
    if (kind === 'insufficient') s.balance = 0;
    view({
      sentAt: kind === 'stale' ? performance.now() - 6000 : performance.now(),
      error: kind === 'storage' ? 'Storage unavailable' : '',
      pending:
        kind === 'pending'
          ? { roundId: 'rk-test', slot: 1, market: 'NUMBERS', picks: [7], amount: 5 }
          : null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Number 7' }));
    expect(
      screen.getByRole('button', { name: /Review bet|Bets are closed|Checking confirmation/ })
    ).toBeDisabled();
  }
);
it('shows only server-released balls and preserves confirmed choices on reload', () => {
  s.serverTime = s.rounds[0].closesAt + 3000;
  s.rounds[0].revealed = [12, 44, 7];
  s.rounds[0].tickets = [
    {
      id: 'saved',
      roundId: 'rk-test',
      slot: 1,
      market: 'NUMBERS',
      picks: [7, 72],
      amount: 5,
      stake: 10,
      payout: null,
    },
  ];
  view();
  expect(screen.getByRole('img', { name: 'Latest released ball 7' })).toBeInTheDocument();
  expect(screen.getByLabelText('Ball 4: waiting')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Number 7, drawn' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(screen.getByRole('button', { name: 'Number 72' })).toBeDisabled();
  expect(screen.queryByText(/ETB returned · Bet/)).not.toBeInTheDocument();
});
it('displays separate settled returns and actual draw history', () => {
  s.serverTime = s.rounds[0].closesAt + 19000;
  s.rounds[0].complete = true;
  s.rounds[0].revealed = Array.from({ length: 18 }, (_, i) => i + 1);
  s.rounds[0].tickets = [
    {
      id: 'one',
      roundId: 'rk-test',
      slot: 1,
      market: 'NUMBERS',
      picks: [1],
      amount: 5,
      stake: 5,
      payout: 18,
    },
    {
      id: 'two',
      roundId: 'rk-test',
      slot: 2,
      market: 'COLOR',
      picks: [2],
      amount: 10,
      stake: 10,
      payout: 0,
    },
  ];
  view();
  const saved = screen.getByRole('region', { name: 'Saved bets' });
  expect(saved).toHaveTextContent('18 ETB returned');
  expect(saved).toHaveTextContent('0 ETB returned');
  fireEvent.click(screen.getByRole('button', { name: 'Recent draws ↗' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Bet 2 · Black · 0 ETB returned');
});
it('uses bounded quick picks and exposes the full rulebook', () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: 'Quick pick 5' }));
  expect(
    within(screen.getByRole('group', { name: '72-number board' })).getAllByRole('button', {
      pressed: true,
    })
  ).toHaveLength(5);
  fireEvent.click(screen.getByRole('button', { name: 'How to play ↗' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('1,000 separate practice ETB');
  expect(screen.getByRole('dialog')).toHaveTextContent('90%');
});
it('confirms two independent bets and keeps confirmed selections locked', async () => {
  connected();
  await screen.findByText('● Connected');
  fireEvent.click(screen.getByRole('button', { name: 'Number 7' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 5 ETB' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm practice bet' }));
  await screen.findByRole('button', { name: '✓ Bet confirmed' });
  expect(mocks.post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '+ Add bet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Color' }));
  fireEvent.click(screen.getByRole('button', { name: 'Red' }));
  fireEvent.change(screen.getByLabelText('Bet amount · ETB'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 10 ETB' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm practice bet' }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  expect(s.balance).toBe(985);
  await screen.findByRole('button', { name: '✓ Bet confirmed' });
  expect(screen.getByRole('button', { name: 'Red' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(screen.getByRole('button', { name: 'Red' })).toBeDisabled();
});
it('recovers a lost confirmation from the saved server receipt without another post', async () => {
  const entry = { roundId: 'rk-test', slot: 1, market: 'NUMBERS' as const, picks: [7], amount: 5 };
  sessionStorage.setItem('salem.roulette-keno.pending.v1.tester', JSON.stringify(entry));
  s.rounds[0].tickets = [{ ...entry, id: 'saved', stake: 5, payout: null }];
  connected();
  await screen.findByText('Bet 1 confirmed by the server.');
  expect(mocks.post).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('salem.roulette-keno.pending.v1.tester')).toBeNull();
});
it('retries the unchanged pending payload and never creates a second bet', async () => {
  const entry = { roundId: 'rk-test', slot: 3, market: 'ROW' as const, picks: [2], amount: 15 };
  sessionStorage.setItem('salem.roulette-keno.pending.v1.tester', JSON.stringify(entry));
  connected();
  await screen.findByText('● Connected');
  fireEvent.click(screen.getByRole('button', { name: 'Retry unconfirmed bet' }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  expect(mocks.post.mock.calls[0][1]).toEqual(entry);
  expect(
    await screen.findByText('Bet 3 confirmed. You can add another bet to this draw.')
  ).toBeInTheDocument();
});
it('does not send a bet when browser storage cannot save it', async () => {
  connected();
  await screen.findByText('● Connected');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('disabled');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Number 7' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 5 ETB' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm practice bet' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save your ticket safely');
  expect(mocks.post).not.toHaveBeenCalled();
});
it('rejects malformed persisted receipts', () => {
  sessionStorage.setItem(
    'salem.roulette-keno.pending.v1.tester',
    JSON.stringify({ roundId: 'r', slot: 1, market: 'COLOR', picks: [4], amount: 5 })
  );
  expect(() => readRouletteKenoPending('tester')).toThrow();
});
