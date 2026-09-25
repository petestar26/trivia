import { prisma } from '@socialplay/database';

export type GameModeValue = 'WAGER' | 'BONUS';
export type GameFamilyValue = 'INSTANT' | 'SCHEDULED_DRAW' | 'SCHEDULED_RACE';
export type GameCatalogStatusValue = 'AVAILABLE' | 'COMING_SOON' | 'RETIRED';
export type GameCurrencyValue = 'COINS' | 'GAME_POINTS';

export interface GameCatalogItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
  minBet: number;
  maxBet: number;
  isActive: boolean;
  mode: GameModeValue;
  family: GameFamilyValue;
  catalogStatus: GameCatalogStatusValue;
  wagerCurrency: GameCurrencyValue | null;
  rewardCurrency: GameCurrencyValue;
  currentRulesVersion: number | null;
}

const PUBLIC_CATALOG_STATUSES: GameCatalogStatusValue[] = ['AVAILABLE', 'COMING_SOON'];

// The compliance-approved public catalog: exactly these 13 keys, each once,
// per the seed migration (20260918020000_casino_foundation_seed) that
// established them. This is an ALLOWLIST, not a denylist of the retired
// `lucky_spin` row — a game row is never public just because its
// catalogStatus happens to be AVAILABLE/COMING_SOON in the database. A row
// that is AVAILABLE/COMING_SOON but NOT in this list (a rogue insert, a
// migration mistake, a future draft row someone forgot to keep DRAFT) never
// reaches a player. Adding a 14th approved game means adding its key here
// AND shipping a forward-only migration for it — never just flipping a DB
// column.
const APPROVED_CATALOG_KEYS: readonly string[] = [
  'dice',
  'number_challenge',
  'trivia',
  'spin_win',
  'thunder_derby_3d',
  'neon_hounds_3d',
  'turbo_circuit_3d',
  'starfall_nebula',
  'jungle_dash_3d',
  'turbo_keno',
  'crystal_trail',
  'heat_vault',
  'strait_rush',
];

export function isApprovedGameKey(key: string): boolean {
  return APPROVED_CATALOG_KEYS.includes(key);
}

/**
 * Public catalog. READ-ONLY — a GET never writes. Returns every row that is
 * AVAILABLE or COMING_SOON AND on the approved-key allowlist (excludes
 * RETIRED, e.g. legacy lucky_spin, and excludes any row not on the
 * allowlist regardless of its catalogStatus) with the new Phase-G0 fields
 * (mode, family, catalogStatus, currencies, current rules version).
 */
export async function listActiveGames(): Promise<GameCatalogItem[]> {
  const rows = await prisma.gameDefinition.findMany({
    where: {
      catalogStatus: { in: PUBLIC_CATALOG_STATUSES },
      key: { in: [...APPROVED_CATALOG_KEYS] },
    },
    orderBy: { key: 'asc' },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      type: true,
      minBet: true,
      maxBet: true,
      isActive: true,
      mode: true,
      family: true,
      catalogStatus: true,
      wagerCurrency: true,
      rewardCurrency: true,
      currentRulesVersion: true,
    },
  });
  return rows;
}

export async function getGameByKey(key: string) {
  return prisma.gameDefinition.findUnique({ where: { key } });
}

export async function getGameConfig(key: string): Promise<Record<string, unknown>> {
  const game = await getGameByKey(key);
  if (!game) return {};
  return (game.configuration as Record<string, unknown>) ?? {};
}

// ─── Rules Helpers ─────────────────────────────────────────────

export async function getGameRules(gameId: string, version: number) {
  return prisma.gameRules.findUnique({
    where: { gameId_version: { gameId, version } },
  });
}

/**
 * Resolve the ACTIVE rules version for a game row. Returns null when the
 * game has no pinned `currentRulesVersion` (e.g. COMING_SOON games that
 * have not published rules yet).
 */
export async function resolveCurrentRules(game: {
  id: string;
  currentRulesVersion: number | null;
}) {
  if (!game.currentRulesVersion) return null;
  return getGameRules(game.id, game.currentRulesVersion);
}