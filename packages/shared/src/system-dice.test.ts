import { expect, it } from 'vitest';
import { parseDiceStake, settleDicePractice } from './system-dice.js';
it('proves exact 90% gross return over all 36 outcomes at every accepted stake', () => {
  for (let stake = 35; stake <= 490; stake += 35) {
    let total = 0, winners = 0;
    for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) {
      const payout = settleDicePractice(stake, [a, b]);
      total += payout; if (payout) winners++;
      expect(Number.isSafeInteger(payout)).toBe(true);
    }
    expect(winners).toBe(21); expect(total * 10).toBe(stake * 36 * 9);
  }
});
it('refuses invalid stakes and malformed dice instead of rounding', () => {
  for (const stake of [0, -35, 34, 36, 50, 70.5, 525, NaN, Infinity, '35', null]) {
    expect(() => parseDiceStake(stake)).toThrow();
  }
  for (const roll of [[0, 6], [7, 1], [1.5, 6], [6], [6, 6, 6]]) {
    expect(() => settleDicePractice(35, roll)).toThrow();
  }
  expect(settleDicePractice(35, [1, 6])).toBe(54);
  expect(settleDicePractice(35, [1, 5])).toBe(0);
});
