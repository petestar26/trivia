import Fastify from 'fastify';
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
vi.mock('../middleware/index.js', async (original) => ({
  ...(await original<typeof import('../middleware/index.js')>()),
  authenticate: async (request: any) => { request.user = { sub: 'admin', roles: ['ADMIN'] }; },
}));
import { agentConfigRoutes } from './config-routes.js';
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

it.each([
  { isActive: true, currencyCode: 'USD' },
  {
    isActive: true,
    agentPaymentAccounts: { updateMany: { where: {}, data: { status: 'APPROVED' } } },
  },
  {
    isActive: true,
    agents: { update: { where: { id: 'a' }, data: { user: { update: { role: 'SUPER_ADMIN' } } } } },
  },
  { isActive: 'true' },
  { agentPaymentEnabled: 1 },
])('rejects non-whitelisted country fields before any transaction: %j', async (payload) => {
  await expect(setCountryFlags('admin', 'et', payload as any)).rejects.toMatchObject({
    statusCode: 400,
  });
  expect(m.$transaction).not.toHaveBeenCalled();
  expect(m.country.update).not.toHaveBeenCalled();
  expect(m.auditLog.create).not.toHaveBeenCalled();
});
it('writes only the explicitly supplied country flags', async () => {
  await setCountryFlags('admin', 'et', { agentPaymentEnabled: false });
  expect(m.country.update).toHaveBeenCalledWith({
    where: { id: 'et' },
    data: { agentPaymentEnabled: false },
  });
});

it('HTTP country PATCH rejects combined nested writes without transaction or audit', async () => {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.status(error.statusCode ?? 500).send({ message: error.message }));
  await app.register(agentConfigRoutes, { prefix: '/agent-config' });
  try {
    const response = await app.inject({ method: 'PATCH', url: '/agent-config/countries/et', payload: {
      isActive: true, currencyCode: 'USD',
      agentPaymentAccounts: { updateMany: { where: {}, data: { status: 'APPROVED' } } },
      agents: { update: { where: { id: 'a' }, data: { user: { update: { role: 'SUPER_ADMIN' } } } } },
    } });
    expect(response.statusCode).toBe(400);
    expect(m.$transaction).not.toHaveBeenCalled();
    expect(m.country.update).not.toHaveBeenCalled();
    expect(m.auditLog.create).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
