import { prisma, Prisma } from '@socialplay/database';
import { createHash } from 'node:crypto';
import { ApiError } from '../middleware';

// W-1B Task A: withdrawal quote service.
//
// A quote is a server-authoritative, persisted price lock — see
// WithdrawalQuote in schema.prisma (W-1A2). It is NOT a wallet hold and
// does not reserve AgentFiatLiquidity; it only fixes the coin/fiat/rate
// numbers a Withdrawal will later be created from (withdrawal-service.ts).
// The client supplies countryId and coinAmount only — it can never
// supply the rate, fee, or resulting fiat amount as authoritative values;
// every number below is computed here from the active ExchangeRateConfig,
// mirroring order-service.ts's exact rate-selection pattern.

// Policy constants (application-level, not schema-derived — see the W-1B
// report for the reasoning: no WithdrawalConfig table exists yet, and a
// hardcoded, documented bound is a safe, easily-revisited service-layer
// decision, not a structural gap).
const MIN_WITHDRAWAL_COINS = 100;
const MAX_WITHDRAWAL_COINS = 1_000_000_000; // matches wallet-service.ts's MAX_BALANCE ceiling
const QUOTE_TTL_SECONDS = 300; // matches the SecurityChallenge/StepUpVerification precedent (W-0)

export interface CreateWithdrawalQuoteArgs {
  countryId: string;
  coinAmount: number;
}

function validateArgs(args: CreateWithdrawalQuoteArgs) {
  if (!args.countryId || typeof args.countryId !== 'string') {
    throw ApiError.badRequest('countryId is required');
  }
  if (!Number.isInteger(args.coinAmount) || args.coinAmount <= 0) {
    throw ApiError.badRequest('coinAmount must be a positive integer');
  }
  if (args.coinAmount < MIN_WITHDRAWAL_COINS) {
    throw ApiError.badRequest(`coinAmount is below the minimum withdrawal amount (${MIN_WITHDRAWAL_COINS})`);
  }
  if (args.coinAmount > MAX_WITHDRAWAL_COINS) {
    throw ApiError.badRequest(`coinAmount exceeds the maximum withdrawal amount (${MAX_WITHDRAWAL_COINS})`);
  }
}

/**
 * Hash of a quote's own canonical creation inputs — purely for
 * traceability/support use, distinct from Withdrawal.requestHash (which
 * hashes quoteId+payoutAccountId at withdrawal-creation time and IS the
 * field idempotency conflicts are compared against — see
 * withdrawal-service.ts). WithdrawalQuote.requestHash deliberately has no
 * unique constraint and no idempotency role of its own: a quote is a
 * cheap, expiring, non-mutating "get me a fresh price" read, so repeated
 * identical requests should each get their own row, not be deduplicated.
 */
function computeQuoteRequestHash(userId: string, countryId: string, coinAmount: number): string {
  return createHash('sha256').update(`${userId}:${countryId}:${coinAmount}`).digest('hex');
}

/**
 * Creates a server-priced, persisted withdrawal quote for the authenticated
 * caller. Identity is always actorUserId — never accepted from the request
 * body. fiatAmount is computed here via Decimal arithmetic (no JS floating
 * point) and floored — the same direction AgentOrder's coinAmount floors
 * in, so the platform never pays out more fiat than the rate strictly
 * allows for the given coinAmount.
 */
export async function createWithdrawalQuote(
  actorUserId: string,
  args: CreateWithdrawalQuoteArgs
): Promise<{
  id: string;
  userId: string;
  countryId: string;
  fiatCurrency: string;
  coinAmount: number;
  fiatAmount: bigint;
  exchangeRateConfigId: string;
  exchangeRateValue: Prisma.Decimal;
  expiresAt: Date;
  createdAt: Date;
}> {
  validateArgs(args);

  const country = await prisma.country.findUnique({ where: { id: args.countryId } });
  if (!country) throw ApiError.badRequest('Invalid country');
  if (!country.isActive || !country.agentPaymentEnabled) {
    throw ApiError.badRequest('Withdrawals are not available for this country');
  }
  const fiatCurrency = country.currencyCode;

  // Same deterministic selection as order-service.ts's rate lookup:
  // country + fiatCurrency + isActive=true + effectiveAt <= now, ordered
  // by effectiveAt DESC, take 1. Copied into the quote and never re-read.
  const rateConfig = await prisma.exchangeRateConfig.findFirst({
    where: { countryId: args.countryId, fiatCurrency, isActive: true, effectiveAt: { lte: new Date() } },
    orderBy: { effectiveAt: 'desc' },
  });
  if (!rateConfig) {
    throw ApiError.badRequest('No active exchange rate is configured for this country/currency');
  }

  // Inverse of AgentOrder's coinAmount = floor(fiatAmount * coinsPerUnit):
  // fiatAmount = floor(coinAmount / coinsPerUnit). Flooring here means the
  // user receives slightly less fiat than the exact rate would give for a
  // fractional remainder — the platform-favoring direction, consistent
  // with AgentOrder's own floor().
  const fiatAmountDecimal = new Prisma.Decimal(args.coinAmount).div(rateConfig.coinsPerUnit).floor();
  const fiatAmount = BigInt(fiatAmountDecimal.toFixed(0));
  if (fiatAmount <= 0n) {
    throw ApiError.badRequest('Computed fiat amount must be positive');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000);
  const requestHash = computeQuoteRequestHash(actorUserId, args.countryId, args.coinAmount);

  const quote = await prisma.withdrawalQuote.create({
    data: {
      userId: actorUserId,
      countryId: args.countryId,
      fiatCurrency,
      coinAmount: args.coinAmount,
      fiatAmount,
      exchangeRateConfigId: rateConfig.id,
      exchangeRateValue: rateConfig.coinsPerUnit,
      requestHash,
      status: 'ACTIVE',
      expiresAt,
    },
  });

  return quote;
}

/**
 * Read-only lookup used by withdrawal-service.ts's pre-flight checks.
 * Ownership is enforced here, not left to the caller: throws
 * ApiError.badRequest when the quote doesn't exist, and ApiError.forbidden
 * when it exists but belongs to a different user.
 */
export async function getOwnWithdrawalQuote(actorUserId: string, quoteId: string) {
  const quote = await prisma.withdrawalQuote.findUnique({ where: { id: quoteId } });
  if (!quote) throw ApiError.badRequest('Invalid quote');
  if (quote.userId !== actorUserId) throw ApiError.forbidden('This quote does not belong to you');
  return quote;
}

export async function listOwnWithdrawalQuotes(actorUserId: string, limit = 20) {
  return prisma.withdrawalQuote.findMany({
    where: { userId: actorUserId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
