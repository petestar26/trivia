import type { GameCatalogEntry } from './api';
export type MemberGame = GameCatalogEntry;

const MEMBER_GAME_NAMES: Record<string, string> = {
  virtual_football_3d: 'Football',
  thunder_derby_3d: 'Derby',
};

/** Display names are independent of stable catalog keys and saved game records. */
export function memberGameName(game: Pick<MemberGame, 'key' | 'name'>): string {
  return MEMBER_GAME_NAMES[game.key] ?? game.name;
}

export const PRACTICE_ROUTES: Record<string, string> = {
  number_challenge: '/games/number-challenge',
  sky_crash: '/games/sky-crash',
  thunder_derby_3d: '/games/thunder-derby',
  virtual_football_3d: '/games/virtual-football',
  crash_point: '/games/crash-point',
  dice: '/games/dice',
  spin_win: '/games/spin-win',
  turbo_keno: '/games/turbo-keno',
};
/** Keep their cards visible, but require server availability before offering entry. */
const GATED_PRACTICE = [
  'number_challenge',
  'sky_crash',
  'thunder_derby_3d',
  'virtual_football_3d',
  'crash_point',
  'dice',
  'spin_win',
  'turbo_keno',
];
/** Unfinished games stay closed even when an older API marks them available. */
export const COMING_SOON_GAME_KEYS = [
  'trivia',
  'neon_hounds_3d',
  'turbo_circuit_3d',
  'starfall_nebula',
  'jungle_dash_3d',
  'crystal_trail',
  'heat_vault',
  'strait_rush',
] as const;
const comingSoonGames = new Set<string>(COMING_SOON_GAME_KEYS);

/** A decorative card never enables an unreleased game or bypasses server availability. */
export function memberGameDestination(game: MemberGame): string | undefined {
  if (game.catalogStatus === 'RETIRED' || comingSoonGames.has(game.key)) return undefined;
  if (GATED_PRACTICE.includes(game.key) && game.practiceAvailable !== true)
    return undefined;
  return PRACTICE_ROUTES[game.key];
}

export function memberGameLabel(game: MemberGame) {
  if (game.catalogStatus === 'RETIRED') return 'Unavailable';
  if (comingSoonGames.has(game.key)) return 'Coming soon';
  if (GATED_PRACTICE.includes(game.key) && game.practiceAvailable !== true)
    return 'Temporarily unavailable';
  if (PRACTICE_ROUTES[game.key]) return 'Free practice';
  return game.catalogStatus === 'COMING_SOON' ? 'Coming soon' : 'Unavailable';
}

/** Unavailable implemented games must not be presented as future releases. */
export function memberGameUnavailableDescription(game: MemberGame) {
  return memberGameLabel(game) === 'Coming soon'
    ? 'A new experience is on its way.'
    : 'This game is currently unavailable.';
}
