import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';
import { applyBalanceChanges, getOrCreateWallet } from '../economy/wallet-service.js';
import type { BalanceChange } from '../economy/wallet-service.js';
import { creditCoins, lockEconomicWallet, lockUserEconomicScope } from '../economy/coin-ledger-service.js';
import { tryActiveBonusGrantPolicy } from '../economy/jurisdiction-service.js';
import { applyXp } from '../progress/progress-service.js';

export interface RewardGrant {
  sourceType: string; // 'TASK' | 'ACHIEVEMENT' | 'DAILY_LOGIN' | ...
  sourceId: string;   // TaskDefinition.id / Achievement.id
  xpReward: number;
  coinReward: number;
  gamePointReward: number;
}

export interface GrantResult {
  granted: boolean;
  alreadyClaimed: boolean;
  xp: number;
  level: number;
  coinsBalance: number;
  gamePointsBalance: number;
}

/**
 * Authoritative reward service.
 *
 * A reward (possibly including Coins / Game Points) is granted exactly once.
 * The `RewardClaim` unique constraint (userId, sourceType, sourceId) prevents
 * duplicate claims. XP is awarded through the shared XP path; wallet-changing
 * rewards are granted through the shared authoritative economy path
 * (`applyBalanceChanges`) inside the same transaction so that a reward can
 * never partially apply or double-apply.
 *
 * Reward amounts are ALWAYS computed server-side from definitions; they are
 * never read from the client.
 *
 * When `callerTx` is supplied, the reward is applied within that caller's
 * transaction (used by achievement-service for atomic unlock+reward).
 * Otherwise a new transaction is created.
 */
export async function grantReward(
  userId: string,
  reward: RewardGrant,
  callerTx?: any
): Promise<GrantResult> {
  const { sourceType, sourceId, xpReward, coinReward, gamePointReward } = reward;

  for (const v of [xpReward, coinReward, gamePointReward]) {
    if (!Number.isInteger(v) || v < 0) {
      throw ApiError.badRequest('Reward amounts must be non-negative integers');
    }
  }

  const doGrant = async (tx: any): Promise<GrantResult> => {
    // L0 serializes the claim before the replay read.
    await lockUserEconomicScope(tx, `reward:${userId}:${sourceType}:${sourceId}`);
    const existing = await tx.rewardClaim.findUnique({
      where: { userId_sourceType_sourceId: { userId, sourceType, sourceId } },
    });

    if (existing) {
      const current = await tx.userProgress.findUnique({ where: { userId } });
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      return {
        granted: false,
        alreadyClaimed: true,
        xp: current?.xp ?? 0,
        level: current?.level ?? 1,
        coinsBalance: wallet?.coinsBalance ?? 0,
        gamePointsBalance: wallet?.gamePointsBalance ?? 0,
      };
    }

    // L1 user before L2 payout jurisdiction / L3 policy. Existing reward
    // entitlement remains payable to a user whose account was later suspended.
    const users = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${userId} FOR SHARE
    `;
    if (!users[0]) throw ApiError.notFound('Reward recipient not found');
    const policy = coinReward > 0 ? await tryActiveBonusGrantPolicy(tx, userId) : null;
    const creditedCoins = policy ? coinReward : 0;
    const requirementAmount = policy ? Math.ceil(coinReward * policy.playthroughMultiplier) : 0;
    if (policy && (!Number.isSafeInteger(requirementAmount) || requirementAmount <= 0 ||
                   requirementAmount > 2_000_000_000)) {
      throw ApiError.forbidden('Configured bonus playthrough exceeds the supported limit');
    }

    const progress = xpReward > 0
      ? await applyXp(tx, userId, {
          amount: xpReward,
          reason: `Reward: ${sourceType} ${sourceId}`,
          referenceType: sourceType,
          referenceId: sourceId,
        })
      : await tx.userProgress.upsert({
          where: { userId }, update: {}, create: { userId },
        });

    // L5 wallet serializes all same-user reward writes. GP-only rewards must
    // remain available while a historical Coin account awaits classification.
    if (creditedCoins > 0) {
      await lockEconomicWallet(tx, userId);
    } else {
      await getOrCreateWallet(userId, tx);
      await tx.$queryRaw`SELECT id FROM wallets WHERE "userId" = ${userId} FOR UPDATE`;
    }
    const claimId = randomUUID();
    const walletReferenceType =
      sourceType === 'ACHIEVEMENT' ? ('ACHIEVEMENT' as const) : ('TASK' as const);
    if (creditedCoins > 0 && policy) {
      const expiryHours = policy.bonusExpiryHours;
      await creditCoins(tx, userId, creditedCoins, {
        type: 'BONUS_GRANT', scopeType: 'REWARD_CLAIM', scopeId: claimId,
        referenceType: walletReferenceType, referenceId: sourceId,
        description: `${sourceType} Coin reward`,
        provenanceType: sourceType === 'TASK' ? 'TASK_REWARD' : 'PROMOTION',
        originalGrantReferenceType: sourceType,
        originalGrantReferenceId: sourceId,
        policy: { id: policy.id, version: policy.version }, requirementAmount,
        expiresAt: expiryHours === null ? null : new Date(Date.now() + expiryHours * 3_600_000),
      });
    }
    if (gamePointReward > 0) {
      const change: BalanceChange = {
        currency: 'GAME_POINTS', amount: gamePointReward, ledgerType: 'CREDIT',
        transactionType: 'GAME_POINT_CREDIT', referenceType: walletReferenceType,
        referenceId: sourceId, description: `${sourceType} reward`,
      };
      await applyBalanceChanges(tx, userId, [change]);
    }
    await tx.rewardClaim.create({
      data: { id: claimId, userId, sourceType, sourceId, xpReward,
        coinReward: creditedCoins, gamePointReward },
    });
    if (coinReward > 0 && !policy) {
      await tx.auditLog.create({ data: {
        userId, action: 'BONUS_GRANT_SKIPPED', entity: 'REWARD_CLAIM',
        entityId: claimId,
        newData: { sourceType, sourceId, requestedCoinReward: coinReward,
          reason: 'NO_ACTIVE_BONUS_POLICY' },
      } });
    }
    const finalWallet = await tx.wallet.findUniqueOrThrow({ where: { userId },
      select: { coinsBalance: true, gamePointsBalance: true } });
    const grantResult: GrantResult = {
      granted: true, alreadyClaimed: false, xp: progress.xp, level: progress.level,
      coinsBalance: finalWallet.coinsBalance,
      gamePointsBalance: finalWallet.gamePointsBalance,
    };
    return grantResult;
  };

  if (callerTx) {
    // Run within the caller's transaction. P2002 is handled by the caller.
    return doGrant(callerTx);
  }

  try {
    return await prisma.$transaction(async (tx) => doGrant(tx));
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return {
        granted: false,
        alreadyClaimed: true,
        xp: 0,
        level: 0,
        coinsBalance: 0,
        gamePointsBalance: 0,
      };
    }
    throw err;
  }
}
