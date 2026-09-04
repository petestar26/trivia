import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server';
import { createWithdrawalQuote } from './quote-service';
import { createUserPayoutAccount } from './payout-account-service';
import { createWithdrawal, claimPayout, submitPayment } from './withdrawal-service';
import { openUserWithdrawalDispute, claimWithdrawalDispute } from './dispute-service';
import { fundAgentFiatLiquidity } from './liquidity-service';
import { executeBalanceChange } from '../economy/wallet-service';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service';

// W-1D2 route-level tests.
//
// Uses Fastify's own inject() against a real built server (buildServer),
// mounted under config.API_PREFIX, exactly like routes.test.ts and
// w1d1-routes.test.ts. Auth tokens are minted via server.jwt.sign so they
// verify like a real client token.
//
// Preconditions for the route under test are always built with direct
// service-layer calls (createWithdrawal/claimPayout/submitPayment/
// openUserWithdrawalDispute/claimWithdrawalDispute) — never a prior HTTP
// call to a DIFFERENT route — so a bug in one route can never mask or fake
// a pass in another route's test.

const PREFIX = `${config.API_PREFIX}/withdrawals`;

try {
  await prisma.$queryRaw`SELECT 1`;
} catch (err) {
  throw new Error('W-1D2 route tests require a reachable Postgres database: ' + (err as Error)?.message);
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

// ─── Fixtures (mirror w1d1-routes.test.ts) ──────────────────────

const TAG = 'w1d2route';

async function createUser(tag: string) {
  const email = `${TAG}-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `${TAG}-${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `W1D2 Route ${tag}`,
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
  const code = `W2R${randomUUID().replaceAll('-', '').slice(0, 6)}`.toUpperCase();
  return prisma.country.create({
    data: { code, name: `W1D2 Route Country ${tag}`, currencyCode: 'USD', isActive: true, agentPaymentEnabled: true },
  });
}

async function createFundedAgent(tag: string, countryId: string, admin: { id: string }, superAdmin: { id: string }) {
  const agentUser = await createUser(`agent-${tag}`);
  const { application } = await submitAgentApplication(agentUser.id, {
    countryId,
    displayName: `W1D2 Route Agent ${tag}`,
    contactEmail: `w1d2route-agent-${tag}@test.local`,
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
    changes: [
      { currency: 'COINS', amount: coins, ledgerType: 'CREDIT', transactionType: 'COIN_CREDIT', referenceType: 'ADMIN', description: 'fixture' },
    ],
    operationName: 'fixture-credit',
  });
  return user;
}

// A fixed, deterministic accountDetails shape used by every fixture below,
// so the masking assertions can compare against an exact expected string
// rather than re-deriving the mask from the input at test time.
const ACCOUNT_DETAILS = { bankName: 'Test Bank', accountNumber: '881122335' };
const MASKED_ACCOUNT_NUMBER = '*****2335'; // 9 chars: 5 stars + last 4 ('881122335')

async function createHeldWithdrawal(tag: string, coinAmount = 10_000) {
  const admin = await createAdmin(tag);
  const superAdmin = await createSuperAdmin(`${tag}-s`);
  const country = await createCountry(tag);
  const pm = await prisma.paymentMethodDefinition.create({
    data: {
      countryId: country.id,
      type: 'BANK_TRANSFER',
      name: `PM-${tag}`,
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
    countryId: country.id,
    methodDefId: pm.id,
    accountDetails: ACCOUNT_DETAILS,
  });
  const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount });
  const { withdrawal } = await createWithdrawal(
    user.id,
    { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `w1d2route-${tag}` },
    1000
  );
  return { user, agentUser, agent, withdrawal: withdrawal as any, payoutAccount, country };
}

async function createPayoutInProgressWithdrawal(tag: string, coinAmount = 10_000) {
  const fixture = await createHeldWithdrawal(tag, coinAmount);
  await claimPayout(fixture.agentUser.id, fixture.withdrawal.id, { idempotencyKey: `pip-${tag}` });
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: fixture.withdrawal.id } });
  return { ...fixture, withdrawal: withdrawal as any };
}

async function createPaymentSubmittedWithdrawal(tag: string, coinAmount = 10_000) {
  const fixture = await createPayoutInProgressWithdrawal(tag, coinAmount);
  await submitPayment(fixture.agentUser.id, fixture.withdrawal.id, {
    referenceNumber: `REF-${tag}`,
    idempotencyKey: `ps-${tag}`,
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

function mintToken(user: { id: string; email: string; username: string; role: string }) {
  const token = server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: [user.role] });
  return `Bearer ${token}`;
}

async function cleanRouteFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: `${TAG}-` } } });
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

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'W1D2 Route Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'W1D2 Route Country' } } });
}

describe(`W-1D2: withdrawal admin/dispute routes ${PREFIX}`, () => {
  beforeAll(() => cleanRouteFixtures());

  // ── Auth/permission gating for every W-1D2 admin route ─────────

  describe('admin route auth gating', () => {
    it('every W-1D2 admin route rejects a missing token with 401 and a non-admin token with 403', async () => {
      const tag = `admin-gate-${Date.now()}`;
      const plainUser = await createUser(`plain-${tag}`);
      const plainToken = mintToken(plainUser);
      const fakeId = randomUUID();

      const checks: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown }> = [
        { method: 'GET', url: `${PREFIX}/admin/disputes` },
        { method: 'GET', url: `${PREFIX}/admin/escalation-candidates` },
        { method: 'GET', url: `${PREFIX}/admin/disputes/${fakeId}` },
        {
          method: 'POST',
          url: `${PREFIX}/admin/${fakeId}/escalate`,
          payload: { escalationReason: 'PAYMENT_DEADLINE_ELAPSED', description: 'x', idempotencyKey: `gate-esc-${tag}` },
        },
        { method: 'POST', url: `${PREFIX}/admin/disputes/${fakeId}/claim`, payload: { idempotencyKey: `gate-claim-${tag}` } },
        {
          method: 'POST',
          url: `${PREFIX}/admin/disputes/${fakeId}/resolve`,
          payload: { outcome: 'CANCELLED', resolutionNote: 'x', idempotencyKey: `gate-resolve-${tag}` },
        },
      ];

      for (const check of checks) {
        const noAuth = await server.inject({ method: check.method, url: check.url, payload: check.payload });
        expect(noAuth.statusCode, `${check.method} ${check.url} (no token) -> ${noAuth.statusCode}`).toBe(401);

        const nonAdmin = await server.inject({
          method: check.method,
          url: check.url,
          headers: { authorization: plainToken },
          payload: check.payload,
        });
        expect(nonAdmin.statusCode, `${check.method} ${check.url} (non-admin token) -> ${nonAdmin.statusCode}`).toBe(403);
      }
    });
  });

  // ── Bad Zod body rejection ──────────────────────────────────────

  describe('request body validation', () => {
    it('POST /:id/confirm-receipt rejects a body missing idempotencyKey with 400', async () => {
      const tag = `zod-confirm-${Date.now()}`;
      const fixture = await createPaymentSubmittedWithdrawal(tag);
      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${fixture.withdrawal.id}/confirm-receipt`,
        headers: { authorization: mintToken(fixture.user) },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /:id/dispute rejects an invalid reason enum value with 400', async () => {
      const tag = `zod-dispute-${Date.now()}`;
      const fixture = await createPaymentSubmittedWithdrawal(tag);
      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${fixture.withdrawal.id}/dispute`,
        headers: { authorization: mintToken(fixture.user) },
        payload: { reason: 'NOT_A_REAL_REASON', description: 'x', idempotencyKey: `zod-dispute-${tag}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/:id/escalate rejects an invalid escalationReason enum value with 400', async () => {
      const tag = `zod-escalate-${Date.now()}`;
      const fixture = await createPayoutInProgressWithdrawal(tag);
      const admin = await createAdmin(`zod-escalate-${tag}`);
      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/admin/${fixture.withdrawal.id}/escalate`,
        headers: { authorization: mintToken(admin) },
        payload: { escalationReason: 'NOT_A_REAL_REASON', description: 'x', idempotencyKey: `zod-escalate-${tag}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /admin/disputes/:id/resolve rejects an invalid outcome enum value with 400', async () => {
      const tag = `zod-resolve-${Date.now()}`;
      const admin = await createAdmin(`zod-resolve-${tag}`);
      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/admin/disputes/${randomUUID()}/resolve`,
        headers: { authorization: mintToken(admin) },
        payload: { outcome: 'MAYBE', resolutionNote: 'x', idempotencyKey: `zod-resolve-${tag}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── POST /:id/confirm-receipt ────────────────────────────────────

  describe('POST /withdrawals/:id/confirm-receipt', () => {
    it('200 on success, 200 idempotent replay with the same settlement, settlement.fiatAmount serialized as a string, owner route stays unmasked', async () => {
      const tag = `confirm-${Date.now()}`;
      const fixture = await createPaymentSubmittedWithdrawal(tag);
      const token = mintToken(fixture.user);
      const payload = { idempotencyKey: `confirm-${tag}` };

      const first = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${fixture.withdrawal.id}/confirm-receipt`,
        headers: { authorization: token },
        payload,
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json();
      expect(firstBody.success).toBe(true);
      expect(firstBody.idempotent).toBe(false);
      expect(firstBody.data.withdrawal.status).toBe('COMPLETED');
      expect(firstBody.data.settlement.outcome).toBe('COMPLETED');
      expect(typeof firstBody.data.settlement.fiatAmount).toBe('string');
      // Owner route: this is the withdrawing user's OWN payout data, so it
      // is deliberately left unmasked here — only the new W-1D2 admin
      // routes mask paymentSnapshot (see dto.ts's serializeAdminWithdrawal).
      expect(firstBody.data.withdrawal.paymentSnapshot.accountNumber).toBe(ACCOUNT_DETAILS.accountNumber);

      const second = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${fixture.withdrawal.id}/confirm-receipt`,
        headers: { authorization: token },
        payload,
      });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json();
      expect(secondBody.idempotent).toBe(true);
      expect(secondBody.data.settlement.id).toBe(firstBody.data.settlement.id);
    });
  });

  // ── POST /:id/dispute ─────────────────────────────────────────────

  describe('POST /withdrawals/:id/dispute', () => {
    it('201 on success (OPEN dispute, DISPUTED withdrawal), 200 on idempotent replay', async () => {
      const tag = `dispute-${Date.now()}`;
      const fixture = await createPaymentSubmittedWithdrawal(tag);
      const token = mintToken(fixture.user);
      const payload = { reason: 'FIAT_NOT_RECEIVED', description: 'Missing funds', idempotencyKey: `dispute-${tag}` };

      const first = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${fixture.withdrawal.id}/dispute`,
        headers: { authorization: token },
        payload,
      });
      expect(first.statusCode).toBe(201);
      const firstBody = first.json();
      expect(firstBody.data.dispute.status).toBe('OPEN');
      expect(firstBody.data.withdrawal.status).toBe('DISPUTED');

      const second = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${fixture.withdrawal.id}/dispute`,
        headers: { authorization: token },
        payload,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().data.dispute.id).toBe(firstBody.data.dispute.id);
    });
  });

  // ── POST /admin/:id/escalate ──────────────────────────────────────

  describe('POST /withdrawals/admin/:id/escalate', () => {
    it('201 when the payment-submission deadline has elapsed; response masks paymentSnapshot', async () => {
      const tag = `escalate-ok-${Date.now()}`;
      const fixture = await createPayoutInProgressWithdrawal(tag);
      await expireDeadline(fixture.withdrawal.id);
      const admin = await createAdmin(`escalate-ok-${tag}`);

      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/admin/${fixture.withdrawal.id}/escalate`,
        headers: { authorization: mintToken(admin) },
        payload: { escalationReason: 'PAYMENT_DEADLINE_ELAPSED', description: 'Deadline elapsed', idempotencyKey: `escalate-http-${tag}` },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.data.dispute.status).toBe('OPEN');
      expect(body.data.withdrawal.status).toBe('DISPUTED');
      expect(body.data.withdrawal.paymentSnapshot.accountNumber).toBe(MASKED_ACCOUNT_NUMBER);
    });

    it('409 ESCALATION_NOT_ALLOWED when the assigned agent is still ACTIVE and the deadline has not elapsed', async () => {
      const tag = `escalate-blocked-${Date.now()}`;
      const fixture = await createPayoutInProgressWithdrawal(tag);
      const admin = await createAdmin(`escalate-blocked-${tag}`);

      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/admin/${fixture.withdrawal.id}/escalate`,
        headers: { authorization: mintToken(admin) },
        payload: { escalationReason: 'AGENT_NOT_ACTIVE', description: 'Agent looks fine', idempotencyKey: `escalate-blocked-${tag}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.code).toBe('ESCALATION_NOT_ALLOWED');
    });
  });

  // ── POST /admin/disputes/:id/claim ────────────────────────────────

  describe('POST /withdrawals/admin/disputes/:id/claim', () => {
    it('200 moves OPEN -> ASSIGNED; response masks paymentSnapshot', async () => {
      const tag = `claim-ok-${Date.now()}`;
      const fixture = await createPaymentSubmittedWithdrawal(tag);
      const { dispute } = await openUserWithdrawalDispute(fixture.user.id, fixture.withdrawal.id, {
        reason: 'FIAT_NOT_RECEIVED',
        description: 'Missing funds',
        idempotencyKey: `open-${tag}`,
      });
      const admin = await createAdmin(`claim-ok-${tag}`);

      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/admin/disputes/${dispute.id}/claim`,
        headers: { authorization: mintToken(admin) },
        payload: { idempotencyKey: `claim-http-${tag}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.dispute.status).toBe('ASSIGNED');
      expect(body.data.dispute.assignedAdminId).toBe(admin.id);
      expect(body.data.withdrawal.paymentSnapshot.accountNumber).toBe(MASKED_ACCOUNT_NUMBER);
    });
  });

  // ── POST /admin/disputes/:id/resolve ──────────────────────────────

  describe('POST /withdrawals/admin/disputes/:id/resolve', () => {
    it('200 outcome COMPLETED: settlement.fiatAmount is a string, response masks paymentSnapshot', async () => {
      const tag = `resolve-completed-${Date.now()}`;
      const fixture = await createPaymentSubmittedWithdrawal(tag);
      const { dispute } = await openUserWithdrawalDispute(fixture.user.id, fixture.withdrawal.id, {
        reason: 'FIAT_NOT_RECEIVED',
        description: 'Missing funds',
        idempotencyKey: `open-${tag}`,
      });
      const admin = await createAdmin(`resolve-completed-${tag}`);
      await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-${tag}` });

      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/admin/disputes/${dispute.id}/resolve`,
        headers: { authorization: mintToken(admin) },
        payload: { outcome: 'COMPLETED', resolutionNote: 'Confirmed via bank statement', idempotencyKey: `resolve-http-${tag}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.withdrawal.status).toBe('COMPLETED');
      expect(body.data.dispute.status).toBe('RESOLVED');
      expect(body.data.settlement.outcome).toBe('COMPLETED');
      expect(typeof body.data.settlement.fiatAmount).toBe('string');
      expect(body.data.withdrawal.paymentSnapshot.accountNumber).toBe(MASKED_ACCOUNT_NUMBER);
    });

    it('200 outcome CANCELLED: settlement has a refundWalletTransactionId, response masks paymentSnapshot', async () => {
      const tag = `resolve-cancelled-${Date.now()}`;
      const fixture = await createPaymentSubmittedWithdrawal(tag);
      const { dispute } = await openUserWithdrawalDispute(fixture.user.id, fixture.withdrawal.id, {
        reason: 'WRONG_FIAT_AMOUNT',
        description: 'Wrong amount received',
        idempotencyKey: `open-${tag}`,
      });
      const admin = await createAdmin(`resolve-cancelled-${tag}`);
      await claimWithdrawalDispute(admin.id, dispute.id, { idempotencyKey: `claim-${tag}` });

      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/admin/disputes/${dispute.id}/resolve`,
        headers: { authorization: mintToken(admin) },
        payload: { outcome: 'CANCELLED', resolutionNote: 'Refunding due to wrong amount', idempotencyKey: `resolve-http-${tag}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.withdrawal.status).toBe('CANCELLED');
      expect(body.data.dispute.status).toBe('RESOLVED');
      expect(body.data.settlement.outcome).toBe('CANCELLED');
      expect(body.data.settlement.refundWalletTransactionId).toBeTruthy();
      expect(typeof body.data.settlement.fiatAmount).toBe('string');
      expect(body.data.withdrawal.paymentSnapshot.accountNumber).toBe(MASKED_ACCOUNT_NUMBER);
    });
  });

  // ── GET /admin/escalation-candidates ──────────────────────────────

  describe('GET /withdrawals/admin/escalation-candidates', () => {
    it('masks paymentSnapshot.accountDetails for every candidate returned', async () => {
      const tag = `candidates-${Date.now()}`;
      const fixture = await createPayoutInProgressWithdrawal(tag);
      await expireDeadline(fixture.withdrawal.id);
      const admin = await createAdmin(`candidates-${tag}`);

      const res = await server.inject({
        method: 'GET',
        url: `${PREFIX}/admin/escalation-candidates`,
        headers: { authorization: mintToken(admin) },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const found = body.data.find((w: any) => w.id === fixture.withdrawal.id);
      expect(found).toBeTruthy();
      expect(found.paymentSnapshot.accountNumber).toBe(MASKED_ACCOUNT_NUMBER);
      expect(found.paymentSnapshot.accountNumber).not.toBe(ACCOUNT_DETAILS.accountNumber);
    });
  });

  // ── GET /admin/disputes/:id ────────────────────────────────────────

  describe('GET /withdrawals/admin/disputes/:id', () => {
    it('masks paymentSnapshot.accountDetails on the embedded withdrawal', async () => {
      const tag = `dispute-get-${Date.now()}`;
      const fixture = await createPaymentSubmittedWithdrawal(tag);
      const { dispute } = await openUserWithdrawalDispute(fixture.user.id, fixture.withdrawal.id, {
        reason: 'FIAT_NOT_RECEIVED',
        description: 'Missing funds',
        idempotencyKey: `open-${tag}`,
      });
      const admin = await createAdmin(`dispute-get-${tag}`);

      const res = await server.inject({
        method: 'GET',
        url: `${PREFIX}/admin/disputes/${dispute.id}`,
        headers: { authorization: mintToken(admin) },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.dispute.id).toBe(dispute.id);
      expect(body.data.withdrawal.paymentSnapshot.accountNumber).toBe(MASKED_ACCOUNT_NUMBER);
      expect(body.data.withdrawal.paymentSnapshot.accountNumber).not.toBe(ACCOUNT_DETAILS.accountNumber);
    });
  });
});
