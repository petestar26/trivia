import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import {
  createCountry,
  setCountryFlags,
  listCountries,
  createPaymentMethod,
  setPaymentMethodActive,
  listPaymentMethods,
  createExchangeRate,
  deactivateExchangeRate,
  getActiveExchangeRate,
  listExchangeRates,
} from './config-service';

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
  const email = `config-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `configtest_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Config Test ${tag}`,
    },
  });
}

async function createAdmin(tag: string) {
  const user = await createUser(tag);
  return prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
}

function uniqueCode(tag: string) {
  // Country.code must be exactly 2 letters — derive a stable-but-unique
  // 2-letter code per test by hashing the tag into the alphabet space.
  let hash = 0;
  for (const ch of tag) hash = (hash * 31 + ch.charCodeAt(0)) % 676;
  const a = String.fromCharCode(65 + Math.floor(hash / 26));
  const b = String.fromCharCode(65 + (hash % 26));
  return `${a}${b}`;
}

async function cleanConfigFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'config-' } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'Config Test Country' } } });
  const countryIds = countries.map((c) => c.id);
  if (countryIds.length) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: { in: countryIds } } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: { in: countryIds } } });
    await prisma.country.deleteMany({ where: { id: { in: countryIds } } });
  }
}

// ═══════════════════════════════════════════════════════════════
// COUNTRY
// ═══════════════════════════════════════════════════════════════

describeIf('Agent config — Country', () => {
  let admin: { id: string };

  beforeAll(async () => {
    await cleanConfigFixtures();
    admin = await createAdmin('countryadmin');
  });

  it('admin can create a valid country, inactive by default', async () => {
    const country = await createCountry(admin.id, {
      code: uniqueCode('create1'),
      name: 'Config Test Country create1',
      currencyCode: 'USD',
    });
    expect(country.isActive).toBe(false);
    expect(country.agentPaymentEnabled).toBe(false);
  });

  it('invalid country code is rejected', async () => {
    await expect(
      createCountry(admin.id, { code: 'usa', name: 'Config Test Country bad1', currencyCode: 'USD' })
    ).rejects.toThrow(/ISO 3166-1/i);
    await expect(
      createCountry(admin.id, { code: 'U', name: 'Config Test Country bad2', currencyCode: 'USD' })
    ).rejects.toThrow(/ISO 3166-1/i);
  });

  it('invalid currency code is rejected', async () => {
    await expect(
      createCountry(admin.id, { code: uniqueCode('bad3'), name: 'Config Test Country bad3', currencyCode: 'us' })
    ).rejects.toThrow(/ISO 4217/i);
  });

  it('duplicate country code is rejected', async () => {
    const code = uniqueCode('dup1');
    await createCountry(admin.id, { code, name: 'Config Test Country dup1a', currencyCode: 'USD' });
    await expect(
      createCountry(admin.id, { code, name: 'Config Test Country dup1b', currencyCode: 'EUR' })
    ).rejects.toThrow(/already exists/i);
  });

  it('ordinary user cannot create a country', async () => {
    const plainUser = await createUser('plain1');
    await expect(
      createCountry(plainUser.id, { code: uniqueCode('unauth1'), name: 'Config Test Country unauth1', currencyCode: 'USD' })
    ).rejects.toThrow(/admin privileges required/i);
  });

  it('admin can independently toggle isActive and agentPaymentEnabled', async () => {
    const country = await createCountry(admin.id, {
      code: uniqueCode('flags1'),
      name: 'Config Test Country flags1',
      currencyCode: 'USD',
    });

    const activated = await setCountryFlags(admin.id, country.id, { isActive: true });
    expect(activated.isActive).toBe(true);
    expect(activated.agentPaymentEnabled).toBe(false); // unaffected

    const enabled = await setCountryFlags(admin.id, country.id, { agentPaymentEnabled: true });
    expect(enabled.isActive).toBe(true); // unaffected
    expect(enabled.agentPaymentEnabled).toBe(true);
  });

  it('listCountries hides inactive countries unless includeInactive is requested', async () => {
    const country = await createCountry(admin.id, {
      code: uniqueCode('list1'),
      name: 'Config Test Country list1',
      currencyCode: 'USD',
    });

    const activeOnly = await listCountries(false);
    expect(activeOnly.find((c) => c.id === country.id)).toBeUndefined();

    const all = await listCountries(true);
    expect(all.find((c) => c.id === country.id)).toBeTruthy();

    await setCountryFlags(admin.id, country.id, { isActive: true });
    const activeOnlyAfter = await listCountries(false);
    expect(activeOnlyAfter.find((c) => c.id === country.id)).toBeTruthy();
  });

  it('country creation is audited', async () => {
    const country = await createCountry(admin.id, {
      code: uniqueCode('audit1'),
      name: 'Config Test Country audit1',
      currencyCode: 'USD',
    });
    const logs = await prisma.auditLog.findMany({ where: { entity: 'Country', entityId: country.id } });
    expect(logs.some((l) => l.action === 'AGENT_CONFIG_COUNTRY_CREATED')).toBe(true);
  });

  it('CONCURRENCY — two admins create the same country code concurrently: exactly one succeeds', async () => {
    const code = uniqueCode('race1');
    const results = await Promise.allSettled([
      createCountry(admin.id, { code, name: 'Config Test Country race1a', currencyCode: 'USD' }),
      createCountry(admin.id, { code, name: 'Config Test Country race1b', currencyCode: 'EUR' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const rows = await prisma.country.findMany({ where: { code } });
    expect(rows.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// PAYMENT METHOD
// ═══════════════════════════════════════════════════════════════

describeIf('Agent config — PaymentMethodDefinition', () => {
  let admin: { id: string };
  let country: { id: string };

  beforeAll(async () => {
    await cleanConfigFixtures();
    admin = await createAdmin('methodadmin');
    country = await createCountry(admin.id, {
      code: uniqueCode('methodcountry'),
      name: 'Config Test Country methodcountry',
      currencyCode: 'USD',
    });
  });

  it('admin can create a valid payment method', async () => {
    const method = await createPaymentMethod(admin.id, {
      countryId: country.id,
      type: 'BANK_TRANSFER',
      name: 'Test Bank Transfer',
      requiredFields: ['bankName', 'accountNumber'],
    });
    expect(method.isActive).toBe(false);
    expect((method.fieldSchema as any).requiredFields).toEqual(['bankName', 'accountNumber']);
  });

  it('invalid countryId is rejected', async () => {
    await expect(
      createPaymentMethod(admin.id, {
        countryId: 'not-a-real-country',
        type: 'BANK_TRANSFER',
        name: 'X',
        requiredFields: ['a'],
      })
    ).rejects.toThrow(/invalid countryid/i);
  });

  it('empty requiredFields is rejected — protects payment-account-service\'s consuming contract', async () => {
    await expect(
      createPaymentMethod(admin.id, { countryId: country.id, type: 'BANK_TRANSFER', name: 'Y', requiredFields: [] })
    ).rejects.toThrow(/non-empty array/i);
    await expect(
      createPaymentMethod(admin.id, { countryId: country.id, type: 'BANK_TRANSFER', name: 'Z', requiredFields: ['  '] })
    ).rejects.toThrow(/non-empty array/i);
  });

  it('duplicate [countryId, type, name] is rejected', async () => {
    await createPaymentMethod(admin.id, {
      countryId: country.id,
      type: 'MOBILE_PAYMENT',
      name: 'Dup Method',
      requiredFields: ['phone'],
    });
    await expect(
      createPaymentMethod(admin.id, {
        countryId: country.id,
        type: 'MOBILE_PAYMENT',
        name: 'Dup Method',
        requiredFields: ['phone2'],
      })
    ).rejects.toThrow(/already exists/i);
  });

  it('ordinary user cannot create a payment method', async () => {
    const plainUser = await createUser('plain2');
    await expect(
      createPaymentMethod(plainUser.id, { countryId: country.id, type: 'BANK_TRANSFER', name: 'Unauthorized', requiredFields: ['a'] })
    ).rejects.toThrow(/admin privileges required/i);
  });

  it('admin can toggle payment method active state', async () => {
    const method = await createPaymentMethod(admin.id, {
      countryId: country.id,
      type: 'BANK_TRANSFER',
      name: 'Togglable',
      requiredFields: ['iban'],
    });
    const activated = await setPaymentMethodActive(admin.id, method.id, true);
    expect(activated.isActive).toBe(true);
    const deactivated = await setPaymentMethodActive(admin.id, method.id, false);
    expect(deactivated.isActive).toBe(false);
  });

  it('listPaymentMethods hides inactive unless requested', async () => {
    const method = await createPaymentMethod(admin.id, {
      countryId: country.id,
      type: 'BANK_TRANSFER',
      name: 'ListTest',
      requiredFields: ['x'],
    });
    const activeOnly = await listPaymentMethods(country.id, false);
    expect(activeOnly.find((m) => m.id === method.id)).toBeUndefined();
    const all = await listPaymentMethods(country.id, true);
    expect(all.find((m) => m.id === method.id)).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// EXCHANGE RATE
// ═══════════════════════════════════════════════════════════════

describeIf('Agent config — ExchangeRateConfig', () => {
  let admin: { id: string };
  let country: { id: string };

  beforeAll(async () => {
    await cleanConfigFixtures();
    admin = await createAdmin('rateadmin');
    country = await createCountry(admin.id, {
      code: uniqueCode('ratecountry'),
      name: 'Config Test Country ratecountry',
      currencyCode: 'USD',
    });
  });

  it('admin can create a valid exchange rate', async () => {
    const rate = await createExchangeRate(admin.id, { countryId: country.id, fiatCurrency: 'USD', coinsPerUnit: 10 });
    expect(rate.isActive).toBe(true);
    expect(rate.setBy).toBe(admin.id);
    expect(Number(rate.coinsPerUnit)).toBe(10);
  });

  it('non-positive coinsPerUnit is rejected', async () => {
    await expect(
      createExchangeRate(admin.id, { countryId: country.id, fiatCurrency: 'USD', coinsPerUnit: 0 })
    ).rejects.toThrow(/positive number/i);
    await expect(
      createExchangeRate(admin.id, { countryId: country.id, fiatCurrency: 'USD', coinsPerUnit: -5 })
    ).rejects.toThrow(/positive number/i);
  });

  it('a newer rate is selected over an older one — matches the exact documented selection query', async () => {
    await createExchangeRate(admin.id, {
      countryId: country.id,
      fiatCurrency: 'EUR',
      coinsPerUnit: 5,
      effectiveAt: new Date(Date.now() - 60_000),
    });
    await createExchangeRate(admin.id, { countryId: country.id, fiatCurrency: 'EUR', coinsPerUnit: 8 });

    const active = await getActiveExchangeRate(country.id, 'EUR');
    expect(Number(active!.coinsPerUnit)).toBe(8);
  });

  it('a future-dated rate is not yet selected', async () => {
    await createExchangeRate(admin.id, {
      countryId: country.id,
      fiatCurrency: 'GBP',
      coinsPerUnit: 20,
      effectiveAt: new Date(Date.now() + 3_600_000),
    });
    const active = await getActiveExchangeRate(country.id, 'GBP');
    expect(active).toBeNull();
  });

  it('deactivating a rate removes it from selection; creating never edits an existing row', async () => {
    const rate = await createExchangeRate(admin.id, { countryId: country.id, fiatCurrency: 'JPY', coinsPerUnit: 3 });
    await deactivateExchangeRate(admin.id, rate.id);

    const active = await getActiveExchangeRate(country.id, 'JPY');
    expect(active).toBeNull();

    const history = await listExchangeRates(country.id);
    const stillThere = history.find((r) => r.id === rate.id);
    expect(stillThere).toBeTruthy(); // historical row preserved, never deleted or rewritten
    expect(stillThere!.isActive).toBe(false);
  });

  it('deactivating an already-inactive rate is rejected', async () => {
    const rate = await createExchangeRate(admin.id, { countryId: country.id, fiatCurrency: 'CAD', coinsPerUnit: 4 });
    await deactivateExchangeRate(admin.id, rate.id);
    await expect(deactivateExchangeRate(admin.id, rate.id)).rejects.toThrow(/already inactive/i);
  });

  it('ordinary user cannot create or deactivate exchange rates', async () => {
    const plainUser = await createUser('plain3');
    await expect(
      createExchangeRate(plainUser.id, { countryId: country.id, fiatCurrency: 'USD', coinsPerUnit: 1 })
    ).rejects.toThrow(/admin privileges required/i);

    const rate = await createExchangeRate(admin.id, { countryId: country.id, fiatCurrency: 'AUD', coinsPerUnit: 6 });
    await expect(deactivateExchangeRate(plainUser.id, rate.id)).rejects.toThrow(/admin privileges required/i);
  });
});
