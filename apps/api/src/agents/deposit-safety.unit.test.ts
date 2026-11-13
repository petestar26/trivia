import { expect, it, vi } from 'vitest';
import { assertDepositSafetyClear } from './order-lifecycle.js';

it.each([
  { rows: [] },
  { rows: [{ blocked: true }] },
  { rows: [{}] },
  { rows: [{ blocked: null }] },
])(
  'fails closed before a resolution callback for absent or held destinations (%j)',
  async ({ rows }) => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue(rows) };
    const resolve = vi.fn();
    await expect(
      (async () => {
        await assertDepositSafetyClear(tx as any, 'synthetic-order');
        resolve();
      })()
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(resolve).not.toHaveBeenCalled();
  }
);

it('allows the safety check alone when the locked destination is clear; it does not assert provider proof', async () => {
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{ blocked: false }]) };
  await expect(assertDepositSafetyClear(tx as any, 'synthetic-order')).resolves.toBeUndefined();
});
