import { expect, it } from 'vitest';
import { memberGameDestination, memberGameLabel, type MemberGame } from './member-game-catalog';
const game = {
  key: 'virtual_football_3d',
  catalogStatus: 'COMING_SOON',
  isActive: false,
} as MemberGame;
it.each([undefined, false, true])(
  'opens group rules without relying on old solo availability %s',
  (practiceAvailable) => {
    expect(memberGameDestination({ ...game, practiceAvailable })).toBe(
      '/play-together?game=virtual_football_3d'
    );
    expect(memberGameLabel({ ...game, practiceAvailable })).toBe('Group play');
    // Retirement still prevents discovery; actual entry requires the group policy.
    expect(
      memberGameDestination({ ...game, practiceAvailable, catalogStatus: 'RETIRED' })
    ).toBeUndefined();
    expect(memberGameLabel({ ...game, practiceAvailable, catalogStatus: 'RETIRED' })).toBe(
      'Unavailable'
    );
  }
);
