import type { Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/api-error.js';
import { parseUsdPolicy, priceUsdPayment } from './usd-pricing.js';
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
/** Account first, then order: matches disable's account -> affected-orders lock order. */
export async function lockDepositReceivingAccount(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw`SELECT a.id FROM agent_payment_accounts a
    JOIN agent_orders o ON o."paymentAccountId"=a.id WHERE o.id=${orderId} FOR SHARE OF a`;
}

/** Safety is independent from approval, dispute assignment and provider evidence. */
export async function assertDepositSafetyClear(tx: Prisma.TransactionClient, orderId: string) {
  const [state] = await tx.$queryRaw<{ blocked: boolean }[]>`
    SELECT (o."safetyHold" OR a."safetyHold" OR a.status='DISABLED') AS blocked
    FROM agent_orders o JOIN agent_payment_accounts a ON a.id=o."paymentAccountId"
    WHERE o.id=${orderId} FOR SHARE OF a`;
  if (!state || state.blocked !== false) throw ApiError.conflict('Order is on safety hold; resolution requires a separately approved policy');
}

export async function assertDepositReady(
  tx: Prisma.TransactionClient,
  order: {
    countryId: string;
    agentId: string;
    safetyHold?: boolean;
    paymentAccountRevision?: number | null;
    paymentSnapshot?: unknown;
    paymentAccountId: string;
    paymentMethodDefId: string;
    exchangeRateConfigId: string;
    fiatCurrency: string;
    pricingSnapshot: unknown;
    createdAt: Date;
    paymentSubmittedAt?: Date | null;
    status?: string;
    fiatAmount?: number;
    coinAmount?: number;
  },
  phase: 'submission' | 'settlement' = 'submission'
) {
  if (order.safetyHold) throw ApiError.conflict('Order is on safety hold; contact payment support');
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
    { status: string; safetyHold: boolean; agentId: string; countryId: string; methodDefId: string }[]
  >`
    SELECT status::text,"safetyHold","agentId","countryId","methodDefId" FROM agent_payment_accounts WHERE id=${order.paymentAccountId} FOR SHARE`;
  const [method] = await tx.$queryRaw<{ isActive: boolean; countryId: string }[]>`
    SELECT "isActive","countryId" FROM payment_method_definitions WHERE id=${order.paymentMethodDefId} FOR SHARE`;
  if (
    agent?.status !== 'ACTIVE' ||
    agent.userStatus !== 'ACTIVE' ||
    agent.countryId !== order.countryId ||
    !country?.isActive ||
    !country.agentPaymentEnabled ||
    !country.usdPricingEnabled ||
    country.currencyCode !== order.fiatCurrency ||
    !account || account.safetyHold || account.status === 'DISABLED' ||
    account.agentId !== order.agentId ||
    !method?.isActive ||
    method.countryId !== order.countryId
  ) {
    throw ApiError.conflict(
      'Payment configuration changed. Do not send money; contact payment support if you already paid.'
    );
  }
  if (order.paymentAccountRevision != null) {
    const [revision] = await tx.$queryRaw<{ matches: boolean }[]>`
      SELECT ("agentId"=${order.agentId} AND "countryId"=${order.countryId}
        AND "methodDefId"=${order.paymentMethodDefId}
        AND "accountDetails"=${JSON.stringify(order.paymentSnapshot)}::jsonb) AS matches
      FROM agent_payment_account_revisions
      WHERE "accountId"=${order.paymentAccountId} AND revision=${order.paymentAccountRevision}`;
    if (!revision?.matches) throw ApiError.conflict('Approved destination revision could not be verified');
  }
  // Rate-row activation controls NEW quotes only. Publishing a replacement
  // deactivates that row but must preserve already-promised immutable terms.
  // Settlement validates the locked terms at acceptance, not today's rate.
  // Submission still checks the live payment deadline using database time.
  let pricingAt = await depositClock(tx);
  if (phase === 'settlement') {
    const submitted = order.paymentSubmittedAt;
    if (order.status !== 'PAYMENT_SUBMITTED' || !submitted ||
        !Number.isFinite(submitted.getTime()) || submitted < order.createdAt ||
        submitted >= depositEntryDeadline(order) || submitted > pricingAt) {
      throw ApiError.conflict('Payment submission is outside the accepted window; open a deposit dispute for staff review');
    }
    pricingAt = order.createdAt;
  }
  const snapshot = order.pricingSnapshot as { version?: string } | null;
  if (snapshot?.version === 'USD_V1' || snapshot?.version === 'ETB_V1') {
    // Price snapshots also contain derived values; pick policy keys only.
    const p = snapshot as any;
    try {
      const policy = parseUsdPolicy(
        Object.fromEntries(
          [
            'version',
            ...(snapshot.version === 'ETB_V1' ? ['walletCurrency'] : ['coinsPerUsd']),
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
        pricingAt
      );
      if (phase === 'settlement') {
        const price = priceUsdPayment(policy, 'deposit', order.fiatAmount!);
        if (price.coinAmount !== order.coinAmount) {
          throw ApiError.conflict('Locked payment amount does not match');
        }
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      throw ApiError.conflict('Locked payment terms are invalid; open a deposit dispute for staff review');
    }
  } else throw ApiError.conflict('Legacy payment terms require staff review');
}
