import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { creditCoins, lockUserEconomicScope } from '../economy/coin-ledger-service.js';
import { runLedgerInvariantCheck } from '../economy/ledger-invariant-checker.js';

/** Test-only country code that fits the policy's varchar(3) jurisdiction key. */
export async function nextTestCountryCode(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0').toUpperCase();
    if (!await prisma.country.findUnique({ where: { code }, select: { id: true } })) return code;
  }
  throw new Error('Could not allocate an unused test jurisdiction code');
}

/** Real policy rows and real gate, with every threshold explicitly attested. */
export async function activateTestWithdrawalPolicy(countryId: string, configuredBy: string): Promise<void> {
  const country = await prisma.country.findUniqueOrThrow({ where: { id: countryId } });
  if (country.code.length > 3) throw new Error('Test country code exceeds policy jurisdiction key');
  const attestation = Object.fromEntries([
    'minWithdrawal', 'maxWithdrawal', 'dailyWithdrawalLimit',
    'monthlyWithdrawalLimit', 'playthroughMultiplier', 'qualifyingGames',
    'maxQualifyingStake', 'holdingPeriodHours', 'giftDailyLimit',
    'kycTierRequired', 'supportedPaymentMethods', 'withdrawalFeePercent',
    'manualReviewThreshold',
  ].map((key) => [key, 'SET']));
  await prisma.$transaction(async (tx) => {
    const policy = await tx.countryCasinoPolicy.create({ data: {
      countryCode: country.code, version: 1, status: 'ENABLED', state: 'ACTIVE',
      minWithdrawal: 1, maxWithdrawal: 1_000_000_000,
      dailyWithdrawalLimit: 1_000_000_000, monthlyWithdrawalLimit: 1_000_000_000,
      playthroughMultiplier: 1, qualifyingGames: ['trivia_quiz'],
      maxQualifyingStake: 1_000_000_000, holdingPeriodHours: 0,
      giftDailyLimit: 1_000_000_000, kycTierRequired: 0,
      supportedPaymentMethods: ['BANK_TRANSFER', 'MOBILE_PAYMENT'],
      withdrawalFeePercent: 0, manualReviewThreshold: 1_000_000_000,
      thresholdsConfiguredAt: new Date(), configuredBy,
      configurationAttestation: {
        ...attestation, maxConversionMultiple: 'NONE', bonusExpiryHours: 'NONE',
      },
    } });
    await tx.countryJurisdiction.create({ data: {
      countryCode: country.code, activePolicyId: policy.id,
    } });
  });
  const run = await runLedgerInvariantCheck();
  if (!run.passed) {
    throw new Error(`Ledger invariant scan failed before test gate enable: ${JSON.stringify(run.violations)}`);
  }
  await prisma.platformGate.upsert({ where: { key: 'WITHDRAWAL_CREATE' },
    create: { key: 'WITHDRAWAL_CREATE', enabled: true, lastInvariantRunId: run.runId },
    update: { enabled: true, lastInvariantRunId: run.runId },
  });
}

/** A fixture purchase carries the same order, consumed reservation, settled
 * witness and wallet reference as production. The DB guard has no test bypass. */
export async function mintTestPurchasedCoins(userId: string, amount: number, scopeId: string = randomUUID()) {
  const tag = randomUUID().replaceAll('-', '');
  const country = await prisma.country.upsert({
    where: { code: 'ZZ' }, update: {},
    create: { code: 'ZZ', name: 'Ledger purchase test jurisdiction',
      currencyCode: 'USD', isActive: true, agentPaymentEnabled: true },
  });
  return prisma.$transaction(async (tx) => {
    await lockUserEconomicScope(tx, `agent_order:${scopeId}`);
    const users = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${userId} FOR SHARE
    `;
    if (!users[0]) throw new Error('Test purchase recipient does not exist');
    const agentUser = await tx.user.create({ data: {
      email: `test-purchase-agent-${tag}@test.local`,
      username: `tpa_${tag.slice(0, 14)}`,
      passwordHash: 'fixture-only', displayName: 'Test purchase agent',
    } });
    const agent = await tx.agent.create({ data: {
      userId: agentUser.id, countryId: country.id,
      displayName: 'Test purchase agent', contactEmail: `tpa-${tag}@test.local`,
      status: 'ACTIVE',
    } });
    await tx.agentOrder.create({ data: {
      id: scopeId, orderNumber: `TP-${tag}`, userId, agentId: agent.id,
      countryId: country.id, paymentMethodDefId: `method-${tag}`,
      paymentAccountId: `account-${tag}`, paymentSnapshot: {},
      fiatAmount: amount, fiatCurrency: 'USD', exchangeRateConfigId: `rate-${tag}`,
      exchangeRateValue: 1, coinAmount: amount, status: 'COMPLETED',
      idempotencyKey: scopeId,
    } });
    const reservation = await tx.agentReservation.create({ data: {
      orderId: scopeId, agentId: agent.id, amount, status: 'CONSUMED',
      consumedAt: new Date(),
    } });
    return creditCoins(tx, userId, amount, {
      type: 'PURCHASE', scopeType: 'AGENT_ORDER', scopeId,
      referenceType: 'AGENT_ORDER', referenceId: scopeId,
      description: 'classified test purchase',
      createdBy: agentUser.id,
      completePurchaseProof: async (purchaseTx, walletTransactionId) => {
        const settlement = await purchaseTx.agentOrderSettlement.create({ data: {
          orderId: scopeId, reservationId: reservation.id, coinAmount: amount,
          walletTransactionId, resolvedVia: 'AGENT_RELEASE',
          releasedBy: agentUser.id,
        } });
        return settlement.id;
      },
    });
  });
}
