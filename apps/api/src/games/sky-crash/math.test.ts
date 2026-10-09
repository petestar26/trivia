import { expect, it } from 'vitest';
import { skyCrashCommitment, skyCrashDraw, skyCrashOutcome } from './math.js';
import { skyCrashCrossingMs, skyCrashMultiplier, parseSkyCrashEntry } from '@socialplay/shared';
it('commits to round identity and a reproducible bounded outcome', () => {
  const seed = 'a'.repeat(64);
  expect(skyCrashCommitment('one', seed)).toHaveLength(64);
  expect(skyCrashCommitment('one', seed)).not.toBe(skyCrashCommitment('two', seed));
  expect(skyCrashOutcome(seed)).toBe(skyCrashOutcome(seed));
  for (let i = 0; i < 1000; i++) {
    const draw = skyCrashDraw(String(i));
    expect(draw).toBeGreaterThanOrEqual(1);
    expect(draw).toBeLessThanOrEqual(1000000000);
    expect(skyCrashOutcome(String(i))).toBeGreaterThanOrEqual(100);
    expect(skyCrashOutcome(String(i))).toBeLessThanOrEqual(2001);
  }
});
it('crossing is the first millisecond that reaches a target and caps cashout at 20x', () => {
  for (const target of [101, 150, 200, 1000, 2000]) {
    const ms = skyCrashCrossingMs(target);
    expect(skyCrashMultiplier(ms)).toBeGreaterThanOrEqual(target);
    expect(skyCrashMultiplier(ms - 1)).toBeLessThan(target);
  }
  expect(skyCrashMultiplier(-10)).toBe(100);
  expect(skyCrashMultiplier(60000)).toBe(2000);
});
it('validates immutable amounts and targets without coercion', () => {
  expect(parseSkyCrashEntry(25, 200)).toEqual({ stake: 25, autoCents: 200 });
  expect(parseSkyCrashEntry(10, null)).toEqual({ stake: 10, autoCents: null });
  for (const amount of [9, 501, 10.5, '25', NaN, Infinity])
    expect(() => parseSkyCrashEntry(amount, null)).toThrow();
  for (const target of [100, 2001, 150.5, '200', undefined])
    expect(() => parseSkyCrashEntry(25, target)).toThrow();
});
