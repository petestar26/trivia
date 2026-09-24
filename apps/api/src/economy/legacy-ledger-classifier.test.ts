import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { classifyLegacyCoinAccount } from './legacy-ledger-classifier.js';
import { runLedgerInvariantCheck } from './ledger-invariant-checker.js';

const unique = (prefix: string) => `${prefix}-${randomUUID()}`;

async function historicalWallet(amount: number, referenceType: 'REWARD' | 'AGENT_ORDER', referenceId: string) {
  const tag = randomUUID().replaceAll('-', '');
  const user = await prisma.user.create({ data: {
    username: `m7_${tag.slice(0, 14)}`, email: `m7-${tag}@test.local`,
    passwordHash: 'fixture-only', displayName: 'M7 historical fixture',
  } });
  const wallet = await prisma.wallet.create({ data: { userId: user.id, coinsBalance: amount } });
  const transaction = await prisma.walletTransaction.create({ data: {
    walletId: wallet.id, userId: user.id, type: 'COIN_CREDIT', ledgerType: 'CREDIT',
    currency: 'COINS', amount, balanceBefore: 0, balanceAfter: amount,
    referenceType, referenceId, description: 'Historical credit', status: 'SUCCEEDED',
  } });
  return { user, wallet, transaction };
}

async function assertBalanced(userId: string, expected: number) {
  const rows = await prisma.$queryRaw<{ wallet: number; lots: number; withdrawable: number;
    unclassified: number; openReviews: number }[]>`
    SELECT w."coinsBalance" AS wallet,
      COALESCE(SUM(p."availableAmount"),0)::int AS lots,
      COALESCE(SUM(CASE WHEN p."lotClass"='WITHDRAWABLE' THEN p."availableAmount" ELSE 0 END),0)::int AS withdrawable,
      COALESCE(SUM(CASE WHEN p."lotClass"='UNCLASSIFIED' THEN p."availableAmount" ELSE 0 END),0)::int AS unclassified,
      (SELECT COUNT(*)::int FROM legacy_balance_reviews r WHERE r."userId"=${userId} AND r.status='OPEN') AS "openReviews"
    FROM wallets w LEFT JOIN coin_provenance p ON p."userId"=w."userId"
    WHERE w."userId"=${userId} GROUP BY w."coinsBalance"
  `;
  expect(rows[0].wallet).toBe(expected);
  expect(rows[0].lots).toBe(expected);
  return rows[0];
}

async function historicalTerminalWithdrawal(status: 'REFUNDED' | 'CONSUMED',
  funding: 'UNKNOWN' | 'MIXED' = 'UNKNOWN') {
  const tag = randomUUID().replaceAll('-', '');
  const amount = funding === 'MIXED' ? 20 : 30;
  const user = await prisma.user.create({ data: {
    username: `m7hold_${tag.slice(0, 12)}`, email: `m7hold-${tag}@test.local`,
    passwordHash: 'fixture-only', displayName: 'M7 terminal hold fixture',
  } });
  const wallet = await prisma.wallet.create({ data: {
    userId: user.id,
    coinsBalance: funding === 'MIXED' ? (status === 'REFUNDED' ? 130 : 110)
      : (status === 'REFUNDED' ? 100 : 70),
  } });
  const country = await prisma.country.create({ data: {
    code: `X${tag.slice(0, 2).toUpperCase()}`, name: `Historical hold ${tag}`,
    currencyCode: 'USD', isActive: true,
  } });
  const method = await prisma.paymentMethodDefinition.create({ data: {
    countryId: country.id, type: 'BANK_TRANSFER', name: `Historical bank ${tag}`,
    fieldSchema: { requiredFields: ['bankName', 'accountNumber'] }, isActive: true,
  } });
  const payout = await prisma.userPayoutAccount.create({ data: {
    userId: user.id, countryId: country.id, methodDefId: method.id,
    accountDetails: { bankName: 'Historical', accountNumber: '1' }, status: 'ACTIVE',
  } });
  const withdrawalId = randomUUID();
  const quote = await prisma.withdrawalQuote.create({ data: {
    userId: user.id, countryId: country.id, fiatCurrency: 'USD',
    coinAmount: amount, fiatAmount: 30n,
    exchangeRateConfigId: unique('historical-rate'), exchangeRateValue: 1,
    requestHash: unique('historical-quote-hash'), status: 'CONSUMED',
    expiresAt: new Date(Date.now() + 86_400_000), consumedAt: new Date(),
    consumedByWithdrawalId: withdrawalId,
  } });
  const base = Date.now() - 100_000;
  const ledger = async (ledgerType: 'CREDIT' | 'DEBIT', amount: number,
    before: number, after: number, referenceType: 'REWARD' | 'WITHDRAWAL' | 'AGENT_ORDER' | 'GAME',
    referenceId: string, offset: number) => prisma.walletTransaction.create({ data: {
      walletId: wallet.id, userId: user.id, currency: 'COINS',
      type: ledgerType === 'CREDIT' ? 'COIN_CREDIT' : 'COIN_DEBIT',
      ledgerType, amount, balanceBefore: before, balanceAfter: after,
      referenceType, referenceId, status: 'SUCCEEDED',
      description: 'Historical terminal withdrawal fixture',
      createdAt: new Date(base + offset * 1000),
    } });
  let debitBefore = 100;
  let debitAfter = 70;
  let debitOffset = 1;
  if (funding === 'MIXED') {
    const orderId = unique('historical-purchase');
    const purchase = await ledger('CREDIT', 100, 0, 100, 'AGENT_ORDER', orderId, 0);
    const agentUser = await prisma.user.create({ data: {
      username: `m7agent_${tag.slice(0, 11)}`, passwordHash: 'fixture-only',
      displayName: 'M7 historical agent',
    } });
    const agent = await prisma.agent.create({ data: {
      userId: agentUser.id, countryId: country.id,
      displayName: 'M7 historical agent', contactEmail: `m7-agent-${tag}@test.local`,
      status: 'ACTIVE',
    } });
    await prisma.agentOrder.create({ data: {
      id: orderId, orderNumber: unique('M7-ORDER'), userId: user.id,
      agentId: agent.id, countryId: country.id, paymentMethodDefId: method.id,
      paymentAccountId: payout.id, paymentSnapshot: {}, fiatAmount: 100,
      fiatCurrency: 'USD', exchangeRateConfigId: unique('historical-rate'),
      exchangeRateValue: 1, coinAmount: 100, status: 'COMPLETED',
      idempotencyKey: unique('historical-order-key'),
    } });
    await prisma.agentOrderSettlement.create({ data: {
      orderId, reservationId: unique('historical-reservation'),
      coinAmount: 100, walletTransactionId: purchase.id,
      resolvedVia: 'AGENT_RELEASE', releasedBy: agentUser.id,
    } });
    const bonusId = unique('historical-trivia');
    const bonus = await ledger('CREDIT', 30, 100, 130, 'GAME', bonusId, 1);
    const policy = await prisma.countryCasinoPolicy.create({ data: {
      countryCode: country.code, version: 1, state: 'DRAFT', status: 'DISABLED',
      minWithdrawal: 1, maxWithdrawal: 1000, dailyWithdrawalLimit: 1000,
      monthlyWithdrawalLimit: 10000, playthroughMultiplier: 5,
      qualifyingGames: ['dice'], maxQualifyingStake: 100,
      holdingPeriodHours: 0, giftDailyLimit: 100, kycTierRequired: 0,
      supportedPaymentMethods: ['BANK_TRANSFER'], withdrawalFeePercent: 0,
      manualReviewThreshold: 1000,
    } });
    const trivia = await prisma.gameDefinition.findUniqueOrThrow({ where: { key: 'trivia' } });
    await prisma.gameSession.create({ data: {
      id: bonusId, userId: user.id, gameId: trivia.id, mode: 'BONUS',
      family: 'INSTANT', betAmount: 0, result: {}, rewardAmount: 30,
      status: 'COMPLETED', settlementCreditCurrency: 'COINS',
    } });
    await prisma.coinProvenance.create({ data: {
      userId: user.id, walletTransactionId: bonus.id, amount: 30,
      provenanceType: 'TRIVIA_REWARD', restrictionStatus: 'RESTRICTED',
      originalSource: 'TRIVIA_REWARD', countryPolicyId: policy.id,
      countryPolicyVersion: policy.version, requiredPlaythrough: 150,
      completedPlaythrough: 0,
    } });
    debitBefore = 130;
    debitAfter = 110;
    debitOffset = 2;
  } else {
    await ledger('CREDIT', 100, 0, 100, 'REWARD', unique('historical-reward'), 0);
  }
  const debit = await ledger('DEBIT', amount, debitBefore, debitAfter,
    'WITHDRAWAL', withdrawalId, debitOffset);
  const refund = status === 'REFUNDED'
    ? await ledger('CREDIT', amount, debitAfter, debitBefore,
      'WITHDRAWAL', withdrawalId, debitOffset + 1)
    : null;
  await prisma.withdrawal.create({ data: {
    id: withdrawalId, withdrawalNumber: unique('WD-M7'), userId: user.id,
    quoteId: quote.id, requestHash: unique('historical-request-hash'),
    idempotencyKey: unique('historical-withdrawal-key'), countryId: country.id,
    paymentMethodDefId: method.id, userPayoutAccountId: payout.id,
    paymentSnapshot: { bankName: 'Historical', accountNumber: '1' },
    fiatAmount: 30n, fiatCurrency: 'USD',
    exchangeRateConfigId: quote.exchangeRateConfigId,
    exchangeRateValue: quote.exchangeRateValue, coinAmount: amount,
    status: status === 'REFUNDED' ? 'CANCELLED' : 'COMPLETED',
    quoteExpiresAt: quote.expiresAt,
    ...(status === 'REFUNDED'
      ? { cancelledAt: new Date(base + 3000) }
      : { paymentSubmittedAt: new Date(base + 2000), completedAt: new Date(base + 3000) }),
  } });
  const hold = await prisma.withdrawalHold.create({ data: {
    withdrawalId, coinAmount: amount, status,
    debitWalletTransactionId: debit.id,
    ...(refund
      ? { refundWalletTransactionId: refund.id, releasedAt: new Date(base + 3000) }
      : { consumedAt: new Date(base + 3000) }),
  } });
  return { user, hold, debit, refund, withdrawalId, amount };
}

afterAll(async () => prisma.$disconnect());

describe('M7 historical COINS replay', () => {
  it('replays an old completed withdrawal from W rather than silently spending bonus B', async () => {
    const fixture = await historicalTerminalWithdrawal('CONSUMED', 'MIXED');
    const preview = await classifyLegacyCoinAccount(fixture.user.id, true);
    const byClass = (lotClass: string) => preview.sources
      .filter((source) => source.lotClass === lotClass)
      .reduce((sum, source) => sum + source.availableAmount, 0);
    expect(byClass('WITHDRAWABLE')).toBe(80);
    expect(byClass('RESTRICTED')).toBe(30);
    await classifyLegacyCoinAccount(fixture.user.id, false);
    expect(await assertBalanced(fixture.user.id, 110)).toMatchObject({
      withdrawable: 80, unclassified: 0, openReviews: 0,
    });
    expect((await runLedgerInvariantCheck()).violations).toEqual([]);
  });
  it('refuses W uplift when a terminal hold points at a different debit ID', async () => {
    const fixture = await historicalTerminalWithdrawal('REFUNDED', 'MIXED');
    const purchase = await prisma.walletTransaction.findFirstOrThrow({ where: {
      userId: fixture.user.id, referenceType: 'AGENT_ORDER', currency: 'COINS',
    } });
    await prisma.withdrawalHold.update({ where: { id: fixture.hold.id }, data: {
      debitWalletTransactionId: purchase.id,
    } });
    const preview = await classifyLegacyCoinAccount(fixture.user.id, true);
    expect(preview).toMatchObject({ walletBalance: 130, reviewAmount: 130,
      ledgerReconciled: false });
    expect(preview.reviewReasons).toContain('Historical withdrawal debit lacks an exact hold link');
    await expect(classifyLegacyCoinAccount(fixture.user.id, false))
      .rejects.toThrow('Historical withdrawal hold lacks its exact Coin debit proof');
    expect(await prisma.economicOperation.count({ where: { userId: fixture.user.id } })).toBe(0);
  });
  it.each(['REFUNDED', 'CONSUMED'] as const)(
    'journals a terminal historical withdrawal %s with a linked exact reversal and zero-net transit lot',
    async (status) => {
      const fixture = await historicalTerminalWithdrawal(status);
      const before = await prisma.economicOperation.count({ where: { userId: fixture.user.id } });
      await classifyLegacyCoinAccount(fixture.user.id, true);
      expect(await prisma.economicOperation.count({ where: { userId: fixture.user.id } })).toBe(before);

      await classifyLegacyCoinAccount(fixture.user.id, false);
      const hold = await prisma.withdrawalHold.findUniqueOrThrow({ where: { id: fixture.hold.id } });
      expect(hold.holdOperationId).toBeTruthy();
      const opening = await prisma.economicOperation.findUniqueOrThrow({ where: { id: hold.holdOperationId! } });
      expect(opening).toMatchObject({ type: 'LEGACY_OPENING', scopeType: 'WITHDRAWAL',
        scopeId: fixture.withdrawalId, walletTransactionIds: [fixture.debit.id] });
      const reserve = await prisma.coinLotEntry.findFirstOrThrow({
        where: { operationId: opening.id, entryType: 'RESERVE' },
      });
      const terminal = await prisma.economicOperation.findUniqueOrThrow({
        where: { type_scopeType_scopeId: {
          type: status === 'REFUNDED' ? 'WITHDRAWAL_RELEASE' : 'WITHDRAWAL_FINALIZE',
          scopeType: 'WITHDRAWAL', scopeId: fixture.withdrawalId,
        } },
      });
      expect(terminal.reversesOperationId).toBe(opening.id);
      expect(terminal.walletTransactionIds).toEqual(fixture.refund ? [fixture.refund.id] : []);
      const terminalEntry = await prisma.coinLotEntry.findFirstOrThrow({ where: { operationId: terminal.id } });
      expect(terminalEntry.reversesEntryId).toBe(reserve.id);
      expect(terminalEntry.lotId).toBe(reserve.lotId);
      expect(terminalEntry.reservedDelta).toBe(-fixture.amount);
      const transit = await prisma.coinProvenance.findUniqueOrThrow({ where: { id: reserve.lotId } });
      expect(transit).toMatchObject({ lotClass: 'UNCLASSIFIED', state: 'EXHAUSTED',
        availableAmount: 0, reservedAmount: 0 });
      await assertBalanced(fixture.user.id, status === 'REFUNDED' ? 100 : 70);
      const check = await runLedgerInvariantCheck();
      expect(check.violations).toEqual([]);
      const operationCount = await prisma.economicOperation.count({ where: { userId: fixture.user.id } });
      const repeated = await classifyLegacyCoinAccount(fixture.user.id, false);
      expect(repeated.idempotent).toBe(true);
      expect(await prisma.economicOperation.count({ where: { userId: fixture.user.id } }))
        .toBe(operationCount);
      expect(operationCount).toBeGreaterThan(before);
    },
  );
  it('M18: unknown REWARD credit remains U with an OPEN review; dry-run writes nothing', async () => {
    const { user } = await historicalWallet(73, 'REWARD', unique('unknown-reward'));
    const before = await prisma.economicOperation.count({ where: { userId: user.id } });
    const preview = await classifyLegacyCoinAccount(user.id, true);
    expect(preview).toMatchObject({ walletBalance: 73, reviewAmount: 73, ledgerReconciled: true });
    expect(preview.sources).toHaveLength(1);
    expect(preview.sources[0]).toMatchObject({ lotClass: 'UNCLASSIFIED', availableAmount: 73, sourceKind: 'UNKNOWN' });
    expect(await prisma.economicOperation.count({ where: { userId: user.id } })).toBe(before);
    await classifyLegacyCoinAccount(user.id, false);
    const balances = await assertBalanced(user.id, 73);
    expect(balances).toMatchObject({ withdrawable: 0, unclassified: 73, openReviews: 1 });
    const retry = await classifyLegacyCoinAccount(user.id, false);
    expect(retry.idempotent).toBe(true);
    expect(await assertBalanced(user.id, 73)).toEqual(balances);
  });

  it('verified settled AGENT_ORDER credit becomes W without a review', async () => {
    const orderId = unique('m7-order');
    const { user, transaction } = await historicalWallet(61, 'AGENT_ORDER', orderId);
    const tag = randomUUID().replaceAll('-', '');
    const agentUser = await prisma.user.create({ data: {
      username: `m7agent_${tag.slice(0, 12)}`, passwordHash: 'fixture-only',
      displayName: 'M7 fixture agent',
    } });
    const country = await prisma.country.create({ data: {
      // 256 two-character suffixes collided across runs; codes are unbounded text.
      code: `Z${tag.slice(0, 8).toUpperCase()}`, name: `M7 ${tag}`,
      currencyCode: 'USD', isActive: true,
    } });
    const agent = await prisma.agent.create({ data: {
      userId: agentUser.id, countryId: country.id, displayName: 'M7 agent',
      contactEmail: `m7-agent-${tag}@test.local`, status: 'ACTIVE',
    } });
    await prisma.agentOrder.create({ data: {
      id: orderId, orderNumber: unique('M7'), userId: user.id, agentId: agent.id,
      countryId: country.id, paymentMethodDefId: unique('method'),
      paymentAccountId: unique('account'), paymentSnapshot: {}, fiatAmount: 61,
      fiatCurrency: 'USD', exchangeRateConfigId: unique('rate'),
      exchangeRateValue: 1, coinAmount: 61, status: 'COMPLETED',
      idempotencyKey: unique('idem'),
    } });
    await prisma.agentOrderSettlement.create({ data: {
      orderId, reservationId: unique('reservation'), coinAmount: 61,
      walletTransactionId: transaction.id, resolvedVia: 'AGENT_RELEASE',
      releasedBy: agentUser.id,
    } });
    const preview = await classifyLegacyCoinAccount(user.id, true);
    expect(preview).toMatchObject({ reviewAmount: 0, ledgerReconciled: true });
    expect(preview.sources[0]).toMatchObject({ lotClass: 'WITHDRAWABLE', availableAmount: 61, sourceKind: 'PURCHASE' });
    await classifyLegacyCoinAccount(user.id, false);
    expect(await assertBalanced(user.id, 61)).toMatchObject({ withdrawable: 61, unclassified: 0, openReviews: 0 });
  });

  it('replays pinned Trivia, retired lucky_spin wagers, payouts, conversion and a gift debit', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const user = await prisma.user.create({ data: {
      username: `m7bonus_${suffix.slice(0, 11)}`, passwordHash: 'fixture-only',
      displayName: 'M7 bonus history',
    } });
    const wallet = await prisma.wallet.create({ data: { userId: user.id, coinsBalance: 20 } });
    const country = await prisma.country.create({ data: {
      code: `Y${suffix.slice(0, 1).toUpperCase()}`, name: `Bonus history ${suffix}`,
      currencyCode: 'USD', isActive: true,
    } });
    const policy = await prisma.countryCasinoPolicy.create({ data: {
      countryCode: country.code, version: 1, state: 'DRAFT', status: 'DISABLED',
      minWithdrawal: 10, maxWithdrawal: 1000, dailyWithdrawalLimit: 1000,
      monthlyWithdrawalLimit: 10000, playthroughMultiplier: 2,
      qualifyingGames: ['lucky_spin'], maxQualifyingStake: 100,
      holdingPeriodHours: 0, giftDailyLimit: 100, kycTierRequired: 0,
      supportedPaymentMethods: ['BANK_TRANSFER'], withdrawalFeePercent: 0,
      manualReviewThreshold: 1000,
    } });
    const trivia = await prisma.gameDefinition.findUniqueOrThrow({ where: { key: 'trivia' } });
    const retired = await prisma.gameDefinition.findUniqueOrThrow({ where: { key: 'lucky_spin' } });
    const bonusId = unique('historical-trivia');
    await prisma.gameSession.create({ data: { id: bonusId, userId: user.id,
      gameId: trivia.id, mode: 'BONUS', family: 'INSTANT', betAmount: 0,
      result: {}, rewardAmount: 30, status: 'COMPLETED',
      settlementCreditCurrency: 'COINS',
    } });
    const base = Date.now() - 100_000;
    let sequence = 0;
    const row = async (amount: number, ledgerType: 'CREDIT' | 'DEBIT',
      balanceBefore: number, balanceAfter: number, sessionId: string,
      referenceType: 'GAME' | 'GIFT' = 'GAME') => {
      const createdAt = new Date(base + sequence++ * 1000);
      return prisma.walletTransaction.create({ data: {
        walletId: wallet.id, userId: user.id, currency: 'COINS',
        type: ledgerType === 'CREDIT' ? 'COIN_CREDIT' : 'COIN_DEBIT',
        ledgerType, amount, balanceBefore, balanceAfter,
        referenceType, referenceId: sessionId,
        description: 'Historical game settlement', status: 'SUCCEEDED', createdAt,
      } });
    };
    const grant = await row(30, 'CREDIT', 0, 30, bonusId);
    await prisma.coinProvenance.create({ data: {
      userId: user.id, walletTransactionId: grant.id, amount: 30,
      provenanceType: 'TRIVIA_REWARD', restrictionStatus: 'RESTRICTED',
      originalSource: 'TRIVIA_REWARD', countryPolicyId: policy.id,
      countryPolicyVersion: policy.version, requiredPlaythrough: 60,
      completedPlaythrough: 0,
    } });
    for (const [index, stake] of [10, 20, 30].entries()) {
      const sessionId = unique(`historical-retired-${index}`);
      await prisma.gameSession.create({ data: { id: sessionId, userId: user.id,
        gameId: retired.id, mode: 'WAGER', family: 'INSTANT', betAmount: stake,
        result: {}, rewardAmount: stake, status: 'COMPLETED',
        settlementDebitCurrency: 'COINS', settlementCreditCurrency: 'COINS',
      } });
      await row(stake, 'DEBIT', 30, 30 - stake, sessionId);
      await row(stake, 'CREDIT', 30 - stake, 30, sessionId);
    }
    await row(10, 'DEBIT', 30, 20, unique('historical-gift'), 'GIFT');
    const preview = await classifyLegacyCoinAccount(user.id, true);
    expect(preview).toMatchObject({ walletBalance: 20, reviewAmount: 0, ledgerReconciled: true });
    expect(preview.sources).toHaveLength(1);
    expect(preview.sources[0]).toMatchObject({ lotClass: 'WITHDRAWABLE',
      availableAmount: 20, sourceKind: 'BONUS_CONVERSION' });
    await classifyLegacyCoinAccount(user.id, false);
    expect(await assertBalanced(user.id, 20)).toMatchObject({ withdrawable: 20, unclassified: 0, openReviews: 0 });
    expect(await prisma.economicOperation.count({ where: { userId: user.id,
      type: 'BONUS_CONVERSION' } })).toBe(1);
  });
});
