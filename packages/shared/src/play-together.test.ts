import { describe, it, expect } from 'vitest';
import {
  TOGETHER_GAMES,
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  togetherSelection,
  togetherSeedCommitment,
  togetherTermsHash,
  deriveTogetherOutcome,
  rankTogether,
  settleTogether,
  togetherPayoutEstimate,
  type TogetherGame,
  type TogetherTerms,
  type TogetherTicket,
} from './play-together.js';
import { quicknetTargetForCutoff } from './spin-win-proof.js';

const seed = 'ab'.repeat(32),
  closesAt = 1_800_000_000_000;
function fixture(game: TogetherGame, picks?: number[][]) {
  const g = TOGETHER_GAMES.find((g) => g.key === game)!;
  const terms: TogetherTerms = {
    id: 'sample-round',
    groupId: 'sample-group',
    game,
    currency: 'ETB',
    entryAmount: 5000,
    feeBps: 700,
    settingsVersion: 1,
    minPlayers: 2,
    maxPlayers: 20,
    closesAt,
    rulesId: TOGETHER_RULES_ID,
    feePolicy: TOGETHER_FEE_POLICY,
    seedCommitment: togetherSeedCommitment('sample-round', seed),
    beaconRound: quicknetTargetForCutoff(closesAt).beaconRound,
  };
  const tickets: TogetherTicket[] = Array.from({ length: picks?.length ?? 4 }, (_, i) => ({
    id: 'entry-' + i,
    userId: 'member-' + i,
    selection:
      picks?.[i] ??
      Array.from({ length: g.picks }, (_, p) =>
        game === 'blackjack' || game === 'virtual_football_3d' ? (p + i) % 3 : g.min + p + i
      ),
  }));
  const proof = {
    seed,
    beacon: { round: terms.beaconRound, signature: 'test-only', randomness: 'cd'.repeat(32) },
  };
  return { terms, tickets, proof };
}
describe('published group rules', () => {
  it.each(TOGETHER_GAMES)(
    '$name has deterministic, replayable outcomes and conserves the pool',
    (game) => {
      const f = fixture(game.key);
      const draw = deriveTogetherOutcome(f.terms, f.tickets, f.proof);
      expect(deriveTogetherOutcome(f.terms, [...f.tickets].reverse(), f.proof)).toEqual(draw);
      const ranks = rankTogether(game.key, f.tickets, draw);
      expect(ranks).toHaveLength(4);
      const s = settleTogether(5000, 700, ranks, f.terms.id);
      expect(s.payouts.reduce((n, p) => n + p.amount, 0) + s.platformFee).toBe(20000);
      expect(s.payouts.filter((p) => p.amount > 0).every((p) => p.amount >= 5000)).toBe(true);
    }
  );
  it('rejects unsupported games, invalid picks, duplicates and incomplete prediction cards', () => {
    expect(() => togetherSelection('turbo_keno', [1, 1, 2, 3, 4])).toThrow();
    expect(() => togetherSelection('turbo_keno', [1, 2, 3, 4, 81])).toThrow();
    expect(() => togetherSelection('number_challenge', [1.5])).toThrow();
    expect(() => togetherSelection('spin_win', [7])).toThrow();
    expect(() => togetherSelection('blackjack', [0, 1])).toThrow();
    expect(() => togetherSelection('blackjack', [0, 1, 2, 0, 1, 3])).toThrow();
    expect(togetherSelection('blackjack', [2, 1, 0, 2, 1, 0])).toEqual([2, 1, 0, 2, 1, 0]);
    expect(() => togetherSelection('sky_crash', [2001])).toThrow();
    expect(() => togetherSelection('unknown' as TogetherGame, [])).toThrow();
  });
  it('draws distinct balls in each published range', () => {
    for (const [game, size, count] of [
      ['turbo_keno', 80, 20],
      ['roulette_keno', 72, 18],
      ['lucky_six', 48, 35],
    ] as const) {
      const f = fixture(game);
      const { numbers } = deriveTogetherOutcome(f.terms, f.tickets, f.proof);
      expect(numbers).toHaveLength(count);
      expect(new Set(numbers).size).toBe(count);
      expect(numbers.every((n) => n >= 1 && n <= size)).toBe(true);
    }
  });
  it('does not feed player guesses or stake size into random outcomes', () => {
    const f = fixture('number_challenge');
    const draw = deriveTogetherOutcome(f.terms, f.tickets, f.proof);
    expect(
      deriveTogetherOutcome(
        { ...f.terms, entryAmount: 9000 },
        f.tickets.map((t) => ({ ...t, selection: [99] })),
        f.proof
      )
    ).toEqual(draw);
  });
  it('binds the seed and exact future beacon to each round', () => {
    const f = fixture('dice');
    expect(() =>
      deriveTogetherOutcome(f.terms, f.tickets, { ...f.proof, seed: 'ff'.repeat(32) })
    ).toThrow();
    expect(() =>
      deriveTogetherOutcome(f.terms, f.tickets, {
        ...f.proof,
        beacon: { ...f.proof.beacon, round: f.proof.beacon.round + 1 },
      })
    ).toThrow();
    expect(() =>
      deriveTogetherOutcome({ ...f.terms, id: 'different' }, f.tickets, f.proof)
    ).toThrow();
    expect(togetherTermsHash(f.terms)).not.toBe(togetherTermsHash({ ...f.terms, feeBps: 800 }));
  });
  it('uses a unique six-deck shoe and completes all automated blackjack hands', () => {
    const f = fixture('blackjack');
    const draw = deriveTogetherOutcome(f.terms, f.tickets, f.proof);
    const cards = draw.hands!.flat();
    expect(new Set(cards).size).toBe(cards.length);
    expect(cards.every((c) => c >= 0 && c < 312)).toBe(true);
    expect(draw.hands).toHaveLength(7);
    expect(draw.numbers.every((n) => [0, 1, 2].includes(n))).toBe(true);
  });
});
describe('ranking rules', () => {
  it('shares equally close Number Challenge guesses', () => {
    const f = fixture('number_challenge', [[48], [52], [90]]);
    const s = settleTogether(
      100,
      700,
      rankTogether(f.terms.game, f.tickets, { numbers: [50] }),
      'r'
    );
    expect(s.winnerCount).toBe(2);
    expect(s.payouts[2].amount).toBe(0);
  });
  it('uses the best selected runner even when an unselected runner wins the race', () => {
    const f = fixture('thunder_derby_3d', [[2], [3], [2]]);
    const s = settleTogether(
      100,
      700,
      rankTogether(f.terms.game, f.tickets, { numbers: [1, 2, 3, 4, 5, 6, 7, 8] }),
      'r'
    );
    expect(s.winnerCount).toBe(2);
    expect(s.payouts[1].amount).toBe(0);
  });
  it('ranks Lucky Six by first completed card, then falls back to hits', () => {
    const f = fixture('lucky_six', [
      [1, 2, 3, 4, 5, 6],
      [1, 2, 3, 4, 5, 7],
      [40, 41, 42, 43, 44, 45],
    ]);
    const ranks = rankTogether('lucky_six', f.tickets, {
      numbers: Array.from({ length: 35 }, (_, i) => i + 1),
    });
    expect(ranks[0].score).toBeGreaterThan(ranks[1].score);
    expect(ranks[1].score).toBeGreaterThan(ranks[2].score);
  });
  it('treats exact crash equality as a loss and refunds an all-crash round', () => {
    const f = fixture('sky_crash', [[200], [250], [300]]);
    expect(rankTogether('sky_crash', f.tickets, { numbers: [250] }).map((r) => r.score)).toEqual([
      200, 0, 0,
    ]);
    const refund = settleTogether(
      100,
      700,
      rankTogether('sky_crash', f.tickets, { numbers: [200] }),
      'r'
    );
    expect(refund.refunds).toBe(true);
    expect(refund.platformFee).toBe(0);
  });
});
describe('profit-only fees and exact accounting', () => {
  it('matches the ten-player, two-winner example', () => {
    const ranking = Array.from({ length: 10 }, (_, i) => ({
      entryId: String(i),
      score: i < 2 ? 5 : 1,
      detail: '',
    }));
    const s = settleTogether(5000, 700, ranking, 'r');
    expect(s.funded).toBe(50000);
    expect(s.platformFee).toBe(2800);
    expect(s.payouts.slice(0, 2).map((p) => p.amount)).toEqual([23600, 23600]);
  });
  it('refunds all ties, no winners, insufficient entrants and cancellations without fees', () => {
    for (const [scores, reason] of [
      [[2, 2], null],
      [[0, 0], null],
      [[4], null],
      [[4, 2], 'CANCELLED'],
    ] as const) {
      const s = settleTogether(
        100,
        700,
        scores.map((score, i) => ({ entryId: String(i), score, detail: '' })),
        'r',
        reason
      );
      expect(s.refunds).toBe(true);
      expect(s.platformFee).toBe(0);
      expect(s.payouts.every((p) => p.amount === 100)).toBe(true);
    }
  });
  it('exhausts every supported player/winner count and representative integer stakes and fees', () => {
    for (let players = 2; players <= 20; players++)
      for (let winners = 1; winners < players; winners++)
        for (const amount of [100, 700, 5000, 100000])
          for (const fee of [0, 1, 700, 2000]) {
            const ranking = Array.from({ length: players }, (_, i) => ({
              entryId: String(i),
              score: i < winners ? 2 : 1,
              detail: '',
            }));
            const s = settleTogether(amount, fee, ranking, 'r');
            expect(s.payouts.reduce((n, p) => n + p.amount, 0) + s.platformFee).toBe(
              players * amount
            );
            const paid = s.payouts.filter((p) => p.amount > 0).map((p) => p.amount);
            expect(Math.min(...paid)).toBeGreaterThanOrEqual(amount);
            expect(Math.max(...paid) - Math.min(...paid)).toBeLessThanOrEqual(1);
            expect(
              settleTogether(amount, fee, [...ranking].reverse(), 'r').payouts.sort((a, b) =>
                a.entryId.localeCompare(b.entryId)
              )
            ).toEqual([...s.payouts].sort((a, b) => a.entryId.localeCompare(b.entryId)));
          }
  });
  it('shows a conditional sole-winner estimate with the original entry included once', () => {
    expect(togetherPayoutEstimate(5000, 10, 700)).toEqual({
      pool: 50000,
      soleWinnerPayout: 46850,
      fee: 3150,
    });
    expect(togetherPayoutEstimate(5000, 1, 700).soleWinnerPayout).toBe(0);
  });
});
