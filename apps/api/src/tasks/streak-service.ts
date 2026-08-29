import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { utcDayKey, previousDayKey } from '../utils/dates';

export interface StreakSnapshot {
  userId: string;
  currentStreak: number;
  longestStreak: number;
  lastActivityDay: string | null;
}

/**
 * Authoritative daily-streak service.
 *
 * The server derives the canonical "today" from the clock (UTC) and compares
 * against the stored last-activity day:
 *   - same day  -> duplicate activity, streak unchanged
 *   - yesterday -> streak +1
 *   - older     -> missed day, streak resets to 1
 * Client-provided dates are never trusted.
 */
export async function recordActivity(userId: string, when: Date = new Date()): Promise<StreakSnapshot> {
  const today = utcDayKey(when);

  return prisma.$transaction(async (tx) => {
    const streak = await tx.dailyStreak.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });

    let current = streak.currentStreak;
    let longest = streak.longestStreak;

    if (streak.lastActivityDay === today) {
      // Duplicate same-day activity — no change.
      return {
        userId,
        currentStreak: current,
        longestStreak: longest,
        lastActivityDay: streak.lastActivityDay,
      };
    }

    if (streak.lastActivityDay && streak.lastActivityDay === previousDayKey(today)) {
      current = streak.currentStreak + 1;
    } else if (streak.lastActivityDay) {
      // Missed at least one day — reset.
      current = 1;
    } else {
      current = 1;
    }

    if (current > longest) longest = current;

    const updated = await tx.dailyStreak.update({
      where: { id: streak.id },
      data: {
        currentStreak: current,
        longestStreak: longest,
        lastActivityDay: today,
      },
    });

    return {
      userId,
      currentStreak: updated.currentStreak,
      longestStreak: updated.longestStreak,
      lastActivityDay: updated.lastActivityDay,
    };
  });
}

export async function getStreak(userId: string): Promise<StreakSnapshot> {
  const streak = await prisma.dailyStreak.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });

  return {
    userId,
    currentStreak: streak.currentStreak,
    longestStreak: streak.longestStreak,
    lastActivityDay: streak.lastActivityDay,
  };
}

export function requirePositive(x: number): number {
  if (!Number.isInteger(x) || x < 0) {
    throw ApiError.badRequest('Streak value must be a non-negative integer');
  }
  return x;
}
