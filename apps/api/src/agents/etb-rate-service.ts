import { prisma } from '@socialplay/database';
import { ETB_REFERENCE_SOURCE, ETB_REFRESH_MS, fetchEtbReference } from './etb-reference.js';
import { parseUsdPolicy } from './usd-pricing.js';

/** One persistent lease across replicas and restarts: at most 96 requests/day. */
export async function refreshEtbRate() {
  const lease = await prisma.$queryRaw<{ id: boolean }[]>`
    UPDATE etb_reference_refresh SET "lastAttemptAt"=now()
    WHERE id=true AND ("lastAttemptAt" IS NULL OR "lastAttemptAt"<=now()-interval '15 minutes') RETURNING id`;
  if (!lease.length) return;
  try {
    const country = await prisma.country.findUnique({ where: { code: 'ET' } });
    if (!country || country.currencyCode !== 'ETB') throw Error('ETB country is not configured');
    const previous = await prisma.exchangeRateConfig.findFirst({
      where: { countryId: country.id },
      orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    const prior = previous?.pricingPolicy as { localPerUsd?: string } | null;
    const reference = await fetchEtbReference(new Date(), prior?.localPerUsd);
    const policy = parseUsdPolicy({
      version: 'ETB_V1',
      walletCurrency: 'ETB',
      minorDigits: 2,
      ...reference,
      source: ETB_REFERENCE_SOURCE,
      p2pDepositMinUsdCents: 200,
      p2pWithdrawalAboveUsdCents: 400,
      cryptoDepositMinUsdCents: 1000,
      cryptoWithdrawalAboveUsdCents: 2000,
      feeMinor: 0,
    });
    await prisma.$transaction(async (tx) => {
      await tx.exchangeRateConfig.create({
        data: {
          countryId: country.id,
          fiatCurrency: 'ETB',
          coinsPerUnit: 1,
          pricingPolicy: policy,
          setBy: 'system:ethioblackmarket-reference',
        },
      });
      await tx.country.update({ where: { id: country.id }, data: { usdPricingEnabled: true } });
      await tx.$executeRaw`UPDATE etb_reference_refresh SET status='READY',"lastSuccessAt"=now() WHERE id=true`;
    });
  } catch {
    await prisma.$executeRaw`UPDATE etb_reference_refresh SET status='UNAVAILABLE' WHERE id=true`;
    // An outage cannot extend an old quote or create a fallback rate.
  }
}

export async function etbRateView() {
  const rate = await prisma.exchangeRateConfig.findFirst({
    where: { fiatCurrency: 'ETB' },
    orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  try {
    if (!rate?.isActive) throw Error('No rate');
    const policy = parseUsdPolicy(rate.pricingPolicy);
    if (policy.version !== 'ETB_V1') throw Error('ETB rate required');
    return { available: true as const, rateId: rate.id, ...policy, usdtPerUsd: '1' as const };
  } catch {
    return {
      available: false as const,
      reason: 'A fresh ETB exchange rate is temporarily unavailable. Please try later.',
    };
  }
}

export function startEtbRateRefresh(onError: () => void) {
  const refresh = () => {
    void refreshEtbRate().catch(onError);
  };
  refresh();
  // Check the lease each minute so scheduling drift cannot skip a whole refresh.
  const timer = setInterval(refresh, Math.min(60_000, ETB_REFRESH_MS));
  timer.unref();
  return () => clearInterval(timer);
}
