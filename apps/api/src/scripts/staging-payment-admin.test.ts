import { beforeEach, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { bootstrapPaymentAdmin } from './staging-payment-admin.js';
const user = { id: 'registered-user', email: 'playqube@admin.com', role: 'USER', status: 'ACTIVE', passwordHash: 'fixture' };
const tx = {
  $queryRaw: vi.fn(), user: { findUnique: vi.fn(), update: vi.fn() },
  session: { deleteMany: vi.fn() }, auditLog: { findFirst: vi.fn(), create: vi.fn() },
};
const run = (apply = true) => bootstrapPaymentAdmin(tx as unknown as Prisma.TransactionClient, apply);
beforeEach(() => {
  vi.resetAllMocks();
  tx.$queryRaw.mockResolvedValueOnce([{ allowed: true }]).mockResolvedValueOnce([{ id: user.id }]);
  tx.user.findUnique.mockResolvedValue({ ...user });
  tx.auditLog.findFirst.mockResolvedValue(null);
});
it('refuses non-owner before reading accounts', async () => {
  tx.$queryRaw.mockReset().mockResolvedValueOnce([{ allowed: false }]);
  await expect(run()).rejects.toThrow('DATABASE_OWNER_REQUIRED');
  expect(tx.user.findUnique).not.toHaveBeenCalled();
});
it('requires registration and never creates an account', async () => {
  tx.$queryRaw.mockReset().mockResolvedValueOnce([{ allowed: true }]).mockResolvedValueOnce([]);
  await expect(run()).rejects.toThrow('REGISTER_ACCOUNT_FIRST');
  expect(tx.user.update).not.toHaveBeenCalled();
});
it.each([{ status: 'SUSPENDED' }, { passwordHash: null }, { email: 'other@example.com' }])('refuses ineligible target %j', async (change) => {
  tx.user.findUnique.mockResolvedValue({ ...user, ...change });
  await expect(run()).rejects.toThrow('ACTIVE_PASSWORD_ACCOUNT_REQUIRED');
  expect(tx.user.update).not.toHaveBeenCalled();
});
it('verification has no writes', async () => {
  expect(await run(false)).toMatchObject({ status: 'READY_TO_GRANT_ADMIN' });
  expect(tx.user.update).not.toHaveBeenCalled();
  expect(tx.auditLog.create).not.toHaveBeenCalled();
  expect(tx.session.deleteMany).not.toHaveBeenCalled();
});
it('grants ADMIN without changing password or funds, revokes sessions and audits', async () => {
  expect(await run()).toMatchObject({ status: 'ADMIN_GRANTED_SIGN_IN_AGAIN' });
  expect(tx.user.update).toHaveBeenCalledWith({ where: { id: user.id }, data: { role: 'ADMIN', tokenVersion: { increment: 1 } } });
  expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: user.id } });
  expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: null, entityId: user.id, oldData: { role: 'USER' } }) });
});
it.each(['ADMIN', 'SUPER_ADMIN'])('does not change existing %s or revoke sessions again', async (role) => {
  tx.user.findUnique.mockResolvedValue({ ...user, role });
  expect(await run()).toMatchObject({ status: 'ADMIN_VERIFIED' });
  expect(tx.user.update).not.toHaveBeenCalled();
  expect(tx.session.deleteMany).not.toHaveBeenCalled();
});
it('never reapplies a consumed grant after demotion', async () => {
  tx.auditLog.findFirst.mockResolvedValue({ entityId: user.id });
  await expect(run()).rejects.toThrow('BOOTSTRAP_ALREADY_CONSUMED');
  expect(tx.user.update).not.toHaveBeenCalled();
});
it('refuses replacement account after the original grant', async () => {
  tx.auditLog.findFirst.mockResolvedValue({ entityId: 'old-account' });
  await expect(run()).rejects.toThrow('BOOTSTRAP_ALREADY_CONSUMED');
});
