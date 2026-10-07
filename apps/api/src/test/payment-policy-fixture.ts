import { Prisma } from '@socialplay/database';
/** Synthetic ETB quotes preserve the lifecycle fixtures' original Coin/minor-unit ratio.
 * They carry the real USD minimums, expiry and snapshot rules. Never use as live FX data.
 */
export function fixtureUsdPolicy(coinsPerMinorUnit: number) {
  return {
    version: 'USD_V1',
    coinsPerUsd: 96,
    localPerUsd: new Prisma.Decimal('0.96').div(coinsPerMinorUnit).toFixed(),
    minorDigits: 2,
    source: 'Disposable lifecycle fixture, not a market rate',
    observedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    p2pDepositMinUsdCents: 200,
    p2pWithdrawalAboveUsdCents: 400,
    cryptoDepositMinUsdCents: 1000,
    cryptoWithdrawalAboveUsdCents: 2000,
    feeMinor: 0,
  };
}
