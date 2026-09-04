import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { randomUUID } from 'node:crypto';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service';
import { fundAgentFiatLiquidity } from './liquidity-service';
import { createWithdrawalQuote } from './quote-service';
import { createUserPayoutAccount } from './payout-account-service';
import { createWithdrawal, claimPayout, submitPayment } from './withdrawal-service';
import { escalateWithdrawalToDispute, claimWithdrawalDispute, resolveWithdrawalDispute } from './dispute-service';
import { sweepWithdrawalTimeouts } from './timeout-service';
import { executeBalanceChange, getWalletBalance } from '../economy/wallet-service';

// W-1D3: withdrawal timeout sweep service tests.
//
// Financial inverse tests operating on the live database. If the database
// is unavailable, they MUST fail hard rather than silently report green
// zero-coverage via describe.skip — a skipped financial suite hides
// regressions.

try {
  await prisma.$queryRaw`SELECT 1`;
} catch (err) {
  console.error('W-1D3 timeout sweep tests require a reachable Postgres database. Failing run.');
  throw new Error('W-1D3 timeout sweep tests failed to connect to Postgres: ' + (err as Error)?.message);
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = describe;

// ─── Fixture helpers (mirror w1d2-dispute-lifecycle.test.ts) ──────────

const TAG_PREFIX = 'w1d3sweep-';

async function createUser(tag: string) {
  const email = `${TAG_PREFIX}${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `${TAG_PREFIX}${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `W1D3 Sweep Test ${tag}`,
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
  const code = `W3S${randomUUID().replaceAll('-', '').slice(0, 6)}`.toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `W1D3 Sweep Test Country ${tag}`,
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
      name: `W1D3 Sweep Method ${tag}`,
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
    displayName: `W1D3 Sweep Agent ${tag}`,
    contactEmail: `w1d3sweep-agent-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.id, undefined);
  const agent = await prisma.agent.findUnique({ where: { userId: agentUser.id } });
  await fundAgentFiatLiquidity(
    superAdmin.id,
    agent!.id,
    'USD',
    liquidityUsd,
    `w1d3sweep-fund-${tag}-${Date.now()}-${Math.random()}`
  );
  return { agentUser, agent: agent! };
}

async function createFundedUser(tag: string, coins: number) {
  const user = await createUser(`user-${tag}`);
  await executeBalanceChange({
    userId: user.id,
    changes: [
      { currency: 'COINS', amount: coins, ledgerType: 'CREDIT', transactionType: 'COIN_CREDIT', referenceType: 'ADMIN', description: 'fixture' },
    ],
    operationName: 'w1d3sweep-test-fixture-credit',
  });
  return user;
}

async function createActivePayoutAccount(userId: string, countryId: string, methodDefId: string) {
  return createUserPayoutAccount(userId, {
    countryId,
    methodDefId,
    accountDetails: { bankName: 'W1D3 Sweep Bank', accountNumber: '771122336' },
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

async function expirePayoutDeadline(withdrawalId: string) {
  await prisma.withdrawal.update({
    where: { id: withdrawalId },
    data: { paymentSubmissionDeadlineAt: new Date(Date.now() - 1000) },
  });
}

async function expireConfirmationDeadline(withdrawalId: string) {
  await prisma.withdrawal.update({
    where: { id: withdrawalId },
    data: { confirmationDeadlineAt: new Date(Date.now() - 1000) },
  });
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

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'W1D3 Sweep Test Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'W1D3 Sweep Test Country' } } });
}

// A full snapshot of everything a timeout sweep must never touch.
async function snapshotMoneyState(fixture: { withdrawal: { id: string }; agent: { id: string }; user: { id: string } }) {
  const [
    wallet,
    walletTransactionCount,
    hold,
    reservation,
    liquidity,
    ledgerCount,
    settlementCount,
    inventoryCount,
  ] = await Promise.all([
    getWalletBalance(fixture.user.id),
    prisma.walletTransaction.count({ where: { userId: fixture.user.id } }),
    prisma.withdrawalHold.findUnique({ where: { withdrawalId: fixture.withdrawal.id } }),
    prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: fixture.withdrawal.id } }),
    prisma.agentFiatLiquidity.findUnique({ where: { agentId_fiatCurrency: { agentId: fixture.agent.id, fiatCurrency: 'USD' } } }),
    prisma.agentFiatLiquidityLedger.count({ where: { agentId: fixture.agent.id } }),
    prisma.withdrawalSettlement.count({ where: { withdrawalId: fixture.withdrawal.id } }),
    prisma.agentInventory.count({ where: { agentId: fixture.agent.id } }),
  ]);
  return {
    coinsBalance: wallet.coinsBalance,
    walletTransactionCount,
    holdStatus: hold?.status ?? null,
    holdCoinAmount: hold?.coinAmount ?? null,
    reservationStatus: reservation?.status ?? null,
    reservationAmount: reservation?.amount ?? null,
    liquidityTotal: liquidity?.totalBalance ?? null,
    liquidityReserved: liquidity?.reservedBalance ?? null,
    ledgerCount,
    settlementCount,
    inventoryCount,
  };
}

// ═══════════════════════════════════════════════════════════════════
// T1: PAYOUT_IN_PROGRESS -> DISPUTED (paymentSubmissionDeadlineAt)
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D3: sweepWithdrawalTimeouts — T1 (payment-submission deadline)', () => {
  beforeAll(() => cleanFixtures());

  it('escalates an expired PAYOUT_IN_PROGRESS withdrawal to DISPUTED with the correct system dispute fields', async () => {
    const tag = `t1-ok-${Date.now()}`;
    const fixture = await createPayoutInProgressWithdrawal(tag);
    await expirePayoutDeadline(fixture.withdrawal.id);

    const summary = await sweepWithdrawalTimeouts();
    expect(summary.lockAcquired).toBe(true);

    const outcome = summary.payoutDeadline.outcomes.find((o) => o.withdrawalId === fixture.withdrawal.id);
    expect(outcome?.result).toBe('ESCALATED');
    expect(outcome?.disputeId).toBeTruthy();

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: fixture.withdrawal.id } });
    expect(withdrawal!.status).toBe('DISPUTED');
    expect(withdrawal!.disputedAt).not.toBeNull();

    const dispute = await prisma.withdrawalDispute.findUnique({ where: { id: outcome!.disputeId! } });
    expect(dispute!.openedBy).toBe('SYSTEM');
    expect(dispute!.reason).toBe('AGENT_UNRESPONSIVE');
    expect(dispute!.escalationReason).toBe('PAYMENT_DEADLINE_ELAPSED');
    expect(dispute!.openedFromStatus).toBe('PAYOUT_IN_PROGRESS');
    expect(dispute!.status).toBe('OPEN');

    const operation = await prisma.withdrawalOperation.findFirst({
      where: { withdrawalId: fixture.withdrawal.id, action: 'SYSTEM_TIMEOUT_ESCALATE_PAYOUT' },
    });
    expect(operation).not.toBeNull();
    expect(operation!.actorUserId).toBe('SYSTEM');

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: outcome!.disputeId!, action: 'WITHDRAWAL_SYSTEM_TIMEOUT_ESCALATED' },
    });
    expect(audit).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// T2: PAYMENT_SUBMITTED -> DISPUTED (confirmationDeadlineAt)
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D3: sweepWithdrawalTimeouts — T2 (confirmation deadline)', () => {
  beforeAll(() => cleanFixtures());

  it('escalates an expired PAYMENT_SUBMITTED withdrawal to DISPUTED with the correct system dispute fields', async () => {
    const tag = `t2-ok-${Date.now()}`;
    const fixture = await createPaymentSubmittedWithdrawal(tag);
    await expireConfirmationDeadline(fixture.withdrawal.id);

    const summary = await sweepWithdrawalTimeouts();
    expect(summary.lockAcquired).toBe(true);

    const outcome = summary.confirmationDeadline.outcomes.find((o) => o.withdrawalId === fixture.withdrawal.id);
    expect(outcome?.result).toBe('ESCALATED');
    expect(outcome?.disputeId).toBeTruthy();

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: fixture.withdrawal.id } });
    expect(withdrawal!.status).toBe('DISPUTED');

    const dispute = await prisma.withdrawalDispute.findUnique({ where: { id: outcome!.disputeId! } });
    expect(dispute!.openedBy).toBe('SYSTEM');
    expect(dispute!.reason).toBe('OTHER');
    expect(dispute!.escalationReason).toBe('CONFIRMATION_DEADLINE_ELAPSED');
    expect(dispute!.openedFromStatus).toBe('PAYMENT_SUBMITTED');
    expect(dispute!.status).toBe('OPEN');

    const operation = await prisma.withdrawalOperation.findFirst({
      where: { withdrawalId: fixture.withdrawal.id, action: 'SYSTEM_TIMEOUT_ESCALATE_CONFIRMATION' },
    });
    expect(operation).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// No-op before deadline
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D3: sweepWithdrawalTimeouts — no-op before either deadline elapses', () => {
  beforeAll(() => cleanFixtures());

  it('leaves a fresh PAYOUT_IN_PROGRESS and PAYMENT_SUBMITTED withdrawal untouched', async () => {
    const tag = `noop-${Date.now()}`;
    const pip = await createPayoutInProgressWithdrawal(`${tag}-pip`);
    const ps = await createPaymentSubmittedWithdrawal(`${tag}-ps`);

    // Force both deadlines safely into the future rather than trusting the
    // fixtures' default windows (15min / 72h) to still be unexpired by the
    // time the sweep runs. The production query compares against the
    // DATABASE's now(), not the Node process's clock — on a machine where
    // those two clocks are skewed, a Node.now()-based "future" value can
    // still land at or before the DB's now() by the time the sweep's SQL
    // runs. Anchor to DB now() instead so this is correct regardless of
    // any app/DB clock skew.
    const [{ now: dbNow }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const future = new Date(dbNow.getTime() + 60 * 60 * 1000);
    await prisma.withdrawal.update({ where: { id: pip.withdrawal.id }, data: { paymentSubmissionDeadlineAt: future } });
    await prisma.withdrawal.update({ where: { id: ps.withdrawal.id }, data: { confirmationDeadlineAt: future } });

    const pipBefore = await prisma.withdrawal.findUnique({ where: { id: pip.withdrawal.id } });
    const psBefore = await prisma.withdrawal.findUnique({ where: { id: ps.withdrawal.id } });
    const [{ now: beforeSweepDbNow }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    expect(pipBefore!.paymentSubmissionDeadlineAt!.getTime()).toBeGreaterThan(beforeSweepDbNow.getTime());
    expect(psBefore!.confirmationDeadlineAt!.getTime()).toBeGreaterThan(beforeSweepDbNow.getTime());

    const summary = await sweepWithdrawalTimeouts();

    expect(summary.payoutDeadline.outcomes.some((o) => o.withdrawalId === pip.withdrawal.id)).toBe(false);
    expect(summary.confirmationDeadline.outcomes.some((o) => o.withdrawalId === ps.withdrawal.id)).toBe(false);

    const pipAfter = await prisma.withdrawal.findUnique({ where: { id: pip.withdrawal.id } });
    expect(pipAfter!.status).toBe('PAYOUT_IN_PROGRESS');
    const psAfter = await prisma.withdrawal.findUnique({ where: { id: ps.withdrawal.id } });
    expect(psAfter!.status).toBe('PAYMENT_SUBMITTED');

    const disputeCount = await prisma.withdrawalDispute.count({
      where: { withdrawalId: { in: [pip.withdrawal.id, ps.withdrawal.id] } },
    });
    expect(disputeCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Money invariants
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D3: sweepWithdrawalTimeouts — money invariants', () => {
  beforeAll(() => cleanFixtures());

  it('T1 escalation leaves every money-bearing row exactly as it was — the sweep only moves status', async () => {
    const tag = `money-t1-${Date.now()}`;
    const fixture = await createPayoutInProgressWithdrawal(tag);
    await expirePayoutDeadline(fixture.withdrawal.id);

    const before = await snapshotMoneyState(fixture);
    await sweepWithdrawalTimeouts();
    const after = await snapshotMoneyState(fixture);

    expect(after).toEqual(before);

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: fixture.withdrawal.id } });
    expect(withdrawal!.status).toBe('DISPUTED');
  });

  it('T2 escalation leaves every money-bearing row exactly as it was — the sweep only moves status', async () => {
    const tag = `money-t2-${Date.now()}`;
    const fixture = await createPaymentSubmittedWithdrawal(tag);
    await expireConfirmationDeadline(fixture.withdrawal.id);

    const before = await snapshotMoneyState(fixture);
    await sweepWithdrawalTimeouts();
    const after = await snapshotMoneyState(fixture);

    expect(after).toEqual(before);

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: fixture.withdrawal.id } });
    expect(withdrawal!.status).toBe('DISPUTED');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Idempotent re-run
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D3: sweepWithdrawalTimeouts — idempotent re-run', () => {
  beforeAll(() => cleanFixtures());

  it('running the sweep again after an escalation creates no second dispute and no second operation', async () => {
    const tag = `idem-${Date.now()}`;
    const fixture = await createPayoutInProgressWithdrawal(tag);
    await expirePayoutDeadline(fixture.withdrawal.id);

    const first = await sweepWithdrawalTimeouts();
    const firstOutcome = first.payoutDeadline.outcomes.find((o) => o.withdrawalId === fixture.withdrawal.id);
    expect(firstOutcome?.result).toBe('ESCALATED');

    const second = await sweepWithdrawalTimeouts();
    const secondOutcome = second.payoutDeadline.outcomes.find((o) => o.withdrawalId === fixture.withdrawal.id);
    // The withdrawal is no longer a T1 candidate at all (status moved to
    // DISPUTED, so it's outside the batch SELECT's WHERE clause) — it
    // simply never appears in the second sweep's outcomes.
    expect(secondOutcome).toBeUndefined();

    const disputeCount = await prisma.withdrawalDispute.count({ where: { withdrawalId: fixture.withdrawal.id } });
    expect(disputeCount).toBe(1);
    const operationCount = await prisma.withdrawalOperation.count({
      where: { withdrawalId: fixture.withdrawal.id, action: 'SYSTEM_TIMEOUT_ESCALATE_PAYOUT' },
    });
    expect(operationCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Skip when an active dispute already exists
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D3: sweepWithdrawalTimeouts — skip when already disputed', () => {
  beforeAll(() => cleanFixtures());

  it('does not create a second dispute for a withdrawal an admin already escalated', async () => {
    const tag = `already-disputed-${Date.now()}`;
    const fixture = await createPayoutInProgressWithdrawal(tag);
    await expirePayoutDeadline(fixture.withdrawal.id);

    const admin = await createAdmin(`already-disputed-${tag}`);
    const { dispute: adminDispute } = await escalateWithdrawalToDispute(admin.id, fixture.withdrawal.id, {
      escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
      description: 'Manually escalated by an admin before the sweep ran',
      idempotencyKey: `manual-escalate-${tag}`,
    });

    const summary = await sweepWithdrawalTimeouts();
    const outcome = summary.payoutDeadline.outcomes.find((o) => o.withdrawalId === fixture.withdrawal.id);
    // The withdrawal's status is already DISPUTED by the time the sweep's
    // batch SELECT runs, so — same as the idempotent-rerun case — it is
    // simply outside the WHERE clause and never appears as a candidate.
    expect(outcome).toBeUndefined();

    const disputeCount = await prisma.withdrawalDispute.count({ where: { withdrawalId: fixture.withdrawal.id } });
    expect(disputeCount).toBe(1);
    const dispute = await prisma.withdrawalDispute.findUnique({ where: { id: adminDispute.id } });
    expect(dispute!.openedBy).toBe(admin.id);
  });

  it('the ACTIVE_DISPUTE_EXISTS guard skips a race where a dispute is opened between batch selection and per-row processing', async () => {
    // A withdrawal that is STILL PAYOUT_IN_PROGRESS in the DB (so the batch
    // SELECT picks it up) but gains an active dispute a moment later —
    // simulating a race the batch SELECT's snapshot can't see. This
    // exercises the escalate function's own re-check directly, since
    // manufacturing the actual SELECT-vs-process timing race
    // deterministically isn't possible from a test.
    const tag = `race-guard-${Date.now()}`;
    const fixture = await createPayoutInProgressWithdrawal(tag);
    await expirePayoutDeadline(fixture.withdrawal.id);
    const admin = await createAdmin(`race-guard-${tag}`);

    // Open a competing dispute WITHOUT transitioning the withdrawal's
    // status away from PAYOUT_IN_PROGRESS, by inserting directly — this is
    // the only way to reach the escalate function's active-dispute check
    // with the withdrawal's status still matching the sweep's candidate
    // criteria (escalateWithdrawalToDispute itself would also flip status
    // to DISPUTED, which is the ordinary case already covered above).
    await prisma.withdrawalDispute.create({
      data: {
        withdrawalId: fixture.withdrawal.id,
        openedBy: admin.id,
        reason: 'OTHER',
        description: 'Race-condition fixture: active dispute with withdrawal still PAYOUT_IN_PROGRESS',
        status: 'OPEN',
        openedFromStatus: 'PAYOUT_IN_PROGRESS',
      },
    });

    const summary = await sweepWithdrawalTimeouts();
    const outcome = summary.payoutDeadline.outcomes.find((o) => o.withdrawalId === fixture.withdrawal.id);
    expect(outcome?.result).toBe('SKIPPED');
    expect(outcome?.reason).toBe('ACTIVE_DISPUTE_EXISTS');

    const disputeCount = await prisma.withdrawalDispute.count({ where: { withdrawalId: fixture.withdrawal.id } });
    expect(disputeCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Concurrent double-run safety
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D3: sweepWithdrawalTimeouts — concurrent double-run safety', () => {
  beforeAll(() => cleanFixtures());

  it('two overlapping sweep calls escalate a given expired withdrawal exactly once', async () => {
    const tag = `concurrent-${Date.now()}`;
    const fixture = await createPayoutInProgressWithdrawal(tag);
    await expirePayoutDeadline(fixture.withdrawal.id);

    const [a, b] = await Promise.all([sweepWithdrawalTimeouts(), sweepWithdrawalTimeouts()]);
    // Both calls must resolve without throwing regardless of which one
    // wins the advisory lock.
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: fixture.withdrawal.id } });
    expect(withdrawal!.status).toBe('DISPUTED');

    const disputeCount = await prisma.withdrawalDispute.count({ where: { withdrawalId: fixture.withdrawal.id } });
    expect(disputeCount).toBe(1);
    const operationCount = await prisma.withdrawalOperation.count({
      where: { withdrawalId: fixture.withdrawal.id, action: 'SYSTEM_TIMEOUT_ESCALATE_PAYOUT' },
    });
    expect(operationCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// sweep -> claim -> resolve proves resolveWithdrawalDispute's existing
// openedFromStatus rules apply unchanged to a system-opened dispute
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D3: sweep -> claim -> resolve preserves W-1D2 admin/dispute lifecycle behavior', () => {
  beforeAll(() => cleanFixtures());

  it('a T1 system dispute requires adminVerifiedPayment to resolve COMPLETED', async () => {
    const tag = `t1-resolve-${Date.now()}`;
    const fixture = await createPayoutInProgressWithdrawal(tag);
    await expirePayoutDeadline(fixture.withdrawal.id);
    const summary = await sweepWithdrawalTimeouts();
    const outcome = summary.payoutDeadline.outcomes.find((o) => o.withdrawalId === fixture.withdrawal.id);
    expect(outcome?.result).toBe('ESCALATED');
    const disputeId = outcome!.disputeId!;

    const admin = await createAdmin(`t1-resolve-${tag}`);
    // Claiming IMMEDIATELY after a system-opened dispute is exactly the
    // near-zero-elapsed-time case that used to violate
    // withdrawal_disputes_chronology_check's assignedAt >= openedAt.
    const claimResult = await claimWithdrawalDispute(admin.id, disputeId, { idempotencyKey: `claim-${tag}` });
    const claimedDispute = claimResult.dispute as any;
    expect(claimedDispute.assignedAt.getTime()).toBeGreaterThanOrEqual(claimedDispute.openedAt.getTime());

    await expect(
      resolveWithdrawalDispute(admin.id, disputeId, {
        outcome: 'COMPLETED',
        resolutionNote: 'Trying to resolve without verified payment',
        idempotencyKey: `resolve-noverify-${tag}`,
      })
    ).rejects.toThrow(/adminVerifiedPayment is required/i);

    const result = await resolveWithdrawalDispute(admin.id, disputeId, {
      outcome: 'COMPLETED',
      resolutionNote: 'Verified externally by the admin',
      idempotencyKey: `resolve-${tag}`,
      adminVerifiedPayment: {
        referenceNumber: 'BANK-REF-SWEEP-1',
        paymentOccurredAt: new Date(),
      },
    });
    expect((result.withdrawal as any).status).toBe('COMPLETED');
    const resolvedDispute = result.dispute as any;
    expect(resolvedDispute.resolvedAt.getTime()).toBeGreaterThanOrEqual(resolvedDispute.assignedAt.getTime());
  });

  it('a T2 system dispute rejects adminVerifiedPayment when resolving COMPLETED', async () => {
    const tag = `t2-resolve-${Date.now()}`;
    const fixture = await createPaymentSubmittedWithdrawal(tag);
    await expireConfirmationDeadline(fixture.withdrawal.id);
    const summary = await sweepWithdrawalTimeouts();
    const outcome = summary.confirmationDeadline.outcomes.find((o) => o.withdrawalId === fixture.withdrawal.id);
    expect(outcome?.result).toBe('ESCALATED');
    const disputeId = outcome!.disputeId!;

    const admin = await createAdmin(`t2-resolve-${tag}`);
    // Same near-zero-elapsed-time claim as the T1 test above.
    const claimResult = await claimWithdrawalDispute(admin.id, disputeId, { idempotencyKey: `claim-${tag}` });
    const claimedDispute = claimResult.dispute as any;
    expect(claimedDispute.assignedAt.getTime()).toBeGreaterThanOrEqual(claimedDispute.openedAt.getTime());

    await expect(
      resolveWithdrawalDispute(admin.id, disputeId, {
        outcome: 'COMPLETED',
        resolutionNote: 'Trying to override the existing agent payment submission',
        idempotencyKey: `resolve-${tag}`,
        adminVerifiedPayment: {
          referenceNumber: 'BANK-REF-SWEEP-2',
          paymentOccurredAt: new Date(),
        },
      })
    ).rejects.toThrow(/must not replace an existing agent payment submission/i);

    const result = await resolveWithdrawalDispute(admin.id, disputeId, {
      outcome: 'COMPLETED',
      resolutionNote: 'Confirmed via the existing agent payment submission',
      idempotencyKey: `resolve-ok-${tag}`,
    });
    expect((result.withdrawal as any).status).toBe('COMPLETED');
    const resolvedDispute = result.dispute as any;
    expect(resolvedDispute.resolvedAt.getTime()).toBeGreaterThanOrEqual(resolvedDispute.assignedAt.getTime());
  });
});

// ═══════════════════════════════════════════════════════════════════
// Non-UTC session regression — proves the AT TIME ZONE 'UTC' fix
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D3: sweepWithdrawalTimeouts — non-UTC session does not falsely escalate', () => {
  beforeAll(() => cleanFixtures());

  it('future deadlines under Asia/Bangkok timezone are not selected/escalated for T1 or T2', async () => {
    const tag = `utc-regression-${Date.now()}`;

    // Switch the Postgres session to a non-UTC timezone so the sweep's SQL
    // runs with Asia/Bangkok (+07). Under the old selector
    // (deadline <= now()), Postgres would implicitly convert the
    // timestamp_without_tz deadline through the +07 session timezone,
    // making a future-in-UTC deadline appear to have already elapsed.
    // The fixed selector (deadline <= now() AT TIME ZONE 'UTC') always
    // compares timestamps without timezone ambiguity.
    await prisma.$executeRawUnsafe(`SET timezone = 'Asia/Bangkok'`);
    try {
      const [{ tz }] = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('timezone') AS tz`;
      expect(tz).toBe('Asia/Bangkok');

      // Create one T1 and one T2 withdrawal, each with a deadline
      // anchored 1 hour into the future (in UTC).
      const pip = await createPayoutInProgressWithdrawal(`${tag}-pip`);
      const ps = await createPaymentSubmittedWithdrawal(`${tag}-ps`);

      const [{ now: dbNow }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      const future = new Date(dbNow.getTime() + 60 * 60 * 1000);
      await prisma.withdrawal.update({ where: { id: pip.withdrawal.id }, data: { paymentSubmissionDeadlineAt: future } });
      await prisma.withdrawal.update({ where: { id: ps.withdrawal.id }, data: { confirmationDeadlineAt: future } });

      const summary = await sweepWithdrawalTimeouts();
      expect(summary.lockAcquired).toBe(true);

      // Neither withdrawal must appear in the sweep's outcomes.
      expect(summary.payoutDeadline.outcomes.some((o) => o.withdrawalId === pip.withdrawal.id)).toBe(false);
      expect(summary.confirmationDeadline.outcomes.some((o) => o.withdrawalId === ps.withdrawal.id)).toBe(false);

      // Statuses remain unchanged — not escalated to DISPUTED.
      const pipAfter = await prisma.withdrawal.findUnique({ where: { id: pip.withdrawal.id } });
      expect(pipAfter!.status).toBe('PAYOUT_IN_PROGRESS');
      expect(pipAfter!.disputedAt).toBeNull();

      const psAfter = await prisma.withdrawal.findUnique({ where: { id: ps.withdrawal.id } });
      expect(psAfter!.status).toBe('PAYMENT_SUBMITTED');
      expect(psAfter!.disputedAt).toBeNull();

      // No dispute or operation rows must have been created.
      const disputeCount = await prisma.withdrawalDispute.count({
        where: { withdrawalId: { in: [pip.withdrawal.id, ps.withdrawal.id] } },
      });
      expect(disputeCount).toBe(0);
      const operationCount = await prisma.withdrawalOperation.count({
        where: {
          withdrawalId: { in: [pip.withdrawal.id, ps.withdrawal.id] },
          action: { in: ['SYSTEM_TIMEOUT_ESCALATE_PAYOUT', 'SYSTEM_TIMEOUT_ESCALATE_CONFIRMATION'] },
        },
      });
      expect(operationCount).toBe(0);
    } finally {
      // Restore session timezone to UTC regardless of test outcome.
      await prisma.$executeRawUnsafe(`SET timezone = 'UTC'`);
    }
  });
});
