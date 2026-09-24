import type { Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';

// ─── User Eligibility Lock ─────────────────────────────────────
// Prisma has no `FOR SHARE` support, so the row lock is done with raw
// SQL against the mapped table name ("users"). The guard is strict:
// an account that is anything other than ACTIVE may not play.

export interface LockedUser {
  id: string;
  status: string;
}

export async function lockUserForPlay(tx: Prisma.TransactionClient, userId: string): Promise<LockedUser> {
  const rows = (await tx.$queryRaw`SELECT "id", "status" FROM "users" WHERE "id" = ${userId} FOR SHARE`) as LockedUser[];
  const user = rows[0];
  if (!user || user.status !== 'ACTIVE') {
    throw ApiError.forbidden('Your account is not eligible to play');
  }
  return user;
}

// ─── Game Definition Lock ──────────────────────────────────────
// Locks the game_definitions row FOR SHARE so a concurrent change to its
// catalogStatus or currentRulesVersion pointer (an admin update, a future
// admin route, or a raw migration) cannot land mid-settlement: the updater
// either commits before this lock is taken (this transaction then sees the
// fresh row) or blocks until this transaction commits/rolls back. Only used
// on the NEW-session path — a replay never re-resolves availability/rules,
// so it never needs this lock (see playGame in game-play.ts).

export interface LockedGame {
  id: string;
  key: string;
  name: string;
  type: string;
  mode: string;
  family: string;
  catalogStatus: string;
  isActive: boolean;
  minBet: number;
  maxBet: number;
  wagerCurrency: string | null;
  rewardCurrency: string;
  currentRulesVersion: number | null;
}

export async function lockGameForPlay(tx: Prisma.TransactionClient, gameKey: string): Promise<LockedGame | null> {
  const rows = (await tx.$queryRaw`
    SELECT "id", "key", "name", "type"::text AS "type", "mode"::text AS "mode", "family"::text AS "family",
           "catalogStatus"::text AS "catalogStatus", "isActive", "minBet", "maxBet",
           "wagerCurrency"::text AS "wagerCurrency", "rewardCurrency"::text AS "rewardCurrency",
           "currentRulesVersion"
    FROM "game_definitions" WHERE "key" = ${gameKey} FOR SHARE
  `) as LockedGame[];
  return rows[0] ?? null;
}
