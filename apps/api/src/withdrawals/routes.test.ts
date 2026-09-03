import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server';
import { createWithdrawalQuote } from './quote-service';
import { createUserPayoutAccount } from './payout-account-service';
import { createWithdrawal } from './withdrawal-service';
import { fundAgentFiatLiquidity } from './liquidity-service';
import { executeBalanceChange } from '../economy/wallet-service';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service';
import { setOwnStepUpPolicy } from '../security/step-up-service';

// W-1C route-level tests.
//
// Uses Fastify's own inject() against a real built server — the same
// pattern already established by server.test.ts (the only existing
// route-level test in this repo; no other route file has HTTP-level
// tests, they all test their service functions directly). Auth tokens
// are minted via the same @fastify/jwt instance the server itself uses
// (server.jwt.sign), so they verify exactly the way a real client's
// token would — no test-only auth bypass exists or is introduced here.

const PREFIX = `${config.API_PREFIX}/withdrawals`;

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  if (server) await server.close();
  await prisma.$disconnect();
});

// ─── Fixtures ──────────────────────────────────────────────────

async function createUser(tag: string) {
  const email = `wroute-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `wroutetest_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Withdrawal Route Test ${tag}`,
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
  const code = `R${randomUUID().replaceAll('-', '').slice(0, 7)}`.toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `Withdrawal Route Test Country ${tag}`,
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
      name: `Withdrawal Route Test Method ${tag}`,
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
    displayName: `Withdrawal Route Agent ${tag}`,
    contactEmail: `wroute-agent-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.id, undefined);
  const agent = await prisma.agent.findUnique({ where: { userId: agentUser.id } });
  await fundAgentFiatLiquidity(superAdmin.id, agent!.id, 'USD', liquidityUsd, `fund-${tag}-${randomUUID()}`);
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

/** Same simplified step-up seeding as withdrawal-service.test.ts — an
 * ACTIVE factor without going through real TOTP encryption, so these
 * tests also run on hosts where SECURITY_TOTP_ENCRYPTION_KEY is unset. */
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

async function mintWithdrawalStepUp(userId: string, tokenIat: number, purpose = 'WITHDRAWAL_CREATE') {
  const now = new Date();
  return prisma.stepUpVerification.create({
    data: {
      userId,
      purpose,
      factorType: 'TOTP',
      tokenIat,
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
    },
  });
}

/** Mints a real access token via the server's own @fastify/jwt instance —
 * verified by the real `authenticate` preHandler, no test-only bypass.
 * Returns the token's actual iat (decoded back out, not independently
 * recomputed) so step-up fixtures can bind to the exact same value
 * requireStepUp() will look up. */
async function mintToken(user: { id: string; email: string; username: string; role: string }) {
  const token = server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: [user.role] });
  const decoded = server.jwt.decode<{ iat: number }>(token);
  return { token, iat: decoded!.iat };
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function cleanRouteFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'wroute-' } } });
  const userIds = users.map((u) => u.id);

  if (userIds.length) {
    const agents = await prisma.agent.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const agentIds = agents.map((a) => a.id);

    await prisma.withdrawalDispute.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
    await prisma.withdrawalEvidence.deleteMany({ where: { withdrawal: { userId: { in: userIds } } } });
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

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'Withdrawal Route Test Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'Withdrawal Route Test Country' } } });
}

async function setupHappyPath(tag: string, opts: { coins?: number; liquidityUsd?: bigint; coinsPerUnit?: number } = {}) {
  const admin = await createAdmin(tag);
  const superAdmin = await createSuperAdmin(`${tag}-super`);
  const country = await createCountry(tag);
  const method = await createPaymentMethod(country.id, tag);
  await createExchangeRate(country.id, 'USD', opts.coinsPerUnit ?? 2, admin.id);
  const agent = await createFundedAgent(tag, country.id, admin, superAdmin, opts.liquidityUsd ?? 100_000n);
  const user = await createFundedUser(tag, opts.coins ?? 10_000);
  const payoutAccount = await createActivePayoutAccount(user.id, country.id, method.id);
  const { token, iat } = await mintToken(user);
  return { admin, superAdmin, country, method, agent, user, payoutAccount, token, iat };
}

describeIf('withdrawals/routes', () => {
  // ── 1. Unauthenticated requests ─────────────────────────────

  const zeroId = '00000000-0000-0000-0000-000000000000';
  const unauthCases: Array<{ method: 'GET' | 'POST'; url: string }> = [
    { method: 'POST', url: '/quotes' },
    { method: 'GET', url: `/quotes/${zeroId}` },
    { method: 'POST', url: '/payout-accounts' },
    { method: 'GET', url: '/payout-accounts' },
    { method: 'GET', url: `/payout-accounts/${zeroId}` },
    { method: 'POST', url: `/payout-accounts/${zeroId}/disable` },
    // '' not '/' — the root POST route is registered as server.post('/', ...)
    // under the /withdrawals prefix, which Fastify collapses to the bare
    // prefix path with NO trailing slash. Since ignoreTrailingSlash isn't
    // configured in server.ts, `${PREFIX}/` would 404 (no route match, so
    // the authenticate preHandler never even runs) rather than 401 —
    // testing the wrong thing entirely.
    { method: 'POST', url: '' },
    { method: 'GET', url: '/me' },
    { method: 'GET', url: `/${zeroId}` },
  ];

  it.each(unauthCases)('rejects unauthenticated $method $url with 401', async ({ method, url }) => {
    const response = await server.inject({ method, url: `${PREFIX}${url}` });
    expect(response.statusCode).toBe(401);
  });

  // ── 2. Create quote success + BigInt/Decimal serialization ──

  it('POST /quotes creates a quote and serializes fiatAmount/exchangeRateValue as strings', async () => {
    await cleanRouteFixtures();
    const tag = `quote-http-${randomUUID()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'USD', 2, admin.id);
    const { token } = await mintToken(user);

    const response = await server.inject({
      method: 'POST',
      url: `${PREFIX}/quotes`,
      headers: authHeader(token),
      payload: { countryId: country.id, coinAmount: 1000 },
    });

    expect(response.statusCode).toBe(201);
    // Parsing the raw response body is itself the proof there was no
    // JSON.stringify-on-BigInt crash server-side — a serialization
    // failure would surface as a 500 with no valid JSON body at all.
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(typeof body.data.fiatAmount).toBe('string');
    expect(body.data.fiatAmount).toBe('500');
    expect(typeof body.data.exchangeRateValue).toBe('string');
    expect(body.data.userId).toBe(user.id);
  });

  // ── 3. Get own quote / reject cross-user ────────────────────

  it('GET /quotes/:id returns the caller\'s own quote and rejects a different user', async () => {
    await cleanRouteFixtures();
    const tag = `quote-get-${randomUUID()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const otherUser = await createUser(`${tag}-other`);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'USD', 2, admin.id);
    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const { token } = await mintToken(user);
    const { token: otherToken } = await mintToken(otherUser);

    const ownResp = await server.inject({ method: 'GET', url: `${PREFIX}/quotes/${quote.id}`, headers: authHeader(token) });
    expect(ownResp.statusCode).toBe(200);
    expect(JSON.parse(ownResp.body).data.id).toBe(quote.id);

    const otherResp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/quotes/${quote.id}`,
      headers: authHeader(otherToken),
    });
    expect(otherResp.statusCode).toBe(403);
  });

  // ── 4. Create payout account — masked HTTP response ─────────

  it('POST /payout-accounts returns a masked accountDetails in the HTTP response', async () => {
    await cleanRouteFixtures();
    const tag = `payout-create-${randomUUID()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag);
    const { token } = await mintToken(user);

    const response = await server.inject({
      method: 'POST',
      url: `${PREFIX}/payout-accounts`,
      headers: authHeader(token),
      payload: {
        countryId: country.id,
        methodDefId: method.id,
        accountDetails: { bankName: 'Test Bank', accountNumber: '000111222' },
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    // "Test Bank" (9 chars) -> 5 stars + last 4 ("Bank");
    // "000111222" (9 chars) -> 5 stars + last 4 ("1222") — same masking
    // algorithm already proven in payout-account-service.test.ts.
    expect(body.data.accountDetails).toEqual({ bankName: '*****Bank', accountNumber: '*****1222' });
    expect(body.data.userId).toBe(user.id);
  });

  // ── 5. Payout account list/get are masked ───────────────────

  it('GET /payout-accounts and GET /payout-accounts/:id both return masked accountDetails', async () => {
    await cleanRouteFixtures();
    const tag = `payout-mask-${randomUUID()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag);
    const account = await createActivePayoutAccount(user.id, country.id, method.id);
    const { token } = await mintToken(user);

    const listResp = await server.inject({ method: 'GET', url: `${PREFIX}/payout-accounts`, headers: authHeader(token) });
    expect(listResp.statusCode).toBe(200);
    const listed = JSON.parse(listResp.body).data.find((a: any) => a.id === account.id);
    expect(listed.accountDetails).toEqual({ bankName: '*****Bank', accountNumber: '*****1222' });

    const getResp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/payout-accounts/${account.id}`,
      headers: authHeader(token),
    });
    expect(getResp.statusCode).toBe(200);
    expect(JSON.parse(getResp.body).data.accountDetails).toEqual({ bankName: '*****Bank', accountNumber: '*****1222' });
  });

  // ── 6. Disable own payout account ───────────────────────────

  it('POST /payout-accounts/:id/disable disables the caller\'s own account', async () => {
    await cleanRouteFixtures();
    const tag = `payout-disable-${randomUUID()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag);
    const account = await createActivePayoutAccount(user.id, country.id, method.id);
    const { token } = await mintToken(user);

    const response = await server.inject({
      method: 'POST',
      url: `${PREFIX}/payout-accounts/${account.id}/disable`,
      headers: authHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.status).toBe('DISABLED');
  });

  // ── 7. Reject cross-user payout account access ──────────────

  it('rejects a different user reading or disabling someone else\'s payout account', async () => {
    await cleanRouteFixtures();
    const tag = `payout-cross-${randomUUID()}`;
    const user = await createUser(tag);
    const otherUser = await createUser(`${tag}-other`);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag);
    const account = await createActivePayoutAccount(user.id, country.id, method.id);
    const { token: otherToken } = await mintToken(otherUser);

    const getResp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/payout-accounts/${account.id}`,
      headers: authHeader(otherToken),
    });
    expect(getResp.statusCode).toBe(403);

    const disableResp = await server.inject({
      method: 'POST',
      url: `${PREFIX}/payout-accounts/${account.id}/disable`,
      headers: authHeader(otherToken),
    });
    expect(disableResp.statusCode).toBe(403);
  });

  // ── 8. Create withdrawal success ────────────────────────────

  it('POST /withdrawals creates a withdrawal — 201, string fiatAmount/exchangeRateValue, no BigInt crash', async () => {
    await cleanRouteFixtures();
    const tag = `withdrawal-create-${randomUUID()}`;
    const { user, country, payoutAccount, token } = await setupHappyPath(tag);
    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });

    const response = await server.inject({
      method: 'POST',
      url: PREFIX,
      headers: authHeader(token),
      payload: { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.data.status).toBe('HELD');
    expect(typeof body.data.fiatAmount).toBe('string');
    expect(body.data.fiatAmount).toBe('500');
    expect(typeof body.data.exchangeRateValue).toBe('string');
  });

  // ── 9. Idempotency through HTTP ──────────────────────────────

  it('idempotency through HTTP: same key+body -> 200 same id; same key + different account -> 409 IDEMPOTENCY_CONFLICT', async () => {
    await cleanRouteFixtures();
    const tag = `withdrawal-idem-${randomUUID()}`;
    const { user, country, method, payoutAccount, token } = await setupHappyPath(tag, {
      coins: 20_000,
      liquidityUsd: 200_000n,
    });
    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const key = `key-${tag}`;

    const first = await server.inject({
      method: 'POST',
      url: PREFIX,
      headers: authHeader(token),
      payload: { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: key },
    });
    expect(first.statusCode).toBe(201);
    const firstId = JSON.parse(first.body).data.id;

    const second = await server.inject({
      method: 'POST',
      url: PREFIX,
      headers: authHeader(token),
      payload: { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: key },
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).data.id).toBe(firstId);

    // A genuinely different request (new quote — the first is already
    // consumed — and a different payout account) reusing the SAME key.
    const secondAccount = await createActivePayoutAccount(user.id, country.id, method.id);
    const anotherQuote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const third = await server.inject({
      method: 'POST',
      url: PREFIX,
      headers: authHeader(token),
      payload: { quoteId: anotherQuote.id, payoutAccountId: secondAccount.id, idempotencyKey: key },
    });
    expect(third.statusCode).toBe(409);
    const thirdBody = JSON.parse(third.body);
    expect(thirdBody.error.details.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  // ── 10. List/get own withdrawals ─────────────────────────────

  it('GET /withdrawals/me and GET /withdrawals/:id return the caller\'s own withdrawal(s)', async () => {
    await cleanRouteFixtures();
    const tag = `withdrawal-list-${randomUUID()}`;
    const { user, country, payoutAccount, token } = await setupHappyPath(tag);
    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const { withdrawal } = await createWithdrawal(
      user.id,
      { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
      1000
    );

    const listResp = await server.inject({ method: 'GET', url: `${PREFIX}/me`, headers: authHeader(token) });
    expect(listResp.statusCode).toBe(200);
    const list = JSON.parse(listResp.body).data;
    expect(list).toHaveLength(1);
    expect(typeof list[0].fiatAmount).toBe('string');

    const getResp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${(withdrawal as any).id}`,
      headers: authHeader(token),
    });
    expect(getResp.statusCode).toBe(200);
    expect(JSON.parse(getResp.body).data.id).toBe((withdrawal as any).id);
  });

  // ── 11. Reject cross-user withdrawal access ──────────────────

  it('GET /withdrawals/:id rejects a different user', async () => {
    await cleanRouteFixtures();
    const tag = `withdrawal-cross-${randomUUID()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);
    const otherUser = await createUser(`${tag}-other`);
    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const { withdrawal } = await createWithdrawal(
      user.id,
      { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
      1000
    );
    const { token: otherToken } = await mintToken(otherUser);

    const response = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${(withdrawal as any).id}`,
      headers: authHeader(otherToken),
    });
    expect(response.statusCode).toBe(403);
  });

  // ── 12. Body userId is not trusted ───────────────────────────

  it('a userId field in the request body is ignored — resources are always owned by the authenticated caller', async () => {
    await cleanRouteFixtures();
    const tag = `no-body-userid-${randomUUID()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const otherUser = await createUser(`${tag}-other`);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'USD', 2, admin.id);
    const { token } = await mintToken(user);

    const response = await server.inject({
      method: 'POST',
      url: `${PREFIX}/quotes`,
      headers: authHeader(token),
      payload: { countryId: country.id, coinAmount: 1000, userId: otherUser.id },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.data.userId).toBe(user.id);
    expect(body.data.userId).not.toBe(otherUser.id);
  });

  // ── 13. Validation failures ───────────────────────────────────

  it('rejects a malformed UUID path param with 400', async () => {
    await cleanRouteFixtures();
    const tag = `bad-uuid-${randomUUID()}`;
    const user = await createUser(tag);
    const { token } = await mintToken(user);

    const response = await server.inject({
      method: 'GET',
      url: `${PREFIX}/quotes/not-a-uuid`,
      headers: authHeader(token),
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a withdrawal creation body missing idempotencyKey with 400', async () => {
    await cleanRouteFixtures();
    const tag = `missing-idem-${randomUUID()}`;
    const user = await createUser(tag);
    const { token } = await mintToken(user);

    const response = await server.inject({
      method: 'POST',
      url: PREFIX,
      headers: authHeader(token),
      payload: { quoteId: randomUUID(), payoutAccountId: randomUUID() },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a non-integer or non-positive coinAmount on quote creation with 400', async () => {
    await cleanRouteFixtures();
    const tag = `bad-coin-amount-${randomUUID()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    const { token } = await mintToken(user);

    const negative = await server.inject({
      method: 'POST',
      url: `${PREFIX}/quotes`,
      headers: authHeader(token),
      payload: { countryId: country.id, coinAmount: -5 },
    });
    expect(negative.statusCode).toBe(400);

    const nonInteger = await server.inject({
      method: 'POST',
      url: `${PREFIX}/quotes`,
      headers: authHeader(token),
      payload: { countryId: country.id, coinAmount: 1.5 },
    });
    expect(nonInteger.statusCode).toBe(400);
  });

  it('rejects accountDetails that is not an object with 400', async () => {
    await cleanRouteFixtures();
    const tag = `bad-account-details-${randomUUID()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag);
    const { token } = await mintToken(user);

    const response = await server.inject({
      method: 'POST',
      url: `${PREFIX}/payout-accounts`,
      headers: authHeader(token),
      payload: { countryId: country.id, methodDefId: method.id, accountDetails: 'not-an-object' },
    });
    expect(response.statusCode).toBe(400);
  });

  // ── 14. Step-up ────────────────────────────────────────────────

  it('POST /withdrawals returns STEP_UP_REQUIRED when the caller\'s policy requires step-up and none was performed', async () => {
    await cleanRouteFixtures();
    const tag = `stepup-missing-${randomUUID()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);
    await enableStepUpPolicy(user.id);
    const { token } = await mintToken(user); // fresh token — no step-up minted for its iat
    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });

    const response = await server.inject({
      method: 'POST',
      url: PREFIX,
      headers: authHeader(token),
      payload: { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.details.code).toBe('STEP_UP_REQUIRED');
  });

  it('POST /withdrawals succeeds with a seeded valid step-up for WITHDRAWAL_CREATE bound to the token\'s iat', async () => {
    await cleanRouteFixtures();
    const tag = `stepup-valid-${randomUUID()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);
    await enableStepUpPolicy(user.id);
    const { token, iat } = await mintToken(user);
    await mintWithdrawalStepUp(user.id, iat);
    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });

    const response = await server.inject({
      method: 'POST',
      url: PREFIX,
      headers: authHeader(token),
      payload: { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).data.status).toBe('HELD');
  });

  it('a step-up minted for a different purpose does not satisfy WITHDRAWAL_CREATE', async () => {
    await cleanRouteFixtures();
    const tag = `stepup-wrong-purpose-${randomUUID()}`;
    const { user, country, payoutAccount } = await setupHappyPath(tag);
    await enableStepUpPolicy(user.id);
    const { token, iat } = await mintToken(user);
    await mintWithdrawalStepUp(user.id, iat, 'SOME_OTHER_PURPOSE');
    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });

    const response = await server.inject({
      method: 'POST',
      url: PREFIX,
      headers: authHeader(token),
      payload: { quoteId: quote.id, payoutAccountId: payoutAccount.id, idempotencyKey: `key-${tag}` },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.details.code).toBe('STEP_UP_REQUIRED');
  });
});
