import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import {
  createUserPayoutAccount,
  listOwnPayoutAccounts,
  getOwnPayoutAccount,
  loadOwnActivePayoutAccountForWithdrawal,
  disableOwnPayoutAccount,
} from './payout-account-service';

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
  const email = `wpayout-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `wpayouttest_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Payout Account Test ${tag}`,
    },
  });
}

async function createCountry(tag: string) {
  const code = `P${tag}`.slice(0, 8).toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `Payout Test Country ${tag}`,
      currencyCode: 'USD',
      isActive: true,
      agentPaymentEnabled: true,
    },
  });
}

async function createPaymentMethod(countryId: string, tag: string, requiredFields: string[], isActive = true) {
  return prisma.paymentMethodDefinition.create({
    data: {
      countryId,
      type: 'BANK_TRANSFER',
      name: `Payout Test Method ${tag}`,
      fieldSchema: { requiredFields },
      isActive,
    },
  });
}

async function cleanPayoutFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'wpayout-' } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.userPayoutAccount.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'Payout Test Country' } } });
  for (const c of countries) {
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: c.id } });
  }
  await prisma.country.deleteMany({ where: { name: { startsWith: 'Payout Test Country' } } });
}

describeIf('withdrawals/payout-account-service', () => {
  it('creates a payout account owned by the authenticated caller', async () => {
    await cleanPayoutFixtures();
    const tag = `create-${Date.now()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag, ['bankName', 'accountNumber']);

    const account = await createUserPayoutAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: { bankName: 'Test Bank', accountNumber: '000111222' },
      displayLabel: 'My Bank',
    });

    expect(account.userId).toBe(user.id);
    expect(account.status).toBe('ACTIVE');
    expect(account.displayLabel).toBe('My Bank');
  });

  it('rejects accountDetails missing a required field', async () => {
    await cleanPayoutFixtures();
    const tag = `missing-field-${Date.now()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag, ['bankName', 'accountNumber']);

    await expect(
      createUserPayoutAccount(user.id, {
        countryId: country.id,
        methodDefId: method.id,
        accountDetails: { bankName: 'Test Bank' },
      })
    ).rejects.toThrow(/accountNumber is required/);
  });

  it('rejects a payment method that does not belong to the given country (Opus carry-forward #4)', async () => {
    await cleanPayoutFixtures();
    const tag = `country-mismatch-${Date.now()}`;
    const user = await createUser(tag);
    const countryA = await createCountry(tag);
    const countryB = await createCountry(`${tag}-b`);
    const methodOnB = await createPaymentMethod(countryB.id, tag, ['bankName']);

    await expect(
      createUserPayoutAccount(user.id, {
        countryId: countryA.id,
        methodDefId: methodOnB.id,
        accountDetails: { bankName: 'Test Bank' },
      })
    ).rejects.toThrow(/does not belong to the selected country/);
  });

  it('rejects an inactive payment method', async () => {
    await cleanPayoutFixtures();
    const tag = `inactive-method-${Date.now()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag, ['bankName'], false);

    await expect(
      createUserPayoutAccount(user.id, {
        countryId: country.id,
        methodDefId: method.id,
        accountDetails: { bankName: 'Test Bank' },
      })
    ).rejects.toThrow(/not currently active/);
  });

  it('masks accountDetails in list/get reads but not the internal withdrawal-service loader', async () => {
    await cleanPayoutFixtures();
    const tag = `mask-${Date.now()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag, ['accountNumber']);

    const created = await createUserPayoutAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: { accountNumber: '000111222333' },
    });

    const list = await listOwnPayoutAccounts(user.id);
    const masked = list.find((a) => a.id === created.id)!;
    expect(masked.accountDetails).toEqual({ accountNumber: '********2333' });

    const single = await getOwnPayoutAccount(user.id, created.id);
    expect(single.accountDetails).toEqual({ accountNumber: '********2333' });

    const unmasked = await loadOwnActivePayoutAccountForWithdrawal(user.id, created.id);
    expect(unmasked.accountDetails).toEqual({ accountNumber: '000111222333' });
  });

  it('rejects reading or using another user\'s payout account', async () => {
    await cleanPayoutFixtures();
    const tag = `ownership-${Date.now()}`;
    const user = await createUser(tag);
    const otherUser = await createUser(`${tag}-other`);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag, ['bankName']);

    const account = await createUserPayoutAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: { bankName: 'Test Bank' },
    });

    await expect(getOwnPayoutAccount(otherUser.id, account.id)).rejects.toThrow(/does not belong to you/);
    await expect(loadOwnActivePayoutAccountForWithdrawal(otherUser.id, account.id)).rejects.toThrow(
      /does not belong to you/
    );
  });

  it('rejects using a disabled payout account for withdrawal', async () => {
    await cleanPayoutFixtures();
    const tag = `disabled-${Date.now()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag, ['bankName']);

    const account = await createUserPayoutAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: { bankName: 'Test Bank' },
    });
    await disableOwnPayoutAccount(user.id, account.id);

    await expect(loadOwnActivePayoutAccountForWithdrawal(user.id, account.id)).rejects.toThrow(
      /not currently active/
    );
  });

  it('soft-disable is idempotent-safe: disabling twice throws a conflict, not a crash', async () => {
    await cleanPayoutFixtures();
    const tag = `double-disable-${Date.now()}`;
    const user = await createUser(tag);
    const country = await createCountry(tag);
    const method = await createPaymentMethod(country.id, tag, ['bankName']);

    const account = await createUserPayoutAccount(user.id, {
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: { bankName: 'Test Bank' },
    });
    await disableOwnPayoutAccount(user.id, account.id);
    await expect(disableOwnPayoutAccount(user.id, account.id)).rejects.toThrow(/already disabled/);
  });
});
