import { beforeEach, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    auditLog: { create: vi.fn() },
    userSecurityPolicy: { findUnique: vi.fn() },
    withdrawal: { count: vi.fn() },
  },
  rate: vi.fn(),
  gate: vi.fn(),
  hold: vi.fn(),
  limits: vi.fn(),
}));
vi.mock('@socialplay/database', async (original) => ({
  ...(await original<typeof import('@socialplay/database')>()),
  prisma: m.db,
}));
vi.mock('../agents/usd-config-service.js', () => ({ selectPaymentRate: m.rate }));
vi.mock('../economy/jurisdiction-service.js', () => ({
  requirePlatformGate: m.gate,
  activePolicyForCountry: async () => ({
    id: 'policy',
    version: 1,
    kycTierRequired: 0,
    withdrawalFeePercent: 0,
    supportedPaymentMethods: ['USDT_TRC20'],
    manualReviewThreshold: 0,
  }),
}));
vi.mock('../economy/coin-ledger-service.js', () => ({
  lockUserEconomicScope: vi.fn(),
  lockEconomicWallet: vi.fn(),
  reserveWithdrawalCoins: m.hold,
  releaseWithdrawalCoins: vi.fn(),
  finalizeWithdrawalCoins: vi.fn(),
  creditCoins: vi.fn(),
}));
vi.mock('../withdrawals/withdrawal-service.js', () => ({ assertWithdrawalPolicyLimits: m.limits }));
import { createDeposit, createWithdrawal } from './service.js';
const countryId = '11111111-1111-4111-8111-111111111111';
const rateId = '22222222-2222-4222-8222-222222222222';
const idempotencyKey = '33333333-3333-4333-8333-333333333333';
const address = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
let stored: any, allocationCount: number, withdrawal: any;
beforeEach(() => {
  vi.resetAllMocks();
  stored = undefined;
  withdrawal = undefined;
  allocationCount = 0;
  m.db.$transaction.mockImplementation((fn) => fn(m.db));
  m.hold.mockResolvedValue({ holdOperationId: 'hold' });
  m.rate.mockResolvedValue({
    id: rateId,
    pricingPolicy: {
      version: 'ETB_V1',
      walletCurrency: 'ETB',
      minorDigits: 2,
      localPerUsd: '182.16377894',
      observedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 1700000).toISOString(),
      source: 'https://ethioblackmarket.com/',
      p2pDepositMinUsdCents: 200,
      p2pWithdrawalAboveUsdCents: 400,
      cryptoDepositMinUsdCents: 1000,
      cryptoWithdrawalAboveUsdCents: 2000,
      feeMinor: 0,
    },
  });
  m.db.$queryRaw.mockImplementation(async (parts: TemplateStringsArray, ...values: any[]) => {
    const sql = parts.join('?');
    if (sql.includes('FROM users')) return [{ status: 'ACTIVE', role: 'USER' }];
    if (sql.includes('FROM user_payout_accounts')) return [{ countryId }];
    if (sql.includes('FROM countries'))
      return [
        { id: countryId, code: 'ET', currencyCode: 'ETB', usdPricingEnabled: true, isActive: true },
      ];
    if (sql.includes('FROM crypto_deposits') && sql.includes('requestKey'))
      return stored ? [stored] : [];
    if (sql.includes('FROM crypto_withdrawals') && sql.includes('requestKey'))
      return withdrawal ? [withdrawal] : [];
    if (sql.includes('FROM crypto_addresses a')) {
      allocationCount++;
      return [{ address }];
    }
    if (sql.includes('INSERT INTO crypto_deposits')) {
      const [id, userId, c, a, micro, minor, snapshot, key, createdAt, expiresAt] = values;
      stored = {
        id,
        userId,
        countryId: c,
        address: a,
        amountMicro: micro,
        coinAmount: minor,
        pricingSnapshot: JSON.parse(snapshot),
        requestKey: key,
        createdAt,
        expiresAt,
        status: 'WAITING',
      };
      return [stored];
    }
    if (sql.includes('INSERT INTO crypto_withdrawals')) {
      const [id, userId, c, a, micro, minor, snapshot, key, holdOperationId] = values;
      withdrawal = {
        id,
        userId,
        countryId: c,
        address: a,
        amountMicro: micro,
        coinAmount: minor,
        pricingSnapshot: JSON.parse(snapshot),
        requestKey: key,
        holdOperationId,
        createdAt: new Date(),
        status: 'HELD',
      };
      return [withdrawal];
    }
    return [];
  });
});
it('allocates an invoice with the exact saved ETB amount and a bounded payment window', async () => {
  const result = await createDeposit('member', { countryId, rateId, amount: '10', idempotencyKey });
  expect(result).toMatchObject({
    currency: 'ETB',
    minorDigits: 2,
    coinAmount: 182163,
    amount: '10.000000',
  });
  expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(900000);
  expect(m.gate).toHaveBeenCalledWith(m.db, 'CRYPTO_DEPOSIT_CREDIT');
});
it('replays the same invoice after repricing without allocating or repricing again', async () => {
  const body = { countryId, rateId, amount: '10', idempotencyKey };
  const first = await createDeposit('member', body);
  m.rate.mockRejectedValue(Error('New reference unavailable'));
  expect(await createDeposit('member', body)).toEqual(first);
  expect(allocationCount).toBe(1);
  await expect(createDeposit('member', { ...body, rateId: countryId })).rejects.toThrow(
    /different/
  );
});
it('requires the reviewed rate before allocating an address', async () => {
  await expect(
    createDeposit('member', { countryId, rateId: countryId, amount: '10', idempotencyKey })
  ).rejects.toThrow(/rate changed/);
  expect(allocationCount).toBe(0);
  expect(stored).toBeUndefined();
});
it('holds exactly the requested ETB santim and snapshots the USDT payout', async () => {
  const result = await createWithdrawal('member', 1, {
    countryId,
    rateId,
    coinAmount: 500029,
    address,
    idempotencyKey,
  });
  expect(m.hold).toHaveBeenCalledWith(m.db, 'member', 500029, expect.anything());
  expect(m.limits).toHaveBeenCalledWith(
    m.db,
    'member',
    500029,
    expect.anything(),
    expect.any(Date)
  );
  expect(result).toMatchObject({ coinAmount: 500029, amount: '27.449419', currency: 'ETB' });
});
