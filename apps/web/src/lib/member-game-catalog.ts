import type { GameCatalogEntry } from './api';
export type MemberGame = GameCatalogEntry;

export const PRACTICE_ROUTES: Record<string, string> = {
  dice: '/games/dice',
  spin_win: '/games/spin-win',
  turbo_keno: '/games/turbo-keno',
};
const RELEASED_ROUTES: Record<string, string> = {
  trivia: '/games/trivia',
  number_challenge: '/games/number-challenge',
};

/** A decorative card never enables an unreleased game or bypasses server availability. */
export function memberGameDestination(game: MemberGame): string | undefined {
  if (game.catalogStatus === 'RETIRED') return undefined;
  return (
    PRACTICE_ROUTES[game.key] ||
    (game.isActive && game.catalogStatus === 'AVAILABLE' ? RELEASED_ROUTES[game.key] : undefined)
  );
}

export function memberGameLabel(game: MemberGame) {
  if (PRACTICE_ROUTES[game.key]) return 'Free practice';
  if (memberGameDestination(game)) return 'Free game';
  return game.catalogStatus === 'COMING_SOON' ? 'Coming soon' : 'Unavailable';
}
