import { prisma } from '@socialplay/database';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { PRACTICE_STREAM } from './scheduled/practice-service.js';

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
  practiceAvailable?: boolean;
  currentRulesId?: string | null;
}

const PUBLIC_CATALOG_STATUSES: GameCatalogStatusValue[] = ['AVAILABLE', 'COMING_SOON'];

// Unreleased titles stay visibly unavailable even if stale catalog data marks
// them active. Publishing their implementation requires an explicit code change.
const COMING_SOON_KEYS: readonly string[] = [
  'trivia',
  'turbo_circuit_3d',
  'starfall_nebula',
  'jungle_dash_3d',
  'crystal_trail',
  'heat_vault',
  'strait_rush',
];

// The catalog and the dedicated practice routes must use the same admission
// flags. A rendered practice tile must not promise access to a disabled route.
const PRACTICE_FLAGS: Record<string, string> = {
  lucky_six: 'LUCKY_SIX_PRACTICE_ENABLED',
  roulette_keno: 'ROULETTE_KENO_PRACTICE_ENABLED',
  number_challenge: 'NUMBER_CHALLENGE_PRACTICE_ENABLED',
  sky_crash: 'SKY_CRASH_PRACTICE_ENABLED',
  thunder_derby_3d: 'THUNDER_DERBY_PRACTICE_ENABLED',
  neon_hounds_3d: 'DOG_RACING_PRACTICE_ENABLED',
  virtual_football_3d: 'VIRTUAL_FOOTBALL_PRACTICE_ENABLED',
  crash_point: 'CRASH_POINT_PRACTICE_ENABLED',
  dice: 'SYSTEM_DICE_PRACTICE_ENABLED',
  turbo_keno: 'SYSTEM_KENO_PRACTICE_ENABLED',
};

// The compliance-approved public catalog: these approved keys, each once,
// per the seed migration (20260918020000_casino_foundation_seed) that
// established them. This is an ALLOWLIST, not a denylist of the retired
// `lucky_spin` row — a game row is never public just because its
// catalogStatus happens to be AVAILABLE/COMING_SOON in the database. A row
// that is AVAILABLE/COMING_SOON but NOT in this list (a rogue insert, a
// migration mistake, a future draft row someone forgot to keep DRAFT) never
// reaches a player. Adding an approved game means adding its key here
// AND shipping a forward-only migration for it — never just flipping a DB
// column.
const APPROVED_CATALOG_KEYS: readonly string[] = [
  'lucky_six',
  'roulette_keno',
  'sky_crash',
  'crash_point',
  'dice',
  'number_challenge',
  'trivia',
  'spin_win',
  'thunder_derby_3d',
  'virtual_football_3d',
  'neon_hounds_3d',
  'turbo_circuit_3d',
  'starfall_nebula',
  'jungle_dash_3d',
  'turbo_keno',
  'crystal_trail',
  'heat_vault',
  'strait_rush',
];

// These legacy payout models have not passed the agreed 90% RTP review.
// Keep the server gate even if an old deployment/admin changes catalog status.
export function isCoinWagerPaused(game: {
  key: string;
  mode: string;
  wagerCurrency: string | null;
}) {
  // Sky Crash has no wallet-funded implementation, regardless of catalog edits.
  return (
    game.key === 'lucky_six' ||
    game.key === 'roulette_keno' ||
    game.key === 'number_challenge' ||
    game.key === 'sky_crash' ||
    game.key === 'thunder_derby_3d' || game.key === 'neon_hounds_3d' ||
    // Practice credits only: Coin admission is paused here regardless of catalog data or flags.
    game.key === 'virtual_football_3d' ||
    (game.mode === 'WAGER' &&
      game.wagerCurrency === 'COINS' &&
      ['number_challenge', 'dice', 'crash_point'].includes(game.key))
  );
}

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
  const spin = rows.find((row) => row.key === 'spin_win');
  const rules = spin?.currentRulesVersion
    ? await getGameRules(spin.id, spin.currentRulesVersion)
    : null;
  const spinPractice = spin
    ? await prisma.scheduledGameStream.findUnique({
        where: { id: PRACTICE_STREAM },
        select: { enabled: true, mode: true, gameKey: true, rulesId: true },
      })
    : null;
  const spinPracticeAvailable = spinPractice?.enabled === true &&
    spinPractice.mode === 'PRACTICE' && spinPractice.gameKey === 'spin_win' &&
    spinPractice.rulesId === SPIN90_RULES_ID;
  const rulesId = (rules?.rules as Record<string, unknown> | undefined)?.rulesId;
  return rows.map((row) =>
    COMING_SOON_KEYS.includes(row.key)
      ? { ...row, isActive: false, catalogStatus: 'COMING_SOON' as const, practiceAvailable: false }
      : row.key === 'lucky_six' || row.key === 'roulette_keno' || row.key === 'number_challenge' || row.key === 'sky_crash' || row.key === 'thunder_derby_3d' || row.key === 'neon_hounds_3d' || row.key === 'virtual_football_3d'
      ? {
          ...row,
          ...(row.key === 'neon_hounds_3d' ? { name: 'Dog Racing' } : {}),
          description: row.key === 'number_challenge' ? 'One-minute rounds. Pick 1–100 before the 30-second countdown ends. The closer your guess, the higher your practice score.' : row.key === 'neon_hounds_3d' ? 'Six or eight greyhounds. Choose your finish and follow the race. Free practice ETB.' : row.description,
          isActive: false,
          catalogStatus: 'COMING_SOON' as const,
          practiceAvailable: process.env[PRACTICE_FLAGS[row.key]] === 'true',
        }
      : row.key === 'crash_point' || row.key === 'dice' || row.key === 'turbo_keno'
        ? {
            ...row,
            ...(isCoinWagerPaused(row) ? { catalogStatus: 'COMING_SOON' as const } : {}),
            practiceAvailable: process.env[PRACTICE_FLAGS[row.key]] === 'true',
          }
      : isCoinWagerPaused(row)
        ? { ...row, catalogStatus: 'COMING_SOON' as const }
        : row.key === 'spin_win'
          ? {
              ...row,
              currentRulesId: typeof rulesId === 'string' ? rulesId : null,
              practiceAvailable: spinPracticeAvailable,
            }
          : row
  );
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
