import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  country: { findUnique: vi.fn() },
  agent: { findMany: vi.fn(), count: vi.fn() },
  user: { findUnique: vi.fn() },
  rate: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: m }));
vi.mock('./usd-config-service.js', () => ({ selectPaymentRate: m.rate }));
import { getPaymentSetup } from './payment-setup.js';
import { assertSuperAdmin } from './inventory-service.js';
import { cryptoPaymentCatalog } from './crypto-catalog.js';
import { ApiError } from '../middleware/api-error.js';
beforeEach(() => {
  vi.clearAllMocks();
  m.user.findUnique.mockResolvedValue({ id: 'admin', role: 'ADMIN', status: 'ACTIVE' });
  m.country.findUnique.mockResolvedValue({ id: 'et', currencyCode: 'ETB', paymentMethods: [] });
  m.agent.count.mockResolvedValue(1);
  m.agent.findMany.mockResolvedValue([
    {
      id: 'a',
      inventory: { totalBalance: 100, reservedBalance: 30 },
      fiatLiquidity: [
        { fiatCurrency: 'ETB', totalBalance: 9007199254740993n, reservedBalance: 2n },
      ],
      paymentAccounts: [
        { status: 'APPROVED', countryId: 'et', methodDef: { countryId: 'et', isActive: true } },
        { status: 'APPROVED', countryId: 'other', methodDef: { countryId: 'et', isActive: true } },
      ],
    },
  ]);
  m.rate.mockResolvedValue({ id: 'rate' });
});
it('reports unreserved balances exactly and excludes cross-country accounts', async () => {
  const value = await getPaymentSetup('admin', 'et');
  expect(value.agents[0].availableCoins).toBe(70);
  expect(value.agents[0].approvedPaymentAccounts).toBe(1);
  expect(value.agents[0].fiatLiquidity[0].availableBalance).toBe('9007199254740991');
  expect(value.rateId).toBe('rate');
  expect(() => JSON.stringify(value)).not.toThrow();
});
it('reports stale pricing as a blocker but does not hide database failures', async () => {
  m.rate.mockRejectedValue(ApiError.badRequest('Exchange rate is stale'));
  expect(await getPaymentSetup('admin', 'et')).toMatchObject({
    rateId: null,
    rateStatus: 'Exchange rate is stale',
  });
  m.rate.mockRejectedValue(new Error('database unavailable'));
  await expect(getPaymentSetup('admin', 'et')).rejects.toThrow('database unavailable');
});
it.each([
  { role: 'USER', status: 'ACTIVE' },
  { role: 'ADMIN', status: 'BANNED' },
])('rejects non-current admin authority %j', async (user) => {
  m.user.findUnique.mockResolvedValue(user);
  await expect(getPaymentSetup('admin', 'et')).rejects.toThrow();
  expect(m.country.findUnique).not.toHaveBeenCalled();
});
it('does not accept an inactive super administrator at funding boundary', async () => {
  m.user.findUnique.mockResolvedValue({ role: 'SUPER_ADMIN', status: 'SUSPENDED' });
  await expect(assertSuperAdmin('admin')).rejects.toThrow('SUPER_ADMIN');
});
it('lists five requested assets without pretending that checkout or networks are connected', () => {
  expect(cryptoPaymentCatalog.map((a) => a.symbol)).toEqual(['USDT', 'USDC', 'BTC', 'ETH', 'SOL']);
  expect(cryptoPaymentCatalog.every((a) => !a.available)).toBe(true);
  expect(JSON.stringify(cryptoPaymentCatalog)).not.toContain('address');
});
