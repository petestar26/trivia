import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { addXp, getProgress } from '../progress/progress-service';
import { grantReward } from './reward-service';
import { ensureAchievements } from './achievement-service';
import { recordActivity } from './activity-service';

// ─── DB availability probe ─────────────────────────────────────
// Integration tests requiring a live PostgreSQL database.

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = dbAvailable ? describe : describe.skip;

// ─── Fixtures ──────────────────────────────────────────────────
// Dedicated prefix so this suite never touches other suites' data.

async function createUser(tag: string) {
  const email = `levelms-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `levelms_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `LevelMS ${tag}`,
    },
  });
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: 'levelms-' } },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.rewardClaim.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userAchievement.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userTask.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userXpEvent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userProgress.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.dailyStreak.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.vipMembership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

async function level2AchievementId(): Promise<string> {
  const achievement = await prisma.achievement.findUnique({ where: { key: 'level_2' } });
  if (!achievement) throw new Error('level_2 achievement definition missing');
  return achievement.id;
}

async function achievementCount(userId: string, key: string): Promise<number> {
  return prisma.userAchievement.count({ where: { userId, achievement: { key } } });
}

async function claimCount(userId: string, sourceId: string): Promise<number> {
  return prisma.rewardClaim.count({
    where: { userId, sourceType: 'ACHIEVEMENT', sourceId },
  });
}

async function gamePointCreditsFor(userId: string, referenceId: string): Promise<number> {
  return prisma.walletTransaction.count({
    where: {
      userId,
      referenceType: 'ACHIEVEMENT',
      referenceId,
      currency: 'GAME_POINTS',
    },
  });
}

async function walletBalance(userId: string): Promise<{ gamePointsBalance: number; coinsBalance: number }> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  return {
    gamePointsBalance: wallet?.gamePointsBalance ?? 0,
    coinsBalance: wallet?.coinsBalance ?? 0,
  };
}

// xpForLevel(2) = floor(100 * 1^1.5) = 100, so 100+ XP is level 2.

describeIf('Level 2 milestone', () => {
  beforeAll(async () => {
    await cleanFixtures();
    await ensureAchievements();
  });

  it('TEST 1 — ordinary activity XP crossing unlocks level_2 exactly once', async () => {
    const user = await createUser('t1');
    const seed = await addXp(user.id, { amount: 90, reason: 't1 seed', referenceType: 'SEED', referenceId: 'seed-t1' });
    expect(seed.level).toBe(1); // below threshold

    // stay_active task (+5) + first_message (25) + level_2 reward (50)
    // on top of the 90 seed → 170, crossing level 2 along the way.
    await recordActivity(user.id, { type: 'MESSAGE' });

    const progress = await getProgress(user.id);
    expect(progress.xp).toBe(170);
    expect(progress.level).toBeGreaterThanOrEqual(2);

    expect(await achievementCount(user.id, 'level_2')).toBe(1);
    const lvl2Id = await level2AchievementId();
    expect(await claimCount(user.id, lvl2Id)).toBe(1);
    expect(await gamePointCreditsFor(user.id, lvl2Id)).toBe(1);
  });

  it('TEST 2 — user already at level 2 self-heals on the next eligible activity', async () => {
    const user = await createUser('t2');
    // Already past the level-2 threshold with persisted level 2 but NO
    // level_2 achievement (the historical crossing never unlocked it).
    const seed = await addXp(user.id, { amount: 120, reason: 't2 seed', referenceType: 'SEED', referenceId: 'seed-t2' });
    expect(seed.level).toBe(2);
    expect(await achievementCount(user.id, 'level_2')).toBe(0);

    await recordActivity(user.id, { type: 'MESSAGE' });

    expect(await achievementCount(user.id, 'level_2')).toBe(1);
    const lvl2Id = await level2AchievementId();
    expect(await claimCount(user.id, lvl2Id)).toBe(1);
    expect(await gamePointCreditsFor(user.id, lvl2Id)).toBe(1);

    const progress = await getProgress(user.id);
    // 120 seed + 5 stay_active + 25 first_message + 50 level_2 reward.
    expect(progress.xp).toBe(200);
    expect(progress.level).toBeGreaterThanOrEqual(2);
  });

  it('TEST 3 — level_2 unlock is idempotent across later activities', async () => {
    const user = await createUser('t3');
    await addXp(user.id, { amount: 95, reason: 't3 seed', referenceType: 'SEED', referenceId: 'seed-t3' });

    // Crossing activity → unlock + pay level_2.
    await recordActivity(user.id, { type: 'MESSAGE' });

    const lvl2Id = await level2AchievementId();
    expect(await achievementCount(user.id, 'level_2')).toBe(1);
    expect(await claimCount(user.id, lvl2Id)).toBe(1);

    const balanceAfterUnlock = await walletBalance(user.id);
    const creditsAfterUnlock = await gamePointCreditsFor(user.id, lvl2Id);

    // Additional activities of the SAME type → stay_active/first_message already
    // done, so no new XP or wallet change; level_2 must not re-pay either.
    await recordActivity(user.id, { type: 'MESSAGE' });
    await recordActivity(user.id, { type: 'MESSAGE' });
    await recordActivity(user.id, { type: 'MESSAGE' });

    expect(await achievementCount(user.id, 'level_2')).toBe(1);
    expect(await claimCount(user.id, lvl2Id)).toBe(1);
    expect(await walletBalance(user.id)).toEqual(balanceAfterUnlock);
    expect(await gamePointCreditsFor(user.id, lvl2Id)).toBe(creditsAfterUnlock);
  });

  it('TEST 4 — achievement XP crossing (real D3 path) is safe and complete', async () => {
    const user = await createUser('t4');
    const seed = await addXp(user.id, { amount: 80, reason: 't4 seed', referenceType: 'SEED', referenceId: 'seed-t4' });
    expect(seed.level).toBe(1);

    // first_message (25 XP) crosses 100 inside the achievement reward path;
    // the level milestone must then unlock via recordActivity — with NO nested
    // Prisma transaction (the pre-fix regressions failed exactly here).
    await recordActivity(user.id, { type: 'MESSAGE' });

    const firstMsg = await prisma.achievement.findUnique({ where: { key: 'first_message' } });
    if (!firstMsg) throw new Error('first_message achievement definition missing');

    expect(await achievementCount(user.id, 'first_message')).toBe(1);
    expect(await achievementCount(user.id, 'level_2')).toBe(1);

    // Both rewards claimed exactly once each.
    expect(await claimCount(user.id, firstMsg.id)).toBe(1);
    const lvl2Id = await level2AchievementId();
    expect(await claimCount(user.id, lvl2Id)).toBe(1);

    // Persisted XP reflects the seed, the completed stay_active task, the
    // ordinary achievement XP, and the level_2 reward XP: 80 + 5 + 25 + 50.
    const progress = await getProgress(user.id);
    expect(progress.xp).toBe(160);
    expect(progress.level).toBeGreaterThanOrEqual(2);

    const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } });
    expect(wallet?.gamePointsBalance).toBe(25); // first_message 10 + level_2 15
    expect(await gamePointCreditsFor(user.id, firstMsg.id)).toBe(1);
    expect(await gamePointCreditsFor(user.id, lvl2Id)).toBe(1);
  });

  it('TEST 5 — grantReward with xpReward: 0 does NOT evaluate level milestones', async () => {
    const user = await createUser('t5');
    const seed = await addXp(user.id, { amount: 100, reason: 't5 seed', referenceType: 'SEED', referenceId: 'seed-t5' });
    expect(seed.level).toBe(2);
    expect(await achievementCount(user.id, 'level_2')).toBe(0);

    const result = await grantReward(user.id, {
      sourceType: 'TASK',
      sourceId: 'levelms-grant-t5',
      xpReward: 0,
      coinReward: 0,
      gamePointReward: 8,
    });

    expect(result.granted).toBe(true);

    // The ordinary reward landed: claim exists and Game Points applied.
    const claim = await prisma.rewardClaim.count({
      where: { userId: user.id, sourceType: 'TASK', sourceId: 'levelms-grant-t5' },
    });
    expect(claim).toBe(1);
    const balance = await walletBalance(user.id);
    expect(balance.gamePointsBalance).toBe(8);
    expect(balance.coinsBalance).toBe(0);

    // grantReward itself must NEVER unlock level milestones.
    expect(await achievementCount(user.id, 'level_2')).toBe(0);
  });
});