import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  agent: { findUnique: vi.fn() },
  agentOrder: { findUnique: vi.fn(), updateMany: vi.fn() },
  dispute: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(), $queryRaw: vi.fn(),
}));
vi.mock('@socialplay/database', async (original) => ({
  ...(await original<typeof import('@socialplay/database')>()), prisma: db,
}));
import { claimDispute, getDisputeById, openDispute, resolveDispute } from './dispute-service.js';
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

it.each([null, 123, {}, [], true, ' ', 'x'.repeat(4001)])('rejects malformed or oversized descriptions (%j) before database access', async (description) => {
  await expect(openDispute('customer', { ...args, description } as any)).rejects.toMatchObject({ statusCode: 400 });
  expect(db.agentOrder.findUnique).not.toHaveBeenCalled();
});
it.each(['orderId', 'idempotencyKey'])('rejects blank and oversized %s', async (field) => {
  for (const value of [' ', 'x'.repeat(129)]) {
    await expect(openDispute('customer', { ...args, [field]: value })).rejects.toMatchObject({ statusCode: 400 });
  }
  expect(db.agentOrder.findUnique).not.toHaveBeenCalled();
});
it.each([null, 123, {}, [], true, ' ', 'x'.repeat(4001)])('rejects malformed resolution notes (%j) before any mutation', async (note) => {
  await expect(resolveDispute('admin', 'dispute', 'RELEASE', note as any)).rejects.toMatchObject({ statusCode: 400 });
  expect(db.user.findUnique).not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
});
it.each([
  { role: 'ADMIN', status: 'SUSPENDED' },
  { role: 'USER', status: 'ACTIVE' },
  undefined,
])('refuses claims when current administrator identity changed after preflight (%j)', async (current) => {
  db.user.findUnique.mockResolvedValue({ id: 'admin', role: 'ADMIN', status: 'ACTIVE' });
  db.$queryRaw.mockResolvedValue(current ? [current] : []);
  await expect(claimDispute('admin', 'dispute')).rejects.toMatchObject({ statusCode: 403 });
  expect(db.dispute.updateMany).not.toHaveBeenCalled();
  expect(db.auditLog.create).not.toHaveBeenCalled();
});
it.each(['ADMIN', 'SUPER_ADMIN'])('allows a currently active %s to claim and records its audit', async (role) => {
  db.user.findUnique.mockResolvedValue({ id: 'admin', role, status: 'ACTIVE' });
  db.$queryRaw.mockResolvedValue([{ role, status: 'ACTIVE' }]);
  db.dispute.updateMany.mockResolvedValue({ count: 1 });
  await expect(claimDispute('admin', 'dispute')).resolves.toMatchObject({ status: 'ASSIGNED' });
  expect(db.auditLog.create).toHaveBeenCalledOnce();
});
