import { describe, expect, it, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import type * as Crypto from 'node:crypto';
import {
  SPIN_MARKETS,
  SPIN_RULES_ID,
  SPIN_WHEEL,
  parseSpinBets,
  settleSpinBets,
} from '@socialplay/shared';
import { generateSpinWinResult } from './spin-win-engine.js';
import { fingerprintPlay } from './game-fingerprint.js';
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof Crypto>()),
  randomInt: vi.fn(() => 0),
}));
const rules = { rulesId: SPIN_RULES_ID };
const bets = [
  { marketId: 'number:0', amount: 10 },
  { marketId: 'red', amount: 5 },
];
describe('Single-zero Spin Win', () => {
  it('has exactly one pocket for every number 0–36', () => {
    expect([...SPIN_WHEEL].sort((a, b) => a - b)).toEqual(Array.from({ length: 37 }, (_, i) => i));
  });
  it.each(SPIN_MARKETS)('$id has correct coverage and exact expected return', (market) => {
    let wins = 0,
      returned = 0;
    for (let n = 0; n < 37; n++) {
      const result = settleSpinBets([{ marketId: market.id, amount: 10 }], n);
      if (result.payout) wins++;
      returned += result.payout;
      expect(result.payout).toBe(market.numbers.includes(n) ? market.grossMultiplier * 10 : 0);
    }
    expect(wins).toBe(market.numbers.length);
    expect(returned).toBe(360);
  });
  it('zero loses every outside, sector and dozen bet', () => {
    expect(
      settleSpinBets(
        SPIN_MARKETS.slice(37).map((m) => ({ marketId: m.id, amount: 1 })),
        0
      ).payout
    ).toBe(0);
  });
  it('adds overlapping wins and returns gross payout including stake', () => {
    expect(
      settleSpinBets(
        [
          { marketId: 'number:1', amount: 10 },
          { marketId: 'red', amount: 5 },
        ],
        1
      )
    ).toMatchObject({ stake: 15, payout: 370, net: 355 });
  });
  it('uses a server crypto draw in [0,37)', () => {
    expect(generateSpinWinResult(15, rules, bets)).toMatchObject({
      rewardAmount: 360,
      result: { number: 0 },
    });
    expect(randomInt).toHaveBeenCalledWith(37);
  });
  it.each([null, {}, { outcomes: [] }, { rulesId: 'unknown' }])(
    'rejects unsupported rules %j',
    (value) => {
      expect(() => generateSpinWinResult(15, value, bets)).toThrow('rules');
    }
  );
  it.each([
    [],
    null,
    [{ marketId: 'red', amount: 0 }],
    [{ marketId: 'red', amount: -1 }],
    [{ marketId: 'red', amount: 1.5 }],
    [{ marketId: 'red', amount: '1' }],
    [{ marketId: 'red', amount: Infinity }],
    [{ marketId: 'number:37', amount: 1 }],
    [
      { marketId: 'red', amount: 1 },
      { marketId: 'red', amount: 1 },
    ],
    [
      { marketId: 'red', amount: 1_000_000 },
      { marketId: 'black', amount: 1 },
    ],
  ])('rejects malformed tickets %j', (value) => {
    expect(() => parseSpinBets(value)).toThrow();
  });
  it('rejects an aggregate stake mismatch before settlement', () => {
    expect(() => generateSpinWinResult(1, rules, bets)).toThrow('stake');
  });
  it('canonicalizes line order but binds replay to market and amount', () => {
    const hash = (input: unknown) =>
      fingerprintPlay({
        gameKey: 'spin_win',
        rulesVersion: 1,
        stake: 15,
        selections: { bets: parseSpinBets(input) },
      });
    expect(hash(bets)).toBe(hash([...bets].reverse()));
    expect(hash(bets)).not.toBe(
      hash([
        { marketId: 'number:1', amount: 10 },
        { marketId: 'red', amount: 5 },
      ])
    );
    expect(hash(bets)).not.toBe(
      hash([
        { marketId: 'number:0', amount: 5 },
        { marketId: 'red', amount: 10 },
      ])
    );
  });
});
