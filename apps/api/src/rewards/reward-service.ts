import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { getOrCreateWallet, applyBalanceChanges, BalanceChange } from '../economy/wallet-service';
import { applyXp } from '../progress/progress-service';

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

  // Ensure the authoritative wallet exists before the transaction.
  await getOrCreateWallet(userId);

  const doGrant = async (tx: any): Promise<GrantResult> => {
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

    await tx.rewardClaim.create({
      data: { userId, sourceType, sourceId, xpReward, coinReward, gamePointReward },
    });

    const progress = xpReward > 0
      ? await applyXp(tx, userId, {
          amount: xpReward,
          reason: `Reward: ${sourceType} ${sourceId}`,
          referenceType: sourceType,
          referenceId: sourceId,
        })
      : await tx.userProgress.upsert({
          where: { userId },
          update: {},
          create: { userId },
        });

    const changes: BalanceChange[] = [];
    const walletReferenceType =
      sourceType === 'ACHIEVEMENT' ? ('ACHIEVEMENT' as const) : ('TASK' as const);
    if (coinReward > 0) {
      changes.push({
        currency: 'COINS' as const,
        amount: coinReward,
        ledgerType: 'CREDIT' as const,
        transactionType: 'COIN_CREDIT' as const,
        referenceType: walletReferenceType,
        referenceId: sourceId,
        description: `${sourceType} reward`,
      });
    }
    if (gamePointReward > 0) {
      changes.push({
        currency: 'GAME_POINTS' as const,
        amount: gamePointReward,
        ledgerType: 'CREDIT' as const,
        transactionType: 'GAME_POINT_CREDIT' as const,
        referenceType: walletReferenceType,
        referenceId: sourceId,
        description: `${sourceType} reward`,
      });
    }

    const walletResult =
      changes.length > 0 ? await applyBalanceChanges(tx, userId, changes) : null;

    const grantResult: GrantResult = {
      granted: true,
      alreadyClaimed: false,
      xp: progress.xp,
      level: progress.level,
      coinsBalance: walletResult?.coinsBalance ?? 0,
      gamePointsBalance: walletResult?.gamePointsBalance ?? 0,
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
