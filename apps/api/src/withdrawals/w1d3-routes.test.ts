import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server';
import { createWithdrawalQuote } from './quote-service';
import { createUserPayoutAccount } from './payout-account-service';
import { createWithdrawal, claimPayout } from './withdrawal-service';
import { fundAgentFiatLiquidity } from './liquidity-service';
import { executeBalanceChange } from '../economy/wallet-service';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service';

// W-1D3 route-level tests.
//
// Uses Fastify's own inject() against a real built server (buildServer),
// exactly like w1d1-routes.test.ts / w1d2-routes.test.ts. Preconditions
// are built with direct service calls, never a prior HTTP call to a
// different route.

const PREFIX = `${config.API_PREFIX}/withdrawals`;

try {
  await prisma.$queryRaw`SELECT 1`;
} catch (err) {
  throw new Error('W-1D3 route tests require a reachable Postgres database: ' + (err as Error)?.message);
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

// ─── Fixtures (mirror w1d2-routes.test.ts) ─────────────────────────

const TAG = 'w1d3route';

async function createUser(tag: string) {
  const email = `${TAG}-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `${TAG}-${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `W1D3 Route ${tag}`,
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
  return prisma.country.create({
    data: { code, name: `W1D3 Route Country ${tag}`, currencyCode: 'USD', isActive: true, agentPaymentEnabled: true },
  });
}

async function createFundedAgent(tag: string, countryId: string, admin: { id: string }, superAdmin: { id: string }) {
  const agentUser = await createUser(`agent-${tag}`);
  const { application } = await submitAgentApplication(agentUser.id, {
    countryId,
    displayName: `W1D3 Route Agent ${tag}`,
    contactEmail: `w1d3route-agent-${tag}@test.local`,
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

const ACCOUNT_DETAILS = { bankName: 'Test Bank', accountNumber: '551122338' };

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
    { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `w1d3route-${tag}` },
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

async function expirePayoutDeadline(withdrawalId: string) {
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

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'W1D3 Route Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'W1D3 Route Country' } } });
}

describe(`W-1D3: withdrawal timeout sweep / reconciliation routes ${PREFIX}`, () => {
  beforeAll(() => cleanRouteFixtures());

  describe('admin route auth gating', () => {
    it('POST /admin/sweeps/timeouts and GET /admin/reconciliation reject a missing token with 401 and a non-admin token with 403', async () => {
      const tag = `gate-${Date.now()}`;
      const plainUser = await createUser(`plain-${tag}`);
      const plainToken = mintToken(plainUser);

      const checks: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown }> = [
        { method: 'POST', url: `${PREFIX}/admin/sweeps/timeouts`, payload: {} },
        { method: 'GET', url: `${PREFIX}/admin/reconciliation` },
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

  describe('POST /withdrawals/admin/sweeps/timeouts', () => {
    it('200 with a counts/outcomes summary shape; escalates an expired withdrawal; idempotent across two calls', async () => {
      const tag = `sweep-${Date.now()}`;
      const fixture = await createPayoutInProgressWithdrawal(tag);
      await expirePayoutDeadline(fixture.withdrawal.id);
      const admin = await createAdmin(`sweep-${tag}`);

      const first = await server.inject({
        method: 'POST',
        url: `${PREFIX}/admin/sweeps/timeouts`,
        headers: { authorization: mintToken(admin) },
        payload: {},
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json();
      expect(firstBody.success).toBe(true);
      expect(typeof firstBody.data.lockAcquired).toBe('boolean');
      expect(typeof firstBody.data.payoutDeadline.candidatesFound).toBe('number');
      expect(typeof firstBody.data.payoutDeadline.escalatedCount).toBe('number');
      expect(Array.isArray(firstBody.data.payoutDeadline.outcomes)).toBe(true);
      expect(typeof firstBody.data.confirmationDeadline.candidatesFound).toBe('number');

      const escalated = firstBody.data.payoutDeadline.outcomes.find((o: any) => o.withdrawalId === fixture.withdrawal.id);
      expect(escalated?.result).toBe('ESCALATED');
      expect(typeof escalated.disputeId).toBe('string');

      const withdrawal = await prisma.withdrawal.findUnique({ where: { id: fixture.withdrawal.id } });
      expect(withdrawal!.status).toBe('DISPUTED');

      // Second call: the withdrawal is DISPUTED now, so it is no longer a
      // candidate at all — the route (and the underlying sweep) is safe to
      // call repeatedly with no further effect.
      const second = await server.inject({
        method: 'POST',
        url: `${PREFIX}/admin/sweeps/timeouts`,
        headers: { authorization: mintToken(admin) },
        payload: {},
      });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json();
      expect(secondBody.data.payoutDeadline.outcomes.some((o: any) => o.withdrawalId === fixture.withdrawal.id)).toBe(false);

      const disputeCount = await prisma.withdrawalDispute.count({ where: { withdrawalId: fixture.withdrawal.id } });
      expect(disputeCount).toBe(1);
    });

    it('accepts an empty body (no batchSize) without error', async () => {
      const tag = `sweep-empty-body-${Date.now()}`;
      const admin = await createAdmin(`sweep-empty-body-${tag}`);
      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/admin/sweeps/timeouts`,
        headers: { authorization: mintToken(admin) },
      });
      expect(res.statusCode).toBe(200);
    });

    it('response never contains paymentSnapshot and parses cleanly (no BigInt serialization crash)', async () => {
      const tag = `sweep-no-leak-${Date.now()}`;
      const fixture = await createPayoutInProgressWithdrawal(tag);
      await expirePayoutDeadline(fixture.withdrawal.id);
      const admin = await createAdmin(`sweep-no-leak-${tag}`);

      const res = await server.inject({
        method: 'POST',
        url: `${PREFIX}/admin/sweeps/timeouts`,
        headers: { authorization: mintToken(admin) },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('paymentSnapshot');
      expect(res.body).not.toContain(ACCOUNT_DETAILS.accountNumber);
      // Would throw if a raw BigInt reached JSON.stringify.
      expect(() => res.json()).not.toThrow();
    });
  });

  describe('GET /withdrawals/admin/reconciliation', () => {
    it('200 with a counts/items report shape', async () => {
      const tag = `recon-${Date.now()}`;
      const admin = await createAdmin(`recon-${tag}`);

      const res = await server.inject({
        method: 'GET',
        url: `${PREFIX}/admin/reconciliation`,
        headers: { authorization: mintToken(admin) },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(typeof body.data.totalIssues).toBe('number');
      expect(typeof body.data.checks.activeHoldOnTerminalWithdrawal.count).toBe('number');
      expect(Array.isArray(body.data.checks.activeHoldOnTerminalWithdrawal.items)).toBe(true);
      expect(typeof body.data.checks.completedWithoutSettlement.count).toBe('number');
      expect(typeof body.data.checks.staleUnclaimedDispute.count).toBe('number');
      expect(typeof body.data.checks.liveWithdrawalMissingAgent.count).toBe('number');
    });

    it('accepts limit and staleDisputeThresholdHours query params', async () => {
      const tag = `recon-query-${Date.now()}`;
      const admin = await createAdmin(`recon-query-${tag}`);

      const res = await server.inject({
        method: 'GET',
        url: `${PREFIX}/admin/reconciliation?limit=5&staleDisputeThresholdHours=24`,
        headers: { authorization: mintToken(admin) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.staleDisputeThresholdMs).toBe(24 * 60 * 60 * 1000);
    });

    it('response never contains paymentSnapshot and parses cleanly (no BigInt serialization crash)', async () => {
      const tag = `recon-no-leak-${Date.now()}`;
      const fixture = await createHeldWithdrawal(tag);
      await prisma.withdrawal.update({ where: { id: fixture.withdrawal.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      const admin = await createAdmin(`recon-no-leak-${tag}`);

      const res = await server.inject({
        method: 'GET',
        url: `${PREFIX}/admin/reconciliation`,
        headers: { authorization: mintToken(admin) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('paymentSnapshot');
      expect(res.body).not.toContain(ACCOUNT_DETAILS.accountNumber);
      expect(() => res.json()).not.toThrow();

      const item = res.json().data.checks.activeHoldOnTerminalWithdrawal.items.find((i: any) => i.withdrawalId === fixture.withdrawal.id);
      expect(item).toBeTruthy();
    });
  });
});
