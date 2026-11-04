import { beforeEach, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({
  db: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    country: { findUnique: vi.fn(), update: vi.fn() },
    exchangeRateConfig: { findFirst: vi.fn(), create: vi.fn() },
  },
  fetch: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: m.db }));
vi.mock('./etb-reference.js', async (original) => ({
  ...(await original<typeof import('./etb-reference.js')>()),
  fetchEtbReference: m.fetch,
}));
import { refreshEtbRate, etbRateView } from './etb-rate-service.js';
const reference = () => ({
  localPerUsd: '182.16377894',
  observedAt: new Date(Date.now() - 1000).toISOString(),
  expiresAt: new Date(Date.now() + 1700000).toISOString(),
});
beforeEach(() => {
  vi.resetAllMocks();
  m.db.$transaction.mockImplementation((fn) => fn(m.db));
  m.db.$queryRaw.mockResolvedValue([{ id: true }]);
  m.db.country.findUnique.mockResolvedValue({ id: 'et', currencyCode: 'ETB' });
  m.db.exchangeRateConfig.findFirst.mockResolvedValue(null);
  m.fetch.mockResolvedValue(reference());
});
it('does not call the provider without the shared refresh lease', async () => {
  m.db.$queryRaw.mockResolvedValue([]);
  await refreshEtbRate();
  expect(m.fetch).not.toHaveBeenCalled();
  expect(m.db.exchangeRateConfig.create).not.toHaveBeenCalled();
});
it('publishes an ETB rate without activating payments or adding funds', async () => {
  await refreshEtbRate();
  expect(m.db.exchangeRateConfig.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      fiatCurrency: 'ETB',
      coinsPerUnit: 1,
      pricingPolicy: expect.objectContaining({
        version: 'ETB_V1',
        walletCurrency: 'ETB',
        localPerUsd: '182.16377894',
      }),
    }),
  });
  expect(m.db.country.update).toHaveBeenCalledWith({
    where: { id: 'et' },
    data: { usdPricingEnabled: true },
  });
});
it('does not create or extend rates when the source fails', async () => {
  m.fetch.mockRejectedValue(Error('Unavailable'));
  await refreshEtbRate();
  expect(m.db.exchangeRateConfig.create).not.toHaveBeenCalled();
  expect(m.db.country.update).not.toHaveBeenCalled();
  expect(m.db.$executeRaw.mock.calls[0][0].join('')).toContain("status='UNAVAILABLE'");
});
it('returns only fresh native ETB terms and rejects disabled or expired reference data', async () => {
  const pricingPolicy = {
    version: 'ETB_V1',
    walletCurrency: 'ETB',
    minorDigits: 2,
    ...reference(),
    source: 'https://ethioblackmarket.com/',
    p2pDepositMinUsdCents: 200,
    p2pWithdrawalAboveUsdCents: 400,
    cryptoDepositMinUsdCents: 1000,
    cryptoWithdrawalAboveUsdCents: 2000,
    feeMinor: 0,
  };
  m.db.exchangeRateConfig.findFirst.mockResolvedValue({
    id: 'rate',
    isActive: true,
    pricingPolicy,
  });
  expect(await etbRateView()).toMatchObject({
    available: true,
    rateId: 'rate',
    walletCurrency: 'ETB',
    usdtPerUsd: '1',
  });
  for (const row of [
    null,
    { isActive: false, pricingPolicy },
    { isActive: true, pricingPolicy: { ...pricingPolicy, expiresAt: new Date(0).toISOString() } },
  ]) {
    m.db.exchangeRateConfig.findFirst.mockResolvedValue(row);
    expect(await etbRateView()).toMatchObject({ available: false });
  }
});
