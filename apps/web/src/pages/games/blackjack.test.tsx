import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BLACKJACK_RULES, type BlackjackSnapshot, type BlackjackEntry } from '@socialplay/shared';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks, unwrapData: (v: { data: unknown }) => v.data }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'tester' } }) }));
import { BlackjackPage, BlackjackView, readBlackjackPending } from './blackjack';
let s: BlackjackSnapshot;
beforeEach(() => {
  sessionStorage.clear();
  mocks.get.mockReset();
  mocks.post.mockReset();
  const now = Date.now();
  s = {
    enabled: true,
    rulesId: BLACKJACK_RULES.id,
    serverTime: now,
    balance: 1000,
    maxTickets: 10,
    rounds: [
      {
        id: 'bj-test',
        opensAt: now - 5000,
        endsAt: now + 155000,
        stage: 0,
        hands: [[0], [1], [2], [3], [4], [5], [6]],
        quotes: {
          '1:WIN': 185,
          '1:DRAW': 800,
          '1:LOSE': 225,
          '1:P17': 1200,
          '2:WIN': 195,
          '0:BLACKJACK': 650,
        },
        tickets: [],
      },
    ],
  };
  mocks.get.mockImplementation(async () => ({ data: structuredClone(s) }));
  mocks.post.mockImplementation(async (_p, e: BlackjackEntry) => {
    const t = { ...e, id: `receipt-${e.slot}`, payout: null };
    s.rounds[0].tickets.push(t);
    s.balance -= e.amount;
    return { data: { accepted: true, id: t.id } };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function view(props: Partial<Parameters<typeof BlackjackView>[0]> = {}) {
  const submit = vi.fn();
  return {
    submit,
    ...render(
      <MemoryRouter>
        <BlackjackView data={s} onSubmit={submit} {...props} />
      </MemoryRouter>
    ),
  };
}
function choose() {
  fireEvent.click(screen.getByRole('button', { name: 'Win at 1.85 times' }));
}
function connected() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter>
        <BlackjackPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it('shows all six seats and dealer, highlights a selection, and confirms the locked price', () => {
  const { submit } = view();
  for (let i = 1; i <= 6; i++)
    expect(screen.getByRole('button', { name: new RegExp(`^Seat ${i},`) })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review bet · 10 ETB' })).toBeDisabled();
  choose();
  expect(screen.getByRole('button', { name: 'Win at 1.85 times' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(screen.getByRole('button', { name: 'Win at 1.85 times' })).toHaveClass('selected');
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 10 ETB' }));
  expect(submit).not.toHaveBeenCalled();
  const d = screen.getByRole('dialog');
  expect(d).toHaveTextContent('18.5 ETB');
  fireEvent.click(within(d).getByRole('button', { name: 'Confirm practice bet' }));
  expect(submit).toHaveBeenCalledWith({
    roundId: 'bj-test',
    slot: 1,
    stage: 0,
    seat: 1,
    market: 'WIN',
    amount: 10,
    odds: 185,
  });
});
it('keeps independent selections and amounts on Bet 1 and Bet 2', () => {
  view();
  choose();
  fireEvent.change(screen.getByLabelText('Bet amount ETB'), { target: { value: '25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add bet' }));
  fireEvent.click(screen.getByRole('button', { name: /^Seat 2,/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Win at 1.95 times' }));
  fireEvent.click(screen.getByRole('button', { name: 'Bet 1' }));
  expect(screen.getByLabelText('Bet amount ETB')).toHaveValue('25');
  expect(screen.getByRole('button', { name: 'Win at 1.85 times' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bet 2' }));
  expect(screen.getByLabelText('Bet amount ETB')).toHaveValue('10');
  expect(screen.getByRole('button', { name: 'Win at 1.95 times' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});
it('offers only final-points markets for the dealer and never fabricates a closed price', () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: /^Dealer,/ }));
  expect(screen.queryByRole('button', { name: /^Win at/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Blackjack at 6.50 times' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '17, closed' })).toBeDisabled();
});
it.each([
  'stale',
  'slow',
  'disabled',
  'rules',
  'disconnect',
  'storage',
  'pending',
  'overdraw',
  'showdown',
  'worker-lag',
])('blocks admission for %s', (kind) => {
  if (kind === 'disabled') s.enabled = false;
  if (kind === 'rules') s.rulesId = 'wrong';
  if (kind === 'overdraw') s.balance = 5;
  if (kind === 'showdown') s.rounds[0].stage = 3;
  if (kind === 'worker-lag') s.rounds[0].opensAt = s.serverTime - 50000;
  view({
    sentAt: kind === 'stale' ? performance.now() - 6000 : performance.now(),
    receivedAt: kind === 'slow' ? performance.now() + 2000 : performance.now(),
    disconnected: kind === 'disconnect',
    error: kind === 'storage' ? 'Storage failed' : '',
    pending:
      kind === 'pending'
        ? { roundId: 'bj-test', slot: 1, stage: 0, seat: 1, market: 'WIN', amount: 10, odds: 185 }
        : null,
  });
  choose();
  expect(
    screen.getByRole('button', { name: /Review bet|Bets are closed|Checking confirmation/ })
  ).toBeDisabled();
});
it.each(['5.5', '0', '501', '6', 'no', ''])('rejects invalid stake %s', (text) => {
  view();
  choose();
  fireEvent.change(screen.getByLabelText('Bet amount ETB'), { target: { value: text } });
  expect(screen.getByRole('button', { name: /Review bet/ })).toBeDisabled();
});
it('invalidates an open review when the dealing stage or quote changes', () => {
  const { submit, rerender } = view();
  choose();
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 10 ETB' }));
  s = {
    ...s,
    rounds: [{ ...s.rounds[0], stage: 1, opensAt: s.serverTime - 45000, quotes: { '1:WIN': 210 } }],
  };
  rerender(
    <MemoryRouter>
      <BlackjackView data={s} onSubmit={submit} />
    </MemoryRouter>
  );
  expect(screen.getByRole('dialog')).toHaveTextContent('stage or price changed');
  expect(screen.getByRole('button', { name: 'Confirm practice bet' })).toBeDisabled();
  expect(submit).not.toHaveBeenCalled();
});
it('shows settled receipts and lets users inspect past results without placing new bets', () => {
  const final = {
    ...s.rounds[0],
    id: 'bj-old',
    opensAt: s.serverTime - 200000,
    endsAt: s.serverTime - 40000,
    stage: 3,
    hands: [
      [0, 9],
      [13, 10],
      [5, 19, 20],
      [22, 23],
      [35, 14, 24],
      [6, 48],
      [7, 49],
    ],
    quotes: {},
    tickets: [
      {
        roundId: 'bj-old',
        slot: 1,
        stage: 0,
        seat: 1,
        market: 'DRAW' as const,
        amount: 10,
        odds: 800,
        id: 'receipt',
        payout: 80,
      },
    ],
  };
  s.rounds.push(final);
  view();
  fireEvent.click(screen.getByRole('button', { name: 'View round bj-old' }));
  expect(screen.getByRole('region', { name: 'Confirmed bets' })).toHaveTextContent(
    '80 ETB returned'
  );
  expect(screen.getByRole('button', { name: '✓ Bet confirmed' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '← Back to live table' }));
  expect(screen.getByRole('button', { name: 'Review bet · 10 ETB' })).toBeDisabled();
});
it('limits the editor to ten drafts and discloses rules', () => {
  view();
  for (let i = 0; i < 9; i++) fireEvent.click(screen.getByRole('button', { name: 'Add bet' }));
  expect(screen.getByRole('button', { name: 'Add bet' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Bet 10' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  fireEvent.click(screen.getByRole('button', { name: 'How to play ↗' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('soft 17');
  expect(screen.getByRole('dialog')).toHaveTextContent('21 market excludes');
});
it('places two independent confirmed bets through the authenticated page', async () => {
  connected();
  await screen.findByRole('button', { name: 'Win at 1.85 times' });
  choose();
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 10 ETB' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm practice bet' }));
  await screen.findByRole('button', { name: '✓ Bet confirmed' });
  fireEvent.click(screen.getByRole('button', { name: 'Add bet' }));
  fireEvent.click(screen.getByRole('button', { name: /^Seat 2,/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Win at 1.95 times' }));
  fireEvent.change(screen.getByLabelText('Bet amount ETB'), { target: { value: '25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 25 ETB' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm practice bet' }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'Confirmed bets' })).toHaveTextContent('35 ETB total')
  );
  expect(mocks.post.mock.calls[1][1]).toMatchObject({ slot: 2, seat: 2, amount: 25, odds: 195 });
});
it('retains uncertain requests across reload and retries the same ticket', async () => {
  const e: BlackjackEntry = {
    roundId: 'bj-test',
    slot: 2,
    stage: 0,
    seat: 1,
    market: 'WIN',
    amount: 25,
    odds: 185,
  };
  sessionStorage.setItem('salem.blackjack.pending.v1.tester', JSON.stringify(e));
  expect(readBlackjackPending('tester')).toEqual(e);
  connected();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Retry unconfirmed bet' })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry unconfirmed bet' }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  expect(mocks.post.mock.calls[0][1]).toEqual(e);
  await waitFor(() =>
    expect(sessionStorage.getItem('salem.blackjack.pending.v1.tester')).toBeNull()
  );
});
it('rejects corrupt pending requests before a network mutation', () => {
  sessionStorage.setItem('salem.blackjack.pending.v1.tester', '{"roundId":"r","slot":1}');
  expect(() => readBlackjackPending('tester')).toThrow();
  connected();
  expect(screen.getByRole('status')).toHaveTextContent('Browser storage');
  expect(mocks.post).not.toHaveBeenCalled();
});
