import { expect, it } from 'vitest';
import { NUMBER_RULES_ID, numberScore, parseNumberEntry } from './number-challenge.js';
it('scores every guess-target pair including both edges and all distance boundaries', () => {
  for (let guess = 1; guess <= 100; guess++)
    for (let target = 1; target <= 100; target++) {
      const d = Math.abs(guess - target);
      expect(numberScore(guess, target)).toEqual({
        away: d,
        score: d === 0 ? 100 : d === 1 ? 60 : d <= 5 ? 40 : d <= 10 ? 20 : 0,
      });
    }
});
it('refuses fractions, coercion, out-of-range values and extra client authority', () => {
  const good = { requestId: 'abcdefghijklmnop', guess: 50, rulesId: NUMBER_RULES_ID };
  expect(parseNumberEntry(good)).toEqual(good);
  for (const guess of [0, 101, 1.2, NaN, Infinity, '50', null, undefined])
    expect(() => parseNumberEntry({ ...good, guess })).toThrow();
  for (const bad of [
    { ...good, target: 50 },
    { ...good, score: 100 },
    { ...good, userId: 'other' },
    { ...good, rulesId: 'old' },
    { ...good, requestId: 'short' },
    [],
    null,
  ])
    expect(() => parseNumberEntry(bad)).toThrow();
});
