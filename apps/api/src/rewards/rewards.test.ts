import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { activateVip, getVip } from '../vip/vip-service';
import { addXp, getProgress, levelForXp } from '../progress/progress-service';
import {
  recordTaskEvent,
  claimTaskReward,
  listTasks,
  ensureTasks,
} from '../tasks/task-service';
import { recordActivity as recordStreak } from '../tasks/streak-service';
import { grantReward } from '../rewards/reward-service';
import { unlockAchievement, ensureAchievements } from '../rewards/achievement-service';
import { getOrCreateWallet, getWalletBalance, reconcileBalance } from '../economy/wallet-service';

// ─── DB availability probe ─────────────────────────────────────
// These are integration tests requiring a live PostgreSQL database.

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

async function createUser(tag: string) {
  const email = `rewards-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `rewards_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Rewards ${tag}`,
    },
  });
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { contains: '@test.local' } },
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

function utcDayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d).replace(/\//g, '-');
}

// ─── VIP ───────────────────────────────────────────────────────

describeIf('VIP', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('vipa');
  });

  it('user starts with no active VIP (isActive false)', async () => {
    const vip = await getVip(a.id);
    expect(vip.tier).toBeNull();
    expect(vip.isActive).toBe(false);
  });

  it('server-side activation yields an active membership', async () => {
    await activateVip(a.id, 'SILVER', 30);
    const vip = await getVip(a.id);
    expect(vip.tier).toBe('SILVER');
    expect(vip.isActive).toBe(true);
    expect(vip.expiresAt).toBeTruthy();
  });

  it('an expired membership automatically behaves as inactive', async () => {
    await prisma.vipMembership.update({
      where: { userId: a.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const vip = await getVip(a.id);
    expect(vip.isActive).toBe(false);
    expect(vip.status).toBe('EXPIRED');
  });
});

// ─── XP / LEVELS ───────────────────────────────────────────────

describeIf('XP / Levels', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('xpa');
  });

  it('XP awards increment server-side and compute level', async () => {
    const r1 = await addXp(a.id, { amount: 100, reason: 'test', referenceType: 'TASK', referenceId: 'a1' });
    expect(r1.xp).toBe(100);
    // xpForLevel(2) = floor(100 * 1^1.5) = 100, so 100 XP is exactly level 2
    expect(r1.level).toBe(2);
    expect(levelForXp(99)).toBe(1);
    expect(levelForXp(100)).toBe(2);
    expect(levelForXp(101)).toBe(2);
    expect(levelForXp(283)).toBe(3);
  });

  it('duplicate XP for the same reference is prevented', async () => {
    const r1 = await addXp(a.id, { amount: 100, reason: 'test', referenceType: 'TASK', referenceId: 'dedupe' });
    const r2 = await addXp(a.id, { amount: 100, reason: 'test', referenceType: 'TASK', referenceId: 'dedupe' });
    expect(r2.xp).toBe(r1.xp);
  });
});

// ─── DAILY TASKS ───────────────────────────────────────────────

describeIf('Daily tasks', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('task');
    await ensureTasks();
  });

  it('daily login task completes when server records the event', async () => {
    await recordTaskEvent(a.id, 'daily_login');
    const tasks = await listTasks(a.id);
    const login = tasks.find((t) => t.key === 'daily_login');
    expect(login).toBeTruthy();
    expect(login!.status).toBe('COMPLETED');
  });

  it('duplicate daily task events do not inflate progress', async () => {
    await recordTaskEvent(a.id, 'daily_login');
    await recordTaskEvent(a.id, 'daily_login');
    const tasks = await listTasks(a.id);
    const login = tasks.find((t) => t.key === 'daily_login');
    expect(login!.progress).toBe(1);
  });

  it('claiming a completed task grants the game point reward once', async () => {
    const tasks = await listTasks(a.id);
    const login = tasks.find((t) => t.key === 'daily_login')!;
    const claim = await claimTaskReward(a.id, login.id);
    expect(claim.granted).toBe(true);

    const claim2 = await claimTaskReward(a.id, login.id);
    expect(claim2.alreadyClaimed).toBe(true);
  });
});

// ─── STREAKS ───────────────────────────────────────────────────

describeIf('Streaks', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('streak');
  });

  it('consecutive days advance the streak', async () => {
    const today = await recordStreak(a.id, new Date());
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.dailyStreak.update({
      where: { userId: a.id },
      data: { lastActivityDay: utcDayKey(yesterday), currentStreak: Math.max(today.currentStreak, 1) },
    });
    const next = await recordStreak(a.id, new Date());
    expect(next.currentStreak).toBe(Math.max(today.currentStreak, 1) + 1);
  });

  it('missed day resets the streak to 1', async () => {
    await prisma.dailyStreak.update({
      where: { userId: a.id },
      data: { lastActivityDay: '2000-01-01', currentStreak: 5 },
    });
    const r = await recordStreak(a.id, new Date());
    expect(r.currentStreak).toBe(1);
  });

  it('duplicate same-day activity does not change the streak', async () => {
    const r1 = await recordStreak(a.id, new Date());
    const r2 = await recordStreak(a.id, new Date());
    expect(r2.currentStreak).toBe(r1.currentStreak);
  });
});

// ─── REWARDS (economy integration) ─────────────────────────────

describeIf('Rewards economy integration', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('rewardecon');
    await getOrCreateWallet(a.id);
  });

  it('wallet-changing reward uses the authoritative economy path', async () => {
    const before = await getWalletBalance(a.id);
    const res = await grantReward(a.id, {
      sourceType: 'TASK',
      sourceId: 'econ-test-1',
      xpReward: 10,
      coinReward: 100,
      gamePointReward: 50,
    });

    expect(res.granted).toBe(true);

    const after = await getWalletBalance(a.id);
    expect(after.coinsBalance).toBe(before.coinsBalance + 100);
    expect(after.gamePointsBalance).toBe(before.gamePointsBalance + 50);

    const rec = await reconcileBalance(a.id);
    expect(rec.coinsMatch).toBe(true);
    expect(rec.gamePointsMatch).toBe(true);

    const ledgerCoin = await prisma.walletTransaction.count({
      where: { userId: a.id, referenceType: 'TASK', amount: 100 },
    });
    expect(ledgerCoin).toBe(1);
  });

  it('duplicate reward claim is rejected and does not credit again', async () => {
    const before = await getWalletBalance(a.id);
    const res2 = await grantReward(a.id, {
      sourceType: 'TASK',
      sourceId: 'econ-test-1',
      xpReward: 10,
      coinReward: 100,
      gamePointReward: 50,
    });
    expect(res2.alreadyClaimed).toBe(true);
    const after = await getWalletBalance(a.id);
    expect(after.coinsBalance).toBe(before.coinsBalance);
  });
});

// ─── ACHIEVEMENTS ──────────────────────────────────────────────

describeIf('Achievements', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('ach');
    await ensureAchievements();
  });

  it('unlocks an achievement and grants its reward exactly once', async () => {
    const r1 = await unlockAchievement(a.id, 'first_message');
    expect(r1.unlocked).toBe(true);

    const r2 = await unlockAchievement(a.id, 'first_message');
    expect(r2.alreadyUnlocked).toBe(true);

    const unlocked = await prisma.userAchievement.count({
      where: { userId: a.id, achievement: { key: 'first_message' } },
    });
    expect(unlocked).toBe(1);
  });

  it('achievement reward is granted exactly once', async () => {
    const grants = await prisma.rewardClaim.count({
      where: { userId: a.id, sourceType: 'ACHIEVEMENT' },
    });
    expect(grants).toBe(1);
  });
});
