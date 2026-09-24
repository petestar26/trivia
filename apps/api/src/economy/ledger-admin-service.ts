import { prisma } from '@socialplay/database';
import type { Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';
import { runLedgerInvariantCheckInTransaction } from './ledger-invariant-checker.js';
import type { LedgerBehaviorEvidence } from './ledger-invariant-checker.js';

type Tx = Prisma.TransactionClient;
export type ReleasableGate = 'CASINO_PLAY' | 'BONUS_GRANT' | 'WITHDRAWAL_CREATE';
export type LedgerGate = ReleasableGate | 'COINS_COMPETITION_PRIZES';

async function requireSuperAdmin(tx: Tx, actorId: string): Promise<void> {
  const rows = (await tx.$queryRaw`
    SELECT "id" FROM "users" WHERE "id"=${actorId}
      AND "status"='ACTIVE' AND "role"='SUPER_ADMIN' FOR SHARE
  `) as { id: string }[];
  if (rows.length !== 1) throw ApiError.forbidden('Active SUPER_ADMIN required');
}

async function lockJurisdiction(tx: Tx, countryCode: string): Promise<void> {
  // New countries may have been added after M5. Make their serialization row
  // before any version read, then lock it just like a migrated country.
  await tx.$executeRaw`
    INSERT INTO "country_jurisdictions" ("countryCode")
    SELECT "code" FROM "countries" WHERE "code"=${countryCode}
    ON CONFLICT ("countryCode") DO NOTHING
  `;
  const rows = (await tx.$queryRaw`
    SELECT "countryCode" FROM "country_jurisdictions"
    WHERE "countryCode"=${countryCode} FOR UPDATE
  `) as { countryCode: string }[];
  if (rows.length !== 1) throw ApiError.notFound('Country jurisdiction not found');
}

export interface CompleteCountryPolicyConfig {
  minWithdrawal: number;
  maxWithdrawal: number;
  dailyWithdrawalLimit: number;
  monthlyWithdrawalLimit: number;
  playthroughMultiplier: number;
  qualifyingGames: string[];
  maxQualifyingStake: number;
  holdingPeriodHours: number;
  giftDailyLimit: number;
  kycTierRequired: number;
  supportedPaymentMethods: string[];
  withdrawalFeePercent: number;
  manualReviewThreshold: number;
  maxConversionMultiple: number | null;
  bonusExpiryHours: number | null;
}

const requiredFields: (keyof CompleteCountryPolicyConfig)[] = [
  'minWithdrawal', 'maxWithdrawal', 'dailyWithdrawalLimit', 'monthlyWithdrawalLimit',
  'playthroughMultiplier', 'qualifyingGames', 'maxQualifyingStake',
  'holdingPeriodHours', 'giftDailyLimit', 'kycTierRequired',
  'supportedPaymentMethods', 'withdrawalFeePercent', 'manualReviewThreshold',
  'maxConversionMultiple', 'bonusExpiryHours',
];

function validateConfig(config: CompleteCountryPolicyConfig): Record<string, string> {
  if (!config || requiredFields.some((key) =>
    !Object.prototype.hasOwnProperty.call(config, key))) {
    throw ApiError.badRequest('Every country policy threshold must be explicitly configured');
  }
  const intFields: (keyof CompleteCountryPolicyConfig)[] = [
    'minWithdrawal', 'maxWithdrawal', 'dailyWithdrawalLimit', 'monthlyWithdrawalLimit',
    'maxQualifyingStake', 'holdingPeriodHours', 'giftDailyLimit',
    'kycTierRequired', 'manualReviewThreshold',
  ];
  if (intFields.some((key) => !Number.isSafeInteger(config[key]))) {
    throw ApiError.badRequest('Coin limits and tier thresholds must be integers');
  }
  if (config.minWithdrawal <= 0 || config.maxWithdrawal < config.minWithdrawal
      || config.dailyWithdrawalLimit < 0 || config.monthlyWithdrawalLimit < 0
      || config.maxQualifyingStake <= 0 || config.holdingPeriodHours < 0
      || config.giftDailyLimit < 0 || config.kycTierRequired < 0
      || config.manualReviewThreshold < 0 || !Number.isFinite(config.playthroughMultiplier)
      || config.playthroughMultiplier <= 0 || !Number.isFinite(config.withdrawalFeePercent)
      || config.withdrawalFeePercent < 0 || config.withdrawalFeePercent > 1
      || !Array.isArray(config.qualifyingGames) || config.qualifyingGames.length === 0
      || config.qualifyingGames.some((v) => typeof v !== 'string' || !v)
      || !Array.isArray(config.supportedPaymentMethods)
      || config.supportedPaymentMethods.length === 0
      || config.supportedPaymentMethods.some((v) => typeof v !== 'string' || !v)
      || (config.maxConversionMultiple !== null &&
          (!Number.isFinite(config.maxConversionMultiple) || config.maxConversionMultiple <= 0))
      || (config.bonusExpiryHours !== null &&
          (!Number.isSafeInteger(config.bonusExpiryHours) || config.bonusExpiryHours <= 0))) {
    throw ApiError.badRequest('Country policy thresholds are invalid or incomplete');
  }
  const attestation = Object.fromEntries(requiredFields.map((key) => [key, 'SET'])) as Record<string, string>;
  attestation.maxConversionMultiple = config.maxConversionMultiple === null ? 'NONE' : 'VALUE';
  attestation.bonusExpiryHours = config.bonusExpiryHours === null ? 'NONE' : 'VALUE';
  return attestation;
}

/** Create or update a DRAFT. No threshold default qualifies as an attestation. */
export async function configureCountryPolicyDraft(
  actorId: string, countryCode: string, config: CompleteCountryPolicyConfig,
  existingVersion?: number,
) {
  if (!/^[A-Z]{2}$/.test(countryCode)
      || (existingVersion !== undefined && (!Number.isSafeInteger(existingVersion) || existingVersion < 1))) {
    throw ApiError.badRequest('Invalid country code or version');
  }
  const attestation = validateConfig(config);
  return prisma.$transaction(async (tx) => {
    await requireSuperAdmin(tx, actorId); // L1
    await lockJurisdiction(tx, countryCode); // L3
    const versions = (await tx.$queryRaw`
      SELECT "id", "version", "state"::text AS "state"
      FROM "country_casino_policies" WHERE "countryCode"=${countryCode}
      ORDER BY "id" FOR UPDATE
    `) as { id: string; version: number; state: string }[];
    const prior = existingVersion === undefined ? null : versions.find((v) => v.version === existingVersion);
    if (existingVersion !== undefined && !prior) throw ApiError.notFound('Policy version not found');
    if (prior && prior.state !== 'DRAFT') throw ApiError.conflict('Only a DRAFT policy can be edited');
    const data = {
      ...config, status: 'DISABLED' as const, state: 'DRAFT' as const,
      thresholdsConfiguredAt: new Date(), configuredBy: actorId,
      configurationAttestation: attestation,
    };
    if (prior) return tx.countryCasinoPolicy.update({ where: { id: prior.id }, data });
    const version = versions.reduce((max, row) => Math.max(max, row.version), 0) + 1;
    return tx.countryCasinoPolicy.create({ data: { countryCode, version, ...data } });
  });
}

/** The jurisdiction row serializes activation against every settlement read. */
export async function activateCountryPolicy(actorId: string, countryCode: string, version: number) {
  if (!/^[A-Z]{2}$/.test(countryCode) || !Number.isSafeInteger(version) || version < 1) {
    throw ApiError.badRequest('Invalid country code or policy version');
  }
  return prisma.$transaction(async (tx) => {
    await requireSuperAdmin(tx, actorId); // L1
    await lockJurisdiction(tx, countryCode); // L3 FOR UPDATE
    const jurisdiction = await tx.countryJurisdiction.findUnique({ where: { countryCode } });
    const versions = (await tx.$queryRaw`
      SELECT "id", "version", "state"::text AS "state", "thresholdsConfiguredAt"
      FROM "country_casino_policies" WHERE "countryCode"=${countryCode}
      ORDER BY "id" FOR UPDATE
    `) as { id: string; version: number; state: string; thresholdsConfiguredAt: Date | null }[];
    const target = versions.find((p) => p.version === version);
    if (!target) throw ApiError.notFound('Policy version not found');
    if (jurisdiction?.activePolicyId === target.id && target.state === 'ACTIVE') {
      return { policyId: target.id, version, idempotent: true };
    }
    if (target.state !== 'DRAFT' || !target.thresholdsConfiguredAt) {
      throw ApiError.conflict('Policy is not a fully configured DRAFT');
    }
    const old = jurisdiction?.activePolicyId
      ? versions.find((p) => p.id === jurisdiction.activePolicyId) : null;
    if (jurisdiction?.activePolicyId && (!old || old.state !== 'ACTIVE')) {
      throw ApiError.internal('Country policy pointer is inconsistent');
    }
    if (old) await tx.countryCasinoPolicy.update({
      where: { id: old.id }, data: { state: 'SUPERSEDED', status: 'DISABLED', disabledAt: new Date() },
    });
    await tx.countryCasinoPolicy.update({
      where: { id: target.id }, data: { state: 'ACTIVE', status: 'ENABLED',
        activatedAt: new Date(), activatedBy: actorId, enabledAt: new Date() },
    });
    await tx.countryJurisdiction.update({
      where: { countryCode }, data: { activePolicyId: target.id, updatedAt: new Date() },
    });
    return { policyId: target.id, version, idempotent: false };
  });
}

export async function deactivateCountryPolicy(actorId: string, countryCode: string) {
  if (!/^[A-Z]{2}$/.test(countryCode)) throw ApiError.badRequest('Invalid country code');
  return prisma.$transaction(async (tx) => {
    await requireSuperAdmin(tx, actorId); // L1
    await lockJurisdiction(tx, countryCode); // L3 FOR UPDATE
    const jurisdiction = await tx.countryJurisdiction.findUnique({ where: { countryCode } });
    const currentId = jurisdiction?.activePolicyId;
    if (!currentId) return { countryCode, idempotent: true };
    await tx.countryCasinoPolicy.update({
      where: { id: currentId }, data: { state: 'SUPERSEDED', status: 'DISABLED', disabledAt: new Date() },
    });
    await tx.countryJurisdiction.update({
      where: { countryCode }, data: { activePolicyId: null, updatedAt: new Date() },
    });
    return { countryCode, idempotent: false };
  });
}

/** Disabling is immediate after current gate readers finish. */
export async function disableLedgerGate(actorId: string, key: LedgerGate) {
  return prisma.$transaction(async (tx) => {
    await requireSuperAdmin(tx, actorId);
    const rows = (await tx.$queryRaw`
      SELECT "key" FROM "platform_gates" WHERE "key"=${key} FOR UPDATE
    `) as { key: string }[];
    if (rows.length !== 1) throw ApiError.notFound('Ledger gate not found');
    return tx.platformGate.update({ where: { key }, data: {
      enabled: false, changedBy: actorId, changedAt: new Date(),
    } });
  });
}

/** A serialized maintenance scan gates value-producing runtime paths. */
export async function enableLedgerGate(
  actorId: string, key: ReleasableGate, evidence: LedgerBehaviorEvidence,
) {
  if (!(['CASINO_PLAY', 'BONUS_GRANT', 'WITHDRAWAL_CREATE'] as string[]).includes(key)) {
    throw ApiError.forbidden('COINS competition prizes remain disabled in G0');
  }
  return prisma.$transaction(async (tx) => {
    await requireSuperAdmin(tx, actorId);
    const rows = (await tx.$queryRaw`
      SELECT "key", "enabled" FROM "platform_gates" WHERE "key"=${key} FOR UPDATE
    `) as { key: string; enabled: boolean }[];
    if (rows.length !== 1) throw ApiError.notFound('Ledger gate not found');
    // A single table-lock statement gives the checker a stable economic
    // snapshot while this gate's readers are excluded by FOR UPDATE above.
    await tx.$executeRawUnsafe(`LOCK TABLE
      "wallets", "wallet_transactions", "coin_provenance", "coin_lot_entries",
      "economic_operations", "coin_ledger_accounts", "legacy_balance_reviews",
      "withdrawal_holds", "country_jurisdictions", "country_casino_policies",
      "game_sessions" IN SHARE MODE`);
    const run = await runLedgerInvariantCheckInTransaction(tx, evidence, true);
    if (!run.passed) return { enabled: false, runId: run.runId, violations: run.violations };
    await tx.platformGate.update({ where: { key }, data: {
      enabled: true, changedBy: actorId, changedAt: new Date(), lastInvariantRunId: run.runId,
    } });
    return { enabled: true, runId: run.runId, violations: [] };
  }, { isolationLevel: 'Serializable', timeout: 120_000 });
}
