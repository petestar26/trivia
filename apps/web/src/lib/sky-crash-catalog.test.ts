import { expect, it } from 'vitest';
import { memberGameDestination, memberGameLabel, type MemberGame } from './member-game-catalog';
const sky = { key: 'sky_crash', catalogStatus: 'COMING_SOON', isActive: false } as MemberGame;
it('requires explicit server practice availability for the new game link', () => {
  for (const practiceAvailable of [undefined, false]) {
    expect(memberGameDestination({ ...sky, practiceAvailable })).toBeUndefined();
    expect(memberGameLabel({ ...sky, practiceAvailable })).toBe('Coming soon');
  }
  expect(memberGameDestination({ ...sky, practiceAvailable: true })).toBe('/games/sky-crash');
  expect(
    memberGameDestination({ ...sky, practiceAvailable: true, catalogStatus: 'RETIRED' })
  ).toBeUndefined();
});
