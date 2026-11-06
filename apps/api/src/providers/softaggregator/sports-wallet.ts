import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { ApiError } from '../../middleware/api-error.js';
import {
  applySportsCashMovement,
  lockEconomicWallet,
  lockUserEconomicScope,
} from '../../economy/coin-ledger-service.js';
import { resolveJurisdictionForPlay } from '../../economy/jurisdiction-service.js';
import { lockUserForPlay } from '../../games/game-locks.js';
import type { TestMovement, WalletReply } from './test-wallet.js';
import { sportsGameId, type SportsEnv } from './sports-config.js';

type Tx = Prisma.TransactionClient;
type Player = {
  user_id: string;
  username: string;
  game_id: string;
  policy_id: string | null;
  policy_version: number | null;
  live_started_at: Date | null;
};
type Admission = {
  enabled: boolean;
  reason: 'not-live' | 'account-unavailable' | null;
  policy?: { id: string; version: number };
};
export async function sportsCashBalance(tx: Tx, userId: string) {
  const [row] = await tx.$queryRaw<{ cash: bigint; bonus: bigint }[]>`
    SELECT COALESCE(sum(p."availableAmount") FILTER(WHERE p."lotClass"='WITHDRAWABLE' AND p.state='OPEN'),0)::bigint AS cash,
      COALESCE(sum(p."availableAmount") FILTER(WHERE p."lotClass"='RESTRICTED' AND p.state='OPEN' AND (p."expiresAt" IS NULL OR p."expiresAt">clock_timestamp())),0)::bigint AS bonus
    FROM coin_provenance p JOIN coin_ledger_accounts a ON a."userId"=p."userId" AND a."classifiedAt" IS NOT NULL
    WHERE p."userId"=${userId}`;
  return { balanceMinor: Number(row?.cash ?? 0), rewardBalanceMinor: Number(row?.bonus ?? 0) };
}

/** Rechecked on every new stake under transactional gate/account locks. */
export async function sportsAdmission(tx: Tx, userId: string, env: SportsEnv): Promise<Admission> {
  if (env.SOFTAGGREGATOR_SPORTS_LIVE_ENABLED !== 'true')
    return { enabled: false, reason: 'not-live' };
  const gates = await tx.$queryRaw<{ key: string; enabled: boolean }[]>`
    SELECT key,enabled FROM platform_gates WHERE key IN ('CASINO_PLAY','SPORTSBOOK_PLAY') ORDER BY key FOR SHARE`;
  if (gates.length !== 2 || gates.some((g) => !g.enabled))
    return { enabled: false, reason: 'not-live' };
  const resolution = await resolveJurisdictionForPlay(tx, userId);
  if (
    !resolution.policy ||
    resolution.country?.code !== (env.SOFTAGGREGATOR_SPORTS_COUNTRY || 'ET')
  )
    return { enabled: false, reason: 'account-unavailable' };
  if (resolution.policy.kycTierRequired > 0) {
    const rows = await tx.$queryRaw<{ verifiedTier: number }[]>`
      SELECT "verifiedTier" FROM user_kyc_verifications WHERE "userId"=${userId} AND status='VERIFIED' FOR SHARE`;
    if (!rows[0] || rows[0].verifiedTier < resolution.policy.kycTierRequired)
      return { enabled: false, reason: 'account-unavailable' };
  }
  return { enabled: true, reason: null, policy: resolution.policy };
}

export function createSportsWallet(db: PrismaClient, env: SportsEnv = process.env) {
  async function snapshot(userId: string) {
    return db.$transaction(async (tx) => {
      await lockUserForPlay(tx, userId);
      const admission = await sportsAdmission(tx, userId, env);
      const balance = await sportsCashBalance(tx, userId);
      return {
        ...balance,
        liveEnabled: admission.enabled,
        canBet: admission.enabled && balance.balanceMinor > 0,
        reason: admission.reason ?? (balance.balanceMinor === 0 ? ('empty-wallet' as const) : null),
        currency: 'ETB' as const,
      };
    });
  }
  async function ensurePlayer(userId: string) {
    return db.$transaction(async (tx) => {
      await lockUserForPlay(tx, userId);
      const admission = await sportsAdmission(tx, userId, env);
      const username = `sr_${randomBytes(16).toString('hex')}`;
      await tx.$executeRaw`INSERT INTO sg_sports_players(user_id,username,game_id)
        VALUES(${userId},${username},${sportsGameId(env)}) ON CONFLICT(user_id) DO NOTHING`;
      const [p] = await tx.$queryRaw<
        Player[]
      >`SELECT * FROM sg_sports_players WHERE user_id=${userId} FOR UPDATE`;
      if (p.game_id !== sportsGameId(env))
        throw ApiError.conflict('Sportsbook configuration changed; please contact support.');
      const balance = await sportsCashBalance(tx, userId);
      if (admission.enabled && balance.balanceMinor > 0 && !p.live_started_at) {
        await tx.$executeRaw`UPDATE sg_sports_players SET live_started_at=clock_timestamp(),policy_id=${admission.policy!.id},policy_version=${admission.policy!.version} WHERE user_id=${userId}`;
      }
      return p;
    });
  }
  async function apply(m: TestMovement): Promise<WalletReply> {
    if (
      env.SOFTAGGREGATOR_SPORTS_CALLBACK_ENABLED !== 'true' ||
      m.currency !== 'ETB' ||
      !/^sr_[a-f0-9]{32}$/.test(m.username)
    )
      return { error: 2, balance: 0 };
    return db.$transaction(
      async (tx) => {
        // Same call ID is serialized even if a faulty sender changes the player.
        if (m.action !== 'balance') await lockUserEconomicScope(tx, `sports-call:${m.callId}`);
        const [identity] = await tx.$queryRaw<
          Player[]
        >`SELECT * FROM sg_sports_players WHERE username=${m.username}`;
        if (!identity || (m.action !== 'balance' && m.gameId !== identity.game_id))
          return { error: 2, balance: 0 };
        const [user] = await tx.$queryRaw<
          { status: string }[]
        >`SELECT status FROM users WHERE id=${identity.user_id} FOR SHARE`;
        if (!user) return { error: 2, balance: 0 };
        const fingerprint = createHash('sha256').update(JSON.stringify(m)).digest('hex');
        if (m.action !== 'balance') {
          const [receipt] = await tx.$queryRaw<
            { request_hash: string; error: 0 | 1 | 2; balance_minor: number }[]
          >`
          SELECT request_hash,error,balance_minor FROM sg_sports_movements WHERE call_id=${m.callId}`;
          if (receipt)
            return receipt.request_hash === fingerprint
              ? { error: receipt.error, balance: receipt.balance_minor }
              : { error: 2, balance: 0 };
        }
        const admission: Admission =
          user.status === 'ACTIVE'
            ? await sportsAdmission(tx, identity.user_id, env)
            : { enabled: false, reason: 'account-unavailable' as const };
        const [p] = await tx.$queryRaw<
          Player[]
        >`SELECT * FROM sg_sports_players WHERE username=${m.username} FOR UPDATE`;
        await lockEconomicWallet(tx, p.user_id);
        const balance = await sportsCashBalance(tx, p.user_id);
        if (
          !p.live_started_at &&
          admission.enabled &&
          balance.balanceMinor > 0 &&
          (m.action === 'balance' || m.action === 'debit')
        ) {
          await tx.$executeRaw`UPDATE sg_sports_players SET live_started_at=clock_timestamp(),policy_id=${admission.policy!.id},policy_version=${admission.policy!.version} WHERE user_id=${p.user_id}`;
          p.live_started_at = new Date();
          p.policy_id = admission.policy!.id;
          p.policy_version = admission.policy!.version;
        }
        if (m.action === 'balance')
          return { error: 0, balance: admission.enabled ? balance.balanceMinor : 0 };
        if (!Number.isSafeInteger(m.amount) || m.amount < 0 || m.amount > 1_000_000_000)
          return { error: 2, balance: 0 };
        let error: 0 | 1 | 2 = 0,
          after = balance.balanceMinor,
          operationId: string | null = null;
        // Credits and rollback adjustments from a previously admitted live session
        // may settle after a pause or suspension. Preview identities cannot mint.
        if (
          !p.live_started_at ||
          (m.action === 'debit' && m.rollback !== '1' && !admission.enabled)
        )
          error = 2;
        else if (m.action === 'debit' && m.amount > balance.balanceMinor) error = 1;
        if (!error && m.amount > 0) {
          const result = await applySportsCashMovement(tx, p.user_id, {
            callId: m.callId,
            action: m.action,
            amount: m.amount,
            requestHash: fingerprint,
            policy: { id: p.policy_id!, version: p.policy_version! },
            roundId: m.roundId,
            gameId: m.gameId,
          });
          after = result.balanceMinor;
          operationId = result.operationId;
        }
        await tx.$executeRaw`INSERT INTO sg_sports_movements(call_id,username,request_hash,action,amount_minor,error,balance_minor,round_id,game_id,rollback,operation_id)
        VALUES(${m.callId},${m.username},${fingerprint},${m.action},${m.amount},${error},${after},${m.roundId},${m.gameId},${m.rollback === '1'},${operationId})`;
        // Do not report success before Prisma/PostgreSQL deferred proofs run.
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS sg_sports_receipt_proof,sg_sports_operation_proof,sg_sports_entry_proof IMMEDIATE'
        );
        return { error, balance: after };
      },
      { timeout: 15_000 }
    );
  }
  return { snapshot, ensurePlayer, apply };
}
