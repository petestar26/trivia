import { expect, it } from 'vitest';
import {
  DERBY_MARKETS,
  derbyOddsCents,
  derbyWins,
  parseDerbyEntry,
  type DerbyField,
} from '@socialplay/shared';
import { derbyCommitment, derbyOrder, derbyPositions } from './math.js';
function* permutations(a: number[]): Generator<number[]> {
  if (a.length === 0) {
    yield [];
    return;
  }
  for (let i = 0; i < a.length; i++)
    for (const tail of permutations(a.filter((_, j) => i !== j))) yield [a[i], ...tail];
}
it.each([6, 8] as DerbyField[])(
  'all markets have exactly 90%% gross expectation for %i runners',
  (field) => {
    const totals = Object.fromEntries(DERBY_MARKETS.map((m) => [m, 0]));
    let n = 0;
    for (const order of permutations(Array.from({ length: field }, (_, i) => i + 1))) {
      n++;
      for (const m of DERBY_MARKETS) {
        const picks =
          m === 'TRIFECTA'
            ? [1, 2, 3]
            : m === 'PERFECTA' || m === 'QUINELLA'
              ? [1, 2]
              : m === 'TOP3' || m === 'WIN'
                ? [1]
                : [];
        if (derbyWins(m, picks, order)) totals[m]++;
      }
    }
    for (const m of DERBY_MARKETS) expect(totals[m] * derbyOddsCents(field, m)).toBe(n * 90);
  }
);
it('distinguishes ordered, unordered and place selections', () => {
  const order = [2, 1, 3, 4, 5, 6];
  expect(derbyWins('PERFECTA', [1, 2], order)).toBe(false);
  expect(derbyWins('QUINELLA', [1, 2], order)).toBe(true);
  expect(derbyWins('TOP3', [3], order)).toBe(true);
  expect(derbyWins('TOP3', [4], order)).toBe(false);
});
it('validates stakes, fields and distinct picks; canonicalizes unordered selections', () => {
  expect(parseDerbyEntry(6, 'QUINELLA', [3, 1], 10).picks).toEqual([1, 3]);
  for (const args of [
    [7, 'WIN', [1], 10],
    [6, 'NOPE', [], 10],
    [6, 'PERFECTA', [1, 1], 10],
    [6, 'WIN', [7], 10],
    [6, 'WIN', [1], 10.5],
    [6, 'EVEN', [1], 10],
    [8, 'WIN', [1], 501],
    [8, 'WIN', [1], NaN],
  ])
    expect(() => parseDerbyEntry(...(args as [unknown, unknown, unknown, unknown]))).toThrow();
});
it('produces deterministic complete permutations and round-bound commitments', () => {
  for (const n of [6, 8] as const) {
    const seed = 'a'.repeat(64),
      order = derbyOrder(seed, n);
    expect([...order].sort()).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(derbyOrder(seed, n)).toEqual(order);
    expect(derbyPositions(order, -1, seed)).toEqual(Array(n).fill(0));
  }
  expect(derbyCommitment('one', 'a'.repeat(64))).not.toBe(derbyCommitment('two', 'a'.repeat(64)));
});

it('race progress moves forward and reaches the committed finishing order', () => {
  for (const field of [6, 8] as const)
    for (let n = 0; n < 8; n++) {
      const seed = n.toString(16).padStart(64, '0'),
        order = derbyOrder(seed, field);
      let previous = Array(field).fill(0);
      for (let elapsed = 0; elapsed <= 45000; elapsed += 250) {
        const positions = derbyPositions(order, elapsed, seed);
        positions.forEach((p, i) => {
          expect(p).toBeGreaterThanOrEqual(previous[i]);
          expect(p).toBeLessThanOrEqual(1.06);
        });
        previous = positions;
      }
      expect(
        previous
          .map((p, i) => ({ p, horse: i + 1 }))
          .sort((a, b) => b.p - a.p)
          .map((p) => p.horse)
      ).toEqual(order);
    }
});
