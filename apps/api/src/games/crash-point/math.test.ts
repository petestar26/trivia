import { expect, it } from 'vitest';
import { crashCommitment, crashDraw, crashOutcome } from './math.js';
import { crashCrossingMs, crashMultiplier, parseCrashEntry } from '@socialplay/shared';
it('commits to round identity and a reproducible bounded outcome', () => {
  const seed = 'a'.repeat(64);
  expect(crashCommitment('one', seed)).toHaveLength(64);
  expect(crashCommitment('one', seed)).not.toBe(crashCommitment('two', seed));
  expect(crashOutcome(seed)).toBe(crashOutcome(seed));
  for (let i = 0; i < 1000; i++) {
    const draw = crashDraw(String(i));
    expect(draw).toBeGreaterThanOrEqual(1);
    expect(draw).toBeLessThanOrEqual(1000000000);
    expect(crashOutcome(String(i))).toBeGreaterThanOrEqual(100);
    expect(crashOutcome(String(i))).toBeLessThanOrEqual(2001);
  }
});
it('crossing is the first millisecond that reaches a target and caps cashout at 20x', () => {
  for (const target of [101, 150, 200, 1000, 2000]) {
    const ms = crashCrossingMs(target);
    expect(crashMultiplier(ms)).toBeGreaterThanOrEqual(target);
    expect(crashMultiplier(ms - 1)).toBeLessThan(target);
  }
  expect(crashMultiplier(-10)).toBe(100);
  expect(crashMultiplier(60000)).toBe(2000);
});
it('validates immutable amounts and targets without coercion', () => {
  expect(parseCrashEntry(25, 200)).toEqual({ stake: 25, autoCents: 200 });
  expect(parseCrashEntry(10, null)).toEqual({ stake: 10, autoCents: null });
  for (const amount of [9, 501, 10.5, '25', NaN, Infinity])
    expect(() => parseCrashEntry(amount, null)).toThrow();
  for (const target of [100, 2001, 150.5, '200', undefined])
    expect(() => parseCrashEntry(25, target)).toThrow();
});
