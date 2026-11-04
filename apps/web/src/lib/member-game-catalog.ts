import type { GameCatalogEntry } from './api';
export type MemberGame = GameCatalogEntry;

const MEMBER_GAME_ORDER = [
  'spin_win',
  'turbo_keno',
  'sky_crash',
  'thunder_derby_3d',
  'virtual_football_3d',
  'neon_hounds_3d',
  'crash_point',
  'roulette_keno',
  'dice',
  'number_challenge',
  'lucky_six',
] as const;
const memberGameRanks = new Map<string, number>(
  MEMBER_GAME_ORDER.map((key, index) => [key, index])
);

/** Keep discovery lists consistent; unlisted games follow the requested collection. */
export function compareMemberGameKeys(a: string, b: string): number {
  return (
    (memberGameRanks.get(a) ?? MEMBER_GAME_ORDER.length) -
    (memberGameRanks.get(b) ?? MEMBER_GAME_ORDER.length)
  );
}

const MEMBER_GAME_NAMES: Record<string, string> = {
  lucky_six: 'Lucky Six',
  roulette_keno: 'Roulette Keno',
  virtual_football_3d: 'Football',
  thunder_derby_3d: 'Derby',
  neon_hounds_3d: 'Dog Racing',
};

/** Display names are independent of stable catalog keys and saved game records. */
export function memberGameName(game: Pick<MemberGame, 'key' | 'name'>): string {
  return MEMBER_GAME_NAMES[game.key] ?? game.name;
}

export const PRACTICE_ROUTES: Record<string, string> = {
  lucky_six: '/games/lucky-six',
  roulette_keno: '/games/roulette-keno',
  number_challenge: '/games/number-challenge',
  sky_crash: '/games/sky-crash',
  thunder_derby_3d: '/games/thunder-derby',
  neon_hounds_3d: '/games/dog-racing',
  virtual_football_3d: '/games/virtual-football',
  crash_point: '/games/crash-point',
  dice: '/games/dice',
  spin_win: '/games/spin-win',
  turbo_keno: '/games/turbo-keno',
};
/** Keep their cards visible, but require server availability before offering entry. */
const GATED_PRACTICE = [
  'lucky_six',
  'roulette_keno',
  'number_challenge',
  'sky_crash',
  'thunder_derby_3d',
  'neon_hounds_3d',
  'virtual_football_3d',
  'crash_point',
  'dice',
  'spin_win',
  'turbo_keno',
];
/** Unfinished games stay closed even when an older API marks them available. */
export const COMING_SOON_GAME_KEYS = [
  'trivia',
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
