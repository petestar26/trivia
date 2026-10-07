import { expect, it, vi } from 'vitest';
import { lockWithdrawalParticipants } from './lock-order.js';
function tx(actorStatus: string, customerStatus = 'ACTIVE') {
  return {
    withdrawal: { findUnique: vi.fn().mockResolvedValue({ userId: 'customer' }) },
    $queryRaw: vi
      .fn()
      .mockImplementation((_sql, id) =>
        Promise.resolve([{ id, status: id === 'agent' ? actorStatus : customerStatus }])
      ),
  };
}
it.each(['SUSPENDED', 'BANNED', 'DELETED'])(
  'rejects inactive actor %s under participant lock',
  async (status) => {
    await expect(lockWithdrawalParticipants(tx(status) as any, 'w', 'agent')).rejects.toMatchObject(
      { statusCode: 403 }
    );
  }
);
it('allows an active processor to recover a suspended customer withdrawal', async () => {
  await expect(
    lockWithdrawalParticipants(tx('ACTIVE', 'SUSPENDED') as any, 'w', 'agent')
  ).resolves.toBeUndefined();
});
