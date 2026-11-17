import { describe, expect, it } from 'vitest';
import { priceUsdPayment, priceEtbCrypto, type UsdPolicy } from './usd-pricing.js';
const p: UsdPolicy = {
  version: 'ETB_V1', walletCurrency: 'ETB', minorDigits: 2, localPerUsd: '150',
  source: 'Synthetic fixture', observedAt: '2026-11-17T00:00:00Z', expiresAt: '2026-11-17T00:10:00Z',
  p2pDepositMinUsdCents: 200, p2pWithdrawalAboveUsdCents: 400,
  cryptoDepositMinUsdCents: 1000, cryptoWithdrawalAboveUsdCents: 2000, feeMinor: 0,
};
describe('ETB agent-payment minimums', () => {
  for (const localPerUsd of ['0.01', '150', '99999.99']) {
    it(`uses inclusive santim thresholds independent of USD rate ${localPerUsd}`, () => {
      const policy = { ...p, localPerUsd };
      expect(() => priceUsdPayment(policy, 'deposit', 9999)).toThrow('Minimum P2P deposit is 100 ETB');
      expect(priceUsdPayment(policy, 'deposit', 10000)).toMatchObject({ coinAmount: 10000, fiatAmount: 10000n });
      expect(() => priceUsdPayment(policy, 'withdrawal', 49999)).toThrow('Minimum P2P withdrawal is 500 ETB');
      expect(priceUsdPayment(policy, 'withdrawal', 50000)).toMatchObject({ coinAmount: 50000, fiatAmount: 50000n });
    });
  }
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 1_000_000_001])('rejects invalid or unsupported amounts %s', amount => {
    expect(() => priceUsdPayment(p, 'deposit', amount)).toThrow();
    expect(() => priceUsdPayment(p, 'withdrawal', amount)).toThrow();
  });
  it('pins the new floor policy without mutating input or changing crypto conversion', () => {
    const before = JSON.stringify(p);
    expect(priceUsdPayment(p, 'deposit', 10000).snapshot).toMatchObject({ p2pMinimumPolicy: { version: 'ETB_P2P_20261117', depositMinMinor: 10000, withdrawalMinMinor: 50000 } });
    expect(JSON.stringify(p)).toBe(before);
    expect(priceEtbCrypto(p, 'deposit', 1_000_000n)).toBe(15000);
    expect(priceEtbCrypto(p, 'withdrawal', 15000)).toBe(1_000_000n);
  });
});
