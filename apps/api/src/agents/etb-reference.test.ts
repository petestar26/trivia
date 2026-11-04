import { describe, expect, it, vi } from 'vitest';
import { fetchEtbReference, parseEtbReference } from './etb-reference.js';
const now = new Date('2026-11-04T14:30:00Z');
const sample = (price = 182.16377893981445, time = now.getTime() / 1000 - 60) => ({
  usdCurrentBlackPrice: price,
  allLastprice: { USD: price },
  historicalPrices: [
    { time: time - 500, value: { USD: 181 } },
    { time, value: { USD: price } },
  ],
});
describe('ETB reference evidence', () => {
  it('uses the matching source timestamp and normalizes eight decimals', () => {
    expect(parseEtbReference(sample(), now)).toEqual({
      localPerUsd: '182.16377894',
      observedAt: '2026-11-04T14:29:00.000Z',
      expiresAt: '2026-11-04T14:59:00.000Z',
    });
  });
  it.each([0, -10, NaN, Infinity, 100001])('rejects invalid price %s', (p) => {
    expect(() => parseEtbReference(sample(p), now)).toThrow();
  });
  it('rejects stale, future, mismatched and absent observation evidence', () => {
    for (const value of [
      sample(182, now.getTime() / 1000 - 1800),
      sample(182, now.getTime() / 1000 + 1),
      { ...sample(), allLastprice: { USD: 181 } },
      { ...sample(), historicalPrices: [] },
      { ...sample(), historicalPrices: [{ time: now.getTime() / 1000, value: { USD: 181 } }] },
    ]) {
      expect(() => parseEtbReference(value, now)).toThrow();
    }
  });
  it('rejects abrupt repricing instead of silently changing customer quotes', () => {
    expect(() => parseEtbReference(sample(210), now, '182')).toThrow(/review/);
  });
  it('reads the fixed endpoint with bounded transport and fails closed on errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(sample())));
    expect((await fetchEtbReference(now, undefined, fetcher)).localPerUsd).toBe('182.16377894');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    await expect(
      fetchEtbReference(
        now,
        undefined,
        vi.fn().mockResolvedValue(new Response('', { status: 503 }))
      )
    ).rejects.toThrow();
    await expect(
      fetchEtbReference(
        now,
        undefined,
        vi.fn().mockResolvedValue(new Response(' '.repeat(2_000_001)))
      )
    ).rejects.toThrow(/large/);
  });
});
