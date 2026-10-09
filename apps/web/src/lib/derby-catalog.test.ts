import { expect, it } from 'vitest';
import { memberGameDestination, memberGameLabel } from './member-game-catalog';
import type { GameCatalogEntry } from './api';
const game = {
  key: 'thunder_derby_3d',
  isActive: false,
  catalogStatus: 'COMING_SOON',
} as GameCatalogEntry;
it('does not release Derby through artwork or a catalog edit alone', () => {
  for (const practiceAvailable of [false, undefined]) {
    expect(memberGameDestination({ ...game, practiceAvailable })).toBeUndefined();
    expect(memberGameLabel({ ...game, practiceAvailable })).toBe('Coming soon');
  }
  expect(memberGameDestination({ ...game, practiceAvailable: true })).toBe('/games/thunder-derby');
  expect(
    memberGameDestination({ ...game, practiceAvailable: true, catalogStatus: 'RETIRED' })
  ).toBeUndefined();
});
