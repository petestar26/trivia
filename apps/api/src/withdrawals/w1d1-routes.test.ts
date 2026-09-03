import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server';
import { createWithdrawalQuote } from './quote-service';
import { createUserPayoutAccount } from './payout-account-service';
import { createWithdrawal, claimPayout, submitPayment } from './withdrawal-service';
import { fundAgentFiatLiquidity } from './liquidity-service';
import { executeBalanceChange } from '../economy/wallet-service';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service';

// W-1D1 route-level tests.
//
// Uses Fastify's own inject() against a real built server (buildServer),
// mounted under config.API_PREFIX, exactly like routes.test.ts. Auth tokens
// are minted via server.jwt.sign so they verify like a real client token.

const PREFIX = `${config.API_PREFIX}/withdrawals`;

try {
  await prisma.$queryRaw`SELECT 1`;
} catch (err) {
  throw new Error('W-1D1 route tests require a reachable Postgres database: ' + (err as Error)?.message);
}

let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  if (server) await server.close();
  await prisma.$disconnect();
});

// ─── Fixtures ──────────────────────────────────────────────────

const TAG = 'w1d1-route';

async function createUser(tag: string) {
  const email = `${TAG}-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `${TAG}-${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `W1D1 Route ${tag}`,
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
  const code = `RT${randomUUID().replaceAll('-', '').slice(0, 6)}`.toUpperCase();
  return prisma.country.create({
    data: { code, name: `W1D1 Route Country ${tag}`, currencyCode: 'USD', isActive: true, agentPaymentEnabled: true },
  });
}

async function createFundedAgent(tag: string, countryId: string, admin: { id: string }, superAdmin: { id: string }) {
  const agentUser = await createUser(`agent-${tag}`);
  const { application } = await submitAgentApplication(agentUser.id, {
    countryId,
    displayName: `W1D1 Route Agent ${tag}`,
    contactEmail: `w1d1-route-agent-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.id, undefined);
  const agent = await prisma.agent.findUnique({ where: { userId: agentUser.id } });
  await fundAgentFiatLiquidity(superAdmin.id, agent!.id, 'USD', 500_000n, `fund-${tag}-${randomUUID()}`);
  return { agentUser, agent: agent! };
}

async function createFundedUser(tag: string, coins: number) {
  const user = await createUser(`user-${tag}`);
  await executeBalanceChange({
    userId: user.id,
    changes: [{ currency: 'COINS', amount: coins, ledgerType: 'CREDIT', transactionType: 'COIN_CREDIT', referenceType: 'ADMIN', description: 'fixture' }],
    operationName: 'fixture-credit',
  });
  return user;
}

async function createHeldWithdrawal(tag: string, coinAmount = 10_000) {
  const admin = await createAdmin(tag);
  const superAdmin = await createSuperAdmin(`${tag}-s`);
  const country = await createCountry(tag);
  const pm = await prisma.paymentMethodDefinition.create({
    data: {
      countryId: country.id,
      type: 'BANK_TRANSFER',
      name: `PM-${tag}`,
      // Must list the fields createUserPayoutAccount's accountDetails
      // below actually supplies — validateAccountDetails reads
      // fieldSchema.requiredFields and throws "misconfigured" when it's
      // absent (payout-account-service.ts), matching the W-1C fixture
      // pattern in withdrawal-service.test.ts's createPaymentMethod.
      fieldSchema: { requiredFields: ['bankName', 'accountNumber'] },
      isActive: true,
    },
  });
  await prisma.exchangeRateConfig.create({
    data: { countryId: country.id, fiatCurrency: 'USD', coinsPerUnit: 2, isActive: true, setBy: admin.id, effectiveAt: new Date(Date.now() - 1000) },
  });
  const { agentUser, agent } = await createFundedAgent(tag, country.id, admin, superAdmin);
  const user = await createFundedUser(tag, 50_000);
  const payoutAccount = await createUserPayoutAccount(user.id, {
    countryId: country.id, methodDefId: pm.id, accountDetails: { bankName: 'TB', accountNumber: '123' },
  });
  const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount });
  const { withdrawal } = await createWithdrawal(user.id, { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `w1d1-route-${tag}` }, 1000);
  return { user, agentUser, agent, withdrawal: withdrawal as any };
}

function mintToken(user: { id: string; email: string; username: string; role: string }) {
  const token = server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: [user.role] });
  return `Bearer ${token}`;
}

async function cleanRouteFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } } });
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
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'W1D1 Route Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'W1D1 Route Country' } } });
}

describe(`W-1D1: withdrawal lifecycle routes ${PREFIX}`, () => {
  beforeAll(() => cleanRouteFixtures());

  describe('GET /withdrawals/agent/assigned', () => {
    it('agent can list assigned withdrawals', async () => {
      const tag = `list-${Date.now()}`;
      const { agentUser, withdrawal } = await createHeldWithdrawal(tag);
      const res = await server.inject({
        method: 'GET',
        url: `${PREFIX}/agent/assigned`,
        headers: { authorization: mintToken(agentUser) },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.some((w: any) => w.id === withdrawal.id)).toBe(true);
    });

    it('non-agent user is rejected with 403', async () => {
      const tag = `list-reject-${Date.now()}`;
      const plainUser = await createUser(`plain-${tag}`);
      const res = await server.inject({
        method: 'GET',
        url: `${PREFIX}/agent/assigned`,
        headers: { authorization: mintToken(plainUser) },
      });
      expect(res.statusCode).toBe(403);
    });

    it('?status=BOGUS returns 400, not an uncaught Prisma validation error', async () => {
      const tag = `list-bogus-${Date.now()}`;
      const { agentUser } = await createHeldWithdrawal(tag);
      const res = await server.inject({
        method: 'GET',
        url: `${PREFIX}/agent/assigned?status=BOGUS`,
        headers: { authorization: mintToken(agentUser) },
      });
      expect(res.statusCode).toBe(400);
    });

    it('?status=HELD (a real enum value) still works', async () => {
      const tag = `list-status-held-${Date.now()}`;
      const { agentUser, withdrawal } = await createHeldWithdrawal(tag);
      const res = await server.inject({
        method: 'GET',
        url: `${PREFIX}/agent/assigned?status=HELD`,
        headers: { authorization: mintToken(agentUser) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.some((w: any) => w.id === withdrawal.id)).toBe(true);
    });
  });

  describe('GET /withdrawals/agent/assigned/:id', () => {
    it('agent can get a single assigned withdrawal', async () => {
      const tag = `get-${Date.now()}`;
      const { agentUser, withdrawal } = await createHeldWithdrawal(tag);
      const res = await server.inject({
        method: 'GET',
        url: `${PREFIX}/agent/assigned/${withdrawal.id}`,
        headers: { authorization: mintToken(agentUser) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.id).toBe(withdrawal.id);
    });

    it('404/403 for withdrawal not assigned to this agent', async () => {
      const tag = `get-other-${Date.now()}`;
      const { withdrawal } = await createHeldWithdrawal(tag);
      const otherUser = await createUser(`other-${tag}`);
      const res = await server.inject({
        method: 'GET',
        url: `${PREFIX}/agent/assigned/${withdrawal.id}`,
        headers: { authorization: mintToken(otherUser) },
      });
      expect([403, 404]).toContain(res.statusCode);
    });
  });

  describe('POST /withdrawals/:id/claim-payout', () => {
    it('agent claims HELD → PAYOUT_IN_PROGRESS', async () => {
      const tag = `claim-${Date.now()}`;
      const { agentUser, withdrawal } = await createHeldWithdrawal(tag);
      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${withdrawal.id}/claim-payout`,
        headers: { authorization: mintToken(agentUser) },
        payload: { idempotencyKey: `ck-${tag}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('PAYOUT_IN_PROGRESS');
    });

    it('400 when not HELD', async () => {
      const tag = `claim-bad-${Date.now()}`;
      const { agentUser, withdrawal } = await createHeldWithdrawal(tag);
      await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `ck1-${tag}` });
      const res = await server.inject({
        method: 'POST', url: `${PREFIX}/${withdrawal.id}/claim-payout`,
        headers: { authorization: mintToken(agentUser) },
        payload: { idempotencyKey: `ck2-${tag}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /withdrawals/:id/submit-payment', () => {
    it('agent submits payment from PAYOUT_IN_PROGRESS', async () => {
      const tag = `sub-${Date.now()}`;
      const { agentUser, withdrawal } = await createHeldWithdrawal(tag);
      await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `ck-${tag}` });
      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${withdrawal.id}/submit-payment`,
        headers: { authorization: mintToken(agentUser) },
        payload: { referenceNumber: 'REF-1', idempotencyKey: `sp-${tag}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.withdrawal.status).toBe('PAYMENT_SUBMITTED');
      expect(body.data.paymentSubmission.referenceNumber).toBe('REF-1');
      expect(body.data.withdrawal.paymentSubmittedAt).not.toBeNull();
      expect(body.data.withdrawal.confirmationDeadlineAt).not.toBeNull();
    });

    it('400 when not PAYOUT_IN_PROGRESS', async () => {
      const tag = `sub-bad-${Date.now()}`;
      const { agentUser, withdrawal } = await createHeldWithdrawal(tag);
      const res = await server.inject({
        method: 'POST', url: `${PREFIX}/${withdrawal.id}/submit-payment`,
        headers: { authorization: mintToken(agentUser) },
        payload: { referenceNumber: 'REF-2', idempotencyKey: `sp-${tag}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /withdrawals/:id/cancel', () => {
    it('user cancels HELD → CANCELLED', async () => {
      const tag = `cancel-${Date.now()}`;
      const { user, withdrawal } = await createHeldWithdrawal(tag);
      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${withdrawal.id}/cancel`,
        headers: { authorization: mintToken(user) },
        payload: { idempotencyKey: `cx-${tag}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('CANCELLED');
    });

    it('403 when not owner', async () => {
      const tag = `cancel-noperm-${Date.now()}`;
      const { withdrawal } = await createHeldWithdrawal(tag);
      const otherUser = await createUser(`other-${tag}`);
      const res = await server.inject({
        method: 'POST', url: `${PREFIX}/${withdrawal.id}/cancel`,
        headers: { authorization: mintToken(otherUser) },
        payload: { idempotencyKey: `cx-${tag}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400 when not HELD (PAYOUT_IN_PROGRESS)', async () => {
      const tag = `cancel-pip-${Date.now()}`;
      const { agentUser, user, withdrawal } = await createHeldWithdrawal(tag);
      await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `ck-${tag}` });
      const res = await server.inject({
        method: 'POST', url: `${PREFIX}/${withdrawal.id}/cancel`,
        headers: { authorization: mintToken(user) },
        payload: { idempotencyKey: `cx-${tag}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400 when not HELD (PAYMENT_SUBMITTED)', async () => {
      const tag = `cancel-ps-${Date.now()}`;
      const { agentUser, user, withdrawal } = await createHeldWithdrawal(tag);
      await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `ck-${tag}` });
      await submitPayment(agentUser.id, withdrawal.id, { referenceNumber: 'X', idempotencyKey: `sp-${tag}` });
      const res = await server.inject({
        method: 'POST', url: `${PREFIX}/${withdrawal.id}/cancel`,
        headers: { authorization: mintToken(user) },
        payload: { idempotencyKey: `cx-${tag}` },
      });
      expect(res.statusCode).toBe(400);
    });

    // W-1D1 fix (OpenAI review blocker): reverts the earlier escape
    // hatch. An agent claiming a withdrawal may already have an external
    // fiat transfer in progress even before recording submitPayment — a
    // user-triggered cancel/refund at that point could double-pay the
    // user. PAYOUT_IN_PROGRESS must reject cancel unconditionally, even
    // once paymentSubmissionDeadlineAt has passed with no payment
    // submitted. (The claim-time deadline check in claimPayout is
    // unaffected — it only blocks a future claim, never moves money.)
    it('400 when PAYOUT_IN_PROGRESS even after paymentSubmissionDeadlineAt has passed with no payment submitted', async () => {
      const tag = `cancel-pip-expired-still-rejects-${Date.now()}`;
      const { agentUser, user, withdrawal } = await createHeldWithdrawal(tag);
      await claimPayout(agentUser.id, withdrawal.id, { idempotencyKey: `ck-${tag}` });
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { paymentSubmissionDeadlineAt: new Date(Date.now() - 1000) },
      });
      const res = await server.inject({
        method: 'POST', url: `${PREFIX}/${withdrawal.id}/cancel`,
        headers: { authorization: mintToken(user) },
        payload: { idempotencyKey: `cx-${tag}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
