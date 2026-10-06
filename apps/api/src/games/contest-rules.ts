import type { GameRules, Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';
import { isApprovedGameKey } from './game-catalog.js';
import { lockGameForPlay } from './game-locks.js';
import type { LockedGame } from './game-locks.js';

export type ContestKind = 'CHALLENGE' | 'COMPETITION';

// Games approved for player-versus-player contests. An ALLOWLIST, checked in
// addition to the public catalog allowlist and catalogStatus = AVAILABLE: a
// retired game (legacy lucky_spin, still isActive), a COMING_SOON entry or a
// game without contest scoring can never host a new contest. Trivia has no
// challenge scoring, so it is a competition game only.
const CONTEST_GAME_KEYS: Record<ContestKind, readonly string[]> = {
  CHALLENGE: ['dice', 'number_challenge'],
  COMPETITION: ['dice', 'number_challenge', 'trivia'],
};

export function isContestGameKey(kind: ContestKind, key: string): boolean {
  return CONTEST_GAME_KEYS[kind].includes(key);
}

/**
 * Resolves the game a new contest will be played on and the exact immutable
 * rules row it will be pinned to. Locks the game row FOR SHARE for the rest
 * of the caller's transaction, so a concurrent status or rules-pointer change
 * either commits first or waits until the contest is created.
 */
export async function pinContestRules(
  tx: Prisma.TransactionClient, gameKey: string, kind: ContestKind,
): Promise<{ game: LockedGame; rules: GameRules }> {
  const game = await lockGameForPlay(tx, gameKey);
  if (!game) throw ApiError.notFound('Game not found');
  if (!isApprovedGameKey(game.key) || !isContestGameKey(kind, game.key)) {
    throw ApiError.badRequest(`This game is not available for ${kind === 'CHALLENGE' ? 'challenges' : 'competitions'}`);
  }
  if (game.catalogStatus !== 'AVAILABLE' || !game.isActive) {
    throw ApiError.badRequest('This game is currently unavailable');
  }
  if (!game.currentRulesVersion) throw ApiError.badRequest('This game has no active rules');
  const rules = await tx.gameRules.findUnique({
    where: { gameId_version: { gameId: game.id, version: game.currentRulesVersion } },
  });
  if (!rules) throw ApiError.badRequest('This game has no active rules');
  return { game, rules };
}

/** The rules row a contest was pinned to at creation. */
export async function pinnedContestRules(tx: Prisma.TransactionClient, gameId: string, rulesVersion: number): Promise<GameRules> {
  const rules = await tx.gameRules.findUnique({
    where: { gameId_version: { gameId, version: rulesVersion } },
  });
  if (!rules) throw ApiError.internal('Contest rules version is missing');
  return rules;
}

/**
 * Session fields of one contest round. The entry fee is paid once, in Game
 * Points, into the contest escrow; a round moves no wallet value, so it
 * records no stake and no settlement currency. Mode, family, currencies and
 * versions come from the pinned rules row, never the mutable game row.
 */
export function contestRoundSnapshot(rules: GameRules, playContext: 'CHALLENGE_ROUND' | 'COMPETITION_ROUND') {
  return {
    betAmount: 0,
    rewardAmount: 0,
    mode: rules.mode,
    family: rules.family,
    wagerCurrency: rules.wagerCurrency,
    rewardCurrency: rules.rewardCurrency,
    rulesVersion: rules.version,
    resultSchemaVersion: rules.resultSchemaVersion,
    settlementDebitCurrency: null,
    settlementCreditCurrency: null,
    playContext,
  };
}
