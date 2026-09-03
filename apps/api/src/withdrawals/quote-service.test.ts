import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { createWithdrawalQuote, getOwnWithdrawalQuote, listOwnWithdrawalQuotes } from './quote-service';

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
  const code = `Q${tag}`.slice(0, 8).toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `Quote Test Country ${tag}`,
      currencyCode: 'USD',
      isActive: overrides.isActive ?? true,
      agentPaymentEnabled: overrides.agentPaymentEnabled ?? true,
    },
  });
}

async function createExchangeRate(countryId: string, fiatCurrency: string, coinsPerUnit: number, adminId: string) {
  return prisma.exchangeRateConfig.create({
    data: { countryId, fiatCurrency, coinsPerUnit, isActive: true, setBy: adminId },
  });
}

async function cleanQuoteFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'wquote-' } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.withdrawalQuote.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'Quote Test Country' } } });
  for (const c of countries) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'Quote Test Country' } } });
}

describeIf('withdrawals/quote-service', () => {
  it('computes fiatAmount from server-side coinsPerUnit via Decimal, not client input', async () => {
    await cleanQuoteFixtures();
    const tag = `calc-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    // 2 coins per smallest fiat unit (matches order-service.ts's exact
    // convention: coinsPerUnit multiplies directly against a minor-unit
    // amount, so 1000 coins / 2 coinsPerUnit = 500 minor units).
    await createExchangeRate(country.id, 'USD', 2, admin.id);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    expect(quote.fiatAmount).toBe(500n);
    expect(typeof quote.fiatAmount).toBe('bigint');
    expect(quote.fiatCurrency).toBe('USD');
    expect(quote.userId).toBe(user.id);
    expect(quote.status).toBe('ACTIVE');
  });

  it('floors the fiat amount rather than rounding up, favoring the platform', async () => {
    await cleanQuoteFixtures();
    const tag = `floor-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'USD', 3, admin.id); // 1000/3 = 333.33...

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    expect(quote.fiatAmount).toBe(333n);
  });

  it('populates WithdrawalQuote.requestHash as a 64-character lowercase hex SHA-256 string', async () => {
    await cleanQuoteFixtures();
    const tag = `hash-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'USD', 2, admin.id);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    expect(quote.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a coinAmount whose computed fiatAmount would floor to zero', async () => {
    await cleanQuoteFixtures();
    const tag = `floor-zero-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    // coinsPerUnit (1000) > coinAmount (the 100-coin minimum) — floor(100/1000) = 0.
    await createExchangeRate(country.id, 'USD', 1000, admin.id);

    await expect(
      createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 100 })
    ).rejects.toThrow(/must be positive/);
  });

  it('rejects coinAmount below the minimum', async () => {
    await cleanQuoteFixtures();
    const tag = `min-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'USD', 2, admin.id);

    await expect(createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1 })).rejects.toThrow(/minimum/);
  });

  it('rejects coinAmount above the maximum', async () => {
    await cleanQuoteFixtures();
    const tag = `max-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'USD', 2, admin.id);

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
    await createExchangeRate(country.id, 'USD', 2, admin.id);

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
    await createExchangeRate(country.id, 'USD', 2, admin.id);

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
    await createExchangeRate(country.id, 'USD', 2, admin.id);

    const quote = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    await expect(getOwnWithdrawalQuote(otherUser.id, quote.id)).rejects.toThrow(/does not belong to you/);
  });

  it('allows a new, independent quote for the same user/country/amount (no dedup)', async () => {
    await cleanQuoteFixtures();
    const tag = `repeat-${Date.now()}`;
    const admin = await createAdmin(tag);
    const user = await createUser(tag);
    const country = await createCountry(tag);
    await createExchangeRate(country.id, 'USD', 2, admin.id);

    const quoteA = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    const quoteB = await createWithdrawalQuote(user.id, { countryId: country.id, coinAmount: 1000 });
    expect(quoteA.id).not.toBe(quoteB.id);

    const list = await listOwnWithdrawalQuotes(user.id);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});
