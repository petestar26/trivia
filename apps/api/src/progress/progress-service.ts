import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';

export interface XpAward {
  amount: number;
  reason: string;
  referenceType: string;
  referenceId?: string;
}

export interface ProgressSnapshot {
  userId: string;
  xp: number;
  level: number;
  leveledUp: boolean;
  previousLevel: number;
}

const BASE_XP = 100;
const GROWTH = 1.5;

/** Threshold XP required to reach a given level (server-authoritative curve). */
export function xpForLevel(level: number): number {
  return Math.floor(BASE_XP * Math.pow(level - 1, GROWTH));
}

/** Derive the level for a given total XP. */
export function levelForXp(xp: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) {
    level += 1;
  }
  return level;
}

/**
 * Authoritative XP service.
 *
 * XP is awarded server-side only. Each award has a (referenceType, referenceId,
 * userId) unique constraint that prevents the same action from being rewarded
 * twice. Awarding is atomic with level computation.
 */

/** Apply an XP award inside a caller-supplied transaction (shared path). */
export async function applyXp(
  tx: any,
  userId: string,
  award: XpAward
): Promise<ProgressSnapshot> {
  if (!Number.isInteger(award.amount) || award.amount < 0) {
    throw ApiError.badRequest('XP amount must be a non-negative integer');
  }

  let progress = await tx.userProgress.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });

  const xpEvent = await tx.userXpEvent.findUnique({
    where: {
      referenceType_referenceId_userId: {
        referenceType: award.referenceType,
        referenceId: award.referenceId ?? null,
        userId,
      },
    },
  });

  if (xpEvent) {
    return {
      userId,
      xp: progress.xp,
      level: progress.level,
      leveledUp: false,
      previousLevel: progress.level,
    };
  }

  const previousLevel = progress.level;
  const newXp = progress.xp + award.amount;

  await tx.userXpEvent.create({
    data: {
      userId,
      xp: award.amount,
      reason: award.reason,
      referenceType: award.referenceType,
      referenceId: award.referenceId ?? null,
    },
  });

  const newLevel = levelForXp(newXp);

  const updated = await tx.userProgress.update({
    where: { id: progress.id },
    data: { xp: newXp, level: newLevel },
  });

  return {
    userId,
    xp: updated.xp,
    level: updated.level,
    leveledUp: newLevel > previousLevel,
    previousLevel,
  };
}

export async function addXp(userId: string, award: XpAward): Promise<ProgressSnapshot> {
  if (!Number.isInteger(award.amount) || award.amount < 0) {
    throw ApiError.badRequest('XP amount must be a non-negative integer');
  }

  return prisma.$transaction(async (tx) => applyXp(tx, userId, award));
}

export async function getProgress(userId: string): Promise<ProgressSnapshot> {
  const progress = await prisma.userProgress.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });

  return {
    userId,
    xp: progress.xp,
    level: progress.level,
    leveledUp: false,
    previousLevel: progress.level,
  };
}
