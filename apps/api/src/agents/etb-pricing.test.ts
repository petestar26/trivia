import { describe, it, expect } from 'vitest';
import { parseUsdPolicy, priceEtbCrypto, priceUsdPayment } from './usd-pricing.js';
const now = new Date('2026-11-04T15:00:00Z');
const policy = parseUsdPolicy(
  {
    version: 'ETB_V1',
    walletCurrency: 'ETB',
    minorDigits: 2,
    localPerUsd: '182.16377894',
    source: 'https://ethioblackmarket.com/',
    observedAt: '2026-11-04T14:59:00Z',
    expiresAt: '2026-11-04T15:29:00Z',
    p2pDepositMinUsdCents: 200,
    p2pWithdrawalAboveUsdCents: 400,
    cryptoDepositMinUsdCents: 1000,
    cryptoWithdrawalAboveUsdCents: 2000,
    feeMinor: 0,
  },
  now
);
describe('native ETB wallet quotes', () => {
  it('credits exactly the local payment in santim without a token conversion', () => {
    expect(priceUsdPayment(policy, 'deposit', 50001)).toMatchObject({
      coinAmount: 50001,
      fiatAmount: 50001n,
    });
    expect(priceUsdPayment(policy, 'withdrawal', 100001)).toMatchObject({
      coinAmount: 100001,
      fiatAmount: 100001n,
    });
  });
  it('uses source precision and rounds crypto credits down to one santim', () => {
    expect(priceEtbCrypto(policy, 'deposit', 10_000_000n)).toBe(182163);
    expect(priceEtbCrypto(policy, 'withdrawal', 182163)).toBe(9_999_957n);
  });
  it('cannot gain ETB through conversion rounding', () => {
    for (const localPerUsd of ['0.12345678', '1', '150', '182.16377894', '99999.99999999']) {
      const p = { ...policy, localPerUsd };
      for (const amount of [100001, 500001, 1000000, 999999999]) {
        const out = priceEtbCrypto(p, 'withdrawal', amount);
        expect(priceEtbCrypto(p, 'deposit', out)).toBeLessThanOrEqual(amount);
      }
    }
  });
  it('honors exact inclusive deposit and exclusive withdrawal thresholds', () => {
    expect(() => priceUsdPayment(policy, 'deposit', 36432)).toThrow(/Minimum/);
    expect(priceUsdPayment(policy, 'deposit', 36433).coinAmount).toBe(36433);
    expect(() => priceUsdPayment(policy, 'withdrawal', 72865)).toThrow(/exceed/);
    expect(priceUsdPayment(policy, 'withdrawal', 72866).coinAmount).toBe(72866);
  });
  it('refuses expired rates, token fields and inappropriate precision', () => {
    for (const p of [
      { ...policy, expiresAt: now.toISOString() },
      { ...policy, coinsPerUsd: 96 },
      { ...policy, minorDigits: 0 },
      { ...policy, expiresAt: '2026-11-04T15:30:00Z' },
    ]) {
      expect(() => parseUsdPolicy(p, now)).toThrow();
    }
  });
  it('rejects zero and overflow before creating a payment', () => {
    expect(() => priceEtbCrypto(policy, 'deposit', 0n)).toThrow();
    expect(() => priceEtbCrypto(policy, 'deposit', 99_999_999_000_000n)).toThrow();
    expect(() => priceEtbCrypto(policy, 'withdrawal', 0)).toThrow();
    expect(() => priceEtbCrypto(policy, 'withdrawal', 1.5)).toThrow();
  });
});
