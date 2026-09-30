import { describe, expect, it } from 'vitest';
import { SPIN90_MARKETS, SPIN90_RULES_ID } from '@socialplay/shared';
import { GAME_ECONOMICS, ECONOMICS_POLICY, gameEconomics } from './policy.js';
import { planContestSettlement } from './contest-pool.js';
import type { ContestPool, PoolContribution } from './contest-pool.js';
import { assertExactHouseReturn, emptyHouseBook, quoteHouseAdmission } from './house-risk.js';
import type { HouseLimits } from './house-risk.js';
import { buildHouseModel, quoteDice90Ticket, quoteNumber90Ticket, quoteSpin90Ticket, DRAW_PROPOSALS, quoteDraftDrawTicket } from './models.js';
import { assertRoundOpen, scheduledRound, SPIN_ROUND_TIMING } from './round-clock.js';
import { MAX_UNITS } from './money.js';
import { generateRoundOutcome, settleHouseTicket } from './round-outcome.js';

const limits: HouseLimits = {
  backedCapital: 100_000n, otherRoundLossReserves: 0n, maxRoundLoss: 100_000n,
  maxRoundPayout: 100_000n, maxTicketStake: 480n, maxUserRoundStake: 480n,
};
const entry = (userId: string, amount: bigint): PoolContribution => ({ id: `receipt-${userId}`, userId, amount, kind: 'ENTRY' });
const pool = (contributions = [entry('a', 100n), entry('b', 100n)]): ContestPool => ({
  policy: ECONOMICS_POLICY, currency: 'COINS', contributions,
});

describe('explicit game economics coverage', () => {
  it('covers all 13 public keys without reviving Lucky Spin', () => {
    expect(GAME_ECONOMICS.map((game) => game.key).sort()).toEqual([
      'dice', 'number_challenge', 'trivia', 'spin_win', 'thunder_derby_3d', 'neon_hounds_3d',
      'turbo_circuit_3d', 'starfall_nebula', 'jungle_dash_3d', 'turbo_keno', 'crystal_trail', 'heat_vault', 'strait_rush',
    ].sort());
    expect(() => gameEconomics('lucky_spin')).toThrow();
  });
  it('makes no house-edge claim for bonus Trivia', () => {
    expect(gameEconomics('trivia').model).toBe('BONUS');
    expect(() => buildHouseModel('trivia', 'v1')).toThrow();
  });
  it.each(DRAW_PROPOSALS)(
    '$key rejects another game rules ID', ({ key }) => {
      expect(() => buildHouseModel(key, SPIN90_RULES_ID)).toThrow('No supported payout model');
    },
  );
  it('cannot relabel legacy rules as 90%', () => {
    expect(() => buildHouseModel('spin_win', 'single-zero-standard-v1')).toThrow();
    expect(() => buildHouseModel('dice', '1')).toThrow();
    expect(() => buildHouseModel('number_challenge', '1')).toThrow();
  });
});

describe('15% funded-entry policy', () => {
  it('takes exactly 30 from 200 and pays 170, with no additional wager edge', () => {
    const plan = planContestSettlement(pool(), { status: 'COMPLETED', winnerIds: ['a'] });
    expect(plan.platformFee).toBe(30n);
    expect(plan.prizes).toEqual([{ userId: 'a', amount: 170n }]);
    expect(plan.refunds).toEqual([]);
  });
  it('does not take a second fee from sponsor funding', () => {
    const plan = planContestSettlement(pool([
      entry('a', 100n), entry('b', 100n), { id: 'sponsor', userId: 's', kind: 'SPONSOR', amount: 73n },
    ]), { status: 'COMPLETED', winnerIds: ['b'] });
    expect(plan.platformFee).toBe(30n);
    expect(plan.prizes).toEqual([{ userId: 'b', amount: 243n }]);
  });
  it('returns every receipt on a void, including sponsors, with zero fees', () => {
    const original = pool([entry('a', 20n), { id: 'sponsor', userId: 's', kind: 'SPONSOR', amount: 7n }]);
    const plan = planContestSettlement(original, { status: 'VOID' });
    expect(plan.platformFee).toBe(0n);
    expect(plan.prizes).toEqual([]);
    expect(plan.refunds.map((refund) => refund.amount)).toEqual([20n, 7n]);
    expect(plan.refunds.map((refund) => refund.receiptId)).toEqual(['receipt-a', 'sponsor']);
  });
  it('distributes tie remainders deterministically to winners, never the house', () => {
    const original = pool([entry('a', 20n), entry('b', 20n), entry('c', 20n)]);
    const forward = planContestSettlement(original, { status: 'COMPLETED', winnerIds: ['a', 'b'] });
    const reverse = planContestSettlement(original, { status: 'COMPLETED', winnerIds: ['b', 'a'] });
    expect(forward).toEqual(reverse);
    expect(forward.platformFee).toBe(9n);
    expect(forward.prizes).toEqual([{ userId: 'a', amount: 26n }, { userId: 'b', amount: 25n }]);
  });
  it('conserves every unit across varied pools and ties', () => {
    for (let entrants = 2; entrants <= 20; entrants++) {
      const receipts = Array.from({ length: entrants }, (_, index) => entry(`user-${index}`, BigInt(index + 1) * 20n));
      for (let count = 1; count <= entrants; count++) {
        const result = planContestSettlement(pool(receipts), {
          status: 'COMPLETED', winnerIds: receipts.slice(0, count).map((receipt) => receipt.userId),
        });
        expect(result.platformFee * 100n).toBe(result.funded * 15n);
        expect(result.prizes.reduce((sum, prize) => sum + prize.amount, result.platformFee)).toBe(result.funded);
        expect(result.prizes.every((prize) => prize.amount > 0n)).toBe(true);
      }
    }
  });
  it('does not misreport Game Points fees as Coin revenue', () => {
    const result = planContestSettlement({ ...pool(), currency: 'GAME_POINTS' }, { status: 'COMPLETED', winnerIds: ['a'] });
    expect(result.currency).toBe('GAME_POINTS');
  });
  it.each([1n, 19n, 21n, -20n, 0n])('rejects unrepresentable or invalid entry %s', (amount) => {
    expect(() => planContestSettlement(pool([entry('a', amount), entry('b', 20n)]), { status: 'COMPLETED', winnerIds: ['a'] })).toThrow();
  });
  it.each([[], ['outsider'], ['a', 'a']].map((winnerIds) => ({ winnerIds })))('rejects invalid winners $winnerIds', ({ winnerIds }) => {
    expect(() => planContestSettlement(pool(), { status: 'COMPLETED', winnerIds })).toThrow();
  });
  it('rejects single-player self-funded contests, duplicate receipts and overflow', () => {
    expect(() => planContestSettlement(pool([entry('a', 100n)]), { status: 'COMPLETED', winnerIds: ['a'] })).toThrow();
    expect(() => planContestSettlement(pool([entry('a', 100n), entry('a', 100n)]), { status: 'VOID' })).toThrow();
    expect(() => planContestSettlement(pool([entry('a', MAX_UNITS - MAX_UNITS % 20n), entry('b', 20n)]), { status: 'VOID' })).toThrow();
  });
  it('never retroactively applies this policy to another pinned policy', () => {
    expect(() => planContestSettlement({ ...pool(), policy: 'old' as typeof ECONOMICS_POLICY }, { status: 'VOID' })).toThrow();
  });
});

describe('exact house mathematics and reserve limits', () => {
  it.each(DRAW_PROPOSALS)('$key proposed math is exact for every selection', (proposal) => {
    for (let choice = 1; choice <= proposal.choices; choice++) {
      const { model, ticket } = quoteDraftDrawTicket(proposal.key, [{ choice, stake: proposal.step }]);
      expect(() => assertExactHouseReturn(model, ticket)).not.toThrow();
      expect(ticket.payouts.reduce((sum, value) => sum + value, 0n) * BigInt(proposal.drawCount) * 10n)
        .toBe(ticket.stake * BigInt(proposal.choices) * 9n);
    }
  });
  it('reserves all 20 possible simultaneous Keno winners rather than only one line', () => {
    const { model, ticket } = quoteDraftDrawTicket('turbo_keno', Array.from({ length: 20 }, (_, i) => ({ choice: i + 1, stake: 5n })));
    const result = quoteHouseAdmission(emptyHouseBook(model), ticket, limits, 0n);
    expect(result.maxGrossPayout).toBe(360n);
    expect(result.requiredLossReserve).toBe(260n);
    expect(() => quoteHouseAdmission(emptyHouseBook(model), ticket, { ...limits, maxRoundPayout: 359n }, 0n)).toThrow();
  });
  it('keeps Keno reserve exact for 80 funded choices and validates distinct draws', () => {
    const { model, ticket } = quoteDraftDrawTicket('turbo_keno', Array.from({ length: 80 }, (_, i) => ({ choice: i + 1, stake: 5n })));
    const result = quoteHouseAdmission(emptyHouseBook(model), ticket, limits, 0n);
    expect(result.maxGrossPayout).toBe(360n);
    expect(result.requiredLossReserve).toBe(0n);
    expect(() => assertExactHouseReturn({ ...model, drawCount: 80 }, ticket)).toThrow();
    expect(() => assertExactHouseReturn({ ...model, weights: model.weights.map(() => 2n) }, ticket)).toThrow();
  });
  it('rejects invalid draft choices and fractional stake steps', () => {
    expect(() => quoteDraftDrawTicket('heat_vault', [])).toThrow();
    expect(() => quoteDraftDrawTicket('thunder_derby_3d', [{ choice: 7, stake: 5n }])).toThrow();
    expect(() => quoteDraftDrawTicket('starfall_nebula', [{ choice: 1, stake: 1n }])).toThrow();
    expect(() => quoteDraftDrawTicket('crystal_trail', [{ choice: 1, stake: 5n }, { choice: 1, stake: 5n }])).toThrow();
  });
  it.each(SPIN90_MARKETS)('$id returns precisely 90% for all stake steps through 480', (market) => {
    for (let amount = 40; amount <= 480; amount += 40) {
      const { model, ticket } = quoteSpin90Ticket([{ marketId: market.id, amount }]);
      expect(ticket.payouts.reduce((sum, payout) => sum + payout, 0n) * 10n).toBe(BigInt(amount) * 37n * 9n);
      expect(() => assertExactHouseReturn(model, ticket)).not.toThrow();
    }
  });
  it('proves proposed Dice over all 36 elementary outcomes, not 11 equiprobable sums', () => {
    const { ticket } = quoteDice90Ticket(35n);
    expect(ticket.payouts.filter((amount) => amount === 54n)).toHaveLength(21);
    expect(ticket.payouts.reduce((sum, payout) => sum + payout, 0n) * 10n).toBe(35n * 36n * 9n);
    expect(() => quoteDice90Ticket(40n)).toThrow();
  });
  it('proves Number exact-match proposal has equal return at boundaries and middle', () => {
    for (let guess = 1; guess <= 100; guess++) {
      const { ticket } = quoteNumber90Ticket(20n, guess);
      expect(ticket.payouts.reduce((sum, payout) => sum + payout, 0n)).toBe(1_800n);
    }
    expect(() => quoteNumber90Ticket(20n, 0)).toThrow();
    expect(() => quoteNumber90Ticket(20n, 101)).toThrow();
    expect(() => quoteNumber90Ticket(MAX_UNITS, 1)).toThrow();
  });
  it('reserves 1292 against a 40 exact-number ticket; stake escrow covers the other 40', () => {
    const { model, ticket } = quoteSpin90Ticket([{ marketId: 'number:7', amount: 40 }]);
    const result = quoteHouseAdmission(emptyHouseBook(model), ticket, limits, 0n);
    expect(result.requiredLossReserve).toBe(1_292n);
    expect(result.maxGrossPayout).toBe(1_332n);
    expect(result.escrowPlusReserve).toBe(1_332n);
  });
  it('counts overlapping markets together for the same outcome', () => {
    const { model, ticket } = quoteSpin90Ticket([{ marketId: 'number:7', amount: 40 }, { marketId: 'red', amount: 40 }]);
    const result = quoteHouseAdmission(emptyHouseBook(model), ticket, limits, 0n);
    expect(result.maxGrossPayout).toBe(1_406n);
    expect(result.requiredLossReserve).toBe(1_326n);
  });
  it('does not treat many users on the same number as independent risk', () => {
    const { model, ticket } = quoteSpin90Ticket([{ marketId: 'number:7', amount: 40 }]);
    const first = quoteHouseAdmission(emptyHouseBook(model), ticket, { ...limits, maxRoundLoss: 2_000n }, 0n);
    expect(() => quoteHouseAdmission(first.book, ticket, { ...limits, maxRoundLoss: 2_000n }, 0n)).toThrow('exposure');
  });
  it('balanced bets can reduce net exposure without eliminating the gross payout cap', () => {
    const model = buildHouseModel('spin_win', SPIN90_RULES_ID);
    let book = emptyHouseBook(model);
    let result;
    for (let number = 0; number < 37; number++) {
      result = quoteHouseAdmission(book, quoteSpin90Ticket([{ marketId: `number:${number}`, amount: 40 }]).ticket, limits, 0n);
      book = result.book;
    }
    expect(result?.requiredLossReserve).toBe(0n);
    expect(result?.maxGrossPayout).toBe(1_332n);
    expect(book.stake).toBe(1_480n);
    expect(() => quoteHouseAdmission(book, quoteSpin90Ticket([{ marketId: 'red', amount: 40 }]).ticket,
      { ...limits, maxRoundPayout: 1_332n }, 0n)).toThrow('exposure');
  });
  it.each([
    { backedCapital: 0n }, { backedCapital: 1_291n }, { maxRoundLoss: 1_291n },
    { maxRoundPayout: 1_331n }, { backedCapital: 1_300n, otherRoundLossReserves: 9n },
    { maxTicketStake: 39n }, { maxUserRoundStake: 39n }, { otherRoundLossReserves: -1n },
  ])('rejects unfunded or out-of-limit admission %#', (overrides) => {
    const { model, ticket } = quoteSpin90Ticket([{ marketId: 'number:7', amount: 40 }]);
    expect(() => quoteHouseAdmission(emptyHouseBook(model), ticket, { ...limits, ...overrides }, 0n)).toThrow();
  });
  it('accepts an exact reserve boundary and rejects a stale second admission after rechecking', () => {
    const { model, ticket } = quoteSpin90Ticket([{ marketId: 'number:7', amount: 40 }]);
    const exact = { ...limits, backedCapital: 1_292n };
    const first = quoteHouseAdmission(emptyHouseBook(model), ticket, exact, 0n);
    expect(first.requiredLossReserve).toBe(1_292n);
    // This proves calculation semantics, NOT database concurrency. The live
    // adapter must reload first.book and all reserves under the treasury lock.
    expect(() => quoteHouseAdmission(first.book, ticket, exact, 0n)).toThrow();
  });
  it('enforces user aggregate limits across multiple tickets', () => {
    const { model, ticket } = quoteSpin90Ticket([{ marketId: 'red', amount: 40 }]);
    const first = quoteHouseAdmission(emptyHouseBook(model), ticket, limits, 0n);
    expect(() => quoteHouseAdmission(first.book, ticket, { ...limits, maxUserRoundStake: 40n }, 40n)).toThrow('Stake limit');
  });
  it('rejects forged payout vectors, weights, rules and corrupted books', () => {
    const { model, ticket } = quoteSpin90Ticket([{ marketId: 'number:7', amount: 40 }]);
    expect(() => assertExactHouseReturn(model, { ...ticket, payouts: ticket.payouts.map((value) => value + 1n) })).toThrow();
    expect(() => assertExactHouseReturn({ ...model, weights: [1n] }, ticket)).toThrow();
    expect(() => assertExactHouseReturn({ ...model, weights: model.weights.map(() => 0n) }, ticket)).toThrow();
    expect(() => assertExactHouseReturn(model, { ...ticket, rulesId: 'other' })).toThrow();
    expect(() => quoteHouseAdmission({ ...emptyHouseBook(model), stake: 100n }, ticket, limits, 0n)).toThrow();
    expect(() => quoteHouseAdmission({ ...emptyHouseBook(model), payouts: ticket.payouts }, ticket, limits, 0n)).toThrow();
  });
  it('does not mutate inputs on acceptance or refusal', () => {
    const { model, ticket } = quoteSpin90Ticket([{ marketId: 'red', amount: 40 }]);
    const book = emptyHouseBook(model);
    const before = structuredClone({ book, ticket, limits });
    quoteHouseAdmission(book, ticket, limits, 0n);
    expect(() => quoteHouseAdmission(book, ticket, { ...limits, backedCapital: 0n }, 0n)).toThrow();
    expect({ book, ticket, limits }).toEqual(before);
  });
  it('settles every Spin outcome from the same ticket with the proven return', () => {
    const { model, ticket } = quoteSpin90Ticket([{ marketId: 'number:7', amount: 40 }]);
    const results = model.outcomes.map((outcome) => settleHouseTicket(model, ticket, {
      gameKey: model.gameKey, rulesId: model.rulesId, outcomes: [outcome],
    }));
    expect(results.reduce((sum, result) => sum + result.houseGrossResult, 0n)).toBe(148n);
    expect(results[7].houseGrossResult).toBe(-1_292n);
  });
  it('samples one durable-result candidate with no economic inputs and settles all Keno hits', () => {
    const { model, ticket } = quoteDraftDrawTicket('turbo_keno', Array.from({ length: 80 }, (_, i) => ({ choice: i + 1, stake: 5n })));
    for (let i = 0; i < 10; i++) {
      const result = generateRoundOutcome(model.gameKey, model.rulesId);
      expect(result.outcomes).toHaveLength(20);
      expect(new Set(result.outcomes).size).toBe(20);
      expect(settleHouseTicket(model, ticket, result).payout).toBe(360n);
    }
    const valid = generateRoundOutcome(model.gameKey, model.rulesId);
    expect(() => settleHouseTicket(model, ticket, { ...valid, outcomes: Array(20).fill('1') })).toThrow();
    expect(() => settleHouseTicket(model, ticket, { ...valid, rulesId: 'different' })).toThrow();
    expect(() => settleHouseTicket(model, ticket, { ...valid, outcomes: valid.outcomes.slice(1) })).toThrow();
  });
});

describe('public and private round timing', () => {
  const timing = { anchorMs: 1_000, ...SPIN_ROUND_TIMING };
  it.each([
    [1_000, 0, 'OPEN'], [45_999, 0, 'OPEN'], [46_000, 0, 'REVEAL'],
    [55_999, 0, 'REVEAL'], [56_000, 0, 'RESULT'], [60_999, 0, 'RESULT'], [61_000, 1, 'OPEN'],
  ])('server time %s maps to round %s, %s', (now, sequence, phase) => {
    expect(scheduledRound(Number(now), timing)).toMatchObject({ sequence, phase });
  });
  it('derives missed rounds after a restart without generating replacement results', () => {
    expect(scheduledRound(1_000 + 1_440 * 60_000, timing)).toMatchObject({ sequence: 1_440, phase: 'OPEN' });
  });
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid or pre-start server time %s', (now) => {
    expect(() => scheduledRound(now, timing)).toThrow();
  });
  it('rejects zero-duration and overflowing schedules', () => {
    expect(() => scheduledRound(1_000, { ...timing, bettingMs: 0 })).toThrow();
    expect(() => scheduledRound(Number.MAX_SAFE_INTEGER, timing)).toThrow();
  });
  it('closes at the exact boundary even if a scheduler has not updated OPEN yet', () => {
    const round = { id: 'round-1', status: 'OPEN', opensAt: 1_000, closesAt: 46_000 };
    expect(() => assertRoundOpen(round, 'round-1', 45_999)).not.toThrow();
    expect(() => assertRoundOpen(round, 'round-1', 46_000)).toThrow();
    expect(() => assertRoundOpen(round, 'round-2', 2_000)).toThrow();
    expect(() => assertRoundOpen({ ...round, status: 'PAUSED' }, 'round-1', 2_000)).toThrow();
    expect(() => assertRoundOpen(round, 'round-1', 999)).toThrow();
  });
});
