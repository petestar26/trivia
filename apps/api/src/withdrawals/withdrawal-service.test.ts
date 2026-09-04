import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { randomUUID } from 'node:crypto';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service';
import { fundAgentFiatLiquidity, adjustAgentFiatLiquidity } from './liquidity-service';
import { createWithdrawalQuote } from './quote-service';
import { createUserPayoutAccount } from './payout-account-service';
import { createWithdrawal, getOwnWithdrawalById, listOwnWithdrawals, cancelHeldWithdrawal } from './withdrawal-service';
import { getWalletBalance } from '../economy/wallet-service';
import { executeBalanceChange } from '../economy/wallet-service';
import { setOwnStepUpPolicy } from '../security/step-up-service';

// ─── DB availability probe ─────────────────────────────────────

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = dbAvailable ? describe : describe.skip;

// ─── Fixtures ──────────────────────────────────────────────────

async function createUser(tag: string) {
  const email = `wcreate-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `wcreatetest_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Withdrawal Create Test ${tag}`,
    },
  });
}

async function createAdmin(tag: string) {
  const user = await createUser(tag);
  return prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
}

async function createSuperAdmin(tag: string) {
  const user = await createUser(tag);
  return prisma.user.update({ where: { id: user.id }, data: { role: 'SUPER_ADMIN' } });
}

async function createCountry(tag: string) {
  const code = `W${randomUUID().replaceAll('-', '').slice(0, 7)}`.toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `Withdrawal Create Test Country ${tag}`,
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
      name: `Withdrawal Create Test Method ${tag}`,
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

/** ACTIVE agent with a funded USD fiat liquidity bucket. No AgentInventory
 * is ever created here — withdrawal creation must never touch it. */
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
    displayName: `Withdrawal Agent ${tag}`,
    contactEmail: `wcreate-agent-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.id, undefined);
  const agent = await prisma.agent.findUnique({ where: { userId: agentUser.id } });
  await fundAgentFiatLiquidity(superAdmin.id, agent!.id, 'USD', liquidityUsd, `fund-${tag}-${Date.now()}-${Math.random()}`);
  return agent!;
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
        description: 'test fixture credit',
      },
    ],
    operationName: 'test-fixture-credit',
  });
}

async function createFundedUser(tag: string, coins: number) {
  const user = await createUser(tag);
  await creditCoins(user.id, coins);
  return user;
}

async function createActivePayoutAccount(userId: string, countryId: string, methodDefId: string) {
  return createUserPayoutAccount(userId, {
    countryId,
    methodDefId,
    accountDetails: { bankName: 'Test Bank', accountNumber: '000111222' },
  });
}

/**
 * Withdrawal integration tests exercise step-up consumption, not the
 * encryption-backed TOTP enrollment flow covered by security.test.ts.
 * Seed the minimum active factor/policy state so these tests also run on
 * hosts where SECURITY_TOTP_ENCRYPTION_KEY is intentionally unset.
 */
async function enableStepUpPolicy(userId: string) {
  await prisma.userTotpFactor.create({
    data: {
      userId,
      encryptedSecret: 'fixture-only-never-decrypted',
      status: 'ACTIVE',
      activatedAt: new Date(),
    },
  });
  await setOwnStepUpPolicy(userId, true);
}

async function mintWithdrawalStepUp(userId: string, tokenIat: number) {
  const now = new Date();
  return prisma.stepUpVerification.create({
    data: {
      userId,
      purpose: 'WITHDRAWAL_CREATE',
      factorType: 'TOTP',
      tokenIat,
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
    },
  });
}

async function cleanWithdrawalFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'wcreate-' } } });
  const userIds = users.map((u) => u.id);

  if (userIds.length) {
    const agents = await prisma.agent.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const agentIds = agents.map((a) => a.id);

    await prisma.withdrawalDispute.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalEvidence.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalSettlement.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalHold.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalLiquidityReservation.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalOperation.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
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

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'Withdrawal Create Test Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'Withdrawal Create Test Country' } } });
}

/** Full happy-path setup: funded agent, funded user, active payout
 * account. Returns everything a creation test typically needs. */
async function setupHappyPath(tag: string, opts: { coins?: number; liquidityUsd?: bigint; coinsPerUnit?: number } = {}) {
  const admin = await createAdmin(tag);
  const superAdmin = await createSuperAdmin(`${tag}-super`);
  const country = await createCountry(tag);
  const method = await createPaymentMethod(country.id, tag);
  await createExchangeRate(country.id, 'USD', opts.coinsPerUnit ?? 2, admin.id);
  const agent = await createFundedAgent(tag, country.id, admin, superAdmin, opts.liquidityUsd ?? 100_000n);
  const user = await createFundedUser(tag, opts.coins ?? 10_000);
  const payoutAccount = await createActivePayoutAccount(user.id, country.id, method.id);
  return { admin, superAdmin, country, method, agent, user, payoutAccount };
}

describeIf('withdrawals/withdrawal-service', () => {
  it('creates exactly one wallet debit, one hold, one reservation, one liquidity ledger row', async () => {
    await cleanWithdrawalFixtures();
    const tag = `single-effects-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const { withdrawal } = await createWithdrawal(
      user.id,
      { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
      1000
    );

    expect((withdrawal as any).status).toBe('HELD');

    const debits = await prisma.walletTransaction.findMany({
      where: { userId: user.id, referenceType: 'WITHDRAWAL', referenceId: (withdrawal as any).id },
    });
    expect(debits).toHaveLength(1);
    expect(debits[0].ledgerType).toBe('DEBIT');
    expect(debits[0].amount).toBe(1000);

    const holds = await prisma.withdrawalHold.findMany({ where: { withdrawalId: (withdrawal as any).id } });
    expect(holds).toHaveLength(1);
    expect(holds[0].debitWalletTransactionId).toBe(debits[0].id);

    const reservations = await prisma.withdrawalLiquidityReservation.findMany({
      where: { withdrawalId: (withdrawal as any).id },
    });
    expect(reservations).toHaveLength(1);

    const ledgerRows = await prisma.agentFiatLiquidityLedger.findMany({
      where: { withdrawalId: (withdrawal as any).id },
    });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].type).toBe('RESERVE');
  });

  it('sets quote.consumedByWithdrawalId to exactly the created withdrawal.id, in the same transaction', async () => {
    await cleanWithdrawalFixtures();
    const tag = `quote-link-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const { withdrawal } = await createWithdrawal(
      user.id,
      { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
      1000
    );

    const consumedQuote = await prisma.withdrawalQuote.findUnique({ where: { id: quote.id } });
    expect(consumedQuote!.status).toBe('CONSUMED');
    expect(consumedQuote!.consumedByWithdrawalId).toBe((withdrawal as any).id);
    expect((withdrawal as any).quoteId).toBe(quote.id);
  });

  it('Withdrawal.requestHash and WithdrawalQuote.requestHash both exist and are different', async () => {
    await cleanWithdrawalFixtures();
    const tag = `hash-separation-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const { withdrawal } = await createWithdrawal(
      user.id,
      { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
      1000
    );

    expect(quote.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect((withdrawal as any).requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect((withdrawal as any).requestHash).not.toBe(quote.requestHash);
  });

  it('paymentSnapshot captures the immutable, unmasked payout account destination details', async () => {
    await cleanWithdrawalFixtures();
    const tag = `snapshot-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const { withdrawal } = await createWithdrawal(
      user.id,
      { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
      1000
    );

    // createActivePayoutAccount's fixture data — the real, unmasked values
    // the agent needs to actually pay the user, not the masked read-path
    // shape (list/get mask accountDetails; withdrawal creation must not).
    expect((withdrawal as any).paymentSnapshot).toEqual({ bankName: 'Test Bank', accountNumber: '000111222' });
    expect((withdrawal as any).paymentSnapshot).toEqual(payoutAccount.accountDetails);
  });

  it('rejects creation with an expired quote', async () => {
    await cleanWithdrawalFixtures();
    const tag = `expired-quote-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    await prisma.withdrawalQuote.update({ where: { id: quote.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(
      createWithdrawal(
        user.id,
        { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
        1000
      )
    ).rejects.toThrow(/expired/);

    const withdrawals = await prisma.withdrawal.findMany({ where: { userId: user.id } });
    expect(withdrawals).toHaveLength(0);
  });

  it('rejects a payout account whose country differs from the quote\'s country, before any wallet debit/hold/reservation', async () => {
    await cleanWithdrawalFixtures();
    const tag = `country-mismatch-${Date.now()}`;
    const { user, country, agent, payoutAccount: accountInCountryA } = await setupHappyPath(tag);

    // A second, unrelated country with its own payment method — the
    // payout account below belongs to THIS country, not the quote's.
    const countryB = await createCountry(`${tag}-b`);
    const methodB = await createPaymentMethod(countryB.id, `${tag}-b`);
    const accountInCountryB = await createActivePayoutAccount(user.id, countryB.id, methodB.id);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });

    await expect(
      createWithdrawal(
        user.id,
        { quoteId: quote.id, payoutAccountId: accountInCountryB.id, idempotencyKey: `key-${tag}` },
        1000
      )
    ).rejects.toThrow(/country/);

    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await prisma.walletTransaction.count({ where: { userId: user.id, referenceType: 'WITHDRAWAL' } })
    ).toBe(0);
    expect(await prisma.withdrawalHold.count({ where: { withdrawal: { userId: user.id } } })).toBe(0);
    expect(
      await prisma.withdrawalLiquidityReservation.count({ where: { withdrawal: { userId: user.id } } })
    ).toBe(0);
    expect(await prisma.agentFiatLiquidityLedger.count({ where: { agentId: agent.id, type: 'RESERVE' } })).toBe(0);

    // Sanity: the SAME-country account still works, proving the rejection
    // above was genuinely about the mismatch, not something else broken.
    const retried = await createWithdrawal(
      user.id,
      { quoteId: quote.id, payoutAccountId: accountInCountryA.id, idempotencyKey: `key-ok-${tag}` },
      1000
    );
    expect((retried.withdrawal as any).status).toBe('HELD');
  });

  it('rejects reusing an already-consumed quote for a second withdrawal', async () => {
    await cleanWithdrawalFixtures();
    const tag = `reuse-quote-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag, { coins: 20_000, liquidityUsd: 200_000n });

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const first = await createWithdrawal(
      user.id,
      { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-a-${tag}` },
      1000
    );

    // W-1D2A one-live-withdrawal-per-user rule: the first withdrawal is
    // still HELD/live, so a retry with a DIFFERENT idempotency key would
    // hit ACTIVE_WITHDRAWAL_EXISTS before ever reaching the consumed-quote
    // check this test exists to prove. Cancel the first withdrawal so
    // there is no live withdrawal, then the retry actually reaches the
    // quote-reuse branch this test is about.
    await cancelHeldWithdrawal(user.id, (first.withdrawal as any).id, { idempotencyKey: `cancel-${tag}` });

    await expect(
      createWithdrawal(
        user.id,
        { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-b-${tag}` },
        1000
      )
    ).rejects.toThrow(/already been used/);
  });

  it('same idempotency key + same request returns the existing withdrawal', async () => {
    await cleanWithdrawalFixtures();
    const tag = `idem-same-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const key = `key-${tag}`;
    const first = await createWithdrawal(user.id, { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: key }, 1000);
    const second = await createWithdrawal(user.id, { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: key }, 1000);

    expect(second.idempotent).toBe(true);
    expect((second.withdrawal as any).id).toBe((first.withdrawal as any).id);

    const withdrawals = await prisma.withdrawal.findMany({ where: { userId: user.id } });
    expect(withdrawals).toHaveLength(1);
  });

  it('same idempotency key + different payoutAccountId returns 409 IDEMPOTENCY_CONFLICT', async () => {
    await cleanWithdrawalFixtures();
    const tag = `idem-conflict-${Date.now()}`;
    const { user, country, method, payoutAccount } = await setupHappyPath(tag);
    const secondAccount = await createActivePayoutAccount(user.id, country.id, method.id);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const key = `key-${tag}`;
    await createWithdrawal(user.id, { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: key }, 1000);

    const quote2 = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    await expect(
      createWithdrawal(user.id, { quoteId: quote2.id, payoutAccountId: secondAccount.id, idempotencyKey: key }, 1000)
    ).rejects.toThrow(/different request data/);

    const withdrawals = await prisma.withdrawal.findMany({ where: { userId: user.id } });
    expect(withdrawals).toHaveLength(1);
  });

  it('a new idempotency key allows a repeated same-shaped withdrawal (once any live withdrawal is terminal)', async () => {
    await cleanWithdrawalFixtures();
    const tag = `repeat-shape-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag, { coins: 20_000, liquidityUsd: 200_000n });

    const quoteA = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const a = await createWithdrawal(user.id, { quoteId: quoteA.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-a-${tag}` }, 1000);

    // W-1D2A: a second LIVE withdrawal (different key) while the first is HELD
    // is now rejected by the one-live-withdrawal rule.
    const quoteLive = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    await expect(
      createWithdrawal(user.id, { quoteId: quoteLive.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-b-${tag}` }, 1000)
    ).rejects.toMatchObject({ details: { code: 'ACTIVE_WITHDRAWAL_EXISTS' } });

    // Once the first is cancelled (terminal), a NEW idempotency key allows a
    // same-shaped withdrawal again — the idempotency unique is scoped per key,
    // not per user.
    await cancelHeldWithdrawal(user.id, (a.withdrawal as any).id, { idempotencyKey: `cancel-${tag}` });

    const quoteB = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const b = await createWithdrawal(user.id, { quoteId: quoteB.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-b-${tag}` }, 1000);

    expect((b.withdrawal as any).id).not.toBe((a.withdrawal as any).id);
    const withdrawals = await prisma.withdrawal.findMany({ where: { userId: user.id } });
    expect(withdrawals).toHaveLength(2);
  });

  it('insufficient wallet balance leaves no withdrawal, hold, reservation, or liquidity ledger row behind', async () => {
    await cleanWithdrawalFixtures();
    const tag = `insufficient-wallet-${Date.now()}`;
    const { user, country, agent, payoutAccount } = await setupHappyPath(tag, { coins: 500 }); // less than the 1000 the quote will need

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    await expect(
      createWithdrawal(user.id, { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` }, 1000)
    ).rejects.toThrow(/Insufficient/);

    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.withdrawalHold.count({ where: { withdrawal: { userId: user.id } } })).toBe(0);
    expect(await prisma.withdrawalLiquidityReservation.count({ where: { agentId: agent.id } })).toBe(0);
    // Liquidity is now reserved BEFORE the wallet is touched (fix #2), so
    // this is the real proof that a later wallet failure still rolls that
    // reservation back — not just that no reservation row was created.
    const liquidityAfter = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    expect(liquidityAfter!.reservedBalance).toBe(0n);
    // The quote itself must also roll back to ACTIVE, not stay CONSUMED —
    // this is the whole point of doing everything in one transaction.
    const quoteAfter = await prisma.withdrawalQuote.findUnique({ where: { id: quote.id } });
    expect(quoteAfter!.status).toBe('ACTIVE');
    expect(quoteAfter!.consumedByWithdrawalId).toBeNull();
  });

  it('insufficient agent liquidity leaves no wallet debit or hold behind, and the wallet balance is unchanged', async () => {
    await cleanWithdrawalFixtures();
    const tag = `insufficient-liquidity-${Date.now()}`;
    // Fund the agent with far less USD than the withdrawal will need.
    const { user, country, payoutAccount } = await setupHappyPath(tag, { coins: 10_000, liquidityUsd: 10n });

    const balanceBefore = await getWalletBalance(user.id);
    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 }); // needs 500 USD minor units, only 10 available

    await expect(
      createWithdrawal(user.id, { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` }, 1000)
    ).rejects.toThrow(/INSUFFICIENT_LIQUIDITY|liquidity/i);

    const balanceAfter = await getWalletBalance(user.id);
    expect(balanceAfter.coinsBalance).toBe(balanceBefore.coinsBalance);
    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await prisma.walletTransaction.count({ where: { userId: user.id, referenceType: 'WITHDRAWAL' } })
    ).toBe(0);
  });

  it('never touches AgentInventory or AgentInventoryLedger', async () => {
    await cleanWithdrawalFixtures();
    const tag = `no-inventory-${Date.now()}`;
    const { user, country, agent, payoutAccount } = await setupHappyPath(tag);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    await createWithdrawal(user.id, { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` }, 1000);

    const inventory = await prisma.agentInventory.findUnique({ where: { agentId: agent.id } });
    expect(inventory).toBeNull();
    expect(await prisma.agentInventoryLedger.count({ where: { agentId: agent.id } })).toBe(0);
  });

  it('withdrawalNumber is allocated via the sequence, is WD-prefixed, and unique across two withdrawals', async () => {
    await cleanWithdrawalFixtures();
    const tag = `number-${Date.now()}`;
    // W-1D2A: the one-live-withdrawal-per-user rule forbids two SIMULTANEOUS
    // live withdrawals for one user. This test only cares about withdrawal
    // number uniqueness across two withdrawals, so it uses two different
    // users (option b).
    const { user: userA, country: countryA, payoutAccount: accountA } = await setupHappyPath(tag, { coins: 20_000, liquidityUsd: 200_000n });
    const { user: userB, country: countryB, payoutAccount: accountB } = await setupHappyPath(`${tag}-b`, { coins: 20_000, liquidityUsd: 200_000n });

    const quoteA = await createWithdrawalQuote(userA.id, { countryId: countryA.id, coinAmount: 1000 });
    const a = await createWithdrawal(userA.id, { quoteId: quoteA.id, payoutAccountId: accountA.id, idempotencyKey: `key-a-${tag}` }, 1000);

    const quoteB = await createWithdrawalQuote(userB.id, { countryId: countryB.id, coinAmount: 1000 });
    const b = await createWithdrawal(userB.id, { quoteId: quoteB.id, payoutAccountId: accountB.id, idempotencyKey: `key-b-${tag}` }, 1000);

    expect((a.withdrawal as any).withdrawalNumber).toMatch(/^WD-\d{6}$/);
    expect((b.withdrawal as any).withdrawalNumber).toMatch(/^WD-\d{6}$/);
    expect((b.withdrawal as any).withdrawalNumber).not.toBe((a.withdrawal as any).withdrawalNumber);
  });

  it('BigInt fiat fields on the created withdrawal stringify safely for a DTO', async () => {
    await cleanWithdrawalFixtures();
    const tag = `bigint-dto-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const { withdrawal } = await createWithdrawal(user.id, { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` }, 1000);

    expect(typeof (withdrawal as any).fiatAmount).toBe('bigint');
    const dto = { ...(withdrawal as any), fiatAmount: (withdrawal as any).fiatAmount.toString() };
    expect(() => JSON.stringify(dto)).not.toThrow();
    expect(JSON.parse(JSON.stringify(dto)).fiatAmount).toBe('500');
  });

  it('getOwnWithdrawalById returns the withdrawal for its owner and rejects everyone else', async () => {
    await cleanWithdrawalFixtures();
    const tag = `get-by-id-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);
    const otherUser = await createUser(`${tag}-other`);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const { withdrawal } = await createWithdrawal(
      user.id,
      { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
      1000
    );

    const fetched = await getOwnWithdrawalById(user.id, (withdrawal as any).id);
    expect(fetched.id).toBe((withdrawal as any).id);

    await expect(getOwnWithdrawalById(otherUser.id, (withdrawal as any).id)).rejects.toThrow(
      /does not belong to you/
    );
    await expect(getOwnWithdrawalById(user.id, 'not-a-real-id')).rejects.toThrow(/not found/i);
  });

  it('listOwnWithdrawals returns only the caller\'s own withdrawals', async () => {
    await cleanWithdrawalFixtures();
    const tag = `list-own-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag, { coins: 20_000, liquidityUsd: 200_000n });
    const otherUser = await createFundedUser(`${tag}-other`, 10_000);
    const otherAccount = await createActivePayoutAccount(otherUser.id, country.id, payoutAccount.methodDefId);

    const quoteA = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const { withdrawal: ownWithdrawal } = await createWithdrawal(
      user.id,
      { quoteId: quoteA.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-a-${tag}` },
      1000
    );
    const quoteB = await createWithdrawalQuote(otherUser.id, { countryId: country.id, coinAmount: 1000 });
    await createWithdrawal(
      otherUser.id,
      { quoteId: quoteB.id, payoutAccountId: otherAccount.id, idempotencyKey: `key-b-${tag}` },
      1000
    );

    const ownList = await listOwnWithdrawals(user.id);
    expect(ownList).toHaveLength(1);
    expect(ownList[0].id).toBe((ownWithdrawal as any).id);
  });

  it('two concurrent identical requests racing on the same quote resolve idempotently, not as a quote-already-used error', async () => {
    await cleanWithdrawalFixtures();
    const tag = `concurrent-idem-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const key = `key-${tag}`;
    const args = { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: key };

    // Both calls race from a cold start — neither has written a Withdrawal
    // row yet when they begin, so both pass the pre-transaction
    // idempotency check and race on the quote claim itself. The loser
    // must resolve via the new in-transaction re-check (fix #4), not
    // throw "quote already used".
    const results = await Promise.allSettled([
      createWithdrawal(user.id, args, 1000),
      createWithdrawal(user.id, args, 1000),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = (results as PromiseFulfilledResult<any>[]).map((r) => r.value.withdrawal.id);
    expect(ids[0]).toBe(ids[1]);
    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(1);

    const idempotentFlags = (results as PromiseFulfilledResult<any>[]).map((r) => r.value.idempotent);
    expect(idempotentFlags.filter((f) => f === true)).toHaveLength(1);
    expect(idempotentFlags.filter((f) => f === false)).toHaveLength(1);
  });

  it('two concurrent withdrawals against a wallet that can only afford one: exactly one succeeds', async () => {
    await cleanWithdrawalFixtures();
    const tag = `concurrent-wallet-${Date.now()}`;
    // Enough coins for exactly ONE 1000-coin withdrawal, plenty of liquidity.
    const { user, country, payoutAccount } = await setupHappyPath(tag, { coins: 1000, liquidityUsd: 1_000_000n });

    const quoteA = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const quoteB = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });

    const results = await Promise.allSettled([
      createWithdrawal(user.id, { quoteId: quoteA.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-a-${tag}` }, 1000),
      createWithdrawal(user.id, { quoteId: quoteB.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-b-${tag}` }, 1000),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const balance = await getWalletBalance(user.id);
    expect(balance.coinsBalance).toBe(0);
    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(1);
  });

  it('two concurrent withdrawals against liquidity that can only cover one: exactly one succeeds, none over-reserved', async () => {
    await cleanWithdrawalFixtures();
    const tag = `concurrent-liquidity-${Date.now()}`;
    // Plenty of coins, but liquidity only covers ONE 500-minor-unit payout.
    const { user, country, agent, payoutAccount } = await setupHappyPath(tag, { coins: 20_000, liquidityUsd: 500n });

    const quoteA = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 }); // needs 500
    const quoteB = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 }); // needs 500

    const results = await Promise.allSettled([
      createWithdrawal(user.id, { quoteId: quoteA.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-a-${tag}` }, 1000),
      createWithdrawal(user.id, { quoteId: quoteB.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-b-${tag}` }, 1000),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const liquidity = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
    });
    expect(liquidity!.reservedBalance).toBe(500n);
    expect(liquidity!.reservedBalance).toBeLessThanOrEqual(liquidity!.totalBalance);
  });

  it('requires step-up when the caller\'s policy demands it, and consumes it exactly once under concurrency', async () => {
    await cleanWithdrawalFixtures();
    const tag = `stepup-concurrent-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag, { coins: 20_000, liquidityUsd: 200_000n });

    await enableStepUpPolicy(user.id);
    const tokenIat = 1000;
    await mintWithdrawalStepUp(user.id, tokenIat);

    const quoteA = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const quoteB = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });

    const results = await Promise.allSettled([
      createWithdrawal(user.id, { quoteId: quoteA.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-a-${tag}` }, tokenIat),
      createWithdrawal(user.id, { quoteId: quoteB.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-b-${tag}` }, tokenIat),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === 'rejected') {
      expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/[Ss]tep-up/);
    }
  });

  it('rejects creation when step-up is required but none was performed', async () => {
    await cleanWithdrawalFixtures();
    const tag = `stepup-missing-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);
    await enableStepUpPolicy(user.id);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    await expect(
      createWithdrawal(user.id, { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` }, 1000)
    ).rejects.toThrow(/[Ss]tep-up/);

    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(0);
  });

  it('a failed creation (insufficient liquidity) does not consume a valid step-up — it remains usable on retry', async () => {
    await cleanWithdrawalFixtures();
    const tag = `stepup-rollback-${Date.now()}`;
    // Liquidity insufficient on the FIRST attempt; fund it before retrying.
    const { user, country, agent, payoutAccount } = await setupHappyPath(tag, { coins: 20_000, liquidityUsd: 10n });

    await enableStepUpPolicy(user.id);
    const tokenIat = 1000;
    await mintWithdrawalStepUp(user.id, tokenIat);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 }); // needs 500, only 10 available

    await expect(
      createWithdrawal(user.id, { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-1-${tag}` }, tokenIat)
    ).rejects.toThrow(/INSUFFICIENT_LIQUIDITY|liquidity/i);

    // The step-up must still be there, unconsumed, for a genuinely retried
    // request (a fresh quote, since the first one is now EXPIRED/still
    // ACTIVE depending on liquidity-retry exhaustion — request a new one
    // to isolate this assertion from quote-claim semantics).
    //
    // The agent already has a USD bucket (funded in setupHappyPath), so
    // topping it up uses adjustAgentFiatLiquidity — fundAgentFiatLiquidity
    // is first-time-funding only and throws a conflict on an existing
    // (agent, currency) bucket.
    await adjustAgentFiatLiquidity(
      (await createSuperAdmin(`${tag}-super2`)).id,
      agent.id,
      'USD',
      1_000_000n,
      'test top-up for retry',
      `topup-${tag}`
    );
    const quote2 = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const retried = await createWithdrawal(
      user.id,
      { quoteId: quote2.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-2-${tag}` },
      tokenIat
    );
    expect((retried.withdrawal as any).status).toBe('HELD');
  });

  // ── W-1D0: self-assignment exclusion ────────────────────────────

  it('excludes the withdrawing user\'s own agent profile from liquidity selection, even as the sole candidate', async () => {
    await cleanWithdrawalFixtures();
    const tag = `self-assign-sole-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag);
    await createExchangeRate(country.id, 'USD', 2, admin.id);

    // The withdrawing user is ALSO this country's only funded agent.
    // Distinct tag from `admin`'s — createUser() dedupes by email, so
    // reusing `tag` here would resolve to the SAME row as `admin` and
    // make approveAgentApplication legitimately reject it as self-review.
    const selfUser = await createFundedUser(`${tag}-self`, 10_000);
    const { application } = await submitAgentApplication(selfUser.id, {
      countryId: country.id,
      displayName: `Self Assign Agent ${tag}`,
      contactEmail: `wcreate-agent-self-${tag}@test.local`,
    });
    await approveAgentApplication(admin.id, application.id, undefined);
    const selfAgent = await prisma.agent.findUnique({ where: { userId: selfUser.id } });
    await fundAgentFiatLiquidity(superAdmin.id, selfAgent!.id, 'USD', 100_000n, `fund-self-${tag}`);

    const payoutAccount = await createActivePayoutAccount(selfUser.id, country.id, method.id);
    const quote = await createWithdrawalQuote(selfUser.id, { countryId: country.id, coinAmount: 1000 });

    // No OTHER agent has liquidity, so this must fail as if no liquidity
    // existed at all — never fall back to assigning the user's own agent.
    await expect(
      createWithdrawal(
        selfUser.id,
        { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
        1000
      )
    ).rejects.toThrow(/INSUFFICIENT_LIQUIDITY|No agent liquidity/);

    expect(await prisma.withdrawal.count({ where: { userId: selfUser.id } })).toBe(0);
    // The self agent's liquidity must be untouched — no reservation leaked.
    const selfLiquidity = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: selfAgent!.id, fiatCurrency: 'USD' } },
    });
    expect(selfLiquidity!.reservedBalance).toBe(0n);
  });

  it('selects a different agent over the withdrawing user\'s own, even when the user\'s own agent has more liquidity', async () => {
    await cleanWithdrawalFixtures();
    const tag = `self-assign-outbid-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag);
    await createExchangeRate(country.id, 'USD', 2, admin.id);

    // Distinct tag from `admin`'s — createUser() dedupes by email, so
    // reusing `tag` here would resolve to the SAME row as `admin` and
    // make approveAgentApplication legitimately reject it as self-review.
    const selfUser = await createFundedUser(`${tag}-self`, 10_000);
    const { application } = await submitAgentApplication(selfUser.id, {
      countryId: country.id,
      displayName: `Self Assign Agent ${tag}`,
      contactEmail: `wcreate-agent-self-${tag}@test.local`,
    });
    await approveAgentApplication(admin.id, application.id, undefined);
    const selfAgent = await prisma.agent.findUnique({ where: { userId: selfUser.id } });
    // Self agent has FAR more liquidity than the other candidate — if
    // selection were merely deprioritizing self rather than excluding it
    // outright, the ORDER BY (available DESC) would still pick self here.
    await fundAgentFiatLiquidity(superAdmin.id, selfAgent!.id, 'USD', 10_000_000n, `fund-self-${tag}`);
    const otherAgent = await createFundedAgent(`${tag}-other`, country.id, admin, superAdmin, 100_000n);

    const payoutAccount = await createActivePayoutAccount(selfUser.id, country.id, method.id);
    const quote = await createWithdrawalQuote(selfUser.id, { countryId: country.id, coinAmount: 1000 });

    const { withdrawal } = await createWithdrawal(
      selfUser.id,
      { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
      1000
    );

    expect((withdrawal as any).agentId).toBe(otherAgent.id);
    expect((withdrawal as any).agentId).not.toBe(selfAgent!.id);

    const selfLiquidity = await prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: selfAgent!.id, fiatCurrency: 'USD' } },
    });
    expect(selfLiquidity!.reservedBalance).toBe(0n); // untouched
  });

  // ── W-1D0: paymentSubmissionDeadlineAt ───────────────────────────

  it('sets paymentSubmissionDeadlineAt atomically at creation (HELD), ~15 minutes out', async () => {
    await cleanWithdrawalFixtures();
    const tag = `payment-deadline-${Date.now()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const before = Date.now();
    const { withdrawal } = await createWithdrawal(
      user.id,
      { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
      1000
    );
    const after = Date.now();

    const w = withdrawal as any;
    expect(w.status).toBe('HELD');
    expect(w.paymentSubmissionDeadlineAt).toBeTruthy();
    const deadline = new Date(w.paymentSubmissionDeadlineAt).getTime();
    const fifteenMinutes = 15 * 60 * 1000;
    expect(deadline).toBeGreaterThanOrEqual(before + fifteenMinutes);
    expect(deadline).toBeLessThanOrEqual(after + fifteenMinutes + 5_000); // small margin for test runtime

    // Persisted, not just present on the return value.
    const persisted = await prisma.withdrawal.findUnique({ where: { id: w.id } });
    expect(persisted!.paymentSubmissionDeadlineAt).not.toBeNull();
    expect(persisted!.paymentSubmissionDeadlineAt!.getTime()).toBe(deadline);
  });
});
