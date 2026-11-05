import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  TOGETHER_FEE_POLICY,
  TOGETHER_RULES_ID,
  type TogetherGame,
  type TogetherRoundView,
} from '@socialplay/shared';
import { TogetherGameResult } from './together-game-result';

function fixture(game: TogetherGame): TogetherRoundView {
  return {
    id: 'round-1',
    groupId: 'group',
    creatorId: 'me',
    groupName: 'Friends',
    game,
    currency: 'GAME_POINTS',
    entryAmount: 1000,
    feeBps: 700,
    settingsVersion: 1,
    minPlayers: 2,
    maxPlayers: 20,
    closesAt: 1000,
    rulesId: TOGETHER_RULES_ID,
    feePolicy: TOGETHER_FEE_POLICY,
    seedCommitment: 'ab'.repeat(32),
    beaconRound: 1,
    state: 'PAID',
    termsHash: 'cd'.repeat(32),
    rosterHash: 'ef'.repeat(32),
    entries: [
      {
        id: 'mine',
        userId: 'me',
        username: 'Abebe',
        selection: [1, 2, 3, 4, 50],
        state: 'SETTLED',
        amount: 1000,
        payout: 1930,
        createdAt: 100,
        walletTransactionId: 'w1',
        payoutTransactionId: 'p1',
        requestId: 'request1',
      },
      {
        id: 'other',
        userId: 'other',
        username: 'Tigist',
        selection: [5, 6, 7, 60, 70],
        state: 'SETTLED',
        amount: 1000,
        payout: 0,
        createdAt: 100,
        walletTransactionId: 'w2',
        payoutTransactionId: null,
        requestId: 'request2',
      },
    ],
    outcome: { numbers: Array.from({ length: 18 }, (_, i) => i + 1) },
    ranking: [],
    settlement: {
      funded: 2000,
      platformFee: 70,
      feeBps: 700,
      winnerCount: 1,
      refunds: false,
      reason: null,
      payouts: [
        { entryId: 'mine', amount: 1930, profit: 930 },
        { entryId: 'other', amount: 0, profit: -1000 },
      ],
    },
    voidReason: null,
    proof: null,
    recoveryDeadline: 7000,
    paidAt: 2000,
  };
}
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['OPEN', 'LOCKED'] as const)(
  'does not expose a result in %s even if an inconsistent response contains one',
  (state) => {
    const round = fixture('roulette_keno');
    round.state = state;
    const { container } = render(
      <TogetherGameResult round={round} userId="me" serverNow={60000} />
    );
    expect(container).toBeEmptyDOMElement();
  }
);

it.each(['spin_win', 'turbo_keno', 'dice', 'number_challenge'] as const)(
  'preserves the recorded result for the initial %s game',
  (game) => {
    const round = fixture(game);
    if (game === 'spin_win') round.outcome = { numbers: [0] };
    if (game === 'turbo_keno')
      round.outcome = { numbers: Array.from({ length: 20 }, (_, i) => i + 1) };
    if (game === 'dice') round.outcome = { numbers: [6, 5, 2, 3] };
    if (game === 'number_challenge') {
      round.outcome = { numbers: [42] };
      round.entries[0].selection = [40];
      round.entries[1].selection = [75];
    }
    render(<TogetherGameResult round={round} userId="me" serverNow={60000} />);
    if (game === 'spin_win')
      expect(screen.getByRole('heading', { name: 'Abebe (you)' })).toBeInTheDocument();
    if (game === 'turbo_keno') expect(screen.getByLabelText('Ball 20: 20')).toBeInTheDocument();
    if (game === 'dice')
      expect(
        within(screen.getByRole('list', { name: 'Recorded dice rolls' })).getAllByRole(
          'listitem'
        )[0]
      ).toHaveTextContent('Abebe (you)6 + 5Total 11');
    if (game === 'number_challenge') expect(screen.getByText('Distance 2')).toBeInTheDocument();
  }
);

it('shows the complete Keno draw and only the current player’s matches on initial load', () => {
  const round = fixture('roulette_keno');
  render(<TogetherGameResult round={round} userId="me" serverNow={60000} />);
  expect(screen.getByText('4 matches')).toBeInTheDocument();
  expect(
    within(screen.getByRole('list', { name: 'Balls in draw order' })).getAllByRole('listitem')
  ).toHaveLength(18);
  expect(screen.getByLabelText('Ball 1: 1, matched your ticket')).toBeInTheDocument();
  expect(screen.getByLabelText('Ball 5: 5')).toBeInTheDocument();
  expect(screen.queryByText(/Replaying/)).not.toBeInTheDocument();
});

it('never uses a previously cancelled selection for the result highlight', () => {
  const round = fixture('roulette_keno');
  round.entries.unshift({
    ...round.entries[0],
    id: 'cancelled',
    state: 'REFUNDED',
    selection: [10, 11, 12, 13, 14],
  });
  render(<TogetherGameResult round={round} userId="me" serverNow={60000} />);
  expect(screen.getByLabelText('Ball 1: 1, matched your ticket')).toBeInTheDocument();
  expect(screen.getByLabelText('Ball 10: 10')).toBeInTheDocument();
});

it('shows Lucky Six completion using its draw position, including tied refund explanation', () => {
  const round = fixture('lucky_six');
  round.outcome = { numbers: Array.from({ length: 35 }, (_, i) => i + 1) };
  round.entries[0].selection = [1, 3, 5, 7, 9, 12];
  round.state = 'REFUNDED';
  round.settlement = {
    ...round.settlement!,
    refunds: true,
    reason: 'ALL_TIED',
    winnerCount: 0,
    platformFee: 0,
  };
  render(<TogetherGameResult round={round} userId="me" serverNow={60000} />);
  expect(screen.getByText(/six completed on ball 12/)).toBeInTheDocument();
  expect(screen.getByText(/Everyone tied.*All entries returned in full/)).toBeInTheDocument();
});

it.each(['thunder_derby_3d', 'neon_hounds_3d'] as const)(
  'shows the real finishing order and own finish for %s',
  (game) => {
    const round = fixture(game);
    round.outcome = { numbers: [8, 2, 7, 1, 4, 5, 6, 3] };
    round.entries[0].selection = [1];
    render(<TogetherGameResult round={round} userId="me" serverNow={60000} />);
    const finish = within(
      screen.getByRole('list', { name: 'Recorded finishing order' })
    ).getAllByRole('listitem');
    expect(finish).toHaveLength(8);
    expect(finish[0]).toHaveTextContent(game === 'neon_hounds_3d' ? 'Dog 8' : 'Runner 8');
    expect(finish[3]).toHaveTextContent('Your pick');
    expect(screen.getByText('#4')).toBeInTheDocument();
  }
);

it('shows the three football scores and grades each of the player’s predictions', () => {
  const round = fixture('virtual_football_3d');
  round.outcome = {
    numbers: [0, 1, 2],
    football: [
      { home: 2, away: 1 },
      { home: 0, away: 0 },
      { home: 1, away: 3 },
    ],
  };
  round.entries[0].selection = [0, 0, 2];
  render(<TogetherGameResult round={round} userId="me" serverNow={60000} />);
  expect(
    within(screen.getByRole('article', { name: 'Simulated match 1' })).getByText('2 – 1')
  ).toBeInTheDocument();
  expect(screen.getAllByText(/· Correct/)).toHaveLength(2);
  expect(screen.getByText('Your prediction: Home win · Missed')).toBeInTheDocument();
});

function blackjackFixture() {
  const round = fixture('blackjack');
  round.outcome = {
    numbers: [0, 1, 2, 1, 1, 1],
    hands: [
      [9, 8],
      [0, 12],
      [22, 21],
      [35, 33],
      [48, 47],
      [61, 60],
      [74, 73],
    ],
  };
  round.entries[0].selection = [0, 0, 2, 1, 1, 1];
  return round;
}

it('displays actual blackjack cards, dealer, natural blackjack, and prediction results', () => {
  render(<TogetherGameResult round={blackjackFixture()} userId="me" serverNow={60000} />);
  const dealer = screen.getByRole('article', { name: 'Dealer hand' });
  expect(within(dealer).getByText('Total 19')).toBeInTheDocument();
  const natural = screen.getByRole('article', { name: 'Hand 1' });
  expect(within(natural).getByLabelText('A of spades')).toBeInTheDocument();
  expect(within(natural).getByText('Blackjack · 21')).toBeInTheDocument();
  expect(within(natural).getByText('Your prediction: Win · Correct')).toBeInTheDocument();
  expect(screen.getAllByRole('article')).toHaveLength(7);
});

it.each(['sky_crash', 'crash_point'] as const)(
  'marks equality with the crash as a loss for %s',
  (game) => {
    const round = fixture(game);
    round.outcome = { numbers: [250] };
    round.entries[0].selection = [250];
    round.entries[1].selection = [200];
    render(<TogetherGameResult round={round} userId="me" serverNow={60000} />);
    const rows = within(screen.getByRole('list', { name: 'Recorded exit targets' })).getAllByRole(
      'listitem'
    );
    expect(rows[0]).toHaveTextContent('Abebe (you)2.50×Crashed');
    expect(rows[1]).toHaveTextContent('Tigist2.00×Qualified');
    expect(
      screen.getByText(/Targets are contest scores, not payout multipliers/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replay for me' })).toBeInTheDocument();
  }
);

it('allows optional replay and immediate final result without changing the input round', () => {
  vi.useFakeTimers();
  let monotonicNow = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
  const round = fixture('roulette_keno');
  const original = structuredClone(round);
  render(<TogetherGameResult round={round} userId="me" serverNow={60000} />);
  fireEvent.click(screen.getByRole('button', { name: 'Replay for me' }));
  expect(screen.getByRole('status')).toHaveTextContent(
    'The group’s result and everyone’s wallet are unchanged'
  );
  expect(screen.getByLabelText('Ball 1: awaiting reveal')).toBeInTheDocument();
  act(() => {
    monotonicNow = 1700;
    vi.advanceTimersByTime(700);
  });
  expect(screen.getByLabelText('Ball 1: 1, matched your ticket')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show final result' }));
  expect(screen.getByLabelText('Ball 18: 18')).toBeInTheDocument();
  expect(round).toEqual(original);
});

it('resets an active replay when navigating to a different round', () => {
  const first = fixture('roulette_keno');
  const { rerender } = render(<TogetherGameResult round={first} userId="me" serverNow={60000} />);
  fireEvent.click(screen.getByRole('button', { name: 'Replay for me' }));
  rerender(
    <TogetherGameResult round={{ ...first, id: 'another-round' }} userId="me" serverNow={60000} />
  );
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Ball 18: 18')).toBeInTheDocument();
});

it('keeps the final result static for reduced-motion users', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
  render(<TogetherGameResult round={fixture('roulette_keno')} userId="me" serverNow={60000} />);
  expect(screen.queryByRole('button', { name: 'Replay for me' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Ball 18: 18')).toBeInTheDocument();
});

it('does not invent a result for an underfilled refunded round', () => {
  const round = fixture('roulette_keno');
  round.state = 'REFUNDED';
  round.outcome = null;
  render(<TogetherGameResult round={round} userId="me" serverNow={60000} />);
  expect(screen.getByRole('heading', { name: 'Entries returned' })).toBeInTheDocument();
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
});

it.each([
  'missing',
  'duplicate balls',
  'wrong score',
  'duplicate cards',
  'incomplete hands',
  'invalid crash',
])('does not fabricate a display for %s', (kind) => {
  let round = fixture('roulette_keno');
  if (kind === 'missing') round.outcome = null;
  if (kind === 'duplicate balls') round.outcome!.numbers[0] = 2;
  if (kind === 'wrong score') {
    round = fixture('virtual_football_3d');
    round.outcome = {
      numbers: [0, 0, 0],
      football: [
        { home: 0, away: 1 },
        { home: 0, away: 1 },
        { home: 0, away: 1 },
      ],
    };
  }
  if (kind === 'duplicate cards') {
    round = blackjackFixture();
    round.outcome!.hands![1] = round.outcome!.hands![0];
  }
  if (kind === 'incomplete hands') {
    round = blackjackFixture();
    round.outcome!.hands![1] = [1, 2];
  }
  if (kind === 'invalid crash') {
    round = fixture('sky_crash');
    round.outcome = { numbers: [NaN] };
  }
  render(<TogetherGameResult round={round} userId="me" serverNow={60000} />);
  expect(screen.getByRole('heading', { name: 'Result display unavailable' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Replay for me' })).not.toBeInTheDocument();
});

it('identifies the winning group pick even when an unselected runner finishes first', () => {
  const round = fixture('thunder_derby_3d');
  round.entries[0].selection = [4];
  round.entries[1].selection = [8];
  round.outcome = { numbers: [1, 2, 3, 4, 5, 6, 7, 8] };
  render(<TogetherGameResult round={round} userId="me" serverNow={60000} />);
  expect(screen.getByText('Group-winning pick: Runner 4')).toBeInTheDocument();
  expect(screen.queryByText('Group-winning pick: Runner 1')).not.toBeInTheDocument();
});

function revealFixture(game: TogetherGame) {
  const round = game === 'blackjack' ? blackjackFixture() : fixture(game);
  round.paidAt = 100000;
  if (game === 'spin_win') round.outcome = { numbers: [0] };
  if (game === 'turbo_keno')
    round.outcome = { numbers: Array.from({ length: 20 }, (_, i) => i + 1) };
  if (game === 'lucky_six') {
    round.outcome = { numbers: Array.from({ length: 35 }, (_, i) => i + 1) };
    round.entries[0].selection = [1, 2, 3, 4, 5, 6];
  }
  if (game === 'dice') round.outcome = { numbers: [6, 5, 2, 3] };
  if (game === 'number_challenge') {
    round.outcome = { numbers: [42] };
    round.entries[0].selection = [40];
    round.entries[1].selection = [75];
  }
  if (game === 'thunder_derby_3d' || game === 'neon_hounds_3d') {
    round.outcome = { numbers: [8, 2, 7, 1, 4, 5, 6, 3] };
    round.entries[0].selection = [1];
    round.entries[1].selection = [8];
  }
  if (game === 'virtual_football_3d') {
    round.outcome = {
      numbers: [0, 1, 2],
      football: [
        { home: 2, away: 1 },
        { home: 0, away: 0 },
        { home: 1, away: 3 },
      ],
    };
    round.entries[0].selection = [0, 1, 2];
  }
  if (game === 'sky_crash' || game === 'crash_point') {
    round.outcome = { numbers: [250] };
    round.entries[0].selection = [200];
    round.entries[1].selection = [300];
  }
  return round;
}

it.each([
  'spin_win',
  'turbo_keno',
  'dice',
  'number_challenge',
  'roulette_keno',
  'lucky_six',
  'thunder_derby_3d',
  'neon_hounds_3d',
  'virtual_football_3d',
  'blackjack',
  'sky_crash',
  'crash_point',
] as const)('%s uses the same canonical reveal progress for participant and spectator', (game) => {
  const round = revealFixture(game),
    original = structuredClone(round);
  const renderViews = (now: number) => (
    <>
      <div data-testid="member">
        <TogetherGameResult round={round} userId="me" serverNow={now} />
      </div>
      <div data-testid="spectator">
        <TogetherGameResult round={round} userId="spectator" serverNow={now} />
      </div>
    </>
  );
  const { rerender } = render(renderViews(102000));
  for (const viewer of ['member', 'spectator']) {
    const panel = screen.getByTestId(viewer).querySelector('.tg-result')!;
    expect(panel).toHaveAttribute('data-reveal-phase', 'scheduled');
    expect(panel).toHaveAttribute('data-reveal-progress', '0');
    expect(panel.querySelectorAll('[data-revealed="true"]')).toHaveLength(0);
  }
  rerender(renderViews(109000));
  const panels = ['member', 'spectator'].map((viewer) =>
    screen.getByTestId(viewer).querySelector('.tg-result')!
  );
  for (const panel of panels) {
    expect(panel).toHaveAttribute('data-reveal-mode', 'shared');
    expect(panel).toHaveAttribute('data-reveal-phase', 'revealing');
    expect(panel).toHaveAttribute('data-reveal-progress', '0.5');
    expect(
      within(panel as HTMLElement).getByRole('progressbar', { name: 'Shared reveal progress' })
    ).toHaveAttribute('aria-valuenow', '50');
  }
  expect(panels[0].querySelectorAll('[data-revealed="true"]').length).toBe(
    panels[1].querySelectorAll('[data-revealed="true"]').length
  );
  rerender(renderViews(115000));
  for (const viewer of ['member', 'spectator']) {
    const panel = screen.getByTestId(viewer).querySelector('.tg-result')!;
    expect(panel).toHaveAttribute('data-reveal-phase', 'complete');
    expect(panel).toHaveAttribute('data-reveal-progress', '1');
    expect(panel.querySelectorAll('[data-revealed="false"]')).toHaveLength(0);
  }
  expect(round).toEqual(original);
});

it('a late viewer joins the current shared draw instead of restarting it', () => {
  const round = revealFixture('roulette_keno');
  render(<TogetherGameResult round={round} userId="me" serverNow={109000} />);
  expect(screen.getByText('9 of 18 balls revealed')).toBeInTheDocument();
  expect(screen.getByLabelText('Ball 9: 9')).toBeInTheDocument();
  expect(screen.getByLabelText('Ball 10: awaiting reveal')).toBeInTheDocument();
});

it('viewing final results early affects only that viewer, who can rejoin the current reveal', () => {
  const round = revealFixture('roulette_keno');
  render(
    <>
      <div data-testid="first">
        <TogetherGameResult round={round} userId="me" serverNow={109000} />
      </div>
      <div data-testid="second">
        <TogetherGameResult round={round} userId="spectator" serverNow={109000} />
      </div>
    </>
  );
  const first = within(screen.getByTestId('first')),
    second = within(screen.getByTestId('second'));
  fireEvent.click(first.getByRole('button', { name: 'Show final result' }));
  expect(first.getByLabelText('Ball 18: 18')).toBeInTheDocument();
  expect(second.getByLabelText('Ball 18: awaiting reveal')).toBeInTheDocument();
  expect(first.queryByRole('button', { name: 'Replay for me' })).not.toBeInTheDocument();
  fireEvent.click(first.getByRole('button', { name: 'Rejoin shared reveal' }));
  expect(first.getByLabelText('Ball 10: awaiting reveal')).toBeInTheDocument();
  expect(first.getByLabelText('Ball 9: 9')).toBeInTheDocument();
});

it('loss of the shared clock shows the saved final and reconnect catches up', () => {
  const round = revealFixture('roulette_keno');
  const { rerender } = render(<TogetherGameResult round={round} userId="me" serverNow={109000} />);
  rerender(<TogetherGameResult round={round} userId="me" serverNow={null} />);
  expect(screen.getByRole('status')).toHaveTextContent('shared clock reconnects');
  expect(screen.getByLabelText('Ball 18: 18')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Replay for me' })).not.toBeInTheDocument();
  rerender(<TogetherGameResult round={round} userId="me" serverNow={112000} />);
  expect(screen.getByText('13 of 18 balls revealed')).toBeInTheDocument();
  expect(screen.getByLabelText('Ball 14: awaiting reveal')).toBeInTheDocument();
});

it('a reduced-motion viewer has immediate access to the same final during the common reveal', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
  const { container } = render(
    <TogetherGameResult round={revealFixture('roulette_keno')} userId="me" serverNow={109000} />
  );
  expect(container.querySelector('.tg-result')).toHaveAttribute('data-reveal-mode', 'final');
  expect(screen.getByLabelText('Ball 18: 18')).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.getByText(/Showing the final result with reduced motion/)).toBeInTheDocument();
});

it('a saved result awaiting payment does not invent a shared start time', () => {
  const round = revealFixture('roulette_keno');
  round.state = 'DRAWN';
  round.paidAt = null;
  const { container } = render(<TogetherGameResult round={round} userId="me" serverNow={109000} />);
  expect(container.querySelector('.tg-result')).toHaveAttribute('data-reveal-phase', 'awaiting');
  expect(screen.getByLabelText('Ball 18: 18')).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Replay for me' })).not.toBeInTheDocument();
});
