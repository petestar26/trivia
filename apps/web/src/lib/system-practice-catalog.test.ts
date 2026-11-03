import { expect, it } from 'vitest';
import { memberGameDestination, memberGameLabel, type MemberGame } from './member-game-catalog';

it.each([
  ['dice', '/games/dice'],
  ['crash_point', '/games/crash-point'],
  ['turbo_keno', '/games/turbo-keno'],
])('requires the server to confirm %s practice before offering its route', (key, route) => {
  const game = { key, catalogStatus: 'COMING_SOON', isActive: false } as MemberGame;
  for (const practiceAvailable of [undefined, false]) {
    expect(memberGameDestination({ ...game, practiceAvailable })).toBeUndefined();
    expect(memberGameLabel({ ...game, practiceAvailable })).toBe('Coming soon');
  }
  expect(memberGameDestination({ ...game, practiceAvailable: true })).toBe(route);
  expect(memberGameLabel({ ...game, practiceAvailable: true })).toBe('Free practice');
  expect(memberGameDestination({ ...game, practiceAvailable: true, catalogStatus: 'RETIRED' })).toBeUndefined();
});
