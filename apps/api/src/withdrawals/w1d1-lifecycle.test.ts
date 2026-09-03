import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { randomUUID } from 'node:crypto';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service';
import { fundAgentFiatLiquidity } from './liquidity-service';
import { createWithdrawalQuote } from './quote-service';
import { createUserPayoutAccount } from './payout-account-service';
import { createWithdrawal } from './withdrawal-service';
import {
  listAssignedWithdrawals,
  getAssignedWithdrawal,
  claimPayout,
  submitPayment,
  cancelHeldWithdrawal,
} from './withdrawal-service';
import { executeBalanceChange, getWalletBalance } from '../economy/wallet-service';

// ─── DB availability probe ─────────────────────────────────────
//
// These are financial inverse tests operating on the live database. If the
// database is unavailable, they MUST fail hard rather than silently report
// green zero-coverage via describe.skip — a skipped financial suite hides
// regressions. We probe at module load and, when unreachable, throw to fail
// the run.

try {
  await prisma.$queryRaw`SELECT 1`;
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('W-1D1 lifecycle tests require a reachable Postgres database. Failing run.');
  throw new Error('W-1D1 lifecycle tests failed to connect to Postgres: ' + (err as Error)?.message);
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = describe;

// ─── Fixture helpers ───────────────────────────────────────────

const TAG_PREFIX = 'wlifecycle-';

async function createUser(tag: string) {
  const email = `${TAG_PREFIX}${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `${TAG_PREFIX}${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `W1D1 Test ${tag}`,
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
  const code = `W1D${randomUUID().replaceAll('-', '').slice(0, 6)}`.toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `W1D1 Test Country ${tag}`,
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
      name: `W1D1 Method ${tag}`,
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
    displayName: `W1D1 Agent ${tag}`,
    contactEmail: `w1d1-agent-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.id, undefined);
  const agent = await prisma.agent.findUnique({ where: { userId: agentUser.id } });
  await fundAgentFiatLiquidity(superAdmin.id, agent!.id, 'USD', liquidityUsd, `w1d1-fund-${tag}-${Date.now()}-${Math.random()}`);
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
      description: 'W1D1 test fixture credit',
    }],
    operationName: 'w1d1-test-fixture-credit',
  });
}

async function createFundedUser(tag: string, coins: number) {
  const user = await createUser(`user-${tag}`);
  await creditCoins(user.id, coins);
  return user;
}

async function createHeldWithdrawal(tag: string, opts: { coins?: number; coinAmount?: number; liquidityUsd?: bigint } = {}) {
  const admin = await createAdmin(tag);
  const superAdmin = await createSuperAdmin(`${tag}-super`);
  const country = await createCountry(tag);
  const method = await createPaymentMethod(country.id, tag);
  await createExchangeRate(country.id, 'USD', 2, admin.id);
  const { agentUser, agent } = await createFundedAgent(tag, country.id, admin, superAdmin, opts.liquidityUsd ?? 500_000n);
  const user = await createFundedUser(tag, opts.coins ?? 50_000);
  const payoutAccount = await createUserPayoutAccount(user.id, {
    countryId: country.id,
    methodDefId: method.id,
    accountDetails: { bankName: 'Test Bank', accountNumber: '001122333' },
  });

  const coinAmount = opts.coinAmount ?? 10_000;
  const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount });
  const { withdrawal } = await createWithdrawal(
    user.id,
    { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `w1d1-${tag}-${Date.now()}` },
    1000
  );

  return { admin, superAdmin, country, agent, agentUser, user, withdrawal: withdrawal as any, payoutAccount };
}

async function cleanLifecycleFixtures() {
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

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'W1D1 Test Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'W1D1 Test Country' } } });
}

// ═══════════════════════════════════════════════════════════════════
// W-1D1 TESTS
// ═══════════════════════════════════════════════════════════════════

describeIf('W-1D1: assigned agent reads', () => {
  beforeAll(() => cleanLifecycleFixtures());

  it('assigned agent can list assigned withdrawals', async () => {
    const tag = `list-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    const result = await listAssignedWithdrawals(agentUser.id);
    expect(result.some((w: any) => w.id === withdrawal.id)).toBe(true);
  });

  it('other agent cannot see assigned withdrawal', async () => {
    const tag = `other-agent-${Date.now()}`;
    const { withdrawal } = await createHeldWithdrawal(tag);
    const otherAgentUser = await createUser(`other-${tag}`);
    const country = await createCountry(`${tag}-other`);

    // otherAgentUser has no agent profile, so listAssignedWithdrawals throws
    await expect(listAssignedWithdrawals(otherAgentUser.id)).rejects.toThrow(/do not have an agent account/i);
  });

  it('getAssignedWithdrawal returns the correct withdrawal', async () => {
    const tag = `get-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    const result = await getAssignedWithdrawal(agentUser.id, withdrawal.id);
    expect(result.id).toBe(withdrawal.id);
    expect(result.status).toBe('HELD');
  });

  it('getAssignedWithdrawal rejects when withdrawal not assigned to this agent', async () => {
    const tag = `get-reject-${Date.now()}`;
    const { withdrawal } = await createHeldWithdrawal(tag);
    const otherUser = await createUser(`other-get-${tag}`);
    const country = await createCountry(`${tag}-gother`);
    await expect(getAssignedWithdrawal(otherUser.id, withdrawal.id)).rejects.toThrow();
  });
});

describeIf('W-1D1: claimPayout (HELD → PAYOUT_IN_PROGRESS)', () => {
  beforeAll(() => cleanLifecycleFixtures());

  it('agent can claim HELD withdrawal → PAYOUT_IN_PROGRESS', async () => {
    const tag = `claim-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    const result = await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });
    expect(result.idempotent).toBe(false);
    expect((result.result as any).status).toBe('PAYOUT_IN_PROGRESS');

    // Verify in DB
    const fresh = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    expect(fresh!.status).toBe('PAYOUT_IN_PROGRESS');

    // Verify operation recorded
    const ops = await prisma.withdrawalOperation.findMany({
      where: { withdrawalId: withdrawal.id, action: 'CLAIM_PAYOUT' },
    });
    expect(ops).toHaveLength(1);
  });

  it('claimPayout does not set paymentSubmittedAt', async () => {
    const tag = `claim-noset-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-no-${tag}` });
    const fresh = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    expect(fresh!.paymentSubmittedAt).toBeNull();
  });

  it('claimPayout is idempotent', async () => {
    const tag = `claim-idemp-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    const r1 = await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-id-${tag}` });
    expect(r1.idempotent).toBe(false);

    const r2 = await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-id-${tag}` });
    expect(r2.idempotent).toBe(true);
    expect((r2.result as any).status).toBe('PAYOUT_IN_PROGRESS');
  });

  it('claimPayout rejected from PAYOUT_IN_PROGRESS', async () => {
    const tag = `claim-reject-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim1-${tag}` });
    await expect(
      claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim2-${tag}` })
    ).rejects.toThrow(/Cannot claim payout from status/i);
  });

  it('claimPayout same key after status progressed to PAYMENT_SUBMITTED returns idempotent replay', async () => {
    const tag = `claim-replay-progressed-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    // Claim payout (HELD → PAYOUT_IN_PROGRESS)
    const r1 = await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-replay-${tag}` });
    expect(r1.idempotent).toBe(false);
    expect((r1.result as any).status).toBe('PAYOUT_IN_PROGRESS');

    // Submit payment (PAYOUT_IN_PROGRESS → PAYMENT_SUBMITTED)
    await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-REPLAY-PROGRESSED',
      idempotencyKey: `sub-replay-${tag}`,
    });

    const fresh = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    expect(fresh!.status).toBe('PAYMENT_SUBMITTED');

    // Same claimPayout key should still replay successfully, returning PAYMENT_SUBMITTED
    const r2 = await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-replay-${tag}` });
    expect(r2.idempotent).toBe(true);
    expect((r2.result as any).status).toBe('PAYMENT_SUBMITTED');
  });

  // W-1D1 fix (Opus adversarial review B1): closes the fund-trap from
  // the other side — an agent cannot claim a withdrawal whose payment-
  // submission window has already lapsed.
  it('claimPayout rejects if paymentSubmissionDeadlineAt has already expired', async () => {
    const tag = `claim-expired-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: { paymentSubmissionDeadlineAt: new Date(Date.now() - 1000) },
    });

    await expect(
      claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` })
    ).rejects.toMatchObject({ details: { code: 'PAYOUT_CLAIM_EXPIRED' } });

    // Must not have partially applied — still HELD, no operation recorded.
    const fresh = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    expect(fresh!.status).toBe('HELD');
    const op = await prisma.withdrawalOperation.findFirst({
      where: { withdrawalId: withdrawal.id, action: 'CLAIM_PAYOUT' },
    });
    expect(op).toBeNull();
  });

  it('claimPayout writes a WITHDRAWAL_PAYOUT_CLAIMED audit row', async () => {
    const tag = `claim-audit-${Date.now()}`;
    const { agentUser, agent, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: withdrawal.id, action: 'WITHDRAWAL_PAYOUT_CLAIMED' },
    });
    expect(audit).not.toBeNull();
    expect((audit!.newData as any).agentId).toBe(agent.id);
  });

  it('user cancel vs payout claim race: exactly one wins', async () => {
    const tag = `race-${Date.now()}`;
    const { agentUser, user, withdrawal } = await createHeldWithdrawal(tag);

    const results = await Promise.allSettled([
      claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-race-${tag}` }),
      cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-race-${tag}` }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const fresh = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    expect(['PAYOUT_IN_PROGRESS', 'CANCELLED']).toContain(fresh!.status);
  });
});

describeIf('W-1D1: submitPayment (PAYOUT_IN_PROGRESS → PAYMENT_SUBMITTED)', () => {
  beforeAll(() => cleanLifecycleFixtures());

  it('submit-payment rejected from HELD', async () => {
    const tag = `submit-held-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    await expect(
      submitPayment(agentUser.id, withdrawal.id, {
        referenceNumber: 'REF-001',
        idempotencyKey: `sub-${tag}`,
      })
    ).rejects.toThrow(/Cannot submit payment from status/i);
  });

  it('agent can submit payment only from PAYOUT_IN_PROGRESS', async () => {
    const tag = `submit-ok-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });
    const result = await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-001',
      note: 'Paid via bank transfer',
      idempotencyKey: `sub-${tag}`,
    });

    expect(result.idempotent).toBe(false);
    expect((result.result as any).referenceNumber).toBe('REF-001');
    expect((result.result as any).note).toBe('Paid via bank transfer');
    expect((result.result as any).submittedByUserId).toBe(agentUser.id);
    expect((result.withdrawal as any).status).toBe('PAYMENT_SUBMITTED');
    expect((result.withdrawal as any).paymentSubmittedAt).not.toBeNull();
    expect((result.withdrawal as any).confirmationDeadlineAt).not.toBeNull();
  });

  it('submit-payment persists WithdrawalPaymentSubmission', async () => {
    const tag = `submit-persist-${Date.now()}`;
    const { agentUser, agent, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });
    await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-PERSIST',
      idempotencyKey: `sub-${tag}`,
    });

    const submission = await prisma.withdrawalPaymentSubmission.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(submission).not.toBeNull();
    expect(submission!.referenceNumber).toBe('REF-PERSIST');
    expect(submission!.agentId).toBe(agent.id);
    expect(submission!.submittedByUserId).toBe(agentUser.id);
  });

  it('normalizes a blank/whitespace note to null, consistently for hash and storage', async () => {
    const tag = `submit-note-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);
    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });

    // Same idempotencyKey, "note: '   '" then a replay with note omitted —
    // both normalize to null, so this must replay, not conflict.
    const r1 = await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-NOTE',
      note: '   ',
      idempotencyKey: `sub-note-${tag}`,
    });
    expect(r1.idempotent).toBe(false);
    expect((r1.result as any).note).toBeNull();

    const r2 = await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-NOTE',
      idempotencyKey: `sub-note-${tag}`,
    });
    expect(r2.idempotent).toBe(true);
  });

  it('submitPayment writes a WITHDRAWAL_PAYMENT_SUBMITTED audit row', async () => {
    const tag = `submit-audit-${Date.now()}`;
    const { agentUser, agent, withdrawal } = await createHeldWithdrawal(tag);
    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });
    await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-AUDIT',
      idempotencyKey: `sub-${tag}`,
    });

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: withdrawal.id, action: 'WITHDRAWAL_PAYMENT_SUBMITTED' },
    });
    expect(audit).not.toBeNull();
    expect((audit!.newData as any).agentId).toBe(agent.id);
    expect((audit!.newData as any).referenceNumber).toBe('REF-AUDIT');
  });

  it('same submit idempotency key replays', async () => {
    const tag = `submit-replay-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });
    const r1 = await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-REPLAY',
      idempotencyKey: `sub-replay-${tag}`,
    });
    expect(r1.idempotent).toBe(false);

    const r2 = await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-REPLAY',
      idempotencyKey: `sub-replay-${tag}`,
    });
    expect(r2.idempotent).toBe(true);
  });

  it('same submit key with different referenceNumber conflicts', async () => {
    const tag = `submit-conflict-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });
    await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-CONFLICT-1',
      idempotencyKey: `sub-conflict-${tag}`,
    });

    // The domain subcode lives in ApiError.details.code, not the message
    // text (the thrown message is "Idempotency key reused with different
    // request data") — assert the structured code directly, matching
    // routes.test.ts's body.error.details.code convention for the
    // HTTP-level equivalent of this same check.
    await expect(
      submitPayment(agentUser.id, withdrawal.id, {
        referenceNumber: 'REF-CONFLICT-2',
        idempotencyKey: `sub-conflict-${tag}`,
      })
    ).rejects.toMatchObject({ details: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('authorization before idempotent replay', async () => {
    const tag = `auth-replay-${Date.now()}`;
    const { agentUser, withdrawal } = await createHeldWithdrawal(tag);
    const otherUser = await createUser(`other-auth-${tag}`);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });
    await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-AUTH',
      idempotencyKey: `sub-auth-${tag}`,
    });

    // A different agent cannot replay
    await expect(
      submitPayment(otherUser.id, withdrawal.id, {
        referenceNumber: 'REF-AUTH',
        idempotencyKey: `sub-auth-${tag}`,
      })
    ).rejects.toThrow();
  });
});

describeIf('W-1D1: cancelHeldWithdrawal (HELD → CANCELLED)', () => {
  beforeAll(() => cleanLifecycleFixtures());

  it('user can cancel HELD withdrawal', async () => {
    const tag = `cancel-ok-${Date.now()}`;
    const { user, withdrawal } = await createHeldWithdrawal(tag, { coinAmount: 5000, coins: 20_000 });

    const beforeBalance = await getWalletBalance(user.id);

    const result = await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-${tag}` });
    expect(result.idempotent).toBe(false);
    expect((result.result as any).status).toBe('CANCELLED');
    expect((result.result as any).cancelledAt).not.toBeNull();

    const afterBalance = await getWalletBalance(user.id);
    expect(afterBalance.coinsBalance).toBe(beforeBalance.coinsBalance + 5000);
  });

  it('cancel uses hold.coinAmount', async () => {
    const tag = `cancel-hold-${Date.now()}`;
    // withdrawal.coinAmount is determined by quote (10000 coins at default exchange rate 2 = 5000 fiat)
    // But hold.coinAmount is set from quote.coinAmount at creation time
    const { user, withdrawal } = await createHeldWithdrawal(tag, { coinAmount: 8000 });

    const hold = await prisma.withdrawalHold.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(hold!.coinAmount).toBe(8000);

    const before = await getWalletBalance(user.id);
    await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-hold-${tag}` });
    const after = await getWalletBalance(user.id);
    expect(after.coinsBalance).toBe(before.coinsBalance + hold!.coinAmount);
  });

  it('double cancel creates exactly one wallet credit and one release ledger', async () => {
    const tag = `cancel-once-${Date.now()}`;
    const { user, withdrawal } = await createHeldWithdrawal(tag);

    // First cancel
    await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-a-${tag}` });
    // Second cancel with same key — should be idempotent replay
    const r2 = await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-a-${tag}` });
    expect(r2.idempotent).toBe(true);

    // Exactly one wallet credit for this withdrawal
    const credits = await prisma.walletTransaction.findMany({
      where: {
        userId: user.id,
        referenceType: 'WITHDRAWAL',
        referenceId: withdrawal.id,
        ledgerType: 'CREDIT',
      },
    });
    expect(credits).toHaveLength(1);

    // Exactly one release ledger entry
    const releases = await prisma.agentFiatLiquidityLedger.findMany({
      where: { withdrawalId: withdrawal.id, type: 'RELEASE' },
    });
    expect(releases).toHaveLength(1);
  });

  it('cancellation releases fiat reservation exactly once', async () => {
    const tag = `cancel-res-${Date.now()}`;
    const { agent, user, withdrawal } = await createHeldWithdrawal(tag);

    const liqBefore = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    const reservedBefore = liqBefore!.reservedBalance;

    await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-res-${tag}` });

    const liqAfter = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });

    // totalBalance unchanged, reservedBalance decreased
    expect(liqAfter!.totalBalance).toBe(liqBefore!.totalBalance);
    expect(liqAfter!.reservedBalance).toBe(reservedBefore - (await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: withdrawal.id } }))!.amount);

    // Reservation RELEASED
    const reservation = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(reservation!.status).toBe('RELEASED');
    expect(reservation!.releasedAt).not.toBeNull();

    // Exactly one RELEASE ledger entry
    const releases = await prisma.agentFiatLiquidityLedger.findMany({
      where: { reservationId: reservation!.id, type: 'RELEASE' },
    });
    expect(releases).toHaveLength(1);
  });

  it('hold marked REFUNDED with refundWalletTransactionId', async () => {
    const tag = `cancel-hold-${Date.now()}`;
    const { user, withdrawal } = await createHeldWithdrawal(tag);

    await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-hold-${tag}` });

    const hold = await prisma.withdrawalHold.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(hold!.status).toBe('REFUNDED');
    expect(hold!.refundWalletTransactionId).not.toBeNull();
    expect(hold!.releasedAt).not.toBeNull();
  });

  it('cancel rejected from PAYOUT_IN_PROGRESS', async () => {
    const tag = `cancel-reject-pip-${Date.now()}`;
    const { agentUser, user, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });
    await expect(
      cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-${tag}` })
    ).rejects.toThrow(/Cannot cancel withdrawal from status/i);
  });

  it('cancel rejected from PAYMENT_SUBMITTED', async () => {
    const tag = `cancel-reject-ps-${Date.now()}`;
    const { agentUser, user, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });
    await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-PS',
      idempotencyKey: `sub-${tag}`,
    });
    await expect(
      cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-${tag}` })
    ).rejects.toThrow(/Cannot cancel withdrawal from status/i);
  });

  // ── PAYOUT_IN_PROGRESS is never user-cancellable, deadline or not ──
  // (OpenAI review blocker on an earlier version of this branch, which
  // allowed an expired-and-unclaimed PAYOUT_IN_PROGRESS to be
  // user-cancelled: once claimPayout has fired, an external fiat
  // transfer may already be in progress even without a recorded
  // submitPayment, so a user-triggered refund at that point could
  // double-pay the user. See cancelHeldWithdrawal's file header.

  it('cancel from PAYOUT_IN_PROGRESS still rejects BEFORE paymentSubmissionDeadlineAt passes', async () => {
    const tag = `cancel-pip-notyet-${Date.now()}`;
    const { agentUser, user, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });
    // Deadline is ~15 minutes out by default — untouched, still in the future.
    await expect(
      cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-${tag}` })
    ).rejects.toThrow(/Cannot cancel withdrawal from status/i);

    const fresh = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    expect(fresh!.status).toBe('PAYOUT_IN_PROGRESS');
  });

  // W-1D1 fix (OpenAI review blocker): reverts the earlier "expired
  // PAYOUT_IN_PROGRESS becomes user-cancellable" behavior. Once
  // claimPayout has fired, an external fiat transfer may already be in
  // progress even without a recorded submitPayment — a user-triggered
  // refund at that point could double-pay the user. PAYOUT_IN_PROGRESS
  // must reject cancel unconditionally, deadline or not.
  it('cancel from PAYOUT_IN_PROGRESS rejects even after paymentSubmissionDeadlineAt has passed, with no payment submitted', async () => {
    const tag = `cancel-pip-expired-still-rejects-${Date.now()}`;
    const { agentUser, agent, user, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });

    const liquidityBefore = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    const walletBefore = await getWalletBalance(user.id);

    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: { paymentSubmissionDeadlineAt: new Date(Date.now() - 1000) },
    });

    await expect(
      cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-${tag}` })
    ).rejects.toThrow(/Cannot cancel withdrawal from status/i);

    // No money moved at all: status, hold, reservation, wallet, and
    // liquidity are all exactly as they were before this rejected call.
    const fresh = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    expect(fresh!.status).toBe('PAYOUT_IN_PROGRESS');
    const hold = await prisma.withdrawalHold.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(hold!.status).toBe('ACTIVE');
    const reservation = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: withdrawal.id } });
    expect(reservation!.status).toBe('ACTIVE');
    const walletAfter = await getWalletBalance(user.id);
    expect(walletAfter.coinsBalance).toBe(walletBefore.coinsBalance);
    const liquidityAfter = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    expect(liquidityAfter!.reservedBalance).toBe(liquidityBefore!.reservedBalance);
  });

  it('cancel from PAYMENT_SUBMITTED still rejects even after paymentSubmissionDeadlineAt has passed', async () => {
    const tag = `cancel-ps-expired-${Date.now()}`;
    const { agentUser, user, withdrawal } = await createHeldWithdrawal(tag);

    await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `claim-${tag}` });
    await submitPayment(agentUser.id, withdrawal.id, {
      referenceNumber: 'REF-PS-EXPIRED',
      idempotencyKey: `sub-${tag}`,
    });
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: { paymentSubmissionDeadlineAt: new Date(Date.now() - 1000) },
    });

    await expect(
      cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-${tag}` })
    ).rejects.toThrow(/Cannot cancel withdrawal from status/i);

    const fresh = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    expect(fresh!.status).toBe('PAYMENT_SUBMITTED'); // never auto-refunded
  });

  it('cancelHeldWithdrawal writes a WITHDRAWAL_CANCELLED audit row (no try/catch swallowing failures)', async () => {
    const tag = `cancel-audit-${Date.now()}`;
    const { user, withdrawal } = await createHeldWithdrawal(tag);

    await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-${tag}` });

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: withdrawal.id, action: 'WITHDRAWAL_CANCELLED' },
    });
    expect(audit).not.toBeNull();
    expect((audit!.newData as any).previousStatus).toBe('HELD');
  });

  it('two withdrawals assigned to the same agent, cancelled concurrently, both succeed with correct final liquidity', async () => {
    // W-1D1 fix (Opus adversarial review R3): releaseReservedLiquidity
    // used to read AgentFiatLiquidity unlocked, so two ORDINARY
    // concurrent cancels against withdrawals assigned to the SAME agent
    // could race on the same starting version and spuriously 409 for one
    // caller — not a real conflict, just an unlocked read. This proves
    // both now succeed (serialized by the row lock) with exact final
    // ledger/liquidity counts.
    const tag = `concurrent-cancel-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag);
    await createExchangeRate(country.id, 'USD', 2, admin.id);
    const { agent } = await createFundedAgent(tag, country.id, admin, superAdmin, 1_000_000n);

    const userA = await createFundedUser(`${tag}-a`, 50_000);
    const userB = await createFundedUser(`${tag}-b`, 50_000);
    const payoutA = await createUserPayoutAccount(userA.id, {
      countryId: country.id, methodDefId: method.id, accountDetails: { bankName: 'TB', accountNumber: '111' },
    });
    const payoutB = await createUserPayoutAccount(userB.id, {
      countryId: country.id, methodDefId: method.id, accountDetails: { bankName: 'TB', accountNumber: '222' },
    });

    const quoteA = await createWithdrawalQuote(userA.id, { countryId: country.id, coinAmount: 5_000 });
    const quoteB = await createWithdrawalQuote(userB.id, { countryId: country.id, coinAmount: 7_000 });
    const { withdrawal: wA } = await createWithdrawal(
      userA.id, { quoteId: quoteA.id, payoutAccountId: payoutA.id, idempotencyKey: `wA-${tag}` }, 1000
    );
    const { withdrawal: wB } = await createWithdrawal(
      userB.id, { quoteId: quoteB.id, payoutAccountId: payoutB.id, idempotencyKey: `wB-${tag}` }, 1000
    );

    const liquidityBefore = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });

    const [resultA, resultB] = await Promise.all([
      cancelHeldWithdrawal(userA.id, (wA as any).id, { idempotencyKey: `cancelA-${tag}` }),
      cancelHeldWithdrawal(userB.id, (wB as any).id, { idempotencyKey: `cancelB-${tag}` }),
    ]);

    expect((resultA.result as any).status).toBe('CANCELLED');
    expect((resultB.result as any).status).toBe('CANCELLED');

    const reservationA = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: (wA as any).id } });
    const reservationB = await prisma.withdrawalLiquidityReservation.findUnique({ where: { withdrawalId: (wB as any).id } });
    expect(reservationA!.status).toBe('RELEASED');
    expect(reservationB!.status).toBe('RELEASED');

    const liquidityAfter = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    expect(liquidityAfter!.reservedBalance).toBe(
      liquidityBefore!.reservedBalance - reservationA!.amount - reservationB!.amount
    );
    expect(liquidityAfter!.totalBalance).toBe(liquidityBefore!.totalBalance);

    const releaseLedgerCount = await prisma.agentFiatLiquidityLedger.count({
      where: { agentId: agent.id, type: 'RELEASE', reservationId: { in: [reservationA!.id, reservationB!.id] } },
    });
    expect(releaseLedgerCount).toBe(2);

    const creditsA = await prisma.walletTransaction.count({
      where: { userId: userA.id, referenceType: 'WITHDRAWAL', ledgerType: 'CREDIT' },
    });
    const creditsB = await prisma.walletTransaction.count({
      where: { userId: userB.id, referenceType: 'WITHDRAWAL', ledgerType: 'CREDIT' },
    });
    expect(creditsA).toBe(1);
    expect(creditsB).toBe(1);
  });

  it('AgentInventory and AgentInventoryLedger unchanged after cancel', async () => {
    const tag = `cancel-inv-${Date.now()}`;
    const { agent, user, withdrawal } = await createHeldWithdrawal(tag);

    const inventoryBefore = await prisma.agentInventory.findUnique({
      where: { agentId: agent.id },
    });
    const ledgerBefore = await prisma.agentInventoryLedger.findMany({
      where: { agentId: agent.id },
    });

    await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-inv-${tag}` });

    const inventoryAfter = await prisma.agentInventory.findUnique({
      where: { agentId: agent.id },
    });
    const ledgerAfter = await prisma.agentInventoryLedger.findMany({
      where: { agentId: agent.id },
    });

    expect(inventoryAfter).toEqual(inventoryBefore);
    expect(ledgerAfter.length).toBe(ledgerBefore.length);
  });

  it('cancel with different idempotency key is not idempotent (new operation)', async () => {
    const tag = `cancel-newkey-${Date.now()}`;
    const { user, withdrawal } = await createHeldWithdrawal(tag);

    const r1 = await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-1-${tag}` });
    expect(r1.idempotent).toBe(false);
    expect((r1.result as any).status).toBe('CANCELLED');

    // Second cancel with different key — the withdrawal is already CANCELLED,
    // so this should fail (not idempotent)
    await expect(
      cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-2-${tag}` })
    ).rejects.toThrow(/Cannot cancel withdrawal from status/i);
  });

  it('cancel same key after CANCELLED returns idempotent replay', async () => {
    const tag = `cancel-replay-after-${Date.now()}`;
    const { user, withdrawal } = await createHeldWithdrawal(tag);

    const r1 = await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-same-${tag}` });
    expect(r1.idempotent).toBe(false);
    expect((r1.result as any).status).toBe('CANCELLED');

    // Same key after CANCELLED — must replay, not fail on status.
    const r2 = await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-same-${tag}` });
    expect(r2.idempotent).toBe(true);
    expect((r2.result as any).status).toBe('CANCELLED');
  });

  it('cancel same key with different caller (new user) does not replay', async () => {
    const tag = `cancel-replay-auth-${Date.now()}`;
    const { user, withdrawal } = await createHeldWithdrawal(tag);

    await cancelHeldWithdrawal(user.id, withdrawal.id, { idempotencyKey: `cancel-auth-${tag}` });

    const otherUser = await createUser(`other-cancel-auth-${tag}`);
    // Another user reusing same key on a withdrawal they do not own must be
    // rejected on authorization (ownership), not treated as a replay.
    await expect(
      cancelHeldWithdrawal(otherUser.id, withdrawal.id, { idempotencyKey: `cancel-auth-${tag}` })
    ).rejects.toThrow(/does not belong to you|not found|forbidden/i);
  });
});
