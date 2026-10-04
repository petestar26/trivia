import { prisma, Prisma } from '@socialplay/database';
import { z } from 'zod';
import { ApiError } from '../middleware/index.js';
import { assertPlatformAdmin } from './agent-service.js';
import { parseUsdPolicy, packageUsdDisplay } from './usd-pricing.js';

export async function selectPaymentRate(
  db: Pick<Prisma.TransactionClient, 'exchangeRateConfig'>,
  country: { id: string; currencyCode: string; usdPricingEnabled: boolean }
) {
  const rate = await db.exchangeRateConfig.findFirst({
    where: {
      countryId: country.id,
      fiatCurrency: country.currencyCode,
      effectiveAt: { lte: new Date() },
      ...(country.usdPricingEnabled
        ? { pricingPolicy: { not: Prisma.DbNull } }
        : { isActive: true }),
    },
    orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!rate || !rate.isActive)
    throw ApiError.badRequest('No active exchange rate is configured for this country/currency');
  if (country.usdPricingEnabled) parseUsdPolicy(rate.pricingPolicy);
  return rate;
}

/** Publishing activates USD pricing only, never country/payment availability. */
export async function publishUsdRate(adminId: string, countryId: string, body: unknown) {
  await assertPlatformAdmin(adminId);
  const policy = parseUsdPolicy(body);
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
    const compatibleRate = new Prisma.Decimal(96)
      .div(policy.localPerUsd)
      .div(10 ** policy.minorDigits)
      .toDecimalPlaces(6);
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

const packageSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    coinAmount: z.number().int().min(1).max(1000000000),
    isActive: z.boolean(),
    displayOrder: z.number().int().min(0).max(10000),
    featured: z.boolean(),
  })
  .strict();

export async function saveCoinPackage(adminId: string, id: string | undefined, body: unknown) {
  await assertPlatformAdmin(adminId);
  const parsed = packageSchema.safeParse(body);
  if (!parsed.success)
    throw ApiError.badRequest('Invalid Coin package; USD price is derived from 96 Coins per USD');
  return prisma.$transaction(async (tx) => {
    const before = id ? await tx.coinPackage.findUnique({ where: { id } }) : null;
    if (id && !before) throw ApiError.notFound('Coin package not found');
    const row = id
      ? await tx.coinPackage.update({ where: { id }, data: parsed.data })
      : await tx.coinPackage.create({ data: parsed.data });
    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'PAYMENT_PACKAGE_SAVED',
        entity: 'CoinPackage',
        entityId: row.id,
        newData: parsed.data,
        ...(before
          ? {
              oldData: {
                name: before.name,
                coinAmount: before.coinAmount,
                isActive: before.isActive,
              },
            }
          : {}),
      },
    });
    return { ...row, usdDisplay: packageUsdDisplay(row.coinAmount) };
  });
}

export async function listCoinPackages(includeInactive = false) {
  const rows = await prisma.coinPackage.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => ({ ...row, usdDisplay: packageUsdDisplay(row.coinAmount) }));
}
