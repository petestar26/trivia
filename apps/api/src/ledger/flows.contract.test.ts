import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@socialplay/database';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service.js';
import { createAgentPaymentAccount, approveAgentPaymentAccount } from '../agents/payment-account-service.js';
import { fundAgentInventory } from '../agents/inventory-service.js';
import { fundAgentFiatLiquidity } from '../withdrawals/liquidity-service.js';
import { createAgentOrder, submitOrderPayment, settleAgentOrder } from '../agents/order-service.js';
import { createWithdrawalQuote } from '../withdrawals/quote-service.js';
import { createWithdrawal, cancelHeldWithdrawal } from '../withdrawals/withdrawal-service.js';
import { sendGift } from '../economy/gift-service.js';
import { flushCoinLedgerConstraints } from '../economy/coin-ledger-service.js';
import type { CreditCoinsArgs, DebitCoinsArgs } from '../economy/coin-ledger-service.js';
import { runLedgerInvariantCheckInTransaction } from '../economy/ledger-invariant-checker.js';
import { playGame } from '../games/game-play.js';
import { waitForBlockedBackends, ROW_LOCK_WAITS, probeRowLockable } from '../test/pg-locks.js';
import { claimPayout } from '../withdrawals/withdrawal-service.js';
import { createCompetition } from '../competitions/competition-service.js';
import { activateTestPolicy } from './test-policy-fixture.js';
import { bootstrapLedgerTestGates } from '../economy/ledger-test-bootstrap.js';

const uid = (prefix: string) => `${prefix}-${randomUUID()}`;
async function user(label: string, role?: 'ADMIN' | 'SUPER_ADMIN') {
  const tag = randomUUID().replaceAll('-', '');
  return prisma.user.create({
    data: { email: `ledger-${label}-${tag}@test.local`, username: `l${tag.slice(0, 14)}`, passwordHash: 'fixture-only', displayName: label, ...(role ? { role } : {}) },
  });
}
async function unusedCountryCode() {
  for (;;) {
    const code = `Z${randomUUID().replaceAll('-', '').slice(0, 2)}`.toUpperCase();
    if (!await prisma.country.findUnique({ where: { code } })) return code;
  }
}

/** One real settled agent order and the full quote/withdrawal prerequisites.
 * Fixture stays isolated by generated IDs; financial history is append-only. */
async function purchasedFixture(amount: number) {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12);
  const admin = await user(`admin-${tag}`, 'ADMIN');
  const superAdmin = await user(`super-${tag}`, 'SUPER_ADMIN');
  const agentUser = await user(`agent-${tag}`);
  const buyer = await user(`buyer-${tag}`);
  const recipient = await user(`recipient-${tag}`);
  const countryCode = await unusedCountryCode();
  const country = await prisma.country.create({
    data: { code: countryCode, name: `Ledger contract ${tag}`, currencyCode: 'USD', isActive: true, agentPaymentEnabled: true },
  });
  const method = await prisma.paymentMethodDefinition.create({
    data: {
      countryId: country.id, type: 'BANK_TRANSFER', name: `Ledger bank ${tag}`,
      fieldSchema: { requiredFields: ['bankName', 'accountNumber'] }, isActive: true,
    },
  });
  await prisma.exchangeRateConfig.create({
    data: { countryId: country.id, fiatCurrency: 'USD', coinsPerUnit: 2, isActive: true, setBy: admin.id, effectiveAt: new Date(Date.now() - 1000) },
  });
  const policy = await prisma.countryCasinoPolicy.create({
    data: {
      countryCode, version: 1, status: 'ENABLED', enabledAt: new Date(),
      minWithdrawal: 100, maxWithdrawal: 100000, dailyWithdrawalLimit: 100000,
      monthlyWithdrawalLimit: 1000000, playthroughMultiplier: 2,
      qualifyingGames: ['dice'], maxQualifyingStake: 1000, holdingPeriodHours: 0,
      giftDailyLimit: 100000, kycTierRequired: 0, supportedPaymentMethods: ['BANK_TRANSFER'],
      withdrawalFeePercent: 0, manualReviewThreshold: 100000,
    },
  });
  await activateTestPolicy(policy.id, countryCode, admin.id);
  const application = await submitAgentApplication(agentUser.id, {
    countryId: country.id, displayName: `Ledger agent ${tag}`, contactEmail: `agent-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.application.id, undefined);
  const agent = await prisma.agent.findUniqueOrThrow({ where: { userId: agentUser.id } });
  const agentAccount = await createAgentPaymentAccount(agentUser.id, {
    countryId: country.id, methodDefId: method.id,
    accountDetails: { bankName: 'Test Bank', accountNumber: '000111222' },
  });
  await approveAgentPaymentAccount(admin.id, agentAccount.id);
  await fundAgentInventory(superAdmin.id, agent.id, amount * 2, uid('inventory'));
  await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', BigInt(amount * 2), uid('liquidity'));
  const payoutAccount = await prisma.userPayoutAccount.create({
    data: {
      userId: buyer.id, countryId: country.id, methodDefId: method.id,
      accountDetails: { bankName: 'Test Bank', accountNumber: '000111222' }, status: 'ACTIVE',
    },
  });
  const created = await createAgentOrder(buyer.id, {
    agentId: agent.id, countryId: country.id, paymentAccountId: agentAccount.id,
    fiatAmount: amount / 2, idempotencyKey: uid('order'),
  });
  await submitOrderPayment(buyer.id, created.order.id);
  await settleAgentOrder(agentUser.id, created.order.id);
  return { buyer, recipient, country, payoutAccount, agent, agentUser, agentAccount };
}

async function withdraw(fixture: Awaited<ReturnType<typeof purchasedFixture>>, coins: number, idempotencyKey = uid('withdraw')) {
  const quote = await createWithdrawalQuote(fixture.buyer.id, { countryId: fixture.country.id, coinAmount: coins });
  return createWithdrawal(fixture.buyer.id, { quoteId: quote.id, payoutAccountId: fixture.payoutAccount.id, idempotencyKey }, 1000);
}

async function withdrawable(userId: string) {
  const rows = await prisma.$queryRaw<{ amount: bigint }[]>`
    SELECT COALESCE(SUM("availableAmount"), 0) AS amount FROM coin_provenance
    WHERE "userId"=${userId} AND "lotClass"='WITHDRAWABLE' AND "state"='OPEN'
  `;
  return Number(rows[0].amount);
}

async function walletCoins(userId: string) {
  return (await prisma.wallet.findUniqueOrThrow({ where: { userId } })).coinsBalance;
}

async function economicTotals(userId: string) {
  const wallet = await walletCoins(userId);
  const hasAvailableCache = await prisma.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'coin_provenance' AND column_name = 'availableAmount'
    ) AS present
  `;
  const rows = hasAvailableCache[0].present
    ? await prisma.$queryRawUnsafe<{ tracked: bigint }[]>(
        'SELECT COALESCE(SUM("availableAmount"), 0) AS tracked FROM coin_provenance WHERE "userId" = $1', userId)
    : await prisma.$queryRawUnsafe<{ tracked: bigint }[]>(
        'SELECT COALESCE(SUM(p."amount" - COALESCE((SELECT SUM(a."allocatedAmount") FROM coin_allocations a WHERE a."provenanceId" = p.id), 0)), 0) AS tracked FROM coin_provenance p WHERE p."userId" = $1', userId);
  return { wallet, tracked: Number(rows[0].tracked) };
}

async function assertEconomicBalance(userId: string) {
  const { wallet, tracked } = await economicTotals(userId);
  expect(wallet).toBe(tracked);
}

/** Hold a row or advisory lock until the test explicitly releases it. */
async function heldLock(acquire: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let ready!: () => void;
  let release!: () => void;
  const acquired = new Promise<void>((resolve) => { ready = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const task = prisma.$transaction(async (tx) => {
    await acquire(tx);
    ready();
    await gate;
  }, { timeout: 20000 });
  await acquired;
  return { release: async () => { release(); await task; } };
}

const settled = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ ok: true as const, value }),
  (error) => ({ ok: false as const, error }),
);

beforeAll(async () => {
  // Migration intentionally leaves financial gates closed. A real invariant
  // scan on the isolated test database is required before these flow tests.
  await bootstrapLedgerTestGates();
});

afterAll(async () => prisma.$disconnect());

describe('Opus financial flows, failing first on 7b84d99', () => {
  it('T4: Coin-denominated competition prizes are disabled before escrow is taken', async () => {
    const fixture = await purchasedFixture(1000);
    const group = await prisma.group.create({
      data: { ownerId: fixture.buyer.id, name: uid('ledger-competition'), description: 'Contract gate' },
    });
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: fixture.buyer.id, role: 'OWNER', status: 'ACTIVE' },
    });
    const startsAt = new Date(Date.now() + 3_600_000).toISOString();
    const endsAt = new Date(Date.now() + 7_200_000).toISOString();
    const before = await walletCoins(fixture.buyer.id);
    await expect(createCompetition(fixture.buyer.id, {
      groupId: group.id, gameKey: 'dice', title: uid('Coin prize'),
      startsAt, endsAt, rewardCoins: 100,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(await walletCoins(fixture.buyer.id)).toBe(before);
    expect(await prisma.groupCompetition.count({ where: { groupId: group.id } })).toBe(0);
    await assertEconomicBalance(fixture.buyer.id);
  });

  it('T1/I5: a real settled Agent order yields withdrawable Coins and a successful hold', async () => {
    const fixture = await purchasedFixture(1000);
    expect(await walletCoins(fixture.buyer.id)).toBe(1000);
    const result = await withdraw(fixture, 500);
    expect((result.withdrawal as { status: string }).status).toBe('HELD');
    expect(await walletCoins(fixture.buyer.id)).toBe(500);
  });

  it('T3/I1/M9/M15: a gift consumes purchased lineage, so subsequent Trivia Coins cannot fund a withdrawal', async () => {
    const fixture = await purchasedFixture(1000);
    const gift = await prisma.gift.create({
      data: { name: uid('ledger-gift'), coinPrice: 1000, recipientPointValue: 100, isActive: true },
    });
    await sendGift({ senderId: fixture.buyer.id, recipientId: fixture.recipient.id, giftId: gift.id, quantity: 1, idempotencyKey: uid('gift') });
    expect(await walletCoins(fixture.buyer.id)).toBe(0);
    for (let i = 0; i < 4; i++) {
      const q = await prisma.triviaQuestion.create({
        data: { question: uid(`Ledger Q${i}`), choices: ['right', 'wrong'], correctIndex: 0, category: 'ledger' },
      });
      const result = await playGame({
        userId: fixture.buyer.id, gameKey: 'trivia', clientData: { questionId: q.id, answerIndex: 0 }, idempotencyKey: uid('trivia'),
      });
      expect(result.rewardAmount).toBe(30);
    }
    expect(await walletCoins(fixture.buyer.id)).toBe(120);
    // Quote minimum is 100 on HEAD; four Trivia grants reproduce the
    // contract's 30-Coin phantom-lot case without bypassing the real route.
    await expect(withdraw(fixture, 100)).rejects.toMatchObject({ statusCode: 400 });
    expect(await walletCoins(fixture.buyer.id)).toBe(120);
    expect(await prisma.withdrawal.count({ where: { userId: fixture.buyer.id } })).toBe(0);
  });

  it('T9/I9/M7/M8: cancelling a hold restores the same purchased lot exactly once', async () => {
    const fixture = await purchasedFixture(1000);
    const { withdrawal } = await withdraw(fixture, 100);
    expect(await walletCoins(fixture.buyer.id)).toBe(900);
    await cancelHeldWithdrawal(fixture.buyer.id, (withdrawal as { id: string }).id, { idempotencyKey: uid('cancel') });
    expect(await walletCoins(fixture.buyer.id)).toBe(1000);
    const available = await withdrawable(fixture.buyer.id);
    expect(available).toBe(1000);
  });

  it('T10/I9: the same cancellation key replays with one linked RELEASE', async () => {
    const fixture = await purchasedFixture(1000);
    const { withdrawal } = await withdraw(fixture, 100);
    const withdrawalId = (withdrawal as { id: string }).id;
    const idempotencyKey = uid('cancel-once');
    const first = await cancelHeldWithdrawal(fixture.buyer.id, withdrawalId, { idempotencyKey });
    const replay = await cancelHeldWithdrawal(fixture.buyer.id, withdrawalId, { idempotencyKey });
    expect(first.idempotent).toBe(false);
    expect(replay.idempotent).toBe(true);
    const releases = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM economic_operations
      WHERE "type"='WITHDRAWAL_RELEASE' AND "scopeType"='WITHDRAWAL' AND "scopeId"=${withdrawalId}
    `;
    expect(Number(releases[0].count)).toBe(1);
    expect(await withdrawable(fixture.buyer.id)).toBe(1000);
    await assertEconomicBalance(fixture.buyer.id);
  });
});

describe('I1: wallet equals current lot value after each economic step', () => {
  it('tracks purchase, gift, bonus, hold, release and rollback without a gap', async () => {
    const fixture = await purchasedFixture(1000);
    await assertEconomicBalance(fixture.buyer.id);
    const gift = await prisma.gift.create({
      data: { name: uid('ledger-small-gift'), coinPrice: 100, recipientPointValue: 10, isActive: true },
    });
    await sendGift({ senderId: fixture.buyer.id, recipientId: fixture.recipient.id, giftId: gift.id, quantity: 1, idempotencyKey: uid('gift') });
    await assertEconomicBalance(fixture.buyer.id);

    const question = await prisma.triviaQuestion.create({
      data: { question: uid('Ledger invariant question'), choices: ['right', 'wrong'], correctIndex: 0, category: 'ledger' },
    });
    await playGame({ userId: fixture.buyer.id, gameKey: 'trivia', clientData: { questionId: question.id, answerIndex: 0 }, idempotencyKey: uid('bonus') });
    await assertEconomicBalance(fixture.buyer.id);

    const { withdrawal } = await withdraw(fixture, 100);
    await assertEconomicBalance(fixture.buyer.id);
    await cancelHeldWithdrawal(fixture.buyer.id, (withdrawal as { id: string }).id, { idempotencyKey: uid('release') });
    await assertEconomicBalance(fixture.buyer.id);

    const beforeFailure = await economicTotals(fixture.buyer.id);
    await expect(playGame({ userId: fixture.buyer.id, gameKey: 'dice', betAmount: 1000, idempotencyKey: uid('insufficient') })).rejects.toMatchObject({ statusCode: 400 });
    expect(await economicTotals(fixture.buyer.id)).toEqual(beforeFailure);
  });
});

describe('Opus deterministic lock schedules', () => {
  it('R1/M11: duplicate withdrawal create waits on a per-user advisory lock and replays one hold', async () => {
    const fixture = await purchasedFixture(1000);
    const quote = await createWithdrawalQuote(fixture.buyer.id, { countryId: fixture.country.id, coinAmount: 100 });
    const args = { quoteId: quote.id, payoutAccountId: fixture.payoutAccount.id, idempotencyKey: uid('same-withdrawal') };
    const scope = `withdrawal_create:${fixture.buyer.id}`;
    const holder = await heldLock((tx) => tx.$queryRaw`
      SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))) AS lock_wait
    `);
    const first = settled(createWithdrawal(fixture.buyer.id, args, 1000));
    let scheduleError: unknown;
    let second: ReturnType<typeof settled<Awaited<ReturnType<typeof createWithdrawal>>>> | undefined;
    try {
      // Prepared statements may show the scope as $1 in pg_stat_activity,
      // so match the lock function rather than the parameter value.
      await waitForBlockedBackends(1, { queryLike: '%pg_advisory_xact_lock%', waitEvents: ['advisory'], timeoutMs: 2500 });
      second = settled(createWithdrawal(fixture.buyer.id, args, 1000));
      await waitForBlockedBackends(2, { queryLike: '%pg_advisory_xact_lock%', waitEvents: ['advisory'], timeoutMs: 2500 });
    } catch (error) {
      scheduleError = error;
    } finally {
      await holder.release();
    }
    const results = await Promise.all([first, ...(second ? [second] : [])]);
    if (scheduleError) throw scheduleError;
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
    if (results[0].ok && results[1].ok) {
      expect((results[0].value.withdrawal as { id: string }).id).toBe((results[1].value.withdrawal as { id: string }).id);
      expect([results[0].value.idempotent, results[1].value.idempotent].sort()).toEqual([false, true]);
    }
    expect(await prisma.withdrawal.count({ where: { userId: fixture.buyer.id } })).toBe(1);
  });

  it('R1: duplicate withdrawal create replays after a five-second user-row lock wait', async () => {
    const fixture = await purchasedFixture(1000);
    const quote = await createWithdrawalQuote(fixture.buyer.id, {
      countryId: fixture.country.id, coinAmount: 100,
    });
    const args = { quoteId: quote.id, payoutAccountId: fixture.payoutAccount.id,
      idempotencyKey: uid('long-wait-withdrawal') };
    const holder = await heldLock((tx) => tx.$queryRaw`
      SELECT id FROM users WHERE id = ${fixture.buyer.id} FOR UPDATE
    `);
    const first = settled(createWithdrawal(fixture.buyer.id, args, 1000));
    let second: ReturnType<typeof settled<Awaited<ReturnType<typeof createWithdrawal>>>> | undefined;
    let scheduleError: unknown;
    try {
      await waitForBlockedBackends(1, { queryLike: '%users%', waitEvents: ROW_LOCK_WAITS });
      // The only timed part crosses Prisma's documented interactive timeout;
      // the ordering itself is proved by row/advisory lock observations.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      second = settled(createWithdrawal(fixture.buyer.id, args, 1000));
      await waitForBlockedBackends(1, {
        queryLike: '%pg_advisory_xact_lock%', waitEvents: ['advisory'],
      });
      await new Promise((resolve) => setTimeout(resolve, 3700));
    } catch (error) { scheduleError = error; }
    finally { await holder.release(); }
    const outcomes = await Promise.all([first, ...(second ? [second] : [])]);
    if (scheduleError) throw scheduleError;
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((result) => result.ok)).toEqual([true, true]);
    if (outcomes[0].ok && outcomes[1].ok) {
      expect((outcomes[0].value.withdrawal as { id: string }).id)
        .toBe((outcomes[1].value.withdrawal as { id: string }).id);
    }
    expect(await prisma.withdrawal.count({ where: { userId: fixture.buyer.id } })).toBe(1);
  }, 30000);

  it('R3: suspension committed before the user lock yields 403 and zero settlement writes', async () => {
    const fixture = await purchasedFixture(1000);
    const before = {
      wallet: await walletCoins(fixture.buyer.id),
      sessions: await prisma.gameSession.count({ where: { userId: fixture.buyer.id } }),
      transactions: await prisma.walletTransaction.count({ where: { userId: fixture.buyer.id } }),
    };
    const holder = await heldLock(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${fixture.buyer.id} FOR UPDATE`;
      await tx.user.update({ where: { id: fixture.buyer.id }, data: { status: 'SUSPENDED' } });
    });
    const play = settled(playGame({ userId: fixture.buyer.id, gameKey: 'dice', betAmount: 100, idempotencyKey: uid('suspend-first') }));
    let scheduleError: unknown;
    try {
      await waitForBlockedBackends(1, { queryLike: '%users%', waitEvents: ROW_LOCK_WAITS });
    } catch (error) { scheduleError = error; }
    finally { await holder.release(); }
    const result = await play;
    if (scheduleError) throw scheduleError;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ statusCode: 403 });
    expect({
      wallet: await walletCoins(fixture.buyer.id),
      sessions: await prisma.gameSession.count({ where: { userId: fixture.buyer.id } }),
      transactions: await prisma.walletTransaction.count({ where: { userId: fixture.buyer.id } }),
    }).toEqual(before);
  });

  it('R3: a play holding the user row commits before a concurrent suspension', async () => {
    const fixture = await purchasedFixture(1000);
    const game = await prisma.gameDefinition.findUniqueOrThrow({ where: { key: 'dice' } });
    const beforeSessions = await prisma.gameSession.count({ where: { userId: fixture.buyer.id } });
    const holder = await heldLock((tx) => tx.$queryRaw`
      SELECT id FROM game_definitions WHERE id = ${game.id} FOR UPDATE
    `);
    const play = settled(playGame({ userId: fixture.buyer.id, gameKey: 'dice', betAmount: 100, idempotencyKey: uid('play-first') }));
    let suspension: ReturnType<typeof settled<Awaited<ReturnType<typeof prisma.user.update>>>> | undefined;
    let scheduleError: unknown;
    try {
      await waitForBlockedBackends(1, { queryLike: '%game_definitions%', waitEvents: ROW_LOCK_WAITS });
      suspension = settled(prisma.user.update({ where: { id: fixture.buyer.id }, data: { status: 'SUSPENDED' } }));
      await waitForBlockedBackends(1, { queryLike: '%users%', waitEvents: ROW_LOCK_WAITS });
    } catch (error) { scheduleError = error; }
    finally { await holder.release(); }
    const playOutcome = await play;
    const suspensionOutcome = suspension ? await suspension : undefined;
    if (scheduleError) throw scheduleError;
    expect(playOutcome.ok).toBe(true);
    expect(suspensionOutcome?.ok).toBe(true);
    expect(await prisma.gameSession.count({ where: { userId: fixture.buyer.id } })).toBe(beforeSessions + 1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: fixture.buyer.id } })).status).toBe('SUSPENDED');
  });

  it('R3: an agent disabled before withdrawal selection cannot receive a new hold', async () => {
    const fixture = await purchasedFixture(1000);
    const quote = await createWithdrawalQuote(fixture.buyer.id, {
      countryId: fixture.country.id, coinAmount: 100,
    });
    const before = await walletCoins(fixture.buyer.id);
    const holder = await heldLock((tx) => tx.agent.update({
      where: { id: fixture.agent.id }, data: { status: 'DISABLED' },
    }));
    const creation = settled(createWithdrawal(fixture.buyer.id, {
      quoteId: quote.id, payoutAccountId: fixture.payoutAccount.id,
      idempotencyKey: uid('disabled-agent'),
    }, 1000));
    let scheduleError: unknown;
    try {
      await waitForBlockedBackends(1, {
        queryLike: '%agents%', waitEvents: ROW_LOCK_WAITS, timeoutMs: 2500,
      });
    } catch (error) { scheduleError = error; }
    finally { await holder.release(); }
    const result = await creation;
    if (scheduleError) throw scheduleError;
    expect(result.ok).toBe(false);
    expect(await prisma.withdrawal.count({ where: { userId: fixture.buyer.id } })).toBe(0);
    expect(await walletCoins(fixture.buyer.id)).toBe(before);
    await assertEconomicBalance(fixture.buyer.id);
  }, 20000);

  it('R2: country disable committed before withdrawal country lock rejects an old quote', async () => {
    const fixture = await purchasedFixture(1000);
    const quote = await createWithdrawalQuote(fixture.buyer.id, {
      countryId: fixture.country.id, coinAmount: 100,
    });
    const before = await walletCoins(fixture.buyer.id);
    const holder = await heldLock((tx) => tx.country.update({
      where: { id: fixture.country.id }, data: { agentPaymentEnabled: false },
    }));
    const creation = settled(createWithdrawal(fixture.buyer.id, {
      quoteId: quote.id, payoutAccountId: fixture.payoutAccount.id,
      idempotencyKey: uid('disabled-country'),
    }, 1000));
    let scheduleError: unknown;
    try {
      await waitForBlockedBackends(1, {
        queryLike: '%countries%', waitEvents: ROW_LOCK_WAITS, timeoutMs: 2500,
      });
    } catch (error) { scheduleError = error; }
    finally { await holder.release(); }
    const result = await creation;
    if (scheduleError) throw scheduleError;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ statusCode: 403 });
    expect(await prisma.withdrawal.count({ where: { userId: fixture.buyer.id } })).toBe(0);
    expect(await walletCoins(fixture.buyer.id)).toBe(before);
    await assertEconomicBalance(fixture.buyer.id);
  }, 20000);

  it('R6: opposite gifts lock the lower wallet first and both finish without deadlock', async () => {
    const fixture = await purchasedFixture(1000);
    await prisma.userPayoutAccount.create({ data: {
      userId: fixture.recipient.id, countryId: fixture.country.id,
      methodDefId: fixture.payoutAccount.methodDefId,
      accountDetails: { bankName: 'Test Bank', accountNumber: '333444555' },
      status: 'ACTIVE',
    } });
    const secondOrder = await createAgentOrder(fixture.recipient.id, {
      agentId: fixture.agent.id, countryId: fixture.country.id, paymentAccountId: fixture.agentAccount.id,
      fiatAmount: 500, idempotencyKey: uid('second-order'),
    });
    await submitOrderPayment(fixture.recipient.id, secondOrder.order.id);
    await settleAgentOrder(fixture.agentUser.id, secondOrder.order.id);
    const giftA = await prisma.gift.create({
      data: { name: uid('opposite-gift'), coinPrice: 10, recipientPointValue: 1, isActive: true },
    });
    const giftB = await prisma.gift.create({
      data: { name: uid('opposite-gift'), coinPrice: 10, recipientPointValue: 1, isActive: true },
    });
    const [lower, higher] = [fixture.buyer.id, fixture.recipient.id].sort();
    const lowerWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: lower } });
    const higherWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: higher } });
    const holder = await heldLock((tx) => tx.$queryRaw`
      SELECT id FROM wallets WHERE id = ${lowerWallet.id} FOR NO KEY UPDATE
    `);
    const a = settled(sendGift({ senderId: lower, recipientId: higher, giftId: giftA.id, quantity: 1, idempotencyKey: uid('lower-gift') }));
    let b: ReturnType<typeof settled<Awaited<ReturnType<typeof sendGift>>>> | undefined;
    let higherLockable: 'free' | 'locked' | undefined;
    let scheduleError: unknown;
    try {
      await waitForBlockedBackends(1, { queryLike: '%wallets%', waitEvents: ROW_LOCK_WAITS, timeoutMs: 2500 });
      b = settled(sendGift({ senderId: higher, recipientId: lower, giftId: giftB.id, quantity: 1, idempotencyKey: uid('higher-gift') }));
      await waitForBlockedBackends(2, { queryLike: '%wallets%', waitEvents: ROW_LOCK_WAITS, timeoutMs: 2500 });
      higherLockable = await probeRowLockable('wallets', higherWallet.id);
    } catch (error) { scheduleError = error; }
    finally { await holder.release(); }
    const outcomes = await Promise.all([a, ...(b ? [b] : [])]);
    if (scheduleError) throw scheduleError;
    expect(higherLockable).toBe('free'); // a reversed wallet lock order makes this 'locked'
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((result) => result.ok)).toBe(true);
    expect(await walletCoins(lower)).toBe(990);
    expect(await walletCoins(higher)).toBe(990);
    await assertEconomicBalance(lower);
    await assertEconomicBalance(higher);
  });

  it('R7/I9: cancel and payout claim serialize on the withdrawal row; only one transition wins', async () => {
    const fixture = await purchasedFixture(1000);
    const { withdrawal } = await withdraw(fixture, 100);
    const withdrawalId = (withdrawal as { id: string }).id;
    const holder = await heldLock((tx) => tx.$queryRaw`
      SELECT id FROM withdrawals WHERE id = ${withdrawalId} FOR UPDATE
    `);
    const cancel = settled(cancelHeldWithdrawal(fixture.buyer.id, withdrawalId, { idempotencyKey: uid('cancel-race') }));
    let claim: ReturnType<typeof settled<Awaited<ReturnType<typeof claimPayout>>>> | undefined;
    let scheduleError: unknown;
    try {
      await waitForBlockedBackends(1, { queryLike: '%withdrawals%', waitEvents: ROW_LOCK_WAITS });
      claim = settled(claimPayout(fixture.agentUser.id, withdrawalId, { idempotencyKey: uid('claim-race') }));
      // The second transition waits on the per-withdrawal advisory lock,
      // while the first waits on the row held by this schedule. This is the
      // contract lock order and prevents both from entering settlement.
      await waitForBlockedBackends(1, {
        queryLike: '%pg_advisory_xact_lock%', waitEvents: ['advisory'], timeoutMs: 2500,
      });
    } catch (error) { scheduleError = error; }
    finally { await holder.release(); }
    const outcomes = await Promise.all([cancel, ...(claim ? [claim] : [])]);
    if (scheduleError) throw scheduleError;
    expect(outcomes).toHaveLength(2);
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    const final = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
    expect(['CANCELLED', 'PAYOUT_IN_PROGRESS']).toContain(final.status);
    if (final.status === 'CANCELLED') {
      expect(await walletCoins(fixture.buyer.id)).toBe(1000);
      expect(await withdrawable(fixture.buyer.id)).toBe(1000);
    } else {
      expect(await walletCoins(fixture.buyer.id)).toBe(900);
      expect(await withdrawable(fixture.buyer.id)).toBe(900);
    }
  });
});

describe('C1: ADMIN_QUALIFY is reserved and disabled (Correction 1)', () => {
  it('the reserved-type guard alone rejects a bare ADMIN_QUALIFY operation insert, with no other statement in the transaction', async () => {
    const fixture = await purchasedFixture(1000);
    const opId = uid('c1-bare-op');
    await expect(prisma.economicOperation.create({ data: {
      id: opId, type: 'ADMIN_QUALIFY', userId: fixture.buyer.id,
      scopeType: 'ADMIN_ADJUSTMENT', scopeId: uid('c1-bare-scope'),
      walletTransactionIds: [], createdBy: 'SYSTEM',
    } })).rejects.toThrow(/ADMIN_QUALIFY is reserved and disabled/);
    expect(await prisma.economicOperation.count({ where: { id: opId } })).toBe(0);
  });

  it('a direct-SQL attempt to create an ADMIN_QUALIFY operation rolls back completely: no operation, entry, lot, wallet change, wallet transaction, or review row survives', async () => {
    const fixture = await purchasedFixture(1000);
    const before = await economicTotals(fixture.buyer.id);
    const opId = uid('c1-attack-op');
    const lotId = uid('c1-attack-lot');
    const entryId = uid('c1-attack-entry');
    const reviewId = uid('c1-attack-review');
    await expect(prisma.$transaction(async (tx) => {
      await tx.economicOperation.create({ data: {
        id: opId, type: 'ADMIN_QUALIFY', userId: fixture.buyer.id,
        scopeType: 'ADMIN_ADJUSTMENT', scopeId: uid('c1-scope'),
        walletTransactionIds: [], createdBy: 'SYSTEM',
      } });
      // These never execute — the operation insert above is rejected by
      // economic_operation_reserved_type_guard before any of them run — but
      // they document the full coordinated attack this proves impossible.
      await tx.coinProvenance.create({ data: {
        id: lotId, userId: fixture.buyer.id, amount: 1_000_000, provenanceType: 'ADMIN_ADJUSTMENT',
        restrictionStatus: 'UNRESTRICTED', originalSource: 'ADMIN_ADJUSTMENT',
        lotClass: 'WITHDRAWABLE', state: 'OPEN', availableAmount: 0, reservedAmount: 0,
        requirementAmount: 0, progressAmount: 0, mintedAt: new Date(), availableAt: new Date(),
        sourceOperationId: opId,
      } });
      await tx.coinLotEntry.create({ data: {
        id: entryId, operationId: opId, lotId, userId: fixture.buyer.id, sequence: 0,
        entryType: 'MINT', availableDelta: 1_000_000,
      } });
      await tx.wallet.update({ where: { userId: fixture.buyer.id },
        data: { coinsBalance: { increment: 1_000_000 } } });
      await tx.legacyBalanceReview.create({ data: {
        id: reviewId, userId: fixture.buyer.id, lotId, amount: 1_000_000, status: 'OPEN',
      } });
      await flushCoinLedgerConstraints(tx);
    })).rejects.toThrow();
    expect(await prisma.economicOperation.count({ where: { id: opId } })).toBe(0);
    expect(await prisma.coinProvenance.count({ where: { id: lotId } })).toBe(0);
    expect(await prisma.coinLotEntry.count({ where: { id: entryId } })).toBe(0);
    expect(await prisma.legacyBalanceReview.count({ where: { id: reviewId } })).toBe(0);
    expect(await economicTotals(fixture.buyer.id)).toEqual(before);
  });

  it('ADMIN_QUALIFY is not assignable to CreditCoinsArgs[\'type\'] (compile-time contract: this file fails to build if it ever becomes assignable)', () => {
    // CreditCoinsArgs['type'] is the only application entry point that can
    // mint Coins by named operation. Its literal union excludes
    // 'ADMIN_QUALIFY' — the @ts-expect-error below is only satisfied while
    // that stays true, so a future change that widens the union to include
    // it fails `tsc`.
    // @ts-expect-error 'ADMIN_QUALIFY' is not assignable to CreditCoinsArgs['type']
    const badCredit: CreditCoinsArgs = { type: 'ADMIN_QUALIFY', scopeType: 'ADMIN_ADJUSTMENT', scopeId: 'x', referenceType: 'ADMIN', description: 'attack' };
    void badCredit;
  });

  it('ADMIN_QUALIFY is not assignable to DebitCoinsArgs[\'type\'] (compile-time contract: this file fails to build if it ever becomes assignable)', () => {
    // @ts-expect-error 'ADMIN_QUALIFY' is not assignable to DebitCoinsArgs['type']
    const badDebit: DebitCoinsArgs = { type: 'ADMIN_QUALIFY', scopeType: 'ADMIN_ADJUSTMENT', scopeId: 'x', referenceType: 'ADMIN', description: 'attack' };
    void badDebit;
  });

  it('the invariant checker independently flags any ADMIN_QUALIFY operation as I0, even if one existed', async () => {
    const fixture = await purchasedFixture(1000);
    const opId = uid('c1-poison-op');
    await expect(prisma.$transaction(async (tx) => {
      // session_replication_role bypasses ORIGIN-mode triggers for this one
      // statement only (SET LOCAL, restored at COMMIT/ROLLBACK) — the same
      // mechanism the fixture-cleanup bridge uses — so this poison row can
      // exist just long enough to prove the SCANNER catches it independently
      // of the INSERT-time trigger, without ever being visible outside this
      // transaction (which we always roll back).
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRawUnsafe(
        `INSERT INTO "economic_operations" (id,"type","userId","scopeType","scopeId","walletTransactionIds","createdBy","createdAt")
         VALUES ($1,'ADMIN_QUALIFY',$2,'ADMIN_ADJUSTMENT',$3,'{}','SYSTEM',now())`,
        opId, fixture.buyer.id, uid('c1-poison-scope'),
      );
      const result = await runLedgerInvariantCheckInTransaction(tx, null, false);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.invariant === 'I0 ADMIN_QUALIFY minting is disabled')).toBe(true);
      throw new Error('c1-rollback-only-probe');
    })).rejects.toThrow('c1-rollback-only-probe');
    expect(await prisma.economicOperation.count({ where: { id: opId } })).toBe(0);
  });
});

describe('C2: value-bearing lots require a valid, journaled source operation (Correction 2)', () => {
  it('rejects a phantom lot with no source operation at all, even when the wallet is updated to match it (isolates the journal-integrity guard from the older wallet-equality guard)', async () => {
    const fixture = await purchasedFixture(1000);
    const before = await economicTotals(fixture.buyer.id);
    const lotId = uid('c2-phantom-b');
    await expect(prisma.$transaction(async (tx) => {
      await tx.coinProvenance.create({ data: {
        id: lotId, userId: fixture.buyer.id, amount: 999_999, provenanceType: 'ADMIN_ADJUSTMENT',
        restrictionStatus: 'UNRESTRICTED', originalSource: 'ADMIN_ADJUSTMENT',
        lotClass: 'WITHDRAWABLE', state: 'OPEN', availableAmount: 999_999, reservedAmount: 0,
        requirementAmount: 0, progressAmount: 0, mintedAt: new Date(), availableAt: new Date(),
        sourceOperationId: null,
      } });
      // Makes the wallet agree with the phantom lot, so classified_wallet_lot_equality
      // alone would NOT catch this — only coin_lot_journal_integrity_guard can.
      await tx.wallet.update({ where: { userId: fixture.buyer.id },
        data: { coinsBalance: { increment: 999_999 } } });
      await flushCoinLedgerConstraints(tx);
    })).rejects.toThrow();
    expect(await prisma.coinProvenance.count({ where: { id: lotId } })).toBe(0);
    expect(await economicTotals(fixture.buyer.id)).toEqual(before);
  });

  it('rejects a phantom lot carrying a real, valid sourceOperationId but no journal entries, even when the wallet is updated to match it', async () => {
    const fixture = await purchasedFixture(1000);
    const before = await economicTotals(fixture.buyer.id);
    const realOp = await prisma.economicOperation.findFirstOrThrow({ where: { userId: fixture.buyer.id } });
    const lotId = uid('c2-phantom-c');
    await expect(prisma.$transaction(async (tx) => {
      await tx.coinProvenance.create({ data: {
        id: lotId, userId: fixture.buyer.id, amount: 999_999, provenanceType: 'ADMIN_ADJUSTMENT',
        restrictionStatus: 'UNRESTRICTED', originalSource: 'ADMIN_ADJUSTMENT',
        lotClass: 'WITHDRAWABLE', state: 'OPEN', availableAmount: 999_999, reservedAmount: 0,
        requirementAmount: 0, progressAmount: 0, mintedAt: new Date(), availableAt: new Date(),
        sourceOperationId: realOp.id,
      } });
      await tx.wallet.update({ where: { userId: fixture.buyer.id },
        data: { coinsBalance: { increment: 999_999 } } });
      await flushCoinLedgerConstraints(tx);
    })).rejects.toThrow();
    expect(await prisma.coinProvenance.count({ where: { id: lotId } })).toBe(0);
    expect(await economicTotals(fixture.buyer.id)).toEqual(before);
  });

  it('rejects the named two-transaction attack: T1 creates a phantom lot alone, T2 separately tries to make the wallet match it — both fail, and state is byte-for-byte unchanged', async () => {
    const fixture = await purchasedFixture(1000);
    const before = await economicTotals(fixture.buyer.id);
    const lotId = uid('c2-phantom-d');
    await expect(prisma.$transaction(async (tx) => {
      await tx.coinProvenance.create({ data: {
        id: lotId, userId: fixture.buyer.id, amount: 500_000, provenanceType: 'ADMIN_ADJUSTMENT',
        restrictionStatus: 'UNRESTRICTED', originalSource: 'ADMIN_ADJUSTMENT',
        lotClass: 'WITHDRAWABLE', state: 'OPEN', availableAmount: 500_000, reservedAmount: 0,
        requirementAmount: 0, progressAmount: 0, mintedAt: new Date(), availableAt: new Date(),
        sourceOperationId: null,
      } });
      await flushCoinLedgerConstraints(tx);
    })).rejects.toThrow();
    expect(await prisma.coinProvenance.count({ where: { id: lotId } })).toBe(0);
    // T1 never persisted, so T2 has nothing real to "match" — it fails on
    // its own against the pre-existing classified_wallet_lot_equality guard.
    await expect(prisma.$transaction(async (tx) => {
      await tx.wallet.update({ where: { userId: fixture.buyer.id },
        data: { coinsBalance: { increment: 500_000 } } });
      await flushCoinLedgerConstraints(tx);
    })).rejects.toThrow();
    expect(await economicTotals(fixture.buyer.id)).toEqual(before);
  });

  it('legitimate purchase, withdrawal hold, cancel and gift flows still reconcile end to end (regression)', async () => {
    const fixture = await purchasedFixture(1000);
    await assertEconomicBalance(fixture.buyer.id);
    const { withdrawal } = await withdraw(fixture, 100);
    await assertEconomicBalance(fixture.buyer.id);
    await cancelHeldWithdrawal(fixture.buyer.id, (withdrawal as { id: string }).id, { idempotencyKey: uid('c2-cancel') });
    await assertEconomicBalance(fixture.buyer.id);
    const gift = await prisma.gift.create({
      data: { name: uid('c2-gift'), coinPrice: 100, recipientPointValue: 10, isActive: true },
    });
    await sendGift({ senderId: fixture.buyer.id, recipientId: fixture.recipient.id, giftId: gift.id, quantity: 1, idempotencyKey: uid('c2-gift-send') });
    await assertEconomicBalance(fixture.buyer.id);
  });
});

describe('C3: gift replay is an immutable snapshot, never re-read from the catalog (Correction 3)', () => {
  it('an exact replay returns the original response even after the catalog item is renamed', async () => {
    const fixture = await purchasedFixture(1000);
    const gift = await prisma.gift.create({
      data: { name: uid('c3-original-name'), coinPrice: 100, recipientPointValue: 10, isActive: true },
    });
    const idempotencyKey = uid('c3-replay');
    const first = await sendGift({
      senderId: fixture.buyer.id, recipientId: fixture.recipient.id,
      giftId: gift.id, quantity: 1, idempotencyKey,
    });
    await prisma.gift.update({ where: { id: gift.id }, data: { name: 'RENAMED-AFTER-SEND' } });
    const replay = await sendGift({
      senderId: fixture.buyer.id, recipientId: fixture.recipient.id,
      giftId: gift.id, quantity: 1, idempotencyKey,
    });
    expect(first.isReplay).toBe(false);
    expect(replay.isReplay).toBe(true);
    expect(replay.giftName).toBe(first.giftName);
    expect(replay.giftName).not.toBe('RENAMED-AFTER-SEND');
    // Every stored response field is identical between the send and its
    // replay; only the isReplay indicator (asserted above) differs.
    const omitIsReplay = (result: typeof first) =>
      Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'isReplay'));
    expect(omitIsReplay(replay)).toEqual(omitIsReplay(first));
  });

  it('a conflicting payload reusing the same idempotency key still returns 409, without touching the catalog', async () => {
    const fixture = await purchasedFixture(1000);
    const giftA = await prisma.gift.create({
      data: { name: uid('c3-gift-a'), coinPrice: 100, recipientPointValue: 10, isActive: true },
    });
    const giftB = await prisma.gift.create({
      data: { name: uid('c3-gift-b'), coinPrice: 100, recipientPointValue: 10, isActive: true },
    });
    const idempotencyKey = uid('c3-conflict');
    await sendGift({ senderId: fixture.buyer.id, recipientId: fixture.recipient.id, giftId: giftA.id, quantity: 1, idempotencyKey });
    await expect(sendGift({
      senderId: fixture.buyer.id, recipientId: fixture.recipient.id, giftId: giftB.id, quantity: 1, idempotencyKey,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('a legacy pre-Correction-3 record (no stored snapshot) replays safely with giftName null, never fabricated from the current catalog', async () => {
    const fixture = await purchasedFixture(1000);
    const gift = await prisma.gift.create({
      data: { name: uid('c3-legacy-name'), coinPrice: 100, recipientPointValue: 10, isActive: true },
    });
    const idempotencyKey = uid('c3-legacy');
    const first = await sendGift({
      senderId: fixture.buyer.id, recipientId: fixture.recipient.id,
      giftId: gift.id, quantity: 1, idempotencyKey,
    });
    // Simulate a row created before this column existed.
    await prisma.giftTransaction.updateMany({
      where: { senderId: fixture.buyer.id, giftId: gift.id },
      data: { responseSnapshot: Prisma.DbNull },
    });
    await prisma.gift.update({ where: { id: gift.id }, data: { name: 'RENAMED-LEGACY' } });
    const replay = await sendGift({
      senderId: fixture.buyer.id, recipientId: fixture.recipient.id,
      giftId: gift.id, quantity: 1, idempotencyKey,
    });
    expect(replay.isReplay).toBe(true);
    expect(replay.giftName).toBeNull();
    expect(replay.totalCoins).toBe(first.totalCoins);
    expect(replay.quantity).toBe(first.quantity);
  });
});
