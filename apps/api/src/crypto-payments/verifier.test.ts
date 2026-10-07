import { it, expect, vi } from 'vitest';
vi.mock('@socialplay/database', () => ({ prisma: {} }));
vi.mock('./service.js', () => ({ settleDeposit: vi.fn() }));
import { scanTransfers } from './verifier.js';
it('finishes every discovery page, verifies each unique receipt and keeps the time window fixed', async () => {
  const discover = vi
    .fn()
    .mockResolvedValueOnce({ hashes: ['a'], next: 'page2' })
    .mockResolvedValueOnce({ hashes: ['a', 'b'] });
  const transfers = vi.fn().mockResolvedValue([]);
  const createdAt = new Date(100),
    until = new Date(500);
  await scanTransfers({ discover, transfers }, { address: 'fixture', createdAt }, until);
  expect(transfers).toHaveBeenCalledTimes(2);
  expect(discover).toHaveBeenNthCalledWith(2, 'fixture', createdAt, until, 'page2');
});
it('does not return evidence from incomplete, looping or failed receipt scans', async () => {
  const discover = vi.fn().mockResolvedValue({ hashes: ['a'], next: 'repeat' }),
    transfers = vi.fn().mockResolvedValue([]);
  await expect(
    scanTransfers({ discover, transfers }, { address: 'fixture', createdAt: new Date() })
  ).rejects.toThrow('did not advance');
  discover.mockResolvedValue({ hashes: ['a'] });
  transfers.mockRejectedValue(new Error('not solidified yet'));
  await expect(
    scanTransfers({ discover, transfers }, { address: 'fixture', createdAt: new Date() })
  ).rejects.toThrow('not solidified');
});
