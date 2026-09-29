import { describe, expect, it } from 'vitest';
import { allocateFunding, splitObligation, splitPayout } from '../economy/coin-allocator.js';

const at = (day: number) => new Date(Date.UTC(2026, 0, day));
const byLot = (shares: readonly { lotId: string; amount: number }[]) =>
  Object.fromEntries(shares.map(({ lotId, amount }) => [lotId, amount]));

/** Opus 5.5 §§03, 08, 10: pure allocator contract. These tests intentionally
 * fail against 7b84d99, which has no pure allocator and still funds FIFO. */
describe('Coin allocation contract', () => {
  it('T7/M2: spends restricted before unclassified before withdrawable, independent of lot age', () => {
    const lots = [
      { id: 'W-old', lotClass: 'WITHDRAWABLE' as const, availableAmount: 100, mintedAt: at(1), expiresAt: null },
      { id: 'U-old', lotClass: 'UNCLASSIFIED' as const, availableAmount: 20, mintedAt: at(2), expiresAt: null },
      { id: 'B-late', lotClass: 'RESTRICTED' as const, availableAmount: 30, mintedAt: at(3), expiresAt: at(20) },
      { id: 'B-soon', lotClass: 'RESTRICTED' as const, availableAmount: 10, mintedAt: at(4), expiresAt: at(10) },
    ];
    const before = lots.map((lot) => ({ ...lot }));
    const funded = allocateFunding(lots, 55);
    expect(funded.map((share) => [share.lotId, share.amount])).toEqual([
      ['B-soon', 10], ['B-late', 30], ['U-old', 15],
    ]);
    expect(lots).toEqual(before); // allocator is pure; a failed operation writes nothing
  });

  it('T7/M1/M2/I1/I6: splits 151 proportionally, rounds withdrawable down, and conserves the wallet', () => {
    const bonus = { id: 'B', lotClass: 'RESTRICTED' as const, availableAmount: 50, mintedAt: at(2), expiresAt: null };
    const purchased = { id: 'W', lotClass: 'WITHDRAWABLE' as const, availableAmount: 100, mintedAt: at(1), expiresAt: null };
    const funding = allocateFunding([purchased, bonus], 60);
    expect(byLot(funding)).toEqual({ B: 50, W: 10 });

    const payout = splitPayout(funding, 151);
    expect(byLot(payout)).toEqual({ B: 126, W: 25 });
    expect(payout.reduce((total, share) => total + share.amount, 0)).toBe(151);
    const restrictedAfter = bonus.availableAmount - 50 + 126;
    const withdrawableAfter = purchased.availableAmount - 10 + 25;
    expect([restrictedAfter, withdrawableAfter]).toEqual([126, 115]);
    expect(restrictedAfter + withdrawableAfter).toBe(150 - 60 + 151);
  });

  it('I6/M1: no payout rounding remainder goes to a withdrawable lot', () => {
    const funding = allocateFunding([
      { id: 'B', lotClass: 'RESTRICTED', availableAmount: 2, mintedAt: at(1), expiresAt: null },
      { id: 'W1', lotClass: 'WITHDRAWABLE', availableAmount: 1, mintedAt: at(1), expiresAt: null },
      { id: 'W2', lotClass: 'WITHDRAWABLE', availableAmount: 1, mintedAt: at(1), expiresAt: null },
    ], 4);
    const payout = splitPayout(funding, 3);
    expect(byLot(payout)).toEqual({ B: 3, W1: 0, W2: 0 });
    expect(payout.reduce((total, share) => total + share.amount, 0)).toBe(3);
  });

  it('I6: returns are exact for zero payout and a single funding lot', () => {
    const funding = allocateFunding([
      { id: 'B', lotClass: 'RESTRICTED', availableAmount: 10, mintedAt: at(1), expiresAt: null },
    ], 10);
    expect(splitPayout(funding, 0).reduce((n, s) => n + s.amount, 0)).toBe(0);
    expect(byLot(splitPayout(funding, 19))).toEqual({ B: 19 });
  });

  it('I6: equal restricted payout remainders go to the soonest-expiring lot', () => {
    const funding = allocateFunding([
      { id: 'B-later', lotClass: 'RESTRICTED', availableAmount: 1, mintedAt: at(1), expiresAt: at(20) },
      { id: 'W', lotClass: 'WITHDRAWABLE', availableAmount: 1, mintedAt: at(1), expiresAt: null },
      { id: 'B-sooner', lotClass: 'RESTRICTED', availableAmount: 1, mintedAt: at(3), expiresAt: at(10) },
    ], 3);
    expect(byLot(splitPayout(funding, 1))).toEqual({ 'B-sooner': 1, 'B-later': 0, W: 0 });
  });

  it('I6: an entirely withdrawable stake yields an entirely withdrawable payout', () => {
    const funding = allocateFunding([
      { id: 'W1', lotClass: 'WITHDRAWABLE', availableAmount: 1, mintedAt: at(1), expiresAt: null },
      { id: 'W2', lotClass: 'WITHDRAWABLE', availableAmount: 1, mintedAt: at(2), expiresAt: null },
    ], 2);
    const payout = splitPayout(funding, 3);
    expect(payout.reduce((total, share) => total + share.amount, 0)).toBe(3);
    expect(payout.every((share) => share.lotClass === 'WITHDRAWABLE')).toBe(true);
  });

  it('T8/M10/I7: transfers an outstanding obligation by remaining value, with ceil rounding', () => {
    expect(splitObligation(150, 20, 40)).toEqual({ moved: 75, retained: 75 });
    expect(splitObligation(150, 40, 40)).toEqual({ moved: 150, retained: 0 });
    expect(splitObligation(5, 1, 2)).toEqual({ moved: 3, retained: 2 });
    for (const movedAmount of [1, 2, 3, 20, 39, 40]) {
      const split = splitObligation(150, movedAmount, 40);
      expect(split.moved + split.retained).toBe(150);
      expect(split.moved).toBe(Math.ceil(150 * movedAmount / 40));
    }
  });

  it('I2/I6/I7: rejects over-allocation and invalid amounts before any record can change', () => {
    const lot = { id: 'B', lotClass: 'RESTRICTED' as const, availableAmount: 10, mintedAt: at(1), expiresAt: null };
    expect(() => allocateFunding([lot], 11)).toThrow();
    expect(() => allocateFunding([lot], -1)).toThrow();
    expect(() => splitObligation(10, 11, 10)).toThrow();
    expect(() => splitObligation(10, 1, 0)).toThrow();
    expect(lot.availableAmount).toBe(10);
  });
});
