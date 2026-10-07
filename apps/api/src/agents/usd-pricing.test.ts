import { describe, expect, it } from 'vitest';
import {
  packageUsdDisplay,
  parseUsdPolicy,
  priceUsdPayment,
  type UsdPolicy,
} from './usd-pricing.js';

const now = new Date('2026-10-04T12:00:00Z');
const policy: UsdPolicy = {
  version: 'USD_V1',
  coinsPerUsd: 96,
  localPerUsd: '150',
  minorDigits: 2,
  source: 'Verified test rate',
  observedAt: '2026-10-04T11:00:00.000Z',
  expiresAt: '2026-10-05T11:00:00.000Z',
  p2pDepositMinUsdCents: 200,
  p2pWithdrawalAboveUsdCents: 400,
  cryptoDepositMinUsdCents: 1000,
  cryptoWithdrawalAboveUsdCents: 2000,
  feeMinor: 0,
};

describe('USD payment arithmetic', () => {
  it('enforces the inclusive USD 2 deposit threshold exactly in local minor units', () => {
    expect(() => priceUsdPayment(policy, 'deposit', 29999)).toThrow(/Minimum P2P deposit/);
    expect(priceUsdPayment(policy, 'deposit', 30000)).toMatchObject({
      coinAmount: 192,
      fiatAmount: 30000n,
    });
  });
  it('enforces the exclusive USD 4 withdrawal threshold', () => {
    expect(() => priceUsdPayment(policy, 'withdrawal', 384)).toThrow(/must exceed/);
    expect(priceUsdPayment(policy, 'withdrawal', 385)).toMatchObject({
      coinAmount: 385,
      fiatAmount: 60156n,
    });
  });
  it('keeps USD coin value stable when the local rate changes', () => {
    expect(priceUsdPayment(policy, 'deposit', 75000).coinAmount).toBe(480);
    expect(priceUsdPayment({ ...policy, localPerUsd: '155' }, 'deposit', 77500).coinAmount).toBe(
      480
    );
    expect(priceUsdPayment({ ...policy, localPerUsd: '155' }, 'withdrawal', 480).fiatAmount).toBe(
      77500n
    );
  });
  it('retains exact fractional rates without reciprocal Decimal truncation', () => {
    const p = { ...policy, localPerUsd: '183.50570001' };
    const result = priceUsdPayment(p, 'deposit', 36702);
    expect(result.coinAmount).toBe(192);
    expect(result.snapshot.usdNumerator).toBe('3670200000000');
    expect(result.snapshot.usdDenominator).toBe('1835057000100');
  });
  it('cannot profit from rounding through deposit and withdrawal', () => {
    for (const localPerUsd of ['0.12345678', '1', '150', '183.50570001', '99999.99999999']) {
      const p = { ...policy, localPerUsd };
      for (const coins of [385, 700, 1400, 3500, 999999]) {
        const payout = priceUsdPayment(p, 'withdrawal', coins).fiatAmount;
        if (payout <= 2147483647n)
          expect(priceUsdPayment(p, 'deposit', Number(payout)).coinAmount).toBeLessThanOrEqual(
            coins
          );
      }
    }
  });
  it('rejects stale, future, overly long and malformed observations', () => {
    expect(parseUsdPolicy(policy, now)).toEqual(policy);
    for (const invalid of [
      { ...policy, observedAt: '2026-10-04T13:00:00.000Z' },
      { ...policy, expiresAt: now.toISOString() },
      { ...policy, expiresAt: '2026-10-06T11:00:00.000Z' },
      { ...policy, localPerUsd: 'NaN' },
      { ...policy, localPerUsd: '0' },
      { ...policy, feeMinor: 1 },
      { ...policy, coinsPerUsd: 100 },
      { ...policy, p2pDepositMinUsdCents: 199 },
    ])
      expect(() => parseUsdPolicy(invalid, now)).toThrow();
  });
  it('derives bundle displays from the one master rate', () => {
    expect([30, 70, 350, 700, 1400, 3500].map(packageUsdDisplay)).toEqual([
      '0.31',
      '0.73',
      '3.65',
      '7.29',
      '14.58',
      '36.46',
    ]);
  });
  it.each([0, -1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER])(
    'rejects invalid amount %s',
    (amount) => {
      expect(() => priceUsdPayment(policy, 'deposit', amount)).toThrow();
      expect(() => priceUsdPayment(policy, 'withdrawal', amount)).toThrow();
    }
  );
});
