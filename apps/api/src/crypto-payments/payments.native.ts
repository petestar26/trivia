import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, it, expect } from 'vitest';
import { prisma } from '@socialplay/database';
import {
  createDeposit,
  settleDeposit,
  createWithdrawal,
  processWithdrawal,
  addAddress,
  listPayments,
  type Deposit,
} from './service.js';
import { bootstrapLedgerTestGates } from '../economy/ledger-test-bootstrap.js';
import { activateTestPolicy } from '../ledger/test-policy-fixture.js';
import { nextTestCountryCode } from '../test/financial-policy-fixtures.js';
import { fixtureUsdPolicy } from '../test/payment-policy-fixture.js';
import { runLedgerInvariantCheck } from '../economy/ledger-invariant-checker.js';
import { assertWithdrawalPolicyLimits } from '../withdrawals/withdrawal-service.js';
const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Throwaway database required');
process.env.TEST_LEDGER_DB_NAME = 'playqube_scheduled_throwaway';
let runId: string;
beforeAll(async () => {
  runId = await bootstrapLedgerTestGates();
  for (const key of ['CRYPTO_DEPOSIT_CREATE', 'CRYPTO_DEPOSIT_CREDIT', 'CRYPTO_WITHDRAWAL_CREATE'])
    await prisma.platformGate.update({
      where: { key },
      data: { enabled: true, lastInvariantRunId: runId },
    });
});
afterAll(async () => {
  await prisma.platformGate.updateMany({
    where: { key: { startsWith: 'CRYPTO_' } },
    data: { enabled: false },
  });
  await prisma.$disconnect();
});
function address() {
  const bytes = Buffer.concat([
    Buffer.from([0x41]),
    createHash('sha256').update(randomUUID()).digest().subarray(0, 20),
  ]);
  const checksum = createHash('sha256')
    .update(createHash('sha256').update(bytes).digest())
    .digest()
    .subarray(0, 4);
  let n = BigInt('0x' + Buffer.concat([bytes, checksum]).toString('hex')),
    out = '';
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  while (n) {
    out = chars[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}
async function stepup(userId: string, purpose: string) {
  await prisma.stepUpVerification.create({
    data: {
      userId,
      purpose,
      tokenIat: 12345,
      factorType: 'TOTP',
      expiresAt: new Date(Date.now() + 60000),
    },
  });
}
async function fixture(limit = 100000) {
  const user = await prisma.user.create({ data: { username: `crypto_${randomUUID()}` } }),
    admin = await prisma.user.create({
      data: { username: `crypto_admin_${randomUUID()}`, role: 'ADMIN' },
    });
  const country = await prisma.country.create({
    data: {
      code: await nextTestCountryCode(),
      name: 'Disposable crypto country',
      currencyCode: 'USD',
      isActive: true,
      usdPricingEnabled: true,
    },
  });
  const method = await prisma.paymentMethodDefinition.create({
    data: {
      countryId: country.id,
      type: 'BANK_TRANSFER',
      name: 'Fixture profile',
      fieldSchema: {},
      isActive: true,
    },
  });
  await prisma.userPayoutAccount.create({
    data: {
      userId: user.id,
      countryId: country.id,
      methodDefId: method.id,
      accountDetails: {},
      status: 'ACTIVE',
    },
  });
  const policy = await prisma.countryCasinoPolicy.create({
    data: {
      countryCode: country.code,
      version: 1,
      status: 'ENABLED',
      minWithdrawal: 1,
      maxWithdrawal: 100000,
      dailyWithdrawalLimit: limit,
      monthlyWithdrawalLimit: limit,
      playthroughMultiplier: 1,
      qualifyingGames: ['dice'],
      maxQualifyingStake: 1000,
      holdingPeriodHours: 0,
      giftDailyLimit: 10000,
      kycTierRequired: 0,
      supportedPaymentMethods: ['USDT_TRC20', 'BANK_TRANSFER'],
      withdrawalFeePercent: 0,
      manualReviewThreshold: 100000,
    },
  });
  await activateTestPolicy(policy.id, country.code, admin.id);
  await prisma.exchangeRateConfig.create({
    data: {
      countryId: country.id,
      fiatCurrency: 'USD',
      coinsPerUnit: 0.96,
      setBy: admin.id,
      pricingPolicy: { ...fixtureUsdPolicy(1), localPerUsd: '1' },
    },
  });
  const receive = address();
  await stepup(admin.id, 'CRYPTO_ADDRESS_ADD');
  await addAddress(admin.id, 12345, {
    address: receive,
    label: 'Synthetic fixture',
    unusedAddressConfirmed: true,
  });
  return { user, admin, country, policy, receive };
}
async function invoice(f: Awaited<ReturnType<typeof fixture>>, amount = '50') {
  return createDeposit(f.user.id, {
    countryId: f.country.id,
    amount,
    idempotencyKey: randomUUID(),
  });
}
async function transfer(id: string, overrides: Record<string, unknown> = {}) {
  const [d] = await prisma.$queryRaw<Deposit[]>`SELECT * FROM crypto_deposits WHERE id=${id}`;
  return {
    txHash: randomUUID().replaceAll('-', '').repeat(2),
    logIndex: 0,
    amount: d.amountMicro,
    blockNumber: 123,
    blockTime: new Date(d.createdAt.getTime() + 1),
    fromHex: '12'.repeat(20),
    ...overrides,
  };
}
it('serializes duplicate requests and repeated credit deliveries into one address and one credit', async () => {
  const f = await fixture(),
    body = { countryId: f.country.id, amount: '50', idempotencyKey: randomUUID() };
  const [a, b] = await Promise.all([
    createDeposit(f.user.id, body),
    createDeposit(f.user.id, body),
  ]);
  expect(a.id).toBe(b.id);
  await expect(createDeposit(f.user.id, { ...body, amount: '51' })).rejects.toThrow(
    'different payment'
  );
  const t = await transfer(a.id);
  await Promise.all([settleDeposit(a.id, [t]), settleDeposit(a.id, [t])]);
  await settleDeposit(a.id, [t]);
  expect(
    (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.user.id } })).coinsBalance
  ).toBe(4800);
  expect(await prisma.walletTransaction.count({ where: { userId: f.user.id } })).toBe(1);
  expect((await listPayments(f.user.id)).deposits[0]).toMatchObject({
    status: 'CREDITED',
    amount: '50.000000',
  });
  const scan = await runLedgerInvariantCheck();
  expect(scan.violations).toEqual([]);
});
it('routes wrong, split and late transfers to review without creating Coins', async () => {
  for (const scenario of ['under', 'over', 'late', 'split']) {
    const f = await fixture(),
      d = await invoice(f, '10'),
      t = await transfer(d.id);
    if (scenario === 'under') t.amount -= 1n;
    if (scenario === 'over') t.amount += 1n;
    if (scenario === 'late') t.blockTime = new Date(Date.now() + 3600000);
    await settleDeposit(
      d.id,
      scenario === 'split'
        ? [
            { ...t, amount: 5_000_000n },
            { ...t, amount: 5_000_000n, logIndex: 1 },
          ]
        : [t]
    );
    expect((await listPayments(f.user.id)).deposits[0].status).toBe('REVIEW');
    expect(await prisma.walletTransaction.count({ where: { userId: f.user.id } })).toBe(0);
  }
});
it('refuses disabled gates, other members, under-minimum amounts and stale rates', async () => {
  const f = await fixture();
  await expect(invoice(f, '9.999999')).rejects.toThrow('Minimum');
  await expect(
    createDeposit(f.admin.id, {
      countryId: f.country.id,
      amount: '10',
      idempotencyKey: randomUUID(),
    })
  ).rejects.toThrow('payment profile');
  await prisma.platformGate.update({
    where: { key: 'CRYPTO_DEPOSIT_CREATE' },
    data: { enabled: false },
  });
  await expect(invoice(f)).rejects.toThrow('not enabled');
  await prisma.platformGate.update({
    where: { key: 'CRYPTO_DEPOSIT_CREATE' },
    data: { enabled: true, lastInvariantRunId: runId },
  });
  await prisma.exchangeRateConfig.create({
    data: {
      countryId: f.country.id,
      fiatCurrency: 'USD',
      coinsPerUnit: 0.96,
      setBy: f.admin.id,
      effectiveAt: new Date(),
      pricingPolicy: {
        ...fixtureUsdPolicy(1),
        observedAt: new Date(Date.now() - 7200000).toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
      },
    },
  });
  await expect(invoice(f)).rejects.toThrow('stale');
});
it('holds eligible Coins, cancels exactly once and enforces cross-channel limits', async () => {
  const f = await fixture(3000),
    d = await invoice(f);
  await settleDeposit(d.id, [await transfer(d.id)]);
  const body = {
    countryId: f.country.id,
    coinAmount: 2016,
    address: address(),
    idempotencyKey: randomUUID(),
  };
  const [a, b] = await Promise.all([
    createWithdrawal(f.user.id, 12345, body),
    createWithdrawal(f.user.id, 12345, body),
  ]);
  expect(a.id).toBe(b.id);
  expect(
    (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.user.id } })).coinsBalance
  ).toBe(2784);
  await expect(
    prisma.$transaction((tx) =>
      assertWithdrawalPolicyLimits(tx, f.user.id, 1000, f.policy, new Date())
    )
  ).rejects.toThrow('Daily');
  await expect(processWithdrawal(f.admin.id, 12345, a.id, 'cancel', {}, false)).rejects.toThrow(
    'cannot process'
  );
  await Promise.all([
    processWithdrawal(f.user.id, 12345, a.id, 'cancel', {}, false),
    processWithdrawal(f.user.id, 12345, a.id, 'cancel', {}, false),
  ]);
  expect(
    (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.user.id } })).coinsBalance
  ).toBe(4800);
});
it('requires assigned admin step-up, prevents cancellation after claim, and finalizes once', async () => {
  const f = await fixture(),
    d = await invoice(f);
  await settleDeposit(d.id, [await transfer(d.id)]);
  const w = await createWithdrawal(f.user.id, 12345, {
    countryId: f.country.id,
    coinAmount: 2016,
    address: address(),
    idempotencyKey: randomUUID(),
  });
  await expect(processWithdrawal(f.admin.id, 12345, w.id, 'claim', {}, true)).rejects.toThrow();
  await stepup(f.admin.id, `CRYPTO_WITHDRAWAL_CLAIM:${w.id}`);
  await processWithdrawal(f.admin.id, 12345, w.id, 'claim', {}, true);
  await expect(processWithdrawal(f.user.id, 12345, w.id, 'cancel', {}, false)).rejects.toThrow(
    'no longer available'
  );
  const body = { txHash: 'fe'.repeat(32), transferred: true };
  await expect(processWithdrawal(f.admin.id, 12345, w.id, 'confirm', body, true)).rejects.toThrow();
  await stepup(f.admin.id, `CRYPTO_WITHDRAWAL_CONFIRM:${w.id}`);
  await Promise.all([
    processWithdrawal(f.admin.id, 12345, w.id, 'confirm', body, true),
    processWithdrawal(f.admin.id, 12345, w.id, 'confirm', body, true),
  ]);
  expect((await listPayments(f.user.id)).withdrawals[0]).toMatchObject({
    status: 'COMPLETED',
    txHash: body.txHash,
  });
  expect(
    (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.user.id } })).coinsBalance
  ).toBe(2784);
  expect(
    await prisma.economicOperation.count({ where: { scopeId: w.id, type: 'WITHDRAWAL_FINALIZE' } })
  ).toBe(1);
});
it('API role cannot forge receipts; verifier can insert but cannot mutate evidence or grant itself capabilities', async () => {
  const role = `crypto_api_${randomUUID().replaceAll('-', '')}`,
    worker = `crypto_worker_${randomUUID().replaceAll('-', '')}`;
  try {
    await prisma.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
    await prisma.$executeRawUnsafe(`CREATE ROLE "${worker}" NOLOGIN`);
    await prisma.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await prisma.$queryRaw`SELECT public.ledger_apply_runtime_grants(${role})::text`;
    await prisma.$queryRaw`SELECT public.crypto_apply_verifier_grants(${worker})::text`;
    const [a] = await prisma.$queryRaw<
      Array<{ insert: boolean; grant: boolean }>
    >`SELECT has_table_privilege(${role},'public.crypto_receipts','INSERT') AS insert,has_function_privilege(${role},'public.crypto_apply_verifier_grants(text)','EXECUTE') AS grant`;
    expect(a).toEqual({ insert: false, grant: false });
    const [w] = await prisma.$queryRaw<
      Array<{ insert: boolean; mutate: boolean }>
    >`SELECT has_table_privilege(${worker},'public.crypto_receipts','INSERT') AS insert,has_table_privilege(${worker},'public.crypto_receipts','UPDATE,DELETE,TRUNCATE,TRIGGER') AS mutate`;
    expect(w).toEqual({ insert: true, mutate: false });
  } finally {
    for (const r of [role, worker]) {
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${r}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${r}"`);
    }
  }
});
