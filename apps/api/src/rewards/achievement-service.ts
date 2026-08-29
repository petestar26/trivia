import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { grantReward } from './reward-service';

export type AchievementCategory =
  | 'SOCIAL'
  | 'CHAT'
  | 'ECONOMY'
  | 'GAME'
  | 'ENGAGEMENT'
  | 'MILESTONE';

export interface AchievementDef {
  key: string;
  category: AchievementCategory;
  title: string;
  description: string;
  xpReward: number;
  coinReward: number;
  gamePointReward: number;
}

/**
 * Server-defined achievement catalog. These are the ONLY achievements the
 * platform recognizes. Clients can never define, modify, or force an
 * achievement — unlocking is driven by server-verified activity.
 */
export const ACHIEVEMENT_DEFS: AchievementDef[] = [
  { key: 'first_group', category: 'SOCIAL', title: 'First Group', description: 'Joined your first group', xpReward: 50, coinReward: 0, gamePointReward: 20 },
  { key: 'first_message', category: 'CHAT', title: 'First Message', description: 'Sent your first message', xpReward: 25, coinReward: 0, gamePointReward: 10 },
  { key: 'first_voice_message', category: 'CHAT', title: 'First Voice Message', description: 'Sent your first voice message', xpReward: 40, coinReward: 0, gamePointReward: 15 },
  { key: 'first_gift_sent', category: 'ECONOMY', title: 'First Gift Sent', description: 'Sent a gift to someone', xpReward: 40, coinReward: 0, gamePointReward: 15 },
  { key: 'first_gift_received', category: 'ECONOMY', title: 'First Gift Received', description: 'Received a gift', xpReward: 40, coinReward: 0, gamePointReward: 15 },
  { key: 'vip_member', category: 'ENGAGEMENT', title: 'VIP Member', description: 'Became a VIP member', xpReward: 100, coinReward: 0, gamePointReward: 30 },
  { key: 'streak_3', category: 'ENGAGEMENT', title: '3-Day Streak', description: 'Stay active 3 days in a row', xpReward: 60, coinReward: 0, gamePointReward: 20 },
  { key: 'level_2', category: 'MILESTONE', title: 'Level 2', description: 'Reach level 2', xpReward: 50, coinReward: 0, gamePointReward: 15 },
];

/** Ensure the Achievement definitions exist (idempotent by unique key). */
export async function ensureAchievements(): Promise<void> {
  for (const def of ACHIEVEMENT_DEFS) {
    await prisma.achievement.upsert({
      where: { key: def.key },
      update: {
        category: def.category,
        title: def.title,
        description: def.description,
        xpReward: def.xpReward,
        coinReward: def.coinReward,
        gamePointReward: def.gamePointReward,
        isActive: true,
      },
      create: {
        key: def.key,
        category: def.category,
        title: def.title,
        description: def.description,
        xpReward: def.xpReward,
        coinReward: def.coinReward,
        gamePointReward: def.gamePointReward,
      },
    });
  }
}

export interface UnlockResult {
  unlocked: boolean;
  alreadyUnlocked: boolean;
  award: { xpReward: number; coinReward: number; gamePointReward: number };
}

/**
 * Server-side achievement unlock. Creating a `UserAchievement` row is guarded
 * by `@@unique([userId, achievementId])`, so an achievement can only be
 * unlocked once. Its reward is granted exactly once via the authoritative
 * reward service.
 */
export async function unlockAchievement(
  userId: string,
  key: string
): Promise<UnlockResult> {
  const def = ACHIEVEMENT_DEFS.find((d) => d.key === key);
  if (!def) {
    throw ApiError.badRequest('Unknown achievement');
  }

  await ensureAchievements();
  const achievement = await prisma.achievement.findUnique({ where: { key } });
  if (!achievement) {
    throw ApiError.internal('Achievement definition missing');
  }

  try {
    const existing = await prisma.userAchievement.findUnique({
      where: { userId_achievementId: { userId, achievementId: achievement.id } },
    });

    if (existing) {
      return {
        unlocked: false,
        alreadyUnlocked: true,
        award: { xpReward: def.xpReward, coinReward: def.coinReward, gamePointReward: def.gamePointReward },
      };
    }

    // Single atomic transaction: achievement unlock + notification + reward
    // (XP + Coins + Game Points). This ensures the reward can never be
    // permanently separated from the unlock on transient failure.
    const result = await prisma.$transaction(async (tx) => {
      await tx.userAchievement.create({
        data: { userId, achievementId: achievement.id },
      });
      await tx.notification.create({
        data: {
          userId,
          type: 'ACHIEVEMENT_UNLOCKED',
          title: 'Achievement unlocked',
          body: def.title,
          data: { achievementKey: key, achievementTitle: def.title },
        },
      });

      // Grant the reward inside the SAME transaction. grantReward's
      // RewardClaim unique guard prevents duplicates under concurrent
      // retries; a P2002 here means a concurrent unlock already succeeded.
      const rewardResult = await grantReward(userId, {
        sourceType: 'ACHIEVEMENT',
        sourceId: achievement.id,
        xpReward: def.xpReward,
        coinReward: def.coinReward,
        gamePointReward: def.gamePointReward,
      }, tx);

      return rewardResult;
    });

    return {
      unlocked: true,
      alreadyUnlocked: false,
      award: { xpReward: def.xpReward, coinReward: def.coinReward, gamePointReward: def.gamePointReward },
    };
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return {
        unlocked: false,
        alreadyUnlocked: true,
        award: { xpReward: def.xpReward, coinReward: def.coinReward, gamePointReward: def.gamePointReward },
      };
    }
    throw err;
  }
}

export async function listUnlocked(userId: string) {
  const rows = await prisma.userAchievement.findMany({
    where: { userId },
    include: { achievement: true },
    orderBy: { unlockedAt: 'asc' },
  });
  return rows.map((r) => ({
    key: r.achievement.key,
    title: r.achievement.title,
    category: r.achievement.category,
    unlockedAt: r.unlockedAt,
  }));
}
