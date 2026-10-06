import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  country: { findUnique: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  exchangeRateConfig: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock('@socialplay/database', async (original) => ({
  ...(await original<typeof import('@socialplay/database')>()),
  prisma: m,
}));
import { setCountryFlags, createExchangeRate } from './config-service.js';
import { selectPaymentRate } from './usd-config-service.js';
const country = {
  id: 'et',
  currencyCode: 'ETB',
  isActive: true,
  agentPaymentEnabled: false,
  usdPricingEnabled: true,
};
function policy() {
  return {
    version: 'USD_V1',
    coinsPerUsd: 96,
    localPerUsd: '150',
    minorDigits: 2,
    source: 'Disposable fixture',
    observedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    p2pDepositMinUsdCents: 200,
    p2pWithdrawalAboveUsdCents: 400,
    cryptoDepositMinUsdCents: 1000,
    cryptoWithdrawalAboveUsdCents: 2000,
    feeMinor: 0,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  m.$transaction.mockImplementation((fn) => fn(m));
  m.user.findUnique.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE' });
  m.country.findUnique.mockResolvedValue(country);
  m.country.update.mockResolvedValue({ ...country, agentPaymentEnabled: true });
  const rate = { id: 'r', isActive: true, pricingPolicy: policy() };
  m.exchangeRateConfig.findFirst.mockResolvedValue(rate);
  m.exchangeRateConfig.findUniqueOrThrow.mockResolvedValue(rate);
  m.$queryRaw.mockResolvedValue([{ id: 'approved-destination' }]);
});
it('rejects legacy pricing before reading a rate', async () => {
  await expect(
    selectPaymentRate(m as any, { ...country, usdPricingEnabled: false })
  ).rejects.toThrow(/USD pricing/);
  expect(m.exchangeRateConfig.findFirst).not.toHaveBeenCalled();
});
it.each([
  { ...country, isActive: false },
  { ...country, usdPricingEnabled: false },
])('cannot activate an unready country %j', async (c) => {
  m.country.findUnique.mockResolvedValue(c);
  await expect(setCountryFlags('admin', 'et', { agentPaymentEnabled: true })).rejects.toThrow();
  expect(m.country.update).not.toHaveBeenCalled();
  expect(m.auditLog.create).not.toHaveBeenCalled();
});
it('rejects missing, disabled, expired and malformed rates without writes', async () => {
  for (const rate of [
    null,
    { isActive: false },
    { isActive: true, pricingPolicy: null },
    { isActive: true, pricingPolicy: { ...policy(), expiresAt: new Date(0).toISOString() } },
  ]) {
    m.exchangeRateConfig.findFirst.mockResolvedValue(rate);
    await expect(setCountryFlags('admin', 'et', { agentPaymentEnabled: true })).rejects.toThrow();
  }
  expect(m.country.update).not.toHaveBeenCalled();
});
it('requires a usable approved destination belonging to an active agent and user', async () => {
  m.$queryRaw.mockResolvedValue([]);
  await expect(setCountryFlags('admin', 'et', { agentPaymentEnabled: true })).rejects.toThrow(
    /approved receiving account/
  );
  expect(m.country.update).not.toHaveBeenCalled();
});
it('rechecks rate validity after acquiring its lock', async () => {
  m.exchangeRateConfig.findUniqueOrThrow.mockResolvedValue({ isActive: false });
  await expect(setCountryFlags('admin', 'et', { agentPaymentEnabled: true })).rejects.toThrow(
    /current USD rate/
  );
  expect(m.country.update).not.toHaveBeenCalled();
});
it('allows configured activation and always permits pausing', async () => {
  await setCountryFlags('admin', 'et', { agentPaymentEnabled: true });
  expect(m.auditLog.create).toHaveBeenCalledTimes(1);
  m.country.findUnique.mockResolvedValue({ ...country, isActive: false, usdPricingEnabled: false });
  m.exchangeRateConfig.findFirst.mockRejectedValue(new Error('must not read a rate while pausing'));
  await setCountryFlags('admin', 'et', { agentPaymentEnabled: false });
  expect(m.auditLog.create).toHaveBeenCalledTimes(2);
});
it('closes legacy rate creation without creating a row', async () => {
  await expect(
    createExchangeRate('admin', { countryId: 'et', fiatCurrency: 'ETB', coinsPerUnit: 1 })
  ).rejects.toThrow(/Legacy/);
  expect(m.exchangeRateConfig.create).not.toHaveBeenCalled();
});
