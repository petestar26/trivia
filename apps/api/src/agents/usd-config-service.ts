import { prisma, Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/index.js';
import { assertPlatformAdmin } from './agent-service.js';
import { parseUsdPolicy } from './usd-pricing.js';

export async function selectPaymentRate(
  db: Pick<Prisma.TransactionClient, 'exchangeRateConfig'>,
  country: { id: string; currencyCode: string; usdPricingEnabled: boolean }
) {
  if (!country.usdPricingEnabled) {
    throw ApiError.badRequest('USD pricing must be configured before accepting payments');
  }
  const rate = await db.exchangeRateConfig.findFirst({
    where: {
      countryId: country.id,
      fiatCurrency: country.currencyCode,
      effectiveAt: { lte: new Date() },
      pricingPolicy: { not: Prisma.DbNull },
    },
    orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!rate || !rate.isActive)
    throw ApiError.badRequest('No active exchange rate is configured for this country/currency');
  const policy = parseUsdPolicy(rate.pricingPolicy);
  if (policy.version !== 'ETB_V1' || country.currencyCode !== 'ETB')
    throw ApiError.badRequest('Payments require an ETB wallet quote');
  return rate;
}

/** Publishing activates USD pricing only, never country/payment availability. */
export async function publishUsdRate(adminId: string, countryId: string, body: unknown) {
  await assertPlatformAdmin(adminId);
  const policy = parseUsdPolicy(body);
  if (policy.version !== 'ETB_V1') throw ApiError.badRequest('Only ETB wallet pricing is supported');
  return prisma.$transaction(async (tx) => {
    const [country] = await tx.$queryRaw<Array<{ currencyCode: string }>>`
      SELECT "currencyCode" FROM countries WHERE id=${countryId} FOR UPDATE`;
    if (!country) throw ApiError.notFound('Country not found');
    const digits = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: country.currencyCode,
    }).resolvedOptions().maximumFractionDigits;
    if (policy.minorDigits !== digits)
      throw ApiError.badRequest('Currency minor-unit precision does not match its ISO currency');
    if (country.currencyCode === 'USD' && !new Prisma.Decimal(policy.localPerUsd).eq(1))
      throw ApiError.badRequest('USD settlement rate must equal 1');
    // Compatibility field only. Exact new arithmetic always uses pricingPolicy.
    if (country.currencyCode !== 'ETB') throw ApiError.badRequest('Wallet currency must be ETB');
    const compatibleRate = new Prisma.Decimal(1);
    if (compatibleRate.lte(0))
      throw ApiError.badRequest('Rate is outside supported currency precision');
    const rate = await tx.exchangeRateConfig.create({
      data: {
        countryId,
        fiatCurrency: country.currencyCode,
        coinsPerUnit: compatibleRate,
        pricingPolicy: policy,
        setBy: adminId,
      },
    });
    await tx.country.update({ where: { id: countryId }, data: { usdPricingEnabled: true } });
    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'PAYMENT_USD_RATE_PUBLISHED',
        entity: 'ExchangeRateConfig',
        entityId: rate.id,
        newData: policy,
      },
    });
    return rate;
  });
}

/** Compatibility routes for clients upgrading from token bundles. */
export async function saveCoinPackage(adminId: string, _id: string | undefined, _body: unknown) {
  await assertPlatformAdmin(adminId);
  throw ApiError.badRequest('This wallet uses ETB directly. Deposit an amount instead of buying a bundle.');
}
export async function listCoinPackages(_includeInactive = false) { return []; }
