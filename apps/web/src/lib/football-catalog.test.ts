import { expect, it } from 'vitest';
import { memberGameDestination, memberGameLabel } from './member-game-catalog';
import type { GameCatalogEntry } from './api';

const game = {
  key: 'virtual_football_3d',
  isActive: false,
  catalogStatus: 'COMING_SOON',
} as GameCatalogEntry;

it('does not release Virtual Football through artwork, a catalog row or its route alone', () => {
  for (const practiceAvailable of [false, undefined]) {
    expect(memberGameDestination({ ...game, practiceAvailable })).toBeUndefined();
    expect(memberGameLabel({ ...game, practiceAvailable })).toBe('Coming soon');
  }
  // Even an active, AVAILABLE catalog row is not enough: the server must report practice available.
  expect(
    memberGameDestination({
      ...game,
      isActive: true,
      catalogStatus: 'AVAILABLE',
      practiceAvailable: false,
    })
  ).toBeUndefined();
  expect(memberGameDestination({ ...game, practiceAvailable: true })).toBe(
    '/games/virtual-football'
  );
  expect(memberGameLabel({ ...game, practiceAvailable: true })).toBe('Free practice');
  expect(
    memberGameDestination({ ...game, practiceAvailable: true, catalogStatus: 'RETIRED' })
  ).toBeUndefined();
});
