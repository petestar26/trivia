import { expect, it } from 'vitest';
import { memberGameDestination, memberGameLabel, type MemberGame } from './member-game-catalog';

it.each([
  ['number_challenge', '/games/number-challenge'],
  ['sky_crash', '/games/sky-crash'],
  ['thunder_derby_3d', '/games/thunder-derby'],
  ['neon_hounds_3d', '/games/dog-racing'],
  ['virtual_football_3d', '/games/virtual-football'],
  ['dice', '/games/dice'],
  ['crash_point', '/games/crash-point'],
  ['turbo_keno', '/games/turbo-keno'],
])('routes %s to group rules without releasing its old solo practice', (key, _route) => {
  const game = { key, catalogStatus: 'COMING_SOON', isActive: false } as MemberGame;
  for (const practiceAvailable of [undefined, false]) {
    expect(memberGameDestination({ ...game, practiceAvailable })).toBe(
      '/play-together?game=' + key
    );
    expect(memberGameLabel({ ...game, practiceAvailable })).toBe('Group play');
  }
  expect(memberGameDestination({ ...game, practiceAvailable: true })).toBe(
    '/play-together?game=' + key
  );
  expect(memberGameLabel({ ...game, practiceAvailable: true })).toBe('Group play');
  expect(
    memberGameDestination({ ...game, practiceAvailable: true, catalogStatus: 'RETIRED' })
  ).toBeUndefined();
  for (const practiceAvailable of [undefined, false, true]) {
    expect(memberGameLabel({ ...game, practiceAvailable, catalogStatus: 'RETIRED' })).toBe(
      'Unavailable'
    );
  }
});

it.each([
  'turbo_circuit_3d',
  'starfall_nebula',
  'jungle_dash_3d',
  'crystal_trail',
  'heat_vault',
  'strait_rush',
])('keeps genuine future game %s coming soon without offering entry', (key) => {
  const game = { key, catalogStatus: 'COMING_SOON', isActive: false } as MemberGame;
  expect(memberGameLabel(game)).toBe('Coming soon');
  expect(memberGameDestination(game)).toBeUndefined();
});
