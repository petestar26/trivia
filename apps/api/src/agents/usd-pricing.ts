import { z } from 'zod';
import { ApiError } from '../middleware/api-error.js';

// Decimal strings are converted to scaled integers before any arithmetic.
// Never divide through IEEE-754 or round a USD display price back into Coins.
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/);
export const usdPolicySchema = z
  .object({
    version: z.literal('USD_V1'),
    coinsPerUsd: z.literal(96),
    localPerUsd: decimal.refine((v) => BigInt(v.replace('.', '')) > 0n),
    minorDigits: z.number().int().min(0).max(4),
    source: z.string().trim().min(3).max(200),
    observedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    p2pDepositMinUsdCents: z.number().int().min(200).max(100000000),
    p2pWithdrawalAboveUsdCents: z.number().int().min(400).max(100000000),
    cryptoDepositMinUsdCents: z.number().int().min(1000).max(100000000),
    cryptoWithdrawalAboveUsdCents: z.number().int().min(2000).max(100000000),
    feeMinor: z.literal(0),
  })
  .strict();
export type UsdPolicy = z.infer<typeof usdPolicySchema>;

export function parseUsdPolicy(value: unknown, now = new Date()): UsdPolicy {
  const result = usdPolicySchema.safeParse(value);
  if (!result.success) throw ApiError.badRequest('Invalid USD pricing configuration');
  const policy = result.data;
  const observed = Date.parse(policy.observedAt),
    expires = Date.parse(policy.expiresAt);
  if (
    observed > now.getTime() ||
    expires <= now.getTime() ||
    expires <= observed ||
    expires - observed > 86400000
  ) {
    throw ApiError.badRequest(
      'Exchange rate is stale or has an invalid observation window; request a fresh rate'
    );
  }
  return policy;
}

function rateFraction(p: UsdPolicy) {
  const [whole, fraction = ''] = p.localPerUsd.split('.');
  return { numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length) };
}
function whole(value: number, max: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max)
    throw ApiError.badRequest('Invalid payment amount');
  return BigInt(value);
}

export function priceUsdPayment(
  policy: UsdPolicy,
  direction: 'deposit' | 'withdrawal',
  amount: number
) {
  const rate = rateFraction(policy),
    minorScale = 10n ** BigInt(policy.minorDigits);
  let fiatMinor: bigint, coins: bigint, usdNumerator: bigint, usdDenominator: bigint;
  if (direction === 'deposit') {
    fiatMinor = whole(amount, 2147483647);
    usdNumerator = fiatMinor * rate.denominator;
    usdDenominator = minorScale * rate.numerator;
    if (usdNumerator * 100n < BigInt(policy.p2pDepositMinUsdCents) * usdDenominator) {
      throw ApiError.badRequest(
        `Minimum P2P deposit is USD ${(policy.p2pDepositMinUsdCents / 100).toFixed(2)}`
      );
    }
    coins = (usdNumerator * BigInt(policy.coinsPerUsd)) / usdDenominator;
  } else {
    coins = whole(amount, 1000000000);
    usdNumerator = coins;
    usdDenominator = BigInt(policy.coinsPerUsd);
    if (usdNumerator * 100n <= BigInt(policy.p2pWithdrawalAboveUsdCents) * usdDenominator) {
      throw ApiError.badRequest(
        `P2P withdrawal must exceed USD ${(policy.p2pWithdrawalAboveUsdCents / 100).toFixed(2)}`
      );
    }
    fiatMinor =
      (coins * rate.numerator * minorScale) / (BigInt(policy.coinsPerUsd) * rate.denominator);
  }
  if (coins <= 0n || coins > 1000000000n || fiatMinor <= 0n || fiatMinor > 9223372036854775807n) {
    throw ApiError.badRequest('Computed payment amount is outside supported limits');
  }
  return {
    coinAmount: Number(coins),
    fiatAmount: fiatMinor,
    snapshot: {
      ...policy,
      direction,
      usdNumerator: usdNumerator.toString(),
      usdDenominator: usdDenominator.toString(),
      coinAmount: Number(coins),
      fiatMinor: fiatMinor.toString(),
      rounding: 'FLOOR',
    },
  };
}

export function packageUsdDisplay(coins: number): string {
  const n = whole(coins, 1000000000);
  const cents = (n * 100n + 48n) / 96n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
