import { randomUUID } from 'node:crypto';
import { prisma, type Prisma } from '@socialplay/database';
import { z } from 'zod';
import { ApiError } from '../middleware/api-error.js';
import { lockUserEconomicScope } from '../economy/coin-ledger-service.js';
import { getWalletBalance } from '../economy/wallet-service.js';
import { tryActiveBonusGrantPolicy } from '../economy/jurisdiction-service.js';
import { grantReward } from '../rewards/reward-service.js';
import { generateReferralCode } from '../referrals/referral-service.js';

type Tx = Prisma.TransactionClient;
export type RewardConfig = {
  version: number;
  daily_enabled: boolean;
  daily_amount: number;
  gift_enabled: boolean;
  gift_amount: number;
  gift_daily_limit: number;
  referral_enabled: boolean;
  referral_amount: number;
  gift_minimum: number;
  updated_at: Date;
  updated_by: string | null;
};
export type Entitlement = {
  id: string;
  kind: 'DAILY' | 'GIFT' | 'REFERRAL';
  amount: number;
  created_at: Date;
  claimed_at: Date | null;
  reward_day: string;
};
const money = z.number().int().min(0).max(100_000_000);
export const configSchema = z
  .object({
    version: z.number().int().positive(),
    daily_enabled: z.boolean(),
    daily_amount: money,
    gift_enabled: z.boolean(),
    gift_amount: money,
    gift_daily_limit: money,
    referral_enabled: z.boolean(),
    referral_amount: money,
    gift_minimum: money,
  })
  .strict()
  .superRefine((v, ctx) => {
    const error = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.daily_enabled && !v.daily_amount) error('Set a positive daily reward before enabling it');
    if (v.gift_enabled && (!v.gift_amount || v.gift_daily_limit < v.gift_amount))
      error('Gift daily limit must cover at least one positive gift reward');
    if (v.referral_enabled && !v.referral_amount)
      error('Set a positive referral reward before enabling it');
    if ((v.gift_enabled || v.referral_enabled) && !v.gift_minimum)
      error('Set a positive qualifying gift purchase minimum');
  });

export function rewardDay(date: Date): string {
  // Fixed Ethiopian calendar-day boundary, independent of browser or server TZ.
  return new Date(date.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

export async function readConfig(tx: Tx = prisma): Promise<RewardConfig> {
  const [row] = await tx.$queryRaw<
    RewardConfig[]
  >`SELECT * FROM member_reward_config WHERE id = 'default'`;
  if (!row) throw ApiError.internal('Reward configuration is unavailable');
  return row;
}

// All configuring/earning transactions lock this row before users, wallets or
// per-user locks. An edit cannot change the terms halfway through a purchase.
export async function lockRewardConfig(tx: Tx): Promise<RewardConfig> {
  const [row] = await tx.$queryRaw<
    RewardConfig[]
  >`SELECT * FROM member_reward_config WHERE id = 'default' FOR SHARE`;
  if (!row) throw ApiError.internal('Reward configuration is unavailable');
  return row;
}

export async function saveConfig(actorId: string, input: unknown) {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0].message);
  const v = parsed.data;
  return prisma.$transaction(async (tx) => {
    const [old] = await tx.$queryRaw<
      RewardConfig[]
    >`SELECT * FROM member_reward_config WHERE id='default' FOR UPDATE`;
    const [actor] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id=${actorId} AND status='ACTIVE' AND role IN ('ADMIN','SUPER_ADMIN') FOR SHARE`;
    if (!actor) throw ApiError.forbidden('Active administrator access required');
    if (old.version !== v.version)
      throw ApiError.conflict('Reward settings changed. Reload before saving.');
    await tx.$executeRaw`UPDATE member_reward_config SET version=version+1,
      daily_enabled=${v.daily_enabled}, daily_amount=${v.daily_amount},
      gift_enabled=${v.gift_enabled}, gift_amount=${v.gift_amount}, gift_daily_limit=${v.gift_daily_limit},
      referral_enabled=${v.referral_enabled}, referral_amount=${v.referral_amount}, gift_minimum=${v.gift_minimum},
      updated_at=clock_timestamp(), updated_by=${actorId} WHERE id='default'`;
    const updated = await readConfig(tx);
    await tx.auditLog.create({
      data: {
        userId: actorId,
        action: 'MEMBER_REWARD_CONFIG_UPDATED',
        entity: 'MEMBER_REWARD_CONFIG',
        entityId: 'default',
        oldData: JSON.parse(JSON.stringify(old)),
        newData: JSON.parse(JSON.stringify(updated)),
      },
    });
    return updated;
  });
}

async function insertEntitlement(
  tx: Tx,
  args: {
    userId: string;
    kind: Entitlement['kind'];
    sourceKey: string;
    amount: number;
    version: number;
    day: string;
    giftId?: string;
  }
) {
  const { userId, kind, sourceKey, amount, version, day, giftId } = args;
  await tx.$executeRaw`INSERT INTO member_reward_entitlements
    (id,user_id,kind,source_key,amount,config_version,reward_day,gift_transaction_id)
    VALUES (${randomUUID()},${userId},${kind},${sourceKey},${amount},${version},${day}::date,${giftId ?? null})
    ON CONFLICT DO NOTHING`;
}

/** Only called by the real-money gift transaction after its authoritative debit.
 * Neither practice ETB nor game-point gift paths import this function. */
export async function recordPaidGiftRewards(tx: Tx, config: RewardConfig, giftId: string) {
  // A second relational proof avoids accepting an arbitrary purchase assertion.
  const [gift] = await tx.$queryRaw<{ senderId: string; totalCoins: number; createdAt: Date }[]>`
    SELECT g."senderId", g."totalCoins", g."createdAt" FROM gift_transactions g
    WHERE g.id=${giftId} AND EXISTS (SELECT 1 FROM economic_operations o
      WHERE o.type='GIFT_SPEND' AND o."userId"=g."senderId" AND o."scopeType"='GIFT_TRANSACTION' AND o."scopeId"=g.id)`;
  if (!gift || gift.totalCoins < config.gift_minimum) return;
  const day = rewardDay(gift.createdAt);
  if (config.gift_enabled) {
    const [sum] = await tx.$queryRaw<{ amount: bigint }[]>`SELECT COALESCE(sum(amount),0) AS amount
      FROM member_reward_entitlements WHERE user_id=${gift.senderId} AND kind='GIFT' AND reward_day=${day}::date`;
    if (Number(sum.amount) + config.gift_amount <= config.gift_daily_limit) {
      await insertEntitlement(tx, {
        userId: gift.senderId,
        kind: 'GIFT',
        sourceKey: giftId,
        amount: config.gift_amount,
        version: config.version,
        day,
        giftId,
      });
    }
  }
  if (config.referral_enabled) {
    const referral = await tx.referral.findUnique({ where: { referredUserId: gift.senderId } });
    if (referral && referral.referrerUserId !== gift.senderId) {
      await insertEntitlement(tx, {
        userId: referral.referrerUserId,
        kind: 'REFERRAL',
        sourceKey: referral.id,
        amount: config.referral_amount,
        version: config.version,
        day,
        giftId,
      });
    }
  }
}

async function earnDailyReward(userId: string) {
  return prisma.$transaction(async (tx) => {
    const config = await lockRewardConfig(tx);
    await lockUserEconomicScope(tx, `member-daily:${userId}`);
    const [actor] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM users WHERE id=${userId} AND status='ACTIVE' FOR SHARE`;
    if (!actor) throw ApiError.forbidden('Active account required');
    const [now] = await tx.$queryRaw<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
    const day = rewardDay(now.at);
    const [existing] = await tx.$queryRaw<Entitlement[]>`SELECT * FROM member_reward_entitlements
      WHERE user_id=${userId} AND kind='DAILY' AND source_key=${day}`;
    if (existing) return { id: existing.id, alreadyEarned: true };
    if (!config.daily_enabled) return null;
    await insertEntitlement(tx, {
      userId,
      kind: 'DAILY',
      sourceKey: day,
      amount: config.daily_amount,
      version: config.version,
      day,
    });
    const [earned] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM member_reward_entitlements
      WHERE user_id=${userId} AND kind='DAILY' AND source_key=${day}`;
    return { id: earned.id, alreadyEarned: false };
  });
}

// Kept for existing callers. Member activity no longer requires a claim action.
export async function checkIn(userId: string) {
  const earned = await earnDailyReward(userId);
  if (!earned) throw ApiError.conflict('Daily rewards are currently unavailable');
  return earned;
}

export async function claimEntitlement(userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    await lockUserEconomicScope(tx, `member-claim:${id}`);
    const [actor] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM users WHERE id=${userId} AND status='ACTIVE' FOR SHARE`;
    if (!actor) throw ApiError.forbidden('Active account required');
    const [entitlement] = await tx.$queryRaw<
      Entitlement[]
    >`SELECT * FROM member_reward_entitlements WHERE id=${id} AND user_id=${userId}`;
    if (!entitlement) throw ApiError.notFound('Reward not found');
    if (entitlement.claimed_at) return { alreadyClaimed: true };
    await grantReward(
      userId,
      {
        sourceType: 'MEMBER_PROMOTION',
        sourceId: id,
        xpReward: 0,
        coinReward: entitlement.amount,
        gamePointReward: 0,
        requireCoinReward: true,
      },
      tx
    );
    const claim = await tx.rewardClaim.findUniqueOrThrow({
      where: {
        userId_sourceType_sourceId: { userId, sourceType: 'MEMBER_PROMOTION', sourceId: id },
      },
    });
    await tx.$executeRaw`UPDATE member_reward_entitlements SET claimed_at=clock_timestamp(), claim_id=${claim.id} WHERE id=${id}`;
    return { alreadyClaimed: false };
  });
}

/** Durable entitlements are the delivery queue. Attempts never change the
 * earned amount, and an unavailable wallet cannot consume or lose a reward. */
export async function deliverPendingRewards(scope: { userId?: string; giftId?: string } = {}) {
  const rows = await prisma.$queryRaw<{ id: string; user_id: string }[]>`
    SELECT id,user_id FROM member_reward_entitlements
    WHERE claim_id IS NULL AND next_attempt_at <= clock_timestamp()
      AND (${scope.userId ?? null}::text IS NULL OR user_id=${scope.userId ?? null})
      AND (${scope.giftId ?? null}::text IS NULL OR gift_transaction_id=${scope.giftId ?? null})
    ORDER BY next_attempt_at,created_at,id LIMIT 50`;
  let credited = 0;
  for (const row of rows) {
    try {
      const result = await claimEntitlement(row.user_id, row.id);
      if (!result.alreadyClaimed) credited++;
    } catch {
      // Move unavailable wallets behind other work. The conditional update is
      // safe if a concurrent login, purchase replay or API instance paid it.
      await prisma.$executeRaw`UPDATE member_reward_entitlements
        SET next_attempt_at=clock_timestamp()+interval '5 minutes'
        WHERE id=${row.id} AND claim_id IS NULL`;
    }
  }
  return { credited };
}

export async function processMemberActivity(userId: string) {
  const daily = await earnDailyReward(userId);
  const delivery = await deliverPendingRewards({ userId });
  return { id: daily?.id, earned: !!daily && !daily.alreadyEarned, ...delivery };
}

// Runs in the API process, whose database role owns monetary reward delivery.
// The restricted practice worker must never be used for real-Birr credits.
export function startRewardDelivery(report: () => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      await deliverPendingRewards();
    } catch {
      report();
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), 30_000);
        timer.unref();
      }
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export async function ensureReferralCode(userId: string) {
  // Older accounts may not have a code. Conditional update preserves the winner.
  for (let i = 0; i < 10; i++) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { referralCode: true },
    });
    if (user.referralCode) return { code: user.referralCode };
    try {
      await prisma.user.updateMany({
        where: { id: userId, referralCode: null, status: 'ACTIVE' },
        data: { referralCode: generateReferralCode() },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }
  throw ApiError.conflict('Referral code could not be created. Please try again.');
}

export async function rewardSummary(userId: string, page = 0) {
  const [config, wallet, user, referrals, rows, totals, eligibility, now] = await Promise.all([
    readConfig(),
    getWalletBalance(userId),
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true } }),
    prisma.referral.count({ where: { referrerUserId: userId } }),
    prisma.$queryRaw<
      Entitlement[]
    >`SELECT id,kind,amount,created_at,claimed_at,reward_day::text FROM member_reward_entitlements
      WHERE user_id=${userId} ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET ${page * 20}`,
    prisma.$queryRaw<{ pending: bigint; earned: bigint; qualified: bigint }[]>`SELECT
      COALESCE(sum(amount) FILTER (WHERE claim_id IS NULL),0) AS pending,
      COALESCE(sum(amount),0) AS earned, count(*) FILTER (WHERE kind='REFERRAL') AS qualified
      FROM member_reward_entitlements WHERE user_id=${userId}`,
    prisma.$transaction(async (tx) => {
      const policy = await tryActiveBonusGrantPolicy(tx, userId);
      return { canClaim: !!policy, expiryHours: policy?.bonusExpiryHours ?? null };
    }),
    prisma.$queryRaw<{ at: Date }[]>`SELECT clock_timestamp() AS at`,
  ]);
  const day = rewardDay(now[0].at);
  const [today] = await prisma.$queryRaw<
    { id: string; claimed_at: Date | null }[]
  >`SELECT id,claimed_at
    FROM member_reward_entitlements WHERE user_id=${userId} AND kind='DAILY' AND source_key=${day}`;
  return {
    config,
    wallet,
    eligibility,
    referralCode: user.referralCode,
    referrals,
    qualifiedReferrals: Number(totals[0].qualified),
    pendingMinor: Number(totals[0].pending),
    earnedMinor: Number(totals[0].earned),
    today: today ?? null,
    day,
    nextCheckInAt: new Date(Date.parse(`${day}T21:00:00Z`)).toISOString(),
    history: rows.slice(0, 20),
    hasMore: rows.length > 20,
  };
}

export async function adminSummary() {
  const [config, history, gates] = await Promise.all([
    readConfig(),
    prisma.$queryRaw`SELECT a.id,a."createdAt",a."newData",json_build_object('username',u.username) AS "user"
      FROM audit_logs a LEFT JOIN users u ON u.id=a."userId"
      WHERE a.action='MEMBER_REWARD_CONFIG_UPDATED' ORDER BY a."createdAt" DESC LIMIT 10`,
    prisma.platformGate.findMany({
      where: { key: { in: ['BONUS_GRANT', 'CASINO_PLAY', 'WITHDRAWAL_CREATE'] } },
      select: { key: true, enabled: true },
    }),
  ]);
  return { config, history, gates };
}
