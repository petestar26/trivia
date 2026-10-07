import type { Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/index.js';
import { parseUsdPolicy } from './usd-pricing.js';
export const DEPOSIT_ENTRY_MS = 15 * 60 * 1000;
export const MAX_PENDING_DEPOSITS = 3;
export function depositEntryDeadline(order: { createdAt: Date; pricingSnapshot: unknown }): Date {
  const expires = (order.pricingSnapshot as { expiresAt?: unknown } | null)?.expiresAt;
  const rateDeadline = typeof expires === 'string' ? Date.parse(expires) : Infinity;
  return new Date(
    Math.min(
      order.createdAt.getTime() + DEPOSIT_ENTRY_MS,
      Number.isFinite(rateDeadline) ? rateDeadline : Infinity
    )
  );
}
export async function depositClock(tx: Prisma.TransactionClient): Promise<Date> {
  return (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
}
export async function assertDepositReady(
  tx: Prisma.TransactionClient,
  order: {
    countryId: string;
    agentId: string;
    paymentAccountId: string;
    paymentMethodDefId: string;
    exchangeRateConfigId: string;
    fiatCurrency: string;
    pricingSnapshot: unknown;
  }
) {
  const [agent] = await tx.$queryRaw<{ status: string; userStatus: string; countryId: string }[]>`
    SELECT a.status::text, u.status::text AS "userStatus", a."countryId"
    FROM agents a JOIN users u ON u.id=a."userId" WHERE a.id=${order.agentId} FOR SHARE OF a,u`;
  const [country] = await tx.$queryRaw<
    {
      isActive: boolean;
      agentPaymentEnabled: boolean;
      usdPricingEnabled: boolean;
      currencyCode: string;
    }[]
  >`
    SELECT "isActive","agentPaymentEnabled","usdPricingEnabled","currencyCode" FROM countries WHERE id=${order.countryId} FOR SHARE`;
  const [account] = await tx.$queryRaw<
    { status: string; agentId: string; countryId: string; methodDefId: string }[]
  >`
    SELECT status::text,"agentId","countryId","methodDefId" FROM agent_payment_accounts WHERE id=${order.paymentAccountId} FOR SHARE`;
  const [method] = await tx.$queryRaw<{ isActive: boolean; countryId: string }[]>`
    SELECT "isActive","countryId" FROM payment_method_definitions WHERE id=${order.paymentMethodDefId} FOR SHARE`;
  const [rate] = await tx.$queryRaw<{ isActive: boolean }[]>`
    SELECT "isActive" FROM exchange_rate_configs WHERE id=${order.exchangeRateConfigId} FOR SHARE`;
  if (
    agent?.status !== 'ACTIVE' ||
    agent.userStatus !== 'ACTIVE' ||
    agent.countryId !== order.countryId ||
    !country?.isActive ||
    !country.agentPaymentEnabled ||
    !country.usdPricingEnabled ||
    country.currencyCode !== order.fiatCurrency ||
    account?.status !== 'APPROVED' ||
    account.agentId !== order.agentId ||
    account.countryId !== order.countryId ||
    account.methodDefId !== order.paymentMethodDefId ||
    !method?.isActive ||
    method.countryId !== order.countryId ||
    !rate?.isActive
  ) {
    throw ApiError.conflict(
      'Payment configuration changed. Do not send money; contact payment support if you already paid.'
    );
  }
  // Validate the original immutable terms, never reprice an existing order.
  const snapshot = order.pricingSnapshot as { version?: string } | null;
  if (snapshot?.version === 'USD_V1') {
    // Price snapshots also contain derived values; pick policy keys only.
    const p = snapshot as any;
    parseUsdPolicy(
      Object.fromEntries(
        [
          'version',
          'coinsPerUsd',
          'localPerUsd',
          'minorDigits',
          'source',
          'observedAt',
          'expiresAt',
          'p2pDepositMinUsdCents',
          'p2pWithdrawalAboveUsdCents',
          'cryptoDepositMinUsdCents',
          'cryptoWithdrawalAboveUsdCents',
          'feeMinor',
        ].map((k) => [k, p[k]])
      ),
      await depositClock(tx)
    );
  } else throw ApiError.conflict('Legacy payment terms require staff review');
}
