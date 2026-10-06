import type { Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';

type Tx = Prisma.TransactionClient;

export interface ActiveCasinoPolicy {
  id: string;
  version: number;
  countryCode: string;
  playthroughMultiplier: number;
  qualifyingGames: unknown;
  maxQualifyingStake: number;
  bonusExpiryHours: number | null;
  minWithdrawal: number;
  maxWithdrawal: number;
  dailyWithdrawalLimit: number;
  monthlyWithdrawalLimit: number;
  holdingPeriodHours: number;
  giftDailyLimit: number;
  kycTierRequired: number;
  manualReviewThreshold: number;
  supportedPaymentMethods: unknown;
  withdrawalFeePercent: number;
}

export interface JurisdictionResolution {
  country: { id: string; code: string } | null;
  policy: ActiveCasinoPolicy | null;
}

export interface PlayableJurisdiction {
  countryCode: string;
  policy: ActiveCasinoPolicy;
}

/** The gates are transactional rows. Turning one off waits for current readers. */
export async function requirePlatformGate(tx: Tx, key: string): Promise<void> {
  const rows = (await tx.$queryRaw`
    SELECT "enabled" FROM "platform_gates" WHERE "key" = ${key} FOR SHARE
  `) as { enabled: boolean }[];
  if (!rows[0]?.enabled) throw ApiError.forbidden('This financial service is not enabled');
}

async function activePolicyForCountry(tx: Tx, countryCode: string): Promise<ActiveCasinoPolicy | null> {
  const pointers = (await tx.$queryRaw`
    SELECT "activePolicyId" FROM "country_jurisdictions"
    WHERE "countryCode" = ${countryCode} FOR SHARE
  `) as { activePolicyId: string | null }[];
  const id = pointers[0]?.activePolicyId;
  if (!id) return null;
  const rows = (await tx.$queryRaw`
    SELECT p."id", p."version", p."countryCode", p."playthroughMultiplier",
           p."qualifyingGames", p."maxQualifyingStake", p."bonusExpiryHours",
           p."minWithdrawal", p."maxWithdrawal", p."dailyWithdrawalLimit",
           p."monthlyWithdrawalLimit", p."holdingPeriodHours", p."giftDailyLimit",
           p."kycTierRequired", p."manualReviewThreshold",
           p."supportedPaymentMethods", p."withdrawalFeePercent"
    FROM "country_casino_policies" p
    WHERE p."id" = ${id} AND p."countryCode" = ${countryCode}
      AND p."state" = 'ACTIVE' AND p."status" = 'ENABLED'
      AND p."thresholdsConfiguredAt" IS NOT NULL
    FOR SHARE
  `) as (Omit<ActiveCasinoPolicy, 'playthroughMultiplier' | 'withdrawalFeePercent'> & {
    playthroughMultiplier: { toNumber(): number } | number;
    withdrawalFeePercent: { toNumber(): number } | number;
  })[];
  const row = rows[0];
  if (!row) return null;
  return { ...row, playthroughMultiplier: typeof row.playthroughMultiplier === 'number'
    ? row.playthroughMultiplier : row.playthroughMultiplier.toNumber(),
    withdrawalFeePercent: typeof row.withdrawalFeePercent === 'number'
      ? row.withdrawalFeePercent : row.withdrawalFeePercent.toNumber() };
}

/** Caller already holds L1 user; this takes L2 account then L3 pointer/policy. */
export async function resolveJurisdictionForPlay(tx: Tx, userId: string): Promise<JurisdictionResolution> {
  await requirePlatformGate(tx, 'CASINO_PLAY');
  const accounts = (await tx.$queryRaw`
    SELECT c."id" AS "countryId", c."code" AS "countryCode"
    FROM "user_payout_accounts" upa
    JOIN "countries" c ON c."id" = upa."countryId"
    WHERE upa."userId" = ${userId} AND upa."status" = 'ACTIVE'
    ORDER BY upa."createdAt" DESC, upa."id" DESC LIMIT 1 FOR SHARE
  `) as { countryId: string; countryCode: string }[];
  const account = accounts[0];
  if (!account) return { country: null, policy: null };
  return {
    country: { id: account.countryId, code: account.countryCode },
    policy: await activePolicyForCountry(tx, account.countryCode),
  };
}

export function requirePlayableJurisdiction(resolution: JurisdictionResolution): PlayableJurisdiction {
  if (!resolution.country) {
    throw ApiError.forbidden('Jurisdiction could not be resolved; play is unavailable');
  }
  if (!resolution.policy) {
    throw ApiError.forbidden('Gaming is not available in your jurisdiction');
  }
  return { countryCode: resolution.country.code, policy: resolution.policy };
}

/** Caller has already locked the chosen payout account at L2. Never reselect it. */
export async function requireActiveWithdrawalPolicy(tx: Tx, userId: string, countryId: string) {
  await requirePlatformGate(tx, 'WITHDRAWAL_CREATE');
  const country = await tx.country.findUnique({ where: { id: countryId }, select: { code: true } });
  if (!country) throw ApiError.forbidden('Payout country is unavailable');
  const policy = await activePolicyForCountry(tx, country.code);
  if (!policy) throw ApiError.forbidden('Withdrawals are unavailable in this country');
  if (policy.kycTierRequired > 0) {
    const rows = (await tx.$queryRaw`
      SELECT "verifiedTier" FROM "user_kyc_verifications"
      WHERE "userId" = ${userId} AND "status" = 'VERIFIED' FOR SHARE
    `) as { verifiedTier: number }[];
    if (!rows[0] || rows[0].verifiedTier < policy.kycTierRequired) {
      throw ApiError.forbidden('Verified identity tier is insufficient for withdrawal');
    }
  }
  return { ...policy, countryId };
}

/** COINS→GP gifts are subject to the sender country’s configured Coin limit. */
export async function requireActiveGiftPolicy(tx: Tx, senderId: string): Promise<ActiveCasinoPolicy> {
  const accounts = (await tx.$queryRaw`
    SELECT c."code" AS "countryCode"
    FROM "user_payout_accounts" upa
    JOIN "countries" c ON c."id" = upa."countryId"
    WHERE upa."userId" = ${senderId} AND upa."status" = 'ACTIVE'
    ORDER BY upa."createdAt" DESC, upa."id" DESC LIMIT 1 FOR SHARE
  `) as { countryCode: string }[];
  if (!accounts[0]) throw ApiError.forbidden('Verified gift jurisdiction is unavailable');
  const policy = await activePolicyForCountry(tx, accounts[0].countryCode);
  if (!policy || policy.giftDailyLimit <= 0) {
    throw ApiError.forbidden('Coin gifts are unavailable in this country');
  }
  return policy;
}

/** Optional bonus authority: missing gate or jurisdiction skips the Coin portion
 * of a task/achievement reward while the GP/XP grant remains claimable. Caller
 * holds the User row at L1 before this helper takes L2 account and L3 policy. */
export async function tryActiveBonusGrantPolicy(tx: Tx, userId: string): Promise<ActiveCasinoPolicy | null> {
  const accounts = (await tx.$queryRaw`
    SELECT c."code" AS "countryCode"
    FROM "user_payout_accounts" upa
    JOIN "countries" c ON c."id" = upa."countryId"
    WHERE upa."userId" = ${userId} AND upa."status" = 'ACTIVE'
    ORDER BY upa."createdAt" DESC, upa."id" DESC LIMIT 1 FOR SHARE
  `) as { countryCode: string }[];
  if (!accounts[0]) return null;
  const gates = (await tx.$queryRaw`
    SELECT "enabled" FROM "platform_gates" WHERE "key" = 'BONUS_GRANT' FOR SHARE
  `) as { enabled: boolean }[];
  if (!gates[0]?.enabled) return null;
  return activePolicyForCountry(tx, accounts[0].countryCode);
}
