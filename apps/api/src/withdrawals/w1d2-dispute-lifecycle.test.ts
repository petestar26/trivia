import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { randomUUID } from 'node:crypto';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service';
import { fundAgentFiatLiquidity } from './liquidity-service';
import { createWithdrawalQuote } from './quote-service';
import { createUserPayoutAccount } from './payout-account-service';
import { createWithdrawal, claimPayout, submitPayment, cancelHeldWithdrawal } from './withdrawal-service';
import {
  confirmWithdrawalReceipt,
  openUserWithdrawalDispute,
  escalateWithdrawalToDispute,
  claimWithdrawalDispute,
  resolveWithdrawalDispute,
} from './dispute-service';
import { executeBalanceChange, getWalletBalance } from '../economy/wallet-service';

// ─── DB availability probe ─────────────────────────────────────
//
// Financial inverse tests operating on the live database. If the database is
// unavailable, they MUST fail hard rather than silently report green
// zero-coverage via describe.skip — a skipped financial suite hides
// regressions.

try {
  await prisma.$queryRaw`SELECT 1`;
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('W-1D2 dispute lifecycle tests require a reachable Postgres database. Failing run.');
  throw new Error('W-1D2 dispute lifecycle tests failed to connect to Postgres: ' + (err as Error)?.message);
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = describe;

// ─── Fixture helpers (mirror W-1D2A fixtures) ──────────────────

const TAG_PREFIX = 'w1d2disp-';

async function createUser(tag: string) {
  const email = `${TAG_PREFIX}${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `${TAG_PREFIX}${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `W1D2 Dispute Test ${tag}`,
    },
  });
}

async function createAdmin(tag: string) {
  const user = await createUser(`admin-${tag}`);
  return prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
}

async function createSuperAdmin(tag: string) {
  const user = await createUser(`super-${tag}`);
  return prisma.user.update({ where: { id: user.id }, data: { role: 'SUPER_ADMIN' } });
}

async function createCountry(tag: string) {
  const code = `W2D${randomUUID().replaceAll('-', '').slice(0, 6)}`.toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `W1D2 Dispute Test Country ${tag}`,
      currencyCode: 'USD',
      isActive: true,
      agentPaymentEnabled: true,
    },
  });
}

async function createPaymentMethod(countryId: string, tag: string) {
  return prisma.paymentMethodDefinition.create({
    data: {
      countryId,
      type: 'BANK_TRANSFER',
      name: `W1D2 Dispute Method ${tag}`,
      fieldSchema: { requiredFields: ['bankName', 'accountNumber'] },
      isActive: true,
    },
  });
}

async function createExchangeRate(countryId: string, fiatCurrency: string, coinsPerUnit: number, adminId: string) {
  return prisma.exchangeRateConfig.create({
    data: {
      countryId,
      fiatCurrency,
      coinsPerUnit,
      isActive: true,
      setBy: adminId,
      effectiveAt: new Date(Date.now() - 1_000),
    },
  });
}

async function createFundedAgent(
  tag: string,
  countryId: string,
  admin: { id: string },
  superAdmin: { id: string },
  liquidityUsd: bigint
) {
  const agentUser = await createUser(`agent-${tag}`);
  const { application } = await submitAgentApplication(agentUser.id, {
    countryId,
    displayName: `W1D2 Dispute Agent ${tag}`,
    contactEmail: `w1d2disp-agent-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.id, undefined);
  const agent = await prisma.agent.findUnique({ where: { userId: agentUser.id } });
  await fundAgentFiatLiquidity(
    superAdmin.id,
    agent!.id,
    'USD',
    liquidityUsd,
    `w1d2disp-fund-${tag}-${Date.now()}-${Math.random()}`
  );
  return { agentUser, agent: agent! };
}

async function creditCoins(userId: string, amount: number) {
  await executeBalanceChange({
    userId,
    changes: [
      {
        currency: 'COINS',
        amount,
        ledgerType: 'CREDIT',
        transactionType: 'COIN_CREDIT',
        referenceType: 'ADMIN',
        description: 'W1D2 dispute test fixture credit',
      },
    ],
    operationName: 'w1d2disp-test-fixture-credit',
  });
}

async function createFundedUser(tag: string, coins: number) {
  const user = await createUser(`user-${tag}`);
  await creditCoins(user.id, coins);
  return user;
}

async function createActivePayoutAccount(userId: string, countryId: string, methodDefId: string) {
  return createUserPayoutAccount(userId, {
    countryId,
    methodDefId,
    accountDetails: { bankName: 'W1D2 Dispute Bank', accountNumber: '881122335' },
  });
}

async function createHeldWithdrawal(
  tag: string,
  opts: { coins?: number; coinAmount?: number; liquidityUsd?: bigint } = {}
) {
  const admin = await createAdmin(tag);
  const superAdmin = await createSuperAdmin(`${tag}-super`);
  const country = await createCountry(tag);
  const method = await createPaymentMethod(country.id, tag);
  await createExchangeRate(country.id, 'USD', 2, admin.id);
  const { agentUser, agent } = await createFundedAgent(tag, country.id, admin, superAdmin, opts.liquidityUsd ?? 500_000n);
  const user = await createFundedUser(tag, opts.coins ?? 50_000);
  const payoutAccount = await createActivePayoutAccount(user.id, country.id, method.id);

  const coinAmount = opts.coinAmount ?? 10_000;
  const idempotencyKey = `${TAG_PREFIX}create-${tag}-${Date.now()}`;
  const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount });
  const { withdrawal } = await createWithdrawal(
    user.id,
    { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey },
    1000
  );

  return { admin, superAdmin, country, agent, agentUser, user, withdrawal: withdrawal as any, payoutAccount };
}

async function createPayoutInProgressWithdrawal(
  tag: string,
  opts: { coins?: number; coinAmount?: number; liquidityUsd?: bigint } = {}
) {
  const fixture = await createHeldWithdrawal(tag, opts);
  await claimPayout(fixture.agentUser.id, fixture.withdrawal.id, {
    idempotencyKey: `${TAG_PREFIX}claim-${tag}-${Date.now()}`,
  });
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: fixture.withdrawal.id } });
  return { ...fixture, withdrawal: withdrawal as any };
}

async function createPaymentSubmittedWithdrawal(
  tag: string,
  opts: { coins?: number; coinAmount?: number; liquidityUsd?: bigint } = {}
) {
  const fixture = await createPayoutInProgressWithdrawal(tag, opts);
  await submitPayment(fixture.agentUser.id, fixture.withdrawal.id, {
    referenceNumber: `REF-${tag}`,
    idempotencyKey: `${TAG_PREFIX}submit-${tag}-${Date.now()}`,
  });
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: fixture.withdrawal.id } });
  return { ...fixture, withdrawal: withdrawal as any };
}

async function expireDeadline(withdrawalId: string) {
  await prisma.withdrawal.update({
    where: { id: withdrawalId },
    data: { paymentSubmissionDeadlineAt: new Date(Date.now() - 1000) },
  });
}

async function setAgentStatus(agentId: string, status: string) {
  return prisma.agent.update({ where: { id: agentId }, data: { status: status as any } });
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: TAG_PREFIX } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    const agents = await prisma.agent.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const agentIds = agents.map((a) => a.id);

    await prisma.withdrawalDispute.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalEvidence.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalPaymentSubmission.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalOperation.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalSettlement.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalHold.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalLiquidityReservation.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawal.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.withdrawalQuote.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userPayoutAccount.deleteMany({ where: { userId: { in: userIds } } });

    if (agentIds.length) {
      await prisma.agentFiatLiquidityLedger.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentFiatLiquidity.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentApplication.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
    }

    await prisma.stepUpVerification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userTotpFactor.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userSecurityPolicy.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'W1D2 Dispute Test Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'W1D2 Dispute Test Country' } } });
}

// ═══════════════════════════════════════════════════════════════════
// 1. confirmWithdrawalReceipt (PAYMENT_SUBMITTED → COMPLETED)
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D2: confirmWithdrawalReceipt (PAYMENT_SUBMITTED → COMPLETED)', () => {
  beforeAll(() => cleanFixtures());

  it('transitions PAYMENT_SUBMITTED -> COMPLETED and creates a USER_CONFIRMED settlement', async () => {
    const tag = `confirm-ok-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);

    const result = await confirmWithdrawalReceipt(user.id, withdrawal.id, { idempotencyKey: `confirm-${tag}` });
    expect(result.idempotent).toBe(false);
    expect((result.withdrawal as any).status).toBe('COMPLETED');
    expect((result.withdrawal as any).completedAt).not.toBeNull();
    expect(result.settlement.outcome).toBe('COMPLETED');
    expect(result.settlement.resolvedVia).toBe('USER_CONFIRMED');
    expect(result.settlement.resolvedByUserId).toBe(user.id);
    expect(result.settlement.disputeId).toBeNull();
  });

  it('leaves the wallet balance unchanged (coins were already debited at HELD)', async () => {
    const tag = `confirm-wallet-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const before = await getWalletBalance(user.id);

    await confirmWithdrawalReceipt(user.id, withdrawal.id, { idempotencyKey: `confirm-${tag}` });

    const after = await getWalletBalance(user.id);
    expect(after.coinsBalance).toBe(before.coinsBalance);
  });

  it('consumes the hold and reservation, decrements AgentFiatLiquidity total/reserved by the fiat amount, and writes exactly one CONSUME ledger row', async () => {
    const tag = `confirm-money-${Date.now()}`;
    const { agent, user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const reservation = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: withdrawal.id } });
    const liquidityBefore = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });

    await confirmWithdrawalReceipt(user.id, withdrawal.id, { idempotencyKey: `confirm-${tag}` });

    const hold = await prisma.withdrawalHold.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(hold!.status).toBe('CONSUMED');
    expect(hold!.consumedAt).not.toBeNull();

    const reservationAfter = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(reservationAfter!.status).toBe('CONSUMED');
    expect(reservationAfter!.consumedAt).not.toBeNull();

    const liquidityAfter = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    expect(liquidityAfter!.totalBalance).toBe(liquidityBefore!.totalBalance - reservation!.amount);
    expect(liquidityAfter!.reservedBalance).toBe(liquidityBefore!.reservedBalance - reservation!.amount);

    const consumeRows = await prisma.agentFiatLiquidityLedger.findMany({
      where: { withdrawalId: withdrawal.id, type: 'CONSUME' },
    });
    expect(consumeRows).toHaveLength(1);
  });

  it('same idempotencyKey replays the original settlement', async () => {
    const tag = `confirm-replay-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);

    const r1 = await confirmWithdrawalReceipt(user.id, withdrawal.id, { idempotencyKey: `confirm-replay-${tag}` });
    expect(r1.idempotent).toBe(false);
    const r2 = await confirmWithdrawalReceipt(user.id, withdrawal.id, { idempotencyKey: `confirm-replay-${tag}` });
    expect(r2.idempotent).toBe(true);
    expect(r2.settlement.id).toBe(r1.settlement.id);
  });

  it('a foreign WithdrawalOperation row under the same key trips the idempotency-conflict guard', async () => {
    // CONFIRM_RECEIPT's request hash has no caller-supplied payload to vary —
    // opts is just { idempotencyKey } — so two legitimate calls from the same
    // user can never disagree on requestHash, and only the withdrawal owner
    // can call this action at all. The only way findOperation's mismatch
    // branch (dispute-service.ts) can fire in practice is a corrupted/foreign
    // operation row sharing the same (withdrawalId, action, idempotencyKey)
    // key. Seed that directly to exercise the guard.
    const tag = `confirm-conflict-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const idempotencyKey = `confirm-conflict-${tag}`;
    const otherUser = await createUser(`confirm-conflict-other-${tag}`);
    await prisma.withdrawalOperation.create({
      data: {
        withdrawalId: withdrawal.id,
        actorUserId: otherUser.id,
        action: 'CONFIRM_RECEIPT',
        idempotencyKey,
        requestHash: 'seeded-foreign-hash',
        resultType: 'WithdrawalSettlement',
        resultId: randomUUID(),
      },
    });

    await expect(
      confirmWithdrawalReceipt(user.id, withdrawal.id, { idempotencyKey })
    ).rejects.toMatchObject({ details: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. openUserWithdrawalDispute (PAYMENT_SUBMITTED → DISPUTED)
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D2: openUserWithdrawalDispute (PAYMENT_SUBMITTED → DISPUTED)', () => {
  beforeAll(() => cleanFixtures());

  it('opens an OPEN dispute with openedFromStatus PAYMENT_SUBMITTED and moves the withdrawal to DISPUTED', async () => {
    const tag = `open-ok-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);

    const result = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Never received the bank transfer',
      idempotencyKey: `open-${tag}`,
    });
    expect(result.idempotent).toBe(false);
    expect(result.dispute.status).toBe('OPEN');
    expect(result.dispute.openedBy).toBe(user.id);
    expect(result.dispute.openedFromStatus).toBe('PAYMENT_SUBMITTED');
    expect((result.withdrawal as any).status).toBe('DISPUTED');
    expect((result.withdrawal as any).disputedAt).not.toBeNull();
  });

  it('only the withdrawing user can open a dispute', async () => {
    const tag = `open-owner-${Date.now()}`;
    const { withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const otherUser = await createUser(`open-owner-other-${tag}`);

    await expect(
      openUserWithdrawalDispute(otherUser.id, withdrawal.id, {
        reason: 'FIAT_NOT_RECEIVED',
        description: 'Not mine',
        idempotencyKey: `open-${tag}`,
      })
    ).rejects.toThrow(/does not belong to you/i);
  });

  it('cannot open a dispute from PAYOUT_IN_PROGRESS', async () => {
    const tag = `open-pip-${Date.now()}`;
    const { user, withdrawal } = await createPayoutInProgressWithdrawal(tag);

    await expect(
      openUserWithdrawalDispute(user.id, withdrawal.id, {
        reason: 'FIAT_NOT_RECEIVED',
        description: 'Too early',
        idempotencyKey: `open-${tag}`,
      })
    ).rejects.toThrow(/Cannot open a dispute from status/i);
  });

  it('cannot open a dispute from HELD', async () => {
    const tag = `open-held-${Date.now()}`;
    const { user, withdrawal } = await createHeldWithdrawal(tag);

    await expect(
      openUserWithdrawalDispute(user.id, withdrawal.id, {
        reason: 'FIAT_NOT_RECEIVED',
        description: 'Too early',
        idempotencyKey: `open-${tag}`,
      })
    ).rejects.toThrow(/Cannot open a dispute from status/i);
  });

  it('cannot open a dispute from COMPLETED', async () => {
    const tag = `open-completed-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    await confirmWithdrawalReceipt(user.id, withdrawal.id, { idempotencyKey: `confirm-${tag}` });

    await expect(
      openUserWithdrawalDispute(user.id, withdrawal.id, {
        reason: 'FIAT_NOT_RECEIVED',
        description: 'Too late',
        idempotencyKey: `open-${tag}`,
      })
    ).rejects.toThrow(/Cannot open a dispute from status/i);
  });

  it('same idempotencyKey replays the original dispute', async () => {
    const tag = `open-replay-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);

    const r1 = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-replay-${tag}`,
    });
    expect(r1.idempotent).toBe(false);
    const r2 = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-replay-${tag}`,
    });
    expect(r2.idempotent).toBe(true);
    expect(r2.dispute.id).toBe(r1.dispute.id);
  });

  it('same idempotencyKey with a different description conflicts', async () => {
    const tag = `open-conflict-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);

    await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'First description',
      idempotencyKey: `open-conflict-${tag}`,
    });

    await expect(
      openUserWithdrawalDispute(user.id, withdrawal.id, {
        reason: 'FIAT_NOT_RECEIVED',
        description: 'Different description',
        idempotencyKey: `open-conflict-${tag}`,
      })
    ).rejects.toMatchObject({ details: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. escalateWithdrawalToDispute (PAYOUT_IN_PROGRESS → DISPUTED)
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D2: escalateWithdrawalToDispute (PAYOUT_IN_PROGRESS → DISPUTED)', () => {
  beforeAll(() => cleanFixtures());

  it('an independent admin can escalate when the assigned agent is not ACTIVE', async () => {
    const tag = `escalate-agent-${Date.now()}`;
    const { agent, withdrawal } = await createPayoutInProgressWithdrawal(tag);
    const admin = await createAdmin(`escalate-agent-${tag}`);
    await setAgentStatus(agent.id, 'DISABLED');

    const result = await escalateWithdrawalToDispute(admin.id, withdrawal.id, {
      escalationReason: 'AGENT_NOT_ACTIVE',
      description: 'Agent disabled mid-payout',
      idempotencyKey: `escalate-${tag}`,
    });
    expect(result.idempotent).toBe(false);
    expect(result.dispute.status).toBe('OPEN');
    expect(result.dispute.openedBy).toBe(admin.id);
    expect(result.dispute.openedFromStatus).toBe('PAYOUT_IN_PROGRESS');
    expect(result.dispute.escalationReason).toBe('AGENT_NOT_ACTIVE');
    expect((result.withdrawal as any).status).toBe('DISPUTED');
  });

  it('an independent admin can escalate when the payment-submission deadline has elapsed', async () => {
    const tag = `escalate-deadline-${Date.now()}`;
    const { withdrawal } = await createPayoutInProgressWithdrawal(tag);
    const admin = await createAdmin(`escalate-deadline-${tag}`);
    await expireDeadline(withdrawal.id);

    const result = await escalateWithdrawalToDispute(admin.id, withdrawal.id, {
      escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
      description: 'Deadline passed with no submission',
      idempotencyKey: `escalate-${tag}`,
    });
    expect(result.idempotent).toBe(false);
    expect((result.withdrawal as any).status).toBe('DISPUTED');
    expect(result.dispute.escalationReason).toBe('PAYMENT_DEADLINE_ELAPSED');
  });

  it('rejects AGENT_NOT_ACTIVE escalation with ESCALATION_NOT_ALLOWED while the assigned agent is still ACTIVE', async () => {
    const tag = `escalate-blocked-agent-${Date.now()}`;
    const { withdrawal } = await createPayoutInProgressWithdrawal(tag);
    const admin = await createAdmin(`escalate-blocked-agent-${tag}`);

    await expect(
      escalateWithdrawalToDispute(admin.id, withdrawal.id, {
        escalationReason: 'AGENT_NOT_ACTIVE',
        description: 'Agent looks fine',
        idempotencyKey: `escalate-${tag}`,
      })
    ).rejects.toMatchObject({ details: { code: 'ESCALATION_NOT_ALLOWED' } });
  });

  it('rejects PAYMENT_DEADLINE_ELAPSED escalation with ESCALATION_NOT_ALLOWED before the deadline passes', async () => {
    const tag = `escalate-blocked-deadline-${Date.now()}`;
    const { withdrawal } = await createPayoutInProgressWithdrawal(tag);
    const admin = await createAdmin(`escalate-blocked-deadline-${tag}`);

    await expect(
      escalateWithdrawalToDispute(admin.id, withdrawal.id, {
        escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
        description: 'Too early',
        idempotencyKey: `escalate-${tag}`,
      })
    ).rejects.toMatchObject({ details: { code: 'ESCALATION_NOT_ALLOWED' } });
  });

  it('blocks self-review when the admin is the withdrawing user', async () => {
    const tag = `escalate-self-user-${Date.now()}`;
    const { user, withdrawal } = await createPayoutInProgressWithdrawal(tag);
    await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });

    await expect(
      escalateWithdrawalToDispute(user.id, withdrawal.id, {
        escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
        description: 'Self review attempt',
        idempotencyKey: `escalate-${tag}`,
      })
    ).rejects.toThrow(/cannot administer your own withdrawal/i);
  });

  it('blocks the assigned agent user from escalating their own assigned withdrawal', async () => {
    const tag = `escalate-self-agent-${Date.now()}`;
    const { agentUser, withdrawal } = await createPayoutInProgressWithdrawal(tag);
    await prisma.user.update({ where: { id: agentUser.id }, data: { role: 'ADMIN' } });

    await expect(
      escalateWithdrawalToDispute(agentUser.id, withdrawal.id, {
        escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
        description: 'Self review attempt',
        idempotencyKey: `escalate-${tag}`,
      })
    ).rejects.toThrow(/cannot administer a withdrawal assigned to your own agent account/i);
  });

  it('same idempotencyKey replays the original escalation', async () => {
    const tag = `escalate-replay-${Date.now()}`;
    const { withdrawal } = await createPayoutInProgressWithdrawal(tag);
    const admin = await createAdmin(`escalate-replay-${tag}`);
    await expireDeadline(withdrawal.id);

    const r1 = await escalateWithdrawalToDispute(admin.id, withdrawal.id, {
      escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
      description: 'Deadline elapsed',
      idempotencyKey: `escalate-replay-${tag}`,
    });
    expect(r1.idempotent).toBe(false);
    const r2 = await escalateWithdrawalToDispute(admin.id, withdrawal.id, {
      escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
      description: 'Deadline elapsed',
      idempotencyKey: `escalate-replay-${tag}`,
    });
    expect(r2.idempotent).toBe(true);
    expect(r2.dispute.id).toBe(r1.dispute.id);
  });

  it('same idempotencyKey with a different description conflicts, even after the withdrawal has progressed to DISPUTED', async () => {
    const tag = `escalate-conflict-${Date.now()}`;
    const { withdrawal } = await createPayoutInProgressWithdrawal(tag);
    const admin = await createAdmin(`escalate-conflict-${tag}`);
    await expireDeadline(withdrawal.id);

    await escalateWithdrawalToDispute(admin.id, withdrawal.id, {
      escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
      description: 'First description',
      idempotencyKey: `escalate-conflict-${tag}`,
    });

    await expect(
      escalateWithdrawalToDispute(admin.id, withdrawal.id, {
        escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
        description: 'Different description',
        idempotencyKey: `escalate-conflict-${tag}`,
      })
    ).rejects.toMatchObject({ details: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. claimWithdrawalDispute (OPEN → ASSIGNED)
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D2: claimWithdrawalDispute (OPEN → ASSIGNED)', () => {
  beforeAll(() => cleanFixtures());

  it('an admin can claim an OPEN dispute, moving it to ASSIGNED', async () => {
    const tag = `claim-ok-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });
    const admin = await createAdmin(`claim-ok-${tag}`);

    const result = await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-${tag}` });
    expect(result.idempotent).toBe(false);
    expect((result.dispute as any).status).toBe('ASSIGNED');
    expect((result.dispute as any).assignedAdminId).toBe(admin.id);
  });

  it('only an active ADMIN/SUPER_ADMIN can claim', async () => {
    const tag = `claim-nonadmin-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });
    const plainUser = await createUser(`claim-nonadmin-plain-${tag}`);

    await expect(
      claimWithdrawalDispute(plainUser.id, dispute.id, { idempotencyKey: `claim-${tag}` })
    ).rejects.toThrow(/Admin privileges required/i);
  });

  it('the admin who opened (escalated) a dispute cannot claim it', async () => {
    const tag = `claim-opener-${Date.now()}`;
    const { withdrawal } = await createPayoutInProgressWithdrawal(tag);
    const adminA = await createAdmin(`claim-opener-${tag}`);
    await expireDeadline(withdrawal.id);
    const { dispute } = await escalateWithdrawalToDispute(adminA.id, withdrawal.id, {
      escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
      description: 'Deadline elapsed',
      idempotencyKey: `escalate-${tag}`,
    });

    await expect(
      claimWithdrawalDispute(adminA.id, dispute.id, { idempotencyKey: `claim-${tag}` })
    ).rejects.toThrow(/cannot claim it/i);
  });

  it('the withdrawing user cannot claim a dispute on their own withdrawal, even if promoted to admin', async () => {
    const tag = `claim-self-user-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });
    await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });

    await expect(
      claimWithdrawalDispute(user.id, dispute.id, { idempotencyKey: `claim-${tag}` })
    ).rejects.toThrow(/cannot administer your own withdrawal/i);
  });

  it('the assigned agent user cannot claim a dispute on their own assigned withdrawal, even if promoted to admin', async () => {
    const tag = `claim-self-agent-${Date.now()}`;
    const { agentUser, user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });
    await prisma.user.update({ where: { id: agentUser.id }, data: { role: 'ADMIN' } });

    await expect(
      claimWithdrawalDispute(agentUser.id, dispute.id, { idempotencyKey: `claim-${tag}` })
    ).rejects.toThrow(/cannot administer a withdrawal assigned to your own agent account/i);
  });

  it('same idempotencyKey replays the original claim', async () => {
    const tag = `claim-replay-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });
    const admin = await createAdmin(`claim-replay-${tag}`);

    const r1 = await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-replay-${tag}` });
    expect(r1.idempotent).toBe(false);
    const r2 = await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-replay-${tag}` });
    expect(r2.idempotent).toBe(true);
  });

  it('a second admin cannot claim a dispute already assigned to another admin', async () => {
    const tag = `claim-taken-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });
    const adminA = await createAdmin(`claim-taken-a-${tag}`);
    const adminB = await createAdmin(`claim-taken-b-${tag}`);
    await claimWithdrawalDispute(adminA.id, dispute.id, { idempotencyKey: `claim-a-${tag}` });

    await expect(
      claimWithdrawalDispute(adminB.id, dispute.id, { idempotencyKey: `claim-b-${tag}` })
    ).rejects.toThrow(/cannot be claimed from status/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. resolveWithdrawalDispute — outcome COMPLETED (DISPUTED → COMPLETED)
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D2: resolveWithdrawalDispute outcome COMPLETED (DISPUTED → COMPLETED)', () => {
  beforeAll(() => cleanFixtures());

  it('only the claiming admin can resolve the dispute', async () => {
    const tag = `resolve-owner-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });
    const adminA = await createAdmin(`resolve-owner-a-${tag}`);
    const adminB = await createAdmin(`resolve-owner-b-${tag}`);
    await claimWithdrawalDispute(adminA.id, dispute.id, { idempotencyKey: `claim-${tag}` });

    await expect(
      resolveWithdrawalDispute(adminB.id, dispute.id, {
        outcome: 'COMPLETED',
        resolutionNote: 'Confirmed via bank statement',
        idempotencyKey: `resolve-${tag}`,
      })
    ).rejects.toThrow(/Only the admin who claimed this dispute may resolve it/i);
  });

  it('resolves a PAYMENT_SUBMITTED-origin dispute as COMPLETED: DISPUTED->COMPLETED, dispute RESOLVED/RELEASE_COINS, wallet unchanged, hold/reservation CONSUMED, liquidity decreases by the fiat amount, one CONSUME row', async () => {
    const tag = `resolve-completed-${Date.now()}`;
    const { agent, user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });
    const admin = await createAdmin(`resolve-completed-${tag}`);
    await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-${tag}` });

    const reservation = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: withdrawal.id } });
    const liquidityBefore = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    const balanceBefore = await getWalletBalance(user.id);

    const result = await resolveWithdrawalDispute(admin.id, dispute.id, {
      outcome: 'COMPLETED',
      resolutionNote: 'Bank statement confirms receipt',
      idempotencyKey: `resolve-${tag}`,
    });
    expect(result.idempotent).toBe(false);
    expect((result.withdrawal as any).status).toBe('COMPLETED');
    expect((result.dispute as any).status).toBe('RESOLVED');
    expect((result.dispute as any).resolution).toBe('RELEASE_COINS');
    expect(result.settlement.outcome).toBe('COMPLETED');
    expect(result.settlement.resolvedVia).toBe('ADMIN_DISPUTE_RESOLUTION');
    expect(result.settlement.disputeId).toBe(dispute.id);
    expect(result.settlement.resolvedByUserId).toBe(admin.id);

    const balanceAfter = await getWalletBalance(user.id);
    expect(balanceAfter.coinsBalance).toBe(balanceBefore.coinsBalance);

    const hold = await prisma.withdrawalHold.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(hold!.status).toBe('CONSUMED');
    const reservationAfter = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(reservationAfter!.status).toBe('CONSUMED');

    const liquidityAfter = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    expect(liquidityAfter!.totalBalance).toBe(liquidityBefore!.totalBalance - reservation!.amount);
    expect(liquidityAfter!.reservedBalance).toBe(liquidityBefore!.reservedBalance - reservation!.amount);

    const consumeRows = await prisma.agentFiatLiquidityLedger.findMany({
      where: { withdrawalId: withdrawal.id, type: 'CONSUME' },
    });
    expect(consumeRows).toHaveLength(1);
  });

  it('requires adminVerifiedPayment to complete a dispute escalated from PAYOUT_IN_PROGRESS, and records an ADMIN_VERIFIED payment submission', async () => {
    const tag = `resolve-verified-${Date.now()}`;
    const { withdrawal } = await createPayoutInProgressWithdrawal(tag);
    const adminA = await createAdmin(`resolve-verified-esc-${tag}`);
    await expireDeadline(withdrawal.id);
    const { dispute } = await escalateWithdrawalToDispute(adminA.id, withdrawal.id, {
      escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
      description: 'No submission',
      idempotencyKey: `escalate-${tag}`,
    });
    const adminB = await createAdmin(`resolve-verified-res-${tag}`);
    await claimWithdrawalDispute(adminB.id, dispute.id, { idempotencyKey: `claim-${tag}` });

    await expect(
      resolveWithdrawalDispute(adminB.id, dispute.id, {
        outcome: 'COMPLETED',
        resolutionNote: 'Verified externally',
        idempotencyKey: `resolve-noverify-${tag}`,
      })
    ).rejects.toThrow(/adminVerifiedPayment is required/i);

    const result = await resolveWithdrawalDispute(adminB.id, dispute.id, {
      outcome: 'COMPLETED',
      resolutionNote: 'Verified externally',
      idempotencyKey: `resolve-${tag}`,
      adminVerifiedPayment: {
        referenceNumber: 'BANK-REF-1',
        paymentOccurredAt: new Date(),
        note: 'Confirmed by phone with agent',
      },
    });
    expect((result.withdrawal as any).status).toBe('COMPLETED');

    const submission = await prisma.withdrawalPaymentSubmission.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(submission!.source).toBe('ADMIN_VERIFIED');
    expect(submission!.paymentOccurredAt).not.toBeNull();
    expect(submission!.submittedByUserId).toBe(adminB.id);
  });

  it('rejects adminVerifiedPayment when resolving a dispute opened from PAYMENT_SUBMITTED', async () => {
    const tag = `resolve-reject-verified-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });
    const admin = await createAdmin(`resolve-reject-verified-${tag}`);
    await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-${tag}` });

    await expect(
      resolveWithdrawalDispute(admin.id, dispute.id, {
        outcome: 'COMPLETED',
        resolutionNote: 'Trying to override the agent submission',
        idempotencyKey: `resolve-${tag}`,
        adminVerifiedPayment: {
          referenceNumber: 'BANK-REF-2',
          paymentOccurredAt: new Date(),
        },
      })
    ).rejects.toThrow(/must not replace an existing agent payment submission/i);
  });

  it('same idempotencyKey replays the original COMPLETED resolution', async () => {
    const tag = `resolve-replay-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });
    const admin = await createAdmin(`resolve-replay-${tag}`);
    await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-${tag}` });

    const r1 = await resolveWithdrawalDispute(admin.id, dispute.id, {
      outcome: 'COMPLETED',
      resolutionNote: 'Confirmed',
      idempotencyKey: `resolve-replay-${tag}`,
    });
    expect(r1.idempotent).toBe(false);
    const r2 = await resolveWithdrawalDispute(admin.id, dispute.id, {
      outcome: 'COMPLETED',
      resolutionNote: 'Confirmed',
      idempotencyKey: `resolve-replay-${tag}`,
    });
    expect(r2.idempotent).toBe(true);
    expect(r2.settlement.id).toBe(r1.settlement.id);
  });

  it('same idempotencyKey with a different resolutionNote conflicts', async () => {
    const tag = `resolve-conflict-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });
    const admin = await createAdmin(`resolve-conflict-${tag}`);
    await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-${tag}` });

    await resolveWithdrawalDispute(admin.id, dispute.id, {
      outcome: 'COMPLETED',
      resolutionNote: 'First note',
      idempotencyKey: `resolve-conflict-${tag}`,
    });

    await expect(
      resolveWithdrawalDispute(admin.id, dispute.id, {
        outcome: 'COMPLETED',
        resolutionNote: 'Different note',
        idempotencyKey: `resolve-conflict-${tag}`,
      })
    ).rejects.toMatchObject({ details: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. resolveWithdrawalDispute — outcome CANCELLED (DISPUTED → CANCELLED)
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D2: resolveWithdrawalDispute outcome CANCELLED (DISPUTED → CANCELLED)', () => {
  beforeAll(() => cleanFixtures());

  it('only the claiming admin can resolve the dispute', async () => {
    const tag = `resolve-cancel-owner-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'WRONG_FIAT_AMOUNT',
      description: 'Wrong amount received',
      idempotencyKey: `open-${tag}`,
    });
    const adminA = await createAdmin(`resolve-cancel-owner-a-${tag}`);
    const adminB = await createAdmin(`resolve-cancel-owner-b-${tag}`);
    await claimWithdrawalDispute(adminA.id, dispute.id, { idempotencyKey: `claim-${tag}` });

    await expect(
      resolveWithdrawalDispute(adminB.id, dispute.id, {
        outcome: 'CANCELLED',
        resolutionNote: 'Refunding due to wrong amount',
        idempotencyKey: `resolve-${tag}`,
      })
    ).rejects.toThrow(/Only the admin who claimed this dispute may resolve it/i);
  });

  it('resolves a dispute as CANCELLED: DISPUTED->CANCELLED, dispute RESOLVED/CANCEL_WITHDRAWAL, wallet credited exactly hold.coinAmount, hold REFUNDED, reservation RELEASED, liquidity reserved decreases (total unchanged), one RELEASE row, no AgentInventory touch', async () => {
    const tag = `resolve-cancelled-${Date.now()}`;
    const { agent, user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'WRONG_FIAT_AMOUNT',
      description: 'Wrong amount received',
      idempotencyKey: `open-${tag}`,
    });
    const admin = await createAdmin(`resolve-cancelled-${tag}`);
    await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-${tag}` });

    const hold = await prisma.withdrawalHold.findUnique({ where: { withdrawalId: withdrawal.id } });
    const reservation = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: withdrawal.id } });
    const liquidityBefore = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    const balanceBefore = await getWalletBalance(user.id);
    const inventoryBefore = await prisma.agentInventory.findUnique({ where: { agentId: agent.id } });
    const inventoryLedgerBefore = await prisma.agentInventoryLedger.count({ where: { agentId: agent.id } });

    const result = await resolveWithdrawalDispute(admin.id, dispute.id, {
      outcome: 'CANCELLED',
      resolutionNote: 'Refunding due to wrong amount',
      idempotencyKey: `resolve-${tag}`,
    });
    expect(result.idempotent).toBe(false);
    expect((result.withdrawal as any).status).toBe('CANCELLED');
    expect((result.dispute as any).status).toBe('RESOLVED');
    expect((result.dispute as any).resolution).toBe('CANCEL_WITHDRAWAL');
    expect(result.settlement.outcome).toBe('CANCELLED');
    expect(result.settlement.refundWalletTransactionId).not.toBeNull();

    const balanceAfter = await getWalletBalance(user.id);
    expect(balanceAfter.coinsBalance).toBe(balanceBefore.coinsBalance + hold!.coinAmount);

    const holdAfter = await prisma.withdrawalHold.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(holdAfter!.status).toBe('REFUNDED');
    expect(holdAfter!.refundWalletTransactionId).toBe(result.settlement.refundWalletTransactionId);

    const reservationAfter = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(reservationAfter!.status).toBe('RELEASED');

    const liquidityAfter = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    expect(liquidityAfter!.reservedBalance).toBe(liquidityBefore!.reservedBalance - reservation!.amount);
    expect(liquidityAfter!.totalBalance).toBe(liquidityBefore!.totalBalance);

    const releaseRows = await prisma.agentFiatLiquidityLedger.findMany({
      where: { withdrawalId: withdrawal.id, type: 'RELEASE' },
    });
    expect(releaseRows).toHaveLength(1);

    const inventoryAfter = await prisma.agentInventory.findUnique({ where: { agentId: agent.id } });
    expect(inventoryAfter?.totalBalance ?? 0).toBe(inventoryBefore?.totalBalance ?? 0);
    expect(inventoryAfter?.reservedBalance ?? 0).toBe(inventoryBefore?.reservedBalance ?? 0);
    const inventoryLedgerAfter = await prisma.agentInventoryLedger.count({ where: { agentId: agent.id } });
    expect(inventoryLedgerAfter).toBe(inventoryLedgerBefore);
  });

  it('same idempotencyKey replays the original CANCELLED resolution', async () => {
    const tag = `resolve-cancel-replay-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'WRONG_FIAT_AMOUNT',
      description: 'Wrong amount received',
      idempotencyKey: `open-${tag}`,
    });
    const admin = await createAdmin(`resolve-cancel-replay-${tag}`);
    await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-${tag}` });

    const r1 = await resolveWithdrawalDispute(admin.id, dispute.id, {
      outcome: 'CANCELLED',
      resolutionNote: 'Refunding',
      idempotencyKey: `resolve-cancel-replay-${tag}`,
    });
    expect(r1.idempotent).toBe(false);
    const r2 = await resolveWithdrawalDispute(admin.id, dispute.id, {
      outcome: 'CANCELLED',
      resolutionNote: 'Refunding',
      idempotencyKey: `resolve-cancel-replay-${tag}`,
    });
    expect(r2.idempotent).toBe(true);
    expect(r2.settlement.id).toBe(r1.settlement.id);
  });

  it('same idempotencyKey with a different resolutionNote conflicts', async () => {
    const tag = `resolve-cancel-conflict-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    const { dispute } = await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'WRONG_FIAT_AMOUNT',
      description: 'Wrong amount received',
      idempotencyKey: `open-${tag}`,
    });
    const admin = await createAdmin(`resolve-cancel-conflict-${tag}`);
    await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-${tag}` });

    await resolveWithdrawalDispute(admin.id, dispute.id, {
      outcome: 'CANCELLED',
      resolutionNote: 'First note',
      idempotencyKey: `resolve-cancel-conflict-${tag}`,
    });

    await expect(
      resolveWithdrawalDispute(admin.id, dispute.id, {
        outcome: 'CANCELLED',
        resolutionNote: 'Different note',
        idempotencyKey: `resolve-cancel-conflict-${tag}`,
      })
    ).rejects.toMatchObject({ details: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. User cancel is still forbidden once past HELD
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D2: cancelHeldWithdrawal remains forbidden once past HELD', () => {
  beforeAll(() => cleanFixtures());

  it('rejects cancellation from PAYOUT_IN_PROGRESS', async () => {
    const tag = `cancel-pip-${Date.now()}`;
    const { user, withdrawal } = await createPayoutInProgressWithdrawal(tag);

    await expect(
      cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-${tag}` })
    ).rejects.toThrow(/Cannot cancel withdrawal from status/i);
  });

  it('rejects cancellation from PAYMENT_SUBMITTED', async () => {
    const tag = `cancel-submitted-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);

    await expect(
      cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-${tag}` })
    ).rejects.toThrow(/Cannot cancel withdrawal from status/i);
  });

  it('rejects cancellation from DISPUTED', async () => {
    const tag = `cancel-disputed-${Date.now()}`;
    const { user, withdrawal } = await createPaymentSubmittedWithdrawal(tag);
    await openUserWithdrawalDispute(user.id, withdrawal.id, {
      reason: 'FIAT_NOT_RECEIVED',
      description: 'Missing funds',
      idempotencyKey: `open-${tag}`,
    });

    await expect(
      cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-${tag}` })
    ).rejects.toThrow(/Cannot cancel withdrawal from status/i);
  });
});
