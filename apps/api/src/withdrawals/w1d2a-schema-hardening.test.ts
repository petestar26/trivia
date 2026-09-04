import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { prisma, Prisma } from '@socialplay/database';
import { randomUUID } from 'node:crypto';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service';
import { fundAgentFiatLiquidity, consumeReservedLiquidity } from './liquidity-service';
import { createWithdrawalQuote } from './quote-service';
import { createUserPayoutAccount } from './payout-account-service';
import { createWithdrawal, claimPayout, submitPayment, cancelHeldWithdrawal } from './withdrawal-service';
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
  console.error('W-1D2A tests require a reachable Postgres database. Failing run.');
  throw new Error('W-1D2A tests failed to connect to Postgres: ' + (err as Error)?.message);
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = describe;

// ─── Fixture helpers (mirror W-1D1 lifecycle fixtures) ─────────

const TAG_PREFIX = 'w1d2a-';

async function createUser(tag: string) {
  const email = `${TAG_PREFIX}${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `${TAG_PREFIX}${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `W1D2A Test ${tag}`,
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
  const code = `W2A${randomUUID().replaceAll('-', '').slice(0, 6)}`.toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `W1D2A Test Country ${tag}`,
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
      name: `W1D2A Method ${tag}`,
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

async function createFundedAgent(tag: string, countryId: string, admin: { id: string }, superAdmin: { id: string }, liquidityUsd: bigint) {
  const agentUser = await createUser(`agent-${tag}`);
  const { application } = await submitAgentApplication(agentUser.id, {
    countryId,
    displayName: `W1D2A Agent ${tag}`,
    contactEmail: `w1d2a-agent-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.id, undefined);
  const agent = await prisma.agent.findUnique({ where: { userId: agentUser.id } });
  await fundAgentFiatLiquidity(superAdmin.id, agent!.id, 'USD', liquidityUsd, `w1d2a-fund-${tag}-${Date.now()}-${Math.random()}`);
  return { agentUser, agent: agent! };
}

async function creditCoins(userId: string, amount: number) {
  await executeBalanceChange({
    userId,
    changes: [{
      currency: 'COINS',
      amount,
      ledgerType: 'CREDIT',
      transactionType: 'COIN_CREDIT',
      referenceType: 'ADMIN',
      description: 'W1D2A test fixture credit',
    }],
    operationName: 'w1d2a-test-fixture-credit',
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
    accountDetails: { bankName: 'W1D2A Bank', accountNumber: '991122334' },
  });
}

async function createHeldWithdrawal(tag: string, opts: { coins?: number; coinAmount?: number; liquidityUsd?: bigint } = {}) {
  const admin = await createAdmin(tag);
  const superAdmin = await createSuperAdmin(`${tag}-super`);
  const country = await createCountry(tag);
  const method = await createPaymentMethod(country.id, tag);
  await createExchangeRate(country.id, 'USD', 2, admin.id);
  const { agentUser, agent } = await createFundedAgent(tag, country.id, admin, superAdmin, opts.liquidityUsd ?? 500_000n);
  const user = await createFundedUser(tag, opts.coins ?? 50_000);
  const payoutAccount = await createActivePayoutAccount(user.id, country.id, method.id);

  const coinAmount = opts.coinAmount ?? 10_000;
  const idempotencyKey = `w1d2a-${tag}-${Date.now()}`;
  const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount });
  const { withdrawal } = await createWithdrawal(
    user.id,
    { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey },
    1000
  );

  return { admin, superAdmin, country, agent, agentUser, user, withdrawal: withdrawal as any, payoutAccount };
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

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'W1D2A Test Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'W1D2A Test Country' } } });
}

// ═══════════════════════════════════════════════════════════════
// W-1D2A TESTS
// ═══════════════════════════════════════════════════════════════

describeIf('W-1D2A: one-live-withdrawal-per-user creation rule', () => {
  beforeAll(() => cleanFixtures());

  it('createWithdrawal rejects a second live withdrawal for the same user with ACTIVE_WITHDRAWAL_EXISTS, without consuming its quote', async () => {
    const tag = `one-live-${Date.now()}`;
    const { user, country, payoutAccount } = await createHeldWithdrawal(tag, { coins: 50_000, liquidityUsd: 500_000n });

    const secondQuote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 5_000 });
    await expect(
      createWithdrawal(
        user.id,
        { quoteId: secondQuote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `one-live-key-${tag}` },
        1000
      )
    ).rejects.toMatchObject({ details: { code: 'ACTIVE_WITHDRAWAL_EXISTS' } });

    // The rejected attempt must NOT have consumed its quote (rejection happens
    // before the quote claim).
    const quoteAfter = await prisma.withdrawalQuote.findUnique({ where: { id: secondQuote.id } });
    expect(quoteAfter!.status).toBe('ACTIVE');
  });

  it('idempotent create replay still works even while the withdrawal is live', async () => {
    const tag = `replay-${Date.now()}`;
    const { user, payoutAccount, withdrawal: first } = await createHeldWithdrawal(tag, { coins: 50_000, liquidityUsd: 500_000n });

    // Rebuild the exact same request (same idempotency key + same request
    // fields) as the fixture used. Replay is keyed on [userId, idempotencyKey]
    // and returns the existing live withdrawal BEFORE the one-live check.
    const replay = await createWithdrawal(
      user.id,
      { quoteId: (first as any).quoteId, payoutAccountId: payoutAccount.id, idempotencyKey: (first as any).idempotencyKey },
      1000
    );
    expect(replay.idempotent).toBe(true);
    expect((replay.withdrawal as any).id).toBe((first as any).id);
    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// Follow-up fix: createWithdrawal's pre-flight idempotency lookup runs
// OUTSIDE the transaction, so a genuinely concurrent same-key request can
// miss it, then enter the transaction after the winner has already
// committed a live withdrawal — without an in-transaction re-check, that
// loser would see the winner's own row at the one-live-withdrawal count
// and incorrectly throw ACTIVE_WITHDRAWAL_EXISTS instead of replaying.
// These tests require TRUE concurrency (Promise.allSettled, not
// sequential awaits) to exercise that race at all — a sequential replay
// (as in the test above) never reaches the transaction, since the
// pre-flight check always short-circuits it first.
// ─────────────────────────────────────────────────────────────────

describeIf('W-1D2A follow-up: createWithdrawal idempotency under the one-live rule, under concurrency', () => {
  beforeAll(() => cleanFixtures());

  async function setupUserForConcurrency(tag: string) {
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag);
    await createExchangeRate(country.id, 'USD', 2, admin.id);
    // W-1D2A follow-up fix: both concurrency tests below race two
    // createWithdrawal calls against the SAME agent's liquidity row. The
    // different-key test is only meant to prove the one-live-withdrawal
    // rule maps the loser to ACTIVE_WITHDRAWAL_EXISTS — not to exercise
    // liquidity exhaustion — so fund a large buffer well beyond both
    // competing quotes' fiat amounts to keep that test deterministic
    // rather than timing/setup-sensitive to INSUFFICIENT_LIQUIDITY.
    await createFundedAgent(tag, country.id, admin, superAdmin, 10_000_000n);
    const user = await createFundedUser(tag, 50_000);
    const payoutAccount = await createActivePayoutAccount(user.id, country.id, method.id);
    return { user, country, payoutAccount };
  }

  it('concurrent creates with the SAME idempotency key + same payload both resolve to the same withdrawal — no spurious ACTIVE_WITHDRAWAL_EXISTS', async () => {
    const tag = `concurrent-same-key-${Date.now()}`;
    const { user, country, payoutAccount } = await setupUserForConcurrency(tag);
    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 5_000 });
    const args = { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `same-key-${tag}` };

    const results = await Promise.allSettled([
      createWithdrawal(user.id, args, 1000),
      createWithdrawal(user.id, args, 1000),
    ]);

    // Neither concurrent copy of the SAME request may see
    // ACTIVE_WITHDRAWAL_EXISTS — both must fulfill: one as the creator,
    // one as an idempotent replay of it.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const fulfilled = results as PromiseFulfilledResult<Awaited<ReturnType<typeof createWithdrawal>>>[];

    const idempotentFlags = fulfilled.map((r) => r.value.idempotent).sort();
    expect(idempotentFlags).toEqual([false, true]);

    const ids = new Set(fulfilled.map((r) => (r.value.withdrawal as any).id));
    expect(ids.size).toBe(1);

    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(1);
  });

  it('concurrent creates with DIFFERENT idempotency keys for the same user: exactly one succeeds, the loser maps to ACTIVE_WITHDRAWAL_EXISTS, never a raw P2002', async () => {
    const tag = `concurrent-diff-key-${Date.now()}`;
    const { user, country, payoutAccount } = await setupUserForConcurrency(tag);
    const quoteA = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 4_000 });
    const quoteB = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 4_500 });

    const results = await Promise.allSettled([
      createWithdrawal(user.id, { quoteId: quoteA.id, payoutAccountId: payoutAccount.id, idempotencyKey: `diff-a-${tag}` }, 1000),
      createWithdrawal(user.id, { quoteId: quoteB.id, payoutAccountId: payoutAccount.id, idempotencyKey: `diff-b-${tag}` }, 1000),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser must map to the friendly ACTIVE_WITHDRAWAL_EXISTS conflict
    // — never a raw, unmapped Prisma P2002 error leaking to the caller.
    const reason = rejected[0].reason as any;
    expect(reason?.details?.code).toBe('ACTIVE_WITHDRAWAL_EXISTS');
    expect(reason?.code).not.toBe('P2002');

    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(1);
  });
});

describeIf('W-1D2A: DB backstop rejects two live withdrawals per user', () => {
  beforeAll(() => cleanFixtures());

  it('directly inserting two HELD withdrawals for one user violates withdrawals_one_live_per_user_unique', async () => {
    const tag = `db-backstop-${Date.now()}`;
    // The first withdrawal is a live HELD row via the service. We then try to
    // bypass the application-level guard and insert a SECOND live withdrawal
    // for the SAME user directly (past the service layer) — the partial unique
    // index withdrawals_one_live_per_user_unique is the hard DB backstop.
    const { user, country, payoutAccount, withdrawal } = await createHeldWithdrawal(tag, { coins: 50_000, liquidityUsd: 500_000n });

    const secondQuote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 5_000 });
    const quote2 = await prisma.withdrawalQuote.findUnique({ where: { id: secondQuote.id } });

    const duplicateInsert = () =>
      prisma.withdrawal.create({
        data: {
          id: randomUUID(),
          withdrawalNumber: 'WD-999999',
          userId: user.id,
          agentId: (withdrawal as any).agentId,
          quoteId: quote2!.id,
          requestHash: randomUUID(),
          idempotencyKey: `db-backstop-${randomUUID()}`,
          countryId: country.id,
          paymentMethodDefId: (payoutAccount as any).methodDefId,
          userPayoutAccountId: payoutAccount.id,
          paymentSnapshot: { bankName: 'Test', accountNumber: '1' },
          fiatAmount: quote2!.fiatAmount,
          fiatCurrency: quote2!.fiatCurrency,
          exchangeRateConfigId: quote2!.exchangeRateConfigId,
          exchangeRateValue: quote2!.exchangeRateValue,
          coinAmount: quote2!.coinAmount,
          status: 'HELD',
          quoteExpiresAt: quote2!.expiresAt,
        },
      });

    await expect(duplicateInsert()).rejects.toThrow(/unique|P2002|one_live/i);

    // Cleanup the second quote so the fixture cleanup can proceed.
    await prisma.withdrawalQuote.deleteMany({ where: { id: quote2!.id } });
  });
});

describeIf('W-1D2A: active-agent transaction recheck (claimPayout / submitPayment)', () => {
  beforeAll(() => cleanFixtures());

  it('claimPayout rejects when the assigned agent is disabled/suspended before claim, with no WithdrawalOperation written', async () => {
    const tag = `claim-disabled-${Date.now()}`;
    const { agent, agentUser, withdrawal } = await createHeldWithdrawal(tag);
    await setAgentStatus(agent.id, 'DISABLED');

    await expect(
      claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-disabled-${tag}` })
    ).rejects.toThrow(/not active/i);

    const op = await prisma.withdrawalOperation.findFirst({ where: { withdrawalId: withdrawal.id, action: 'CLAIM_PAYOUT' } });
    expect(op).toBeNull();
    const fresh = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    expect(fresh!.status).toBe('HELD');
  });

  it('submitPayment rejects when the assigned agent is disabled AFTER a successful claim; no submission or operation is written and status stays PAYOUT_IN_PROGRESS', async () => {
    const tag = `submit-disabled-${Date.now()}`;
    const { agent, agentUser, withdrawal } = await createHeldWithdrawal(tag);
    // Agent is ACTIVE: claim succeeds.
    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `submit-claim-${tag}` });

    // Disable the agent mid-request window (after claim, before submit).
    await setAgentStatus(agent.id, 'DISABLED');

    await expect(
      submitPayment(agentUser.id, withdrawal.id, { referenceNumber: 'REF-XYZ', idempotencyKey: `submit-pay-${tag}` })
    ).rejects.toThrow(/not active/i);

    // No payment submission, no operation, status unchanged = PAYOUT_IN_PROGRESS.
    const submission = await prisma.withdrawalPaymentSubmission.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(submission).toBeNull();
    const op = await prisma.withdrawalOperation.findFirst({ where: { withdrawalId: withdrawal.id, action: 'SUBMIT_PAYMENT' } });
    expect(op).toBeNull();
    const fresh = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    expect(fresh!.status).toBe('PAYOUT_IN_PROGRESS');
  });
});

describeIf('W-1D2A: user cancel works when assigned agent is disabled and withdrawal is HELD', () => {
  beforeAll(() => cleanFixtures());

  it('user cancel with a disabled assigned agent refunds exactly, releases reservation, and marks hold REFUNDED', async () => {
    const tag = `cancel-disabled-${Date.now()}`;
    const { agent, user, withdrawal } = await createHeldWithdrawal(tag, { coins: 50_000, liquidityUsd: 500_000n });
    const balanceBefore = await getWalletBalance(user.id);
    await setAgentStatus(agent.id, 'DISABLED');

    const result = await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-disabled-${tag}` });
    expect(result.idempotent).toBe(false);
    expect((result.result as any).status).toBe('CANCELLED');

    const hold = await prisma.withdrawalHold.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(hold!.status).toBe('REFUNDED');
    const reservation = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(reservation!.status).toBe('RELEASED');

    const balanceAfter = await getWalletBalance(user.id);
    expect(balanceAfter.coinsBalance).toBe(balanceBefore.coinsBalance + (withdrawal as any).coinAmount);
  });
});

describeIf('W-1D2A: consumeReservedLiquidity helper', () => {
  beforeAll(() => cleanFixtures());

  it('consumes an ACTIVE reservation: CONSUMED, total/reserved decrease exactly, one CONSUME ledger row, no AgentInventory touch', async () => {
    const tag = `consume-${Date.now()}`;
    const { agent, withdrawal } = await createHeldWithdrawal(tag, { coins: 50_000, liquidityUsd: 500_000n });

    const reservation = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: withdrawal.id } });
    const liquidityBefore = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    expect(liquidityBefore).not.toBeNull();

    const inventoryBefore = await prisma.agentInventory.findUnique({ where: { agentId: agent.id } });
    const inventoryLedgerBefore = await prisma.agentInventoryLedger.count({ where: { agentId: agent.id } });

    await prisma.$transaction((tx) =>
      consumeReservedLiquidity(tx, {
        id: reservation!.id,
        agentId: reservation!.agentId,
        fiatCurrency: reservation!.fiatCurrency,
        amount: reservation!.amount,
        withdrawalId: withdrawal.id,
      })
    );

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
    expect(consumeRows[0].reservationId).toBe(reservation!.id);

    // AgentInventory / AgentInventoryLedger must be untouched by a fiat consume.
    const inventoryAfter = await prisma.agentInventory.findUnique({ where: { agentId: agent.id } });
    expect(inventoryAfter?.totalBalance ?? 0).toBe(inventoryBefore?.totalBalance ?? 0);
    expect(inventoryAfter?.reservedBalance ?? 0).toBe(inventoryBefore?.reservedBalance ?? 0);
    const inventoryLedgerAfter = await prisma.agentInventoryLedger.count({ where: { agentId: agent.id } });
    expect(inventoryLedgerAfter).toBe(inventoryLedgerBefore);
  });
});
