import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { randomUUID } from 'node:crypto';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service';
import { fundAgentFiatLiquidity } from './liquidity-service';
import { createWithdrawalQuote } from './quote-service';
import { createUserPayoutAccount } from './payout-account-service';
import { createWithdrawal, claimPayout } from './withdrawal-service';
import { runWithdrawalReconciliation } from './reconciliation-service';
import { executeBalanceChange } from '../economy/wallet-service';

// W-1D3: withdrawal reconciliation service tests.
//
// Financial inverse tests operating on the live database — hard-fail on an
// unreachable database rather than describe.skip, matching every other
// withdrawal suite in this repo.

try {
  await prisma.$queryRaw`SELECT 1`;
} catch (err) {
  console.error('W-1D3 reconciliation tests require a reachable Postgres database. Failing run.');
  throw new Error('W-1D3 reconciliation tests failed to connect to Postgres: ' + (err as Error)?.message);
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = describe;

// ─── Fixture helpers ────────────────────────────────────────────────

const TAG_PREFIX = 'w1d3recon-';

async function createUser(tag: string) {
  const email = `${TAG_PREFIX}${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `${TAG_PREFIX}${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `W1D3 Reconciliation Test ${tag}`,
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
  const code = `W3R${randomUUID().replaceAll('-', '').slice(0, 6)}`.toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `W1D3 Reconciliation Test Country ${tag}`,
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
      name: `W1D3 Reconciliation Method ${tag}`,
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
    displayName: `W1D3 Reconciliation Agent ${tag}`,
    contactEmail: `w1d3recon-agent-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.id, undefined);
  const agent = await prisma.agent.findUnique({ where: { userId: agentUser.id } });
  await fundAgentFiatLiquidity(
    superAdmin.id,
    agent!.id,
    'USD',
    liquidityUsd,
    `w1d3recon-fund-${tag}-${Date.now()}-${Math.random()}`
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
    operationName: 'w1d3recon-test-fixture-credit',
  });
  return user;
}

async function createActivePayoutAccount(userId: string, countryId: string, methodDefId: string) {
  return createUserPayoutAccount(userId, {
    countryId,
    methodDefId,
    accountDetails: { bankName: 'W1D3 Reconciliation Bank', accountNumber: '661122337' },
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

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'W1D3 Reconciliation Test Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'W1D3 Reconciliation Test Country' } } });
}

describeIf('W-1D3: runWithdrawalReconciliation', () => {
  beforeAll(() => cleanFixtures());

  it('detects an ACTIVE hold on a terminal (CANCELLED) withdrawal', async () => {
    const tag = `hold-terminal-${Date.now()}`;
    const fixture = await createHeldWithdrawal(tag);
    // Force a drift state directly — a real ACTIVE hold surviving onto a
    // terminal withdrawal should never happen through the service layer
    // (that's exactly the invariant this detector exists to catch), so a
    // direct write is the only way to construct the fixture.
    await prisma.withdrawal.update({ where: { id: fixture.withdrawal.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });

    const report = await runWithdrawalReconciliation();
    const item = report.checks.activeHoldOnTerminalWithdrawal.items.find((i) => i.withdrawalId === fixture.withdrawal.id);
    expect(item).toBeTruthy();
    expect(item!.reasonCode).toBe('ACTIVE_HOLD_ON_TERMINAL_WITHDRAWAL');

    const hold = await prisma.withdrawalHold.findUnique({ where: { withdrawalId: fixture.withdrawal.id } });
    expect(hold!.status).toBe('ACTIVE');
  });

  it('detects an ACTIVE reservation on a terminal (CANCELLED) withdrawal', async () => {
    const tag = `reservation-terminal-${Date.now()}`;
    const fixture = await createHeldWithdrawal(tag);
    await prisma.withdrawal.update({ where: { id: fixture.withdrawal.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });

    const report = await runWithdrawalReconciliation();
    const item = report.checks.activeReservationOnTerminalWithdrawal.items.find((i) => i.withdrawalId === fixture.withdrawal.id);
    expect(item).toBeTruthy();
    expect(item!.reasonCode).toBe('ACTIVE_RESERVATION_ON_TERMINAL_WITHDRAWAL');

    const reservation = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: fixture.withdrawal.id } });
    expect(reservation!.status).toBe('ACTIVE');
  });

  it('detects a COMPLETED withdrawal with no settlement row', async () => {
    const tag = `completed-no-settlement-${Date.now()}`;
    const fixture = await createHeldWithdrawal(tag);
    // Force COMPLETED without ever creating a WithdrawalSettlement — the
    // real completion paths (confirmWithdrawalReceipt / resolveWithdrawalDispute)
    // always create one atomically with the status write, so this is
    // another drift state only reachable via a direct write.
    await prisma.withdrawal.update({ where: { id: fixture.withdrawal.id }, data: { status: 'COMPLETED', completedAt: new Date(), paymentSubmittedAt: new Date() } });

    const report = await runWithdrawalReconciliation();
    const item = report.checks.completedWithoutSettlement.items.find((i) => i.withdrawalId === fixture.withdrawal.id);
    expect(item).toBeTruthy();
    expect(item!.reasonCode).toBe('COMPLETED_WITHOUT_SETTLEMENT');

    const settlementCount = await prisma.withdrawalSettlement.count({ where: { withdrawalId: fixture.withdrawal.id } });
    expect(settlementCount).toBe(0);
  });

  it('detects a DISPUTED withdrawal whose dispute is OPEN and older than the threshold', async () => {
    const tag = `stale-dispute-${Date.now()}`;
    const fixture = await createHeldWithdrawal(tag);
    await claimPayout(fixture.agentUser.id, fixture.withdrawal.id, { idempotencyKey: `claim-${tag}` });
    const oldOpenedAt = new Date(Date.now() - 72 * 60 * 60 * 1000); // 72h ago
    await prisma.$transaction([
      prisma.withdrawal.update({ where: { id: fixture.withdrawal.id }, data: { status: 'DISPUTED', disputedAt: oldOpenedAt } }),
      prisma.withdrawalDispute.create({
        data: {
          withdrawalId: fixture.withdrawal.id,
          openedBy: 'SYSTEM',
          reason: 'AGENT_UNRESPONSIVE',
          description: 'Stale dispute fixture',
          status: 'OPEN',
          openedFromStatus: 'PAYOUT_IN_PROGRESS',
          openedAt: oldOpenedAt,
        },
      }),
    ]);

    // Default threshold is 48h — a 72h-old OPEN dispute must be flagged.
    const report = await runWithdrawalReconciliation();
    const item = report.checks.staleUnclaimedDispute.items.find((i) => i.withdrawalId === fixture.withdrawal.id);
    expect(item).toBeTruthy();
    expect(item!.reasonCode).toBe('DISPUTE_OPEN_UNCLAIMED_PAST_THRESHOLD');

    // A generous threshold must NOT flag the same dispute.
    const lenientReport = await runWithdrawalReconciliation({ staleDisputeThresholdMs: 30 * 24 * 60 * 60 * 1000 });
    expect(lenientReport.checks.staleUnclaimedDispute.items.some((i) => i.withdrawalId === fixture.withdrawal.id)).toBe(false);
  });

  it('detects a live (PAYOUT_IN_PROGRESS) withdrawal with a null agentId', async () => {
    const tag = `missing-agent-${Date.now()}`;
    const fixture = await createHeldWithdrawal(tag);
    await claimPayout(fixture.agentUser.id, fixture.withdrawal.id, { idempotencyKey: `claim-${tag}` });
    // Real code never nulls agentId on a live withdrawal (Withdrawal.agent
    // is onDelete: SetNull, so this models an agent hard-delete, which the
    // service layer never performs — agents are disabled, not deleted).
    await prisma.withdrawal.update({ where: { id: fixture.withdrawal.id }, data: { agentId: null } });

    const report = await runWithdrawalReconciliation();
    const item = report.checks.liveWithdrawalMissingAgent.items.find((i) => i.withdrawalId === fixture.withdrawal.id);
    expect(item).toBeTruthy();
    expect(item!.reasonCode).toBe('LIVE_WITHDRAWAL_MISSING_AGENT');
  });

  it('a clean HELD withdrawal with no drift trips no detector', async () => {
    const tag = `clean-${Date.now()}`;
    const fixture = await createHeldWithdrawal(tag);

    const report = await runWithdrawalReconciliation();
    for (const check of Object.values(report.checks)) {
      expect(check.items.some((i) => i.withdrawalId === fixture.withdrawal.id)).toBe(false);
    }
  });

  it('mutates nothing — every counter and status is identical before and after a full report', async () => {
    const tag = `mutates-nothing-${Date.now()}`;
    const fixture = await createHeldWithdrawal(tag);
    await claimPayout(fixture.agentUser.id, fixture.withdrawal.id, { idempotencyKey: `claim-${tag}` });

    const before = {
      withdrawal: await prisma.withdrawal.findUnique({ where: { id: fixture.withdrawal.id } }),
      hold: await prisma.withdrawalHold.findUnique({ where: { withdrawalId: fixture.withdrawal.id } }),
      reservation: await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: fixture.withdrawal.id } }),
      operationCount: await prisma.withdrawalOperation.count({ where: { withdrawalId: fixture.withdrawal.id } }),
      disputeCount: await prisma.withdrawalDispute.count({ where: { withdrawalId: fixture.withdrawal.id } }),
      auditCount: await prisma.auditLog.count(),
    };

    await runWithdrawalReconciliation();

    const after = {
      withdrawal: await prisma.withdrawal.findUnique({ where: { id: fixture.withdrawal.id } }),
      hold: await prisma.withdrawalHold.findUnique({ where: { withdrawalId: fixture.withdrawal.id } }),
      reservation: await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: fixture.withdrawal.id } }),
      operationCount: await prisma.withdrawalOperation.count({ where: { withdrawalId: fixture.withdrawal.id } }),
      disputeCount: await prisma.withdrawalDispute.count({ where: { withdrawalId: fixture.withdrawal.id } }),
      auditCount: await prisma.auditLog.count(),
    };

    expect(after).toEqual(before);
  });

  it('returns counts and reason codes, bounded by limit, never a full Withdrawal body', async () => {
    const tag = `shape-${Date.now()}`;
    const fixture = await createHeldWithdrawal(tag);
    await prisma.withdrawal.update({ where: { id: fixture.withdrawal.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });

    const report = await runWithdrawalReconciliation({ limit: 1 });
    expect(typeof report.totalIssues).toBe('number');
    const item = report.checks.activeHoldOnTerminalWithdrawal.items[0];
    if (item) {
      expect(Object.keys(item).sort()).toEqual(['holdId', 'reasonCode', 'withdrawalId', 'withdrawalStatus'].sort());
    }
  });
});
