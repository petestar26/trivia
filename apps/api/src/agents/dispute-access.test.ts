import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  agent: { findUnique: vi.fn() },
  agentOrder: { findUnique: vi.fn(), updateMany: vi.fn() },
  dispute: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(), $queryRaw: vi.fn(),
}));
vi.mock('@socialplay/database', async (original) => ({
  ...(await original<typeof import('@socialplay/database')>()), prisma: db,
}));
import { getDisputeById, openDispute } from './dispute-service.js';
const args = { orderId: 'order', reason: 'OTHER' as const, description: 'Private payment receipt', idempotencyKey: 'known-request-key' };
const dispute = { id: 'dispute', ...args, openedBy: 'customer', status: 'OPEN' };
beforeEach(() => {
  vi.resetAllMocks();
  db.user.findUnique.mockResolvedValue({ status: 'ACTIVE', role: 'USER' });
  db.agentOrder.findUnique.mockResolvedValue({ id: 'order', userId: 'customer', agentId: 'agent' });
  db.agent.findUnique.mockResolvedValue({ userId: 'agent-user' });
  db.dispute.findUnique.mockResolvedValue(dispute);
  db.$transaction.mockImplementation((fn) => fn(db));
});
it('does not disclose a dispute on an unrelated caller replay with an exact known key and payload', async () => {
  await expect(openDispute('stranger', args)).rejects.toThrow(/access/);
  expect(db.dispute.findUnique).not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
});
it.each(['customer', 'agent-user'])('preserves authorized replay for %s', async (actor) => {
  await expect(openDispute(actor, args)).resolves.toEqual({ dispute, idempotent: true });
  expect(db.$transaction).not.toHaveBeenCalled();
});
it.each(['SUSPENDED', 'BANNED', 'DELETED'])('rejects %s owners before replay or private reads', async (status) => {
  db.user.findUnique.mockResolvedValue({ status, role: 'ADMIN' });
  await expect(openDispute('customer', args)).rejects.toThrow(/active account/);
  await expect(getDisputeById('customer', 'dispute')).rejects.toThrow(/active account/);
});
it('returns conflict for an authorized replay with changed fields', async () => {
  await expect(openDispute('customer', { ...args, description: 'Changed' })).rejects.toThrow(/different request data/);
});
it('rechecks active status under a lock before changing order state', async () => {
  db.dispute.findUnique.mockResolvedValue(null);
  db.dispute.findFirst.mockResolvedValue(null);
  db.$queryRaw.mockResolvedValue([{ status: 'SUSPENDED' }]);
  await expect(openDispute('customer', args)).rejects.toThrow(/active account/);
  expect(db.agentOrder.updateMany).not.toHaveBeenCalled();
  expect(db.dispute.create).not.toHaveBeenCalled();
});
it('rejects missing request data as a validation error', async () => {
  await expect(openDispute('customer', undefined as any)).rejects.toMatchObject({ statusCode: 400 });
});
