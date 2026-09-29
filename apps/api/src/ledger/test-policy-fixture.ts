import { prisma } from '@socialplay/database';

/** Test-only schema probe so the same suite proves failure on 7b84d99 and
 * then exercises the forward-only policy-pointer migration. */
export async function hasLedgerPolicyPointer(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('public.country_jurisdictions') IS NOT NULL AS present
  `;
  return rows[0].present;
}

/** Explicit administrator attestation. M6's deferred constraints verify that
 * the new ACTIVE version and the country pointer agree at commit. */
export async function activateTestPolicy(policyId: string, countryCode: string, adminId: string) {
  if (!await hasLedgerPolicyPointer()) return;
  const required = [
    'minWithdrawal', 'maxWithdrawal', 'dailyWithdrawalLimit', 'monthlyWithdrawalLimit',
    'playthroughMultiplier', 'qualifyingGames', 'maxQualifyingStake',
    'holdingPeriodHours', 'giftDailyLimit', 'kycTierRequired',
    'supportedPaymentMethods', 'withdrawalFeePercent', 'manualReviewThreshold',
  ];
  const attestation = Object.fromEntries(required.map((field) => [field, 'SET']));
  Object.assign(attestation, { maxConversionMultiple: 'NONE', bonusExpiryHours: 'NONE' });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'INSERT INTO country_jurisdictions ("countryCode", "activePolicyId") VALUES ($1, NULL) ON CONFLICT ("countryCode") DO NOTHING',
      countryCode,
    );
    await tx.$executeRawUnsafe(
      `UPDATE country_casino_policies SET "state"='ACTIVE',
         "thresholdsConfiguredAt"=CURRENT_TIMESTAMP, "configurationAttestation"=$2::jsonb,
         "configuredBy"=$3, "activatedAt"=CURRENT_TIMESTAMP, "activatedBy"=$3
       WHERE "id"=$1`,
      policyId, JSON.stringify(attestation), adminId,
    );
    await tx.$executeRawUnsafe(
      'UPDATE country_jurisdictions SET "activePolicyId"=$2 WHERE "countryCode"=$1',
      countryCode, policyId,
    );
  });
}

export async function disableTestPolicy(policyId: string, countryCode: string) {
  if (!await hasLedgerPolicyPointer()) {
    await prisma.countryCasinoPolicy.update({
      where: { id: policyId }, data: { status: 'DISABLED', disabledAt: new Date() },
    });
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'UPDATE country_jurisdictions SET "activePolicyId"=NULL WHERE "countryCode"=$1 AND "activePolicyId"=$2',
      countryCode, policyId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE country_casino_policies SET "state"='SUPERSEDED', "status"='DISABLED',
         "disabledAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
      policyId,
    );
  });
}
