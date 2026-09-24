import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { applyBalanceChanges, getOrCreateWallet } from './wallet-service.js';
import {
  creditCoins,
  debitCoins,
  finalizeWithdrawalCoins,
  releaseWithdrawalCoins,
  reserveWithdrawalCoins,
  settleWagerCoins,
} from './coin-ledger-service.js';
import { activateTestPolicy, disableTestPolicy } from '../ledger/test-policy-fixture.js';
import { mintTestPurchasedCoins } from '../test/financial-policy-fixtures.js';
import { executeTestAdjustment } from '../test/adjustment-fixtures.js';

// The old provenance-service tests manufactured lots without wallet entries,
// then asserted FIFO funding, fresh requirements on wins, and diluted gift
// obligations. Those states violate the Opus I1/I6/I7 contract. Each fixture
// below uses an economic operation and leaves append-only history intact.

const id = (prefix: string) => `${prefix}-${randomUUID()}`;

async function makeUser(role?: 'SUPER_ADMIN') {
  const tag = randomUUID().replaceAll('-', '');
  return prisma.user.create({
    data: {
      email: `ledger-provenance-${tag}@test.local`,
      username: `lp${tag.slice(0, 14)}`,
      passwordHash: 'fixture-only',
      displayName: 'Ledger provenance fixture',
      ...(role ? { role } : {}),
    },
  });
}

async function makeActivePolicy() {
  let code: string;
  do {
    code = `Z${randomUUID().replaceAll('-', '').slice(0, 2)}`.toUpperCase();
  } while (await prisma.country.findUnique({ where: { code } }));
  const admin = await makeUser();
  await prisma.country.create({ data: { code, name: `Ledger ${code}`, currencyCode: 'USD', isActive: true } });
  const policy = await prisma.countryCasinoPolicy.create({
    data: {
      countryCode: code, version: 1, status: 'ENABLED', enabledAt: new Date(),
      minWithdrawal: 100, maxWithdrawal: 100000, dailyWithdrawalLimit: 100000,
      monthlyWithdrawalLimit: 1000000, playthroughMultiplier: 2,
      qualifyingGames: ['dice'], maxQualifyingStake: 1000, holdingPeriodHours: 0,
      giftDailyLimit: 100000, kycTierRequired: 0, supportedPaymentMethods: ['BANK_TRANSFER'],
      withdrawalFeePercent: 0, manualReviewThreshold: 100000,
    },
  });
  // M6 requires an administrator's explicit attestation for every threshold.
  // Pointer and ACTIVE state change in one transaction; deferred guards verify
  // that exactly this immutable version is authoritative at commit.
  const required = [
    'minWithdrawal', 'maxWithdrawal', 'dailyWithdrawalLimit', 'monthlyWithdrawalLimit',
    'playthroughMultiplier', 'qualifyingGames', 'maxQualifyingStake',
    'holdingPeriodHours', 'giftDailyLimit', 'kycTierRequired',
    'supportedPaymentMethods', 'withdrawalFeePercent', 'manualReviewThreshold',
  ];
  const attestation = Object.fromEntries(required.map((key) => [key, 'SET']));
  Object.assign(attestation, { maxConversionMultiple: 'NONE', bonusExpiryHours: 'NONE' });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'INSERT INTO country_jurisdictions ("countryCode", "activePolicyId") VALUES ($1, NULL)', code,
    );
    await tx.$executeRawUnsafe(
      `UPDATE country_casino_policies SET "state"='ACTIVE',
         "thresholdsConfiguredAt"=CURRENT_TIMESTAMP, "configurationAttestation"=$2::jsonb,
         "configuredBy"=$3, "activatedAt"=CURRENT_TIMESTAMP, "activatedBy"=$3
       WHERE "id"=$1`,
      policy.id, JSON.stringify(attestation), admin.id,
    );
    await tx.$executeRawUnsafe(
      'UPDATE country_jurisdictions SET "activePolicyId"=$2 WHERE "countryCode"=$1', code, policy.id,
    );
  });
  return { id: policy.id, version: policy.version };
}

async function purchase(userId: string, amount: number) {
  return mintTestPurchasedCoins(userId, amount);
}

async function bonus(userId: string, amount: number, requirementAmount: number,
  policy: { id: string; version: number }) {
  const sessionId = id('bonus');
  return prisma.$transaction((tx) => creditCoins(tx, userId, amount, {
    type: 'BONUS_GRANT', scopeType: 'GAME_SESSION', scopeId: sessionId,
    referenceType: 'GAME', referenceId: sessionId, description: 'Contract Trivia grant',
    policy, requirementAmount, provenanceType: 'TRIVIA_REWARD', idempotencyKey: sessionId,
  }));
}

async function wager(userId: string, policy: { id: string; version: number },
  stake: number, payout: number, gameKey = 'dice') {
  const sessionId = id('wager');
  return prisma.$transaction((tx) => settleWagerCoins(tx, userId, {
    sessionId, gameKey, stake, payout, idempotencyKey: sessionId, policy,
    responseSnapshot: (newBalance) => ({ sessionId, gameKey, stake, payout, newBalance }),
  }));
}

type LotRow = {
  id: string; lotClass: string; state: string; availableAmount: number;
  reservedAmount: number; requirementAmount: number; progressAmount: number;
  parentLotId: string | null;
};
async function lot(lotId: string): Promise<LotRow> {
  const rows = await prisma.$queryRaw<LotRow[]>`
    SELECT "id", "lotClass"::text AS "lotClass", "state"::text AS "state",
           "availableAmount", "reservedAmount", "requirementAmount",
           "progressAmount", "parentLotId"
    FROM coin_provenance WHERE "id" = ${lotId}
  `;
  return rows[0];
}

async function economicTotals(userId: string) {
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
  const rows = await prisma.$queryRaw<{ amount: bigint }[]>`
    SELECT COALESCE(SUM("availableAmount"), 0) AS amount
    FROM coin_provenance WHERE "userId" = ${userId}
  `;
  return { wallet: wallet.coinsBalance, lots: Number(rows[0].amount) };
}

async function operationCount(userId: string, type?: string) {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM economic_operations
    WHERE "userId" = ${userId} AND (${type ?? null}::text IS NULL OR "type"::text = ${type ?? null})
  `;
  return Number(rows[0].count);
}

async function expectBalanced(userId: string, expected?: number) {
  const totals = await economicTotals(userId);
  expect(totals.wallet).toBe(totals.lots);
  if (expected !== undefined) expect(totals.wallet).toBe(expected);
}

/** Prisma 5 can resolve a callback even when a deferred constraint aborts its
 * COMMIT. Flush inside the callback so rejection is observable to the test;
 * the durable-balance assertions below remain the independent backstop. */
async function flushDeferredLedgerChecks(tx: { $executeRawUnsafe: (sql: string) => Promise<unknown> }) {
  await tx.$executeRawUnsafe(
    'SET CONSTRAINTS "wallet_coin_lot_equality", "entry_coin_lot_equality", "classification_coin_lot_equality" IMMEDIATE',
  );
}

afterAll(async () => prisma.$disconnect());

describe('Opus coin ledger: classified balances and immutable operations', () => {
  it('I1/I5: a purchase mints exactly one withdrawable lot and keeps the visible wallet equal to lots', async () => {
    const user = await makeUser();
    const credit = await purchase(user.id, 100);
    const minted = await lot(credit.lotId);
    expect(minted).toMatchObject({ lotClass: 'WITHDRAWABLE', state: 'OPEN', availableAmount: 100, reservedAmount: 0 });
    await expectBalanced(user.id, 100);
    const [op] = await prisma.$queryRaw<{ type: string; scopeType: string }[]>`
      SELECT "type"::text AS "type", "scopeType" FROM economic_operations WHERE "id" = ${credit.operationId}
    `;
    expect(op).toMatchObject({ type: 'PURCHASE', scopeType: 'AGENT_ORDER' });
  });

  it('I5/M19: a PURCHASE label without an exact settled order cannot mint withdrawable Coins', async () => {
    const user = await makeUser();
    await getOrCreateWallet(user.id);
    const orderId = id('fabricated-order');
    await expect(prisma.$transaction((tx) => creditCoins(tx, user.id, 100, {
      type: 'PURCHASE', scopeType: 'AGENT_ORDER', scopeId: orderId,
      referenceType: 'AGENT_ORDER', referenceId: orderId,
      description: 'Fabricated purchase proof',
      completePurchaseProof: async () => 'fabricated-settlement-id',
    }))).rejects.toThrow();
    await expectBalanced(user.id, 0);
    expect(await operationCount(user.id, 'PURCHASE')).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { userId: user.id, currency: 'COINS' } })).toBe(0);
  });

  it('I3/I5: a settled purchase witness cannot be edited or deleted after mint', async () => {
    const user = await makeUser();
    const credit = await purchase(user.id, 100);
    const operation = await prisma.economicOperation.findUniqueOrThrow({ where: { id: credit.operationId } });
    const settlement = await prisma.agentOrderSettlement.findUniqueOrThrow({ where: { orderId: operation.scopeId } });
    await expect(prisma.agentOrderSettlement.update({ where: { id: settlement.id },
      data: { coinAmount: 101 },
    })).rejects.toThrow();
    await expect(prisma.agentOrderSettlement.delete({ where: { id: settlement.id } })).rejects.toThrow();
    await expect(prisma.agentReservation.delete({ where: { id: settlement.reservationId } })).rejects.toThrow();
    await expectBalanced(user.id, 100);
  });

  it('I4: duplicate operation scope rolls back the wallet credit and cannot mint a second lot', async () => {
    const user = await makeUser();
    const scopeId = id('same-order');
    const args = {
      type: 'PURCHASE' as const, scopeType: 'AGENT_ORDER', scopeId,
      referenceType: 'AGENT_ORDER' as const, referenceId: scopeId,
      description: 'Contract purchase', idempotencyKey: scopeId,
    };
    await mintTestPurchasedCoins(user.id, 100, scopeId);
    await expect(prisma.$transaction((tx) => creditCoins(tx, user.id, 100, {
      ...args, completePurchaseProof: async () => 'duplicate-scope-rejected-before-proof',
    }))).rejects.toThrow();
    await expectBalanced(user.id, 100);
    expect(await prisma.coinProvenance.count({ where: { userId: user.id } })).toBe(1);
  });

  it('I1: an aborted operation leaves wallet, lots and operations unchanged', async () => {
    const user = await makeUser();
    await purchase(user.id, 100);
    const before = await economicTotals(user.id);
    const operations = await operationCount(user.id);
    const admin = await makeUser('SUPER_ADMIN');
    await expect(prisma.$transaction(async (tx) => {
      // Settles as far as a real adjustment would; the rollback discards it
      // before any deferred guard could even check its approval.
      await creditCoins(tx, user.id, 25, {
        type: 'ADMIN_ADJUST', scopeType: 'ADMIN_ADJUSTMENT', scopeId: id('rollback'),
        referenceType: 'ADMIN', description: 'Rollback probe', createdBy: admin.id,
        evidence: { caseId: 'rollback-probe' }, adjustmentApproval: { id: id('rollback-approval'), amount: 25 },
      });
      throw new Error('forced rollback');
    })).rejects.toThrow('forced rollback');
    expect(await economicTotals(user.id)).toEqual(before);
    expect(await operationCount(user.id)).toBe(operations);
  });

  it('I5/T11: an unexplained admin credit enters review and cannot be reserved for withdrawal', async () => {
    const user = await makeUser();
    const credit = await executeTestAdjustment(user.id, 25);
    expect((await lot(credit.reviewLotId!)).lotClass).toBe('UNCLASSIFIED');
    const [review] = await prisma.$queryRaw<{ status: string }[]>`
      SELECT "status" FROM legacy_balance_reviews WHERE "lotId" = ${credit.reviewLotId}
    `;
    expect(review?.status).toBe('OPEN');
    await expectBalanced(user.id, 25);
    const policy = await makeActivePolicy();
    await expect(prisma.$transaction((tx) => reserveWithdrawalCoins(tx, user.id, 25, {
      withdrawalId: id('withdraw'), policyId: policy.id, policyVersion: policy.version,
      holdingPeriodHours: 0,
    }))).rejects.toMatchObject({ statusCode: 400 });
    await expectBalanced(user.id, 25);
  });

  it('I5: an admin adjustment cannot directly mint WITHDRAWABLE value', async () => {
    const user = await makeUser();
    await expect(prisma.$transaction((tx) => creditCoins(tx, user.id, 10, {
      type: 'ADMIN_ADJUST', scopeType: 'ADMIN_ADJUSTMENT', scopeId: id('forbidden-w'),
      referenceType: 'ADMIN', description: 'Forbidden qualification', lotClass: 'WITHDRAWABLE',
    }))).rejects.toMatchObject({ statusCode: 403 });
    expect(await prisma.wallet.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe('Opus coin ledger: bonus spending, payouts and conversion', () => {
  it('I5/T2: staking purchased Coins returns the entire payout to withdrawable value', async () => {
    const user = await makeUser();
    const policy = await makeActivePolicy();
    const purchased = await purchase(user.id, 100);
    const result = await wager(user.id, policy, 100, 200);
    expect(result.funding.map((share) => [share.lotClass, share.amount])).toEqual([
      ['WITHDRAWABLE', 100],
    ]);
    expect(result.payoutShares.map((share) => [share.lotClass, share.amount])).toEqual([
      ['WITHDRAWABLE', 200],
    ]);
    expect(await lot(purchased.lotId)).toMatchObject({
      lotClass: 'WITHDRAWABLE', state: 'OPEN', availableAmount: 200,
    });
    expect(await prisma.coinProvenance.count({ where: { userId: user.id } })).toBe(1);
    await expectBalanced(user.id, 200);
  });

  it('I6/T7: mixed B50/W100 stake60 payout151 returns B126/W115', async () => {
    const user = await makeUser();
    const policy = await makeActivePolicy();
    const purchased = await purchase(user.id, 100);
    const restricted = await bonus(user.id, 50, 100, policy);
    await expectBalanced(user.id, 150);
    const result = await wager(user.id, policy, 60, 151);
    expect(result.funding.map((share) => [share.lotClass, share.amount])).toEqual([
      ['RESTRICTED', 50], ['WITHDRAWABLE', 10],
    ]);
    expect(result.payoutShares.map((share) => [share.lotClass, share.amount])).toEqual([
      ['RESTRICTED', 126], ['WITHDRAWABLE', 25],
    ]);
    expect((await lot(restricted.lotId)).availableAmount).toBe(126);
    expect((await lot(purchased.lotId)).availableAmount).toBe(115);
    expect((await lot(restricted.lotId)).requirementAmount).toBe(100);
    await expectBalanced(user.id, 241);
  });

  it('I7/I8/T5: a bonus requirement stays fixed and converts once when qualifying progress reaches it', async () => {
    const user = await makeUser();
    const policy = await makeActivePolicy();
    const restricted = await bonus(user.id, 20, 20, policy);
    await wager(user.id, policy, 10, 10);
    expect(await lot(restricted.lotId)).toMatchObject({
      lotClass: 'RESTRICTED', state: 'OPEN', availableAmount: 20,
      requirementAmount: 20, progressAmount: 10,
    });
    await expectBalanced(user.id, 20);
    await wager(user.id, policy, 10, 10);
    expect(await lot(restricted.lotId)).toMatchObject({
      state: 'CONVERTED', availableAmount: 0, requirementAmount: 20, progressAmount: 20,
    });
    const successors = await prisma.$queryRaw<LotRow[]>`
      SELECT "id", "lotClass"::text AS "lotClass", "state"::text AS "state",
             "availableAmount", "reservedAmount", "requirementAmount",
             "progressAmount", "parentLotId"
      FROM coin_provenance WHERE "parentLotId" = ${restricted.lotId}
    `;
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ lotClass: 'WITHDRAWABLE', availableAmount: 20 });
    await wager(user.id, policy, 5, 5);
    expect(await operationCount(user.id, 'BONUS_CONVERSION')).toBe(1);
    await expectBalanced(user.id, 20);
  });

  it('I7: a nonqualifying game cannot advance a restricted lot', async () => {
    const user = await makeUser();
    const policy = await makeActivePolicy();
    const restricted = await bonus(user.id, 20, 20, policy);
    await wager(user.id, policy, 10, 10, 'number_challenge');
    expect(await lot(restricted.lotId)).toMatchObject({
      lotClass: 'RESTRICTED', state: 'OPEN', availableAmount: 20,
      requirementAmount: 20, progressAmount: 0,
    });
    await expectBalanced(user.id, 20);
  });

  it('I7/M4: a bonus keeps its original qualifying games after country policy rotation', async () => {
    const user = await makeUser();
    const original = await makeActivePolicy();
    const restricted = await bonus(user.id, 20, 20, original);
    const oldRow = await prisma.countryCasinoPolicy.findUniqueOrThrow({ where: { id: original.id } });
    await disableTestPolicy(original.id, oldRow.countryCode);
    const newer = await prisma.countryCasinoPolicy.create({ data: {
      countryCode: oldRow.countryCode, version: original.version + 1,
      status: 'ENABLED', enabledAt: new Date(),
      minWithdrawal: 100, maxWithdrawal: 100000, dailyWithdrawalLimit: 100000,
      monthlyWithdrawalLimit: 1000000, playthroughMultiplier: 2,
      qualifyingGames: ['number_challenge'], maxQualifyingStake: 1000,
      holdingPeriodHours: 0, giftDailyLimit: 100000, kycTierRequired: 0,
      supportedPaymentMethods: ['BANK_TRANSFER'], withdrawalFeePercent: 0,
      manualReviewThreshold: 100000,
    } });
    const admin = await makeUser();
    await activateTestPolicy(newer.id, oldRow.countryCode, admin.id);
    const wagerPolicy = { id: newer.id, version: newer.version };

    await wager(user.id, wagerPolicy, 10, 10, 'dice');
    expect(await lot(restricted.lotId)).toMatchObject({
      lotClass: 'RESTRICTED', requirementAmount: 20, progressAmount: 10,
    });
    await wager(user.id, wagerPolicy, 10, 10, 'dice');
    expect(await lot(restricted.lotId)).toMatchObject({
      state: 'CONVERTED', requirementAmount: 20, progressAmount: 20,
    });
    expect(await operationCount(user.id, 'BONUS_CONVERSION')).toBe(1);
    await expectBalanced(user.id, 20);
  });

  it('I7/T6: 400 rounds reuse one bonus lot without increasing its fixed requirement', async () => {
    const user = await makeUser();
    const policy = await makeActivePolicy();
    const restricted = await bonus(user.id, 100, 10000, policy);
    for (let round = 0; round < 400; round++) {
      await wager(user.id, policy, 10, 10);
    }
    expect(await lot(restricted.lotId)).toMatchObject({
      lotClass: 'RESTRICTED', state: 'OPEN', availableAmount: 100,
      requirementAmount: 10000, progressAmount: 4000,
    });
    expect(await prisma.coinProvenance.count({ where: { userId: user.id } })).toBe(1);
    await expectBalanced(user.id, 100);
  });

  it('I1/Q1: gift spend consumes restricted Coins first and leaves no phantom purchase value', async () => {
    const user = await makeUser();
    const policy = await makeActivePolicy();
    const purchased = await purchase(user.id, 100);
    const restricted = await bonus(user.id, 30, 150, policy);
    const giftId = id('gift');
    const debit = await prisma.$transaction((tx) => debitCoins(tx, user.id, 50, {
      type: 'GIFT_SPEND', scopeType: 'GIFT', scopeId: giftId,
      referenceType: 'GIFT', referenceId: giftId, description: 'Gift spend',
    }));
    expect(debit.funding.map((share) => [share.lotClass, share.amount])).toEqual([
      ['RESTRICTED', 30], ['WITHDRAWABLE', 20],
    ]);
    expect((await lot(restricted.lotId)).state).toBe('EXHAUSTED');
    expect((await lot(purchased.lotId)).availableAmount).toBe(80);
    await expectBalanced(user.id, 80);
  });
});

describe('Opus coin ledger: reservation and database guards', () => {
  it('I5/M16: a purchased lot cannot fund a withdrawal until its holding period ends', async () => {
    const user = await makeUser();
    const policy = await makeActivePolicy();
    const purchased = await purchase(user.id, 100);
    const source = await prisma.coinProvenance.findUniqueOrThrow({ where: { id: purchased.lotId } });
    const availableAt = source.availableAt ?? source.mintedAt;
    if (!availableAt) throw new Error('Purchased lot must have an availability timestamp');
    const notYet = new Date(availableAt.getTime() + 3_600_000 - 1);
    await expect(prisma.$transaction((tx) => reserveWithdrawalCoins(tx, user.id, 50, {
      withdrawalId: id('too-early'), policyId: policy.id, policyVersion: policy.version,
      holdingPeriodHours: 1, now: notYet,
    }))).rejects.toMatchObject({ statusCode: 400 });
    await expectBalanced(user.id, 100);
    const eligibleAt = new Date(notYet.getTime() + 1);
    await prisma.$transaction((tx) => reserveWithdrawalCoins(tx, user.id, 50, {
      withdrawalId: id('after-hold'), policyId: policy.id, policyVersion: policy.version,
      holdingPeriodHours: 1, now: eligibleAt,
    }));
    expect(await lot(purchased.lotId)).toMatchObject({ availableAmount: 50, reservedAmount: 50 });
    await expectBalanced(user.id, 50);
  });

  it('I9/M7: RELEASE returns two reserved shares to their exact source lots with linked entry reversals', async () => {
    const user = await makeUser();
    const policy = await makeActivePolicy();
    const first = await purchase(user.id, 40);
    const second = await purchase(user.id, 60);
    const withdrawalId = id('two-source-withdrawal');
    const held = await prisma.$transaction((tx) => reserveWithdrawalCoins(tx, user.id, 70, {
      withdrawalId, policyId: policy.id, policyVersion: policy.version,
      holdingPeriodHours: 0,
    }));
    expect(new Set(held.reservations.map((share) => share.lotId))).toEqual(
      new Set([first.lotId, second.lotId])
    );
    await expectBalanced(user.id, 30);
    const released = await prisma.$transaction((tx) => releaseWithdrawalCoins(tx, user.id, withdrawalId, {
      holdOperationId: held.holdOperationId, amount: 70,
    }));
    expect(await lot(first.lotId)).toMatchObject({ availableAmount: 40, reservedAmount: 0 });
    expect(await lot(second.lotId)).toMatchObject({ availableAmount: 60, reservedAmount: 0 });
    const reserves = await prisma.coinLotEntry.findMany({ where: { operationId: held.holdOperationId } });
    const reversals = await prisma.coinLotEntry.findMany({ where: { operationId: released.releaseOperationId } });
    expect(reversals).toHaveLength(2);
    expect(new Set(reversals.map((entry) => entry.reversesEntryId))).toEqual(
      new Set(reserves.map((entry) => entry.id))
    );
    for (const reversal of reversals) {
      const source = reserves.find((entry) => entry.id === reversal.reversesEntryId);
      expect(source?.lotId).toBe(reversal.lotId);
    }
    await expectBalanced(user.id, 100);
  });

  it('I10/T14: a Game Points debit cannot create untracked Coins in the same transaction', async () => {
    const user = await makeUser();
    await purchase(user.id, 100);
    await prisma.$transaction((tx) => applyBalanceChanges(tx, user.id, [{
      currency: 'GAME_POINTS', amount: 10, ledgerType: 'CREDIT',
      transactionType: 'GAME_POINT_CREDIT', referenceType: 'ADMIN',
      description: 'Game Points fixture',
    }]));
    const before = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
    const transactionCount = await prisma.walletTransaction.count({ where: { userId: user.id } });
    await expect(prisma.$transaction(async (tx) => {
      await applyBalanceChanges(tx, user.id, [
        {
          currency: 'GAME_POINTS', amount: 10, ledgerType: 'DEBIT',
          transactionType: 'GAME_POINT_DEBIT', referenceType: 'TRANSFER',
          description: 'Forbidden conversion debit',
        },
        {
          currency: 'COINS', amount: 10, ledgerType: 'CREDIT',
          transactionType: 'COIN_CREDIT', referenceType: 'TRANSFER',
          description: 'Forbidden conversion credit',
        },
      ]);
      await flushDeferredLedgerChecks(tx);
    })).rejects.toThrow();
    const after = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
    expect([after.coinsBalance, after.gamePointsBalance]).toEqual([
      before.coinsBalance, before.gamePointsBalance,
    ]);
    expect(await prisma.walletTransaction.count({ where: { userId: user.id } })).toBe(transactionCount);
    await expectBalanced(user.id, 100);
  });

  it('I9: RELEASE restores the original lot once; FINALIZE consumes a different hold once', async () => {
    const user = await makeUser();
    const policy = await makeActivePolicy();
    const purchased = await purchase(user.id, 100);
    const firstId = id('withdraw');
    const first = await prisma.$transaction((tx) => reserveWithdrawalCoins(tx, user.id, 40, {
      withdrawalId: firstId, policyId: policy.id, policyVersion: policy.version,
      holdingPeriodHours: 0,
    }));
    expect(await lot(purchased.lotId)).toMatchObject({ availableAmount: 60, reservedAmount: 40 });
    await expectBalanced(user.id, 60);
    await prisma.$transaction((tx) => releaseWithdrawalCoins(tx, user.id, firstId, {
      holdOperationId: first.holdOperationId, amount: 40,
    }));
    expect(await lot(purchased.lotId)).toMatchObject({ availableAmount: 100, reservedAmount: 0 });
    await expectBalanced(user.id, 100);
    await expect(prisma.$transaction((tx) => releaseWithdrawalCoins(tx, user.id, firstId, {
      holdOperationId: first.holdOperationId, amount: 40,
    }))).rejects.toThrow();
    await expectBalanced(user.id, 100);

    const secondId = id('withdraw');
    const second = await prisma.$transaction((tx) => reserveWithdrawalCoins(tx, user.id, 30, {
      withdrawalId: secondId, policyId: policy.id, policyVersion: policy.version,
      holdingPeriodHours: 0,
    }));
    await prisma.$transaction((tx) => finalizeWithdrawalCoins(tx, user.id, secondId, {
      holdOperationId: second.holdOperationId, amount: 30,
    }));
    expect(await lot(purchased.lotId)).toMatchObject({ availableAmount: 70, reservedAmount: 0 });
    await expect(prisma.$transaction((tx) => releaseWithdrawalCoins(tx, user.id, secondId, {
      holdOperationId: second.holdOperationId, amount: 30,
    }))).rejects.toThrow();
    await expectBalanced(user.id, 70);
  });

  it('I2/I3/I1/T13: caches and history are immutable; raw wallet tampering cannot commit', async () => {
    const user = await makeUser();
    const purchased = await purchase(user.id, 50);
    await expect(prisma.$executeRaw`
      UPDATE coin_provenance SET "availableAmount" = 51 WHERE "id" = ${purchased.lotId}
    `).rejects.toThrow();
    await expect(prisma.$executeRaw`
      UPDATE economic_operations SET "snapshot" = '{}'::jsonb WHERE "id" = ${purchased.operationId}
    `).rejects.toThrow();
    await expect(prisma.$executeRaw`
      DELETE FROM coin_lot_entries WHERE "operationId" = ${purchased.operationId}
    `).rejects.toThrow();
    await expect(prisma.$transaction(async (tx) => {
      await tx.wallet.update({ where: { userId: user.id }, data: { coinsBalance: 51 } });
      await flushDeferredLedgerChecks(tx);
    })).rejects.toThrow();
    await expectBalanced(user.id, 50);
  });
});
