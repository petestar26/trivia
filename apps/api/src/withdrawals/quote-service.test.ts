import { fixtureEtbPolicy } from '../test/payment-policy-fixture.js';
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { randomUUID } from 'node:crypto';
import { createWithdrawalQuote, getOwnWithdrawalQuote, listOwnWithdrawalQuotes } from './quote-service.js';

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
  const email = `wquote-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `wquotetest_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Withdrawal Quote Test ${tag}`,
    },
  });
}

async function createAdmin(tag: string) {
  const user = await createUser(tag);
  return prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
}

async function createCountry(tag: string, overrides: Partial<{ isActive: boolean; agentPaymentEnabled: boolean }> = {}) {
  const code = `Q${randomUUID().replaceAll('-', '').slice(0, 7)}`.toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `Quote Test Country ${tag}`,
      currencyCode: 'ETB',
      isActive: overrides.isActive ?? true,
      agentPaymentEnabled: overrides.agentPaymentEnabled ?? true, usdPricingEnabled: true,
    },
  });
}

async function createExchangeRate(countryId: string, fiatCurrency: string, coinsPerUnit: number, adminId: string) {
  return prisma.exchangeRateConfig.create({ data: {
      countryId,
      fiatCurrency,
      coinsPerUnit,
      isActive: true,
      setBy: adminId,
      // Avoid a same-millisecond boundary race with the service's
      // effectiveAt <= now lookup.
      effectiveAt: new Date(Date.now() - 1_000),
      pricingPolicy: fixtureEtbPolicy()} });
}

async function cleanQuoteFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'wquote-' } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.withdrawalQuote.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  // Coin provenance/allocation rows are a real foreign key to User —
  // must be cleared before the user row itself can be deleted. Covers
  // both rows this run created AND legacy backfill rows for any stale
  // fixture user left behind by a prior interrupted run (same prefix).
  await prisma.coinAllocation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.coinProvenance.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'Quote Test Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'Quote Test Country' } } });
}

describeIf('withdrawals/quote-service', () => {
  it('quotes ETB wallet minor units one-to-one from server pricing, not client input', async () => {
    await cleanQuoteFixtures();
    const tag = `calc-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    // Wallet and payout use the same integer ETB minor units.
    await createExchangeRate(country.id, 'ETB', 1, admin.id);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    expect(quote.fiatAmount).toBe(1000n);
    expect(typeof quote.fiatAmount).toBe('bigint');
    expect(quote.fiatCurrency).toBe('ETB');
    expect(quote.userId).toBe(user.id);
    expect(quote.status).toBe('ACTIVE');
  });

  it('preserves every minor unit for amounts not divisible by legacy ratios', async () => {
    await cleanQuoteFixtures();
    const tag = `floor-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'ETB', 1, admin.id);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1001 });
    expect(quote.fiatAmount).toBe(1001n);
  });

  it('populates WithdrawalQuote.requestHash as a 64-character lowercase hex SHA-256 string', async () => {
    await cleanQuoteFixtures();
    const tag = `hash-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'ETB', 1, admin.id);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    expect(quote.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a payout at the USD-equivalent minimum instead of rounding it into eligibility', async () => {
    await cleanQuoteFixtures();
    const tag = `floor-zero-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    // 384 ETB minor units at 0.96 ETB/USD equal USD 4 exactly; withdrawal must exceed it.
    await createExchangeRate(country.id, 'ETB', 1, admin.id);

    await expect(
      createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 384 })
    ).rejects.toThrow(/must exceed/);
  });

  it('rejects coinAmount below the minimum', async () => {
    await cleanQuoteFixtures();
    const tag = `min-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'ETB', 1, admin.id);

    await expect(createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1 })).rejects.toThrow(/minimum/);
  });

  it('rejects coinAmount above the maximum', async () => {
    await cleanQuoteFixtures();
    const tag = `max-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'ETB', 1, admin.id);

    await expect(
      createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 10_000_000_000 })
    ).rejects.toThrow(/maximum/);
  });

  it('rejects a non-integer or non-positive coinAmount', async () => {
    await cleanQuoteFixtures();
    const tag = `bad-amount-${Date.now()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);

    await expect(createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 0 })).rejects.toThrow();
    await expect(createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: -500 })).rejects.toThrow();
    await expect(createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1.5 })).rejects.toThrow();
  });

  it('rejects a country with no active exchange rate configured', async () => {
    await cleanQuoteFixtures();
    const tag = `no-rate-${Date.now()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    // no ExchangeRateConfig created

    await expect(createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 })).rejects.toThrow(
      /No active exchange rate/
    );
  });

  it('rejects a country with agent payments disabled', async () => {
    await cleanQuoteFixtures();
    const tag = `disabled-country-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag, { agentPaymentEnabled: false });
    await createExchangeRate(country.id, 'ETB', 1, admin.id);

    await expect(createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 })).rejects.toThrow(
      /not available/
    );
  });

  it('sets an expiry in the future and persists the quote for later lookup', async () => {
    await cleanQuoteFixtures();
    const tag = `expiry-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'ETB', 1, admin.id);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    expect(quote.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const fetched = await getOwnWithdrawalQuote(user.id, quote.id);
    expect(fetched.id).toBe(quote.id);
    expect(fetched.status).toBe('ACTIVE');
  });

  it('rejects looking up a quote that belongs to a different user', async () => {
    await cleanQuoteFixtures();
    const tag = `ownership-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const otherUser = await createUser(`${tag}-other`);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'ETB', 1, admin.id);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    await expect(getOwnWithdrawalQuote(otherUser.id, quote.id)).rejects.toThrow(/does not belong to you/);
  });

  it('allows a new, independent quote for the same user/country/amount (no dedup)', async () => {
    await cleanQuoteFixtures();
    const tag = `repeat-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'ETB', 1, admin.id);

    const quoteA = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const quoteB = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    expect(quoteA.id).not.toBe(quoteB.id);

    const list = await listOwnWithdrawalQuotes(user.id);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});

describeIf('ETB-priced withdrawal quotes', () => {
  it('preserves older quotes and refuses fallback when the latest ETB rate is disabled', async () => {
    const { publishUsdRate } = await import('../agents/usd-config-service.js');
    const tag = `usd-${Date.now()}`;
    const admin = await createAdmin(tag), user = await createUser(tag + '-customer');
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'ETB', 1, admin.id);
    const historicalRate = await prisma.exchangeRateConfig.findFirstOrThrow({ where: { countryId: country.id } });
    // Seed a historical quote directly: new legacy quotes are deliberately forbidden.
    const legacy = await prisma.withdrawalQuote.create({ data: {
      userId: user.id, countryId: country.id, fiatCurrency: 'ETB', coinAmount: 100,
      fiatAmount: 50n, exchangeRateConfigId: historicalRate.id, exchangeRateValue: historicalRate.coinsPerUnit,
      requestHash: 'historical-fixture', expiresAt: new Date(Date.now()+60000), status: 'ACTIVE',
    } });
    await prisma.country.update({ where: { id: country.id }, data: { currencyCode: 'ETB' } });
    const rate = await publishUsdRate(admin.id, country.id, {
      version: 'ETB_V1', walletCurrency: 'ETB', localPerUsd: '0.96', minorDigits: 2,
      source: 'Native test rate', observedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 120000).toISOString(), feeMinor: 0,
      p2pDepositMinUsdCents: 200, p2pWithdrawalAboveUsdCents: 400,
      cryptoDepositMinUsdCents: 1000, cryptoWithdrawalAboveUsdCents: 2000,
    });
    await expect(createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 384 })).rejects.toThrow(/must exceed/);
    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 385 });
    expect(quote.fiatAmount).toBe(385n);
    expect(quote.pricingSnapshot).toMatchObject({ coinAmount: 385, version: 'ETB_V1', walletCurrency: 'ETB', usdNumerator: '38500', usdDenominator: '9600' });
    expect(quote.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 120000);
    const old = await getOwnWithdrawalQuote(user.id, legacy.id);
    expect(old.fiatAmount).toBe(50n);
    expect(old.pricingSnapshot).toBeNull();
    await prisma.exchangeRateConfig.update({ where: { id: rate.id }, data: { isActive: false } });
    await expect(createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 385 })).rejects.toThrow(/No active exchange rate/);
    expect((await getOwnWithdrawalQuote(user.id, quote.id)).fiatAmount).toBe(385n);
  });
});

describeIf('withdrawal pricing compatibility boundary', () => {
  it('rejects publishing a legacy USD policy for a native ETB wallet', async () => {
    const { publishUsdRate } = await import('../agents/usd-config-service.js');
    const { fixtureUsdPolicy } = await import('../test/payment-policy-fixture.js');
    const tag = `reject-usd-${Date.now()}`;
    const admin = await createAdmin(tag);
    const country = await createCountry(tag);
    await expect(publishUsdRate(admin.id, country.id, fixtureUsdPolicy(2)))
      .rejects.toThrow(/Only ETB wallet pricing is supported/);
    expect(await prisma.exchangeRateConfig.count({ where: { countryId: country.id } })).toBe(0);
  });
});
