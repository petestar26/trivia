import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  LUCKY_SIX_RULES,
  lsStake,
  type LuckySixSnapshot,
  type LuckySixEntry,
} from '@socialplay/shared';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks, unwrapData: (v: { data: unknown }) => v.data }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'tester' } }) }));
import { LuckySixPage, LuckySixView, readLuckySixPending } from './lucky-six';
let s: LuckySixSnapshot;
beforeEach(() => {
  sessionStorage.clear();
  mocks.get.mockReset();
  mocks.post.mockReset();
  const now = Date.now();
  s = {
    enabled: true,
    rulesId: LUCKY_SIX_RULES.id,
    maxTickets: 10,
    serverTime: now,
    balance: 1000,
    rounds: [
      {
        id: 'ls-test',
        opensAt: now - 5000,
        closesAt: now + 205000,
        endsAt: now + 295000,
        revealed: [],
        complete: false,
        tickets: [],
      },
    ],
  };
  mocks.get.mockImplementation(async () => ({ data: structuredClone(s) }));
  mocks.post.mockImplementation(async (_path, e: LuckySixEntry) => {
    const t = { ...e, id: 'receipt-' + e.slot, stake: lsStake(e.market, e.amount), payout: null };
    s.rounds[0].tickets.push(t);
    s.balance -= t.stake;
    return { data: { accepted: true, id: t.id } };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function view(props: Partial<Parameters<typeof LuckySixView>[0]> = {}) {
  const submit = vi.fn();
  const rendered = render(
    <MemoryRouter>
      <LuckySixView data={s} onSubmit={submit} {...props} />
    </MemoryRouter>
  );
  return { submit, ...rendered };
}
function pickSix() {
  for (const n of [1, 9, 17, 25, 33, 41])
    fireEvent.click(screen.getByRole('button', { name: `Number ${n}` }));
}
function connected() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter>
        <LuckySixPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it('requires six distinct choices and reviews one stake rather than six stakes', () => {
  const { submit } = view();
  expect(
    within(screen.getByRole('group', { name: '48-number board' })).getAllByRole('button')
  ).toHaveLength(48);
  expect(screen.getByRole('button', { name: 'Review bet · 5 ETB' })).toBeDisabled();
  pickSix();
  fireEvent.click(screen.getByRole('button', { name: 'Number 2' }));
  expect(screen.getByRole('button', { name: 'Number 2' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Number 41' })).toHaveClass('is-selected');
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 5 ETB' }));
  expect(submit).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('Match all six');
  expect(dialog).toHaveTextContent('settle after ball 35');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm practice bet' }));
  expect(submit).toHaveBeenCalledWith({
    roundId: 'ls-test',
    slot: 1,
    market: 'SIX',
    picks: [1, 9, 17, 25, 33, 41],
    amount: 5,
  });
});
it('prices all colors as eight lines and rejects a bundle over 500 ETB', () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: 'Colors' }));
  fireEvent.change(screen.getByLabelText('Bet type'), { target: { value: 'ALL_COLORS' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 40 ETB' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('total cost is eight times');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  fireEvent.change(screen.getByLabelText('ETB per color line'), { target: { value: '65' } });
  expect(screen.getByRole('button', { name: 'Review bet · 520 ETB' })).toBeDisabled();
});
it('uses one first-five number and shows its scope', () => {
  view();
  fireEvent.change(screen.getByLabelText('Bet type'), { target: { value: 'PRE_NUMBER' } });
  fireEvent.click(screen.getByRole('button', { name: 'Number 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Number 48' }));
  expect(screen.getByRole('button', { name: 'Number 1' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 5 ETB' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('first five balls');
  expect(screen.getByRole('dialog')).toHaveTextContent('43 ETB');
});
it('retains independent drafts and amounts across numbered bet tabs', () => {
  view();
  pickSix();
  fireEvent.change(screen.getByLabelText('Bet amount · ETB'), { target: { value: '25' } });
  fireEvent.click(screen.getByRole('button', { name: '+ Add bet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Colors' }));
  fireEvent.click(screen.getByRole('button', { name: 'Blue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Bet 1 Draft' }));
  expect(screen.getByLabelText('Bet amount · ETB')).toHaveValue('25');
  expect(screen.getByRole('button', { name: 'Number 41' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Bet 2 Draft' }));
  expect(screen.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'true');
});
it.each(['stale', 'disabled', 'closed', 'wrong-rules', 'storage', 'pending', 'insufficient'])(
  'blocks entry when %s',
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
          ? { roundId: 'ls-test', slot: 1, market: 'SIX', picks: [1, 2, 3, 4, 5, 6], amount: 5 }
          : null,
    });
    pickSix();
    const button = screen.getByRole('button', {
      name: /Review bet|Bets are closed|Checking confirmation/,
    });
    expect(button).toBeDisabled();
  }
);
it('rechecks cutoff while a confirmation dialog is open', () => {
  const { submit, rerender } = view();
  pickSix();
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 5 ETB' }));
  const closed = structuredClone(s);
  closed.rounds[0].closesAt = s.serverTime - 1;
  rerender(
    <MemoryRouter>
      <LuckySixView data={closed} onSubmit={submit} />
    </MemoryRouter>
  );
  expect(screen.getByRole('button', { name: 'Confirm practice bet' })).toBeDisabled();
  expect(submit).not.toHaveBeenCalled();
});
it('keeps the confirmed selection visible, locks changes, and permits a separate next bet', async () => {
  connected();
  await screen.findByRole('button', { name: 'Number 1' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Number 1' })).toBeEnabled());
  pickSix();
  fireEvent.click(screen.getByRole('button', { name: 'Review bet · 5 ETB' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm practice bet' }));
  await screen.findByRole('button', { name: '✓ Bet confirmed' });
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(s.balance).toBe(995);
  expect(screen.getByRole('button', { name: 'Number 41' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Number 41' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '+ Add bet' }));
  expect(screen.getByRole('button', { name: 'Number 41' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Number 41' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
});
it('recovers a saved pending request from the authoritative receipt without re-posting', async () => {
  const e: LuckySixEntry = {
    roundId: 'ls-test',
    slot: 1,
    market: 'SIX',
    picks: [1, 2, 3, 4, 5, 6],
    amount: 5,
  };
  sessionStorage.setItem('salem.lucky-six.pending.v1.tester', JSON.stringify(e));
  s.rounds[0].tickets = [{ ...e, id: 'saved', stake: 5, payout: null }];
  s.balance = 995;
  connected();
  await screen.findByText('Bet 1 confirmed by the server.');
  expect(mocks.post).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('salem.lucky-six.pending.v1.tester')).toBeNull();
});
it('validates persisted requests and blocks unsafe browser storage', async () => {
  sessionStorage.setItem(
    'salem.lucky-six.pending.v1.tester',
    JSON.stringify({ roundId: 'r', slot: 1, market: 'SIX', picks: [1], amount: 5 })
  );
  expect(() => readLuckySixPending('tester')).toThrow();
  connected();
  await screen.findByText(/Browser storage could not be read/);
  expect(mocks.post).not.toHaveBeenCalled();
});
it('shows only released results, six-match completion and the full rules table', () => {
  s.rounds[0].closesAt = s.serverTime - 20000;
  s.rounds[0].revealed = [1, 9, 17, 25, 33, 41];
  s.rounds[0].tickets = [
    {
      id: 'saved',
      roundId: 'ls-test',
      slot: 1,
      market: 'SIX',
      picks: [1, 9, 17, 25, 33, 41],
      amount: 5,
      stake: 5,
      payout: null,
    },
  ];
  view();
  expect(screen.getByRole('img', { name: 'Latest released ball: 41, Red' })).toBeInTheDocument();
  expect(screen.getByText(/Six matched at ball 6/)).toBeInTheDocument();
  expect(
    within(screen.getByRole('list', { name: 'Released balls' })).getAllByRole('listitem')
  ).toHaveLength(35);
  expect(screen.getByLabelText('Ball 7: waiting')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'How to play ↗' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('Ball 35');
  expect(dialog).toHaveTextContent('1.8×');
  expect(dialog).toHaveTextContent('tied');
});
it('shows unique six-number quick picks and resets drafts for a new round', () => {
  const { submit, rerender } = view();
  fireEvent.click(screen.getByRole('button', { name: 'Quick pick 6' }));
  expect(screen.getByLabelText('6 of 6 numbers selected')).toBeInTheDocument();
  const next = structuredClone(s);
  next.rounds[0].id = 'ls-next';
  rerender(
    <MemoryRouter>
      <LuckySixView data={next} onSubmit={submit} />
    </MemoryRouter>
  );
  expect(screen.getByLabelText('0 of 6 numbers selected')).toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
});
