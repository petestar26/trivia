import { expect, it } from 'vitest';
import { NUMBER_TIMED_RULES_ID, parseNumberTimedEntry } from './number-timed.js';
const entry = {
  requestId: 'abcdefghijklmnop',
  roundId: 'number-v2:29862600',
  guess: 50,
  rulesId: NUMBER_TIMED_RULES_ID,
};
it('requires the shared round and exact v2 payload', () => {
  expect(parseNumberTimedEntry(entry)).toEqual(entry);
  for (const bad of [
    { ...entry, roundId: undefined },
    { ...entry, rulesId: 'number-challenge-practice-v1' },
    { ...entry, guess: 0 },
    { ...entry, guess: 101 },
    { ...entry, guess: 50.5 },
    { ...entry, target: 50 },
    { ...entry, roundId: 'evil' },
    { ...entry, guess: '50' },
  ])
    expect(() => parseNumberTimedEntry(bad)).toThrow();
});
