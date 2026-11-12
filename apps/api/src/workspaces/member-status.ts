import { z } from 'zod';
import { ApiError } from '../middleware/api-error.js';
import { assertPlatformAdminWith } from '../agents/agent-service.js';
import type { TransactionalDatabase } from '../database/identity.js';
import { getSocketServer } from '../realtime/broadcast.js';

/**
 * Suspend or reactivate a plain member. A restricted staff operation: the
 * caller supplies the staff database explicitly and this module imports no
 * client. The database's owner-only users_privilege_guard still applies, so a
 * non-owner staff identity cannot change status until an operator provides a
 * narrow, reviewed path for it (see docs/deployment/staff-database-identity.md).
 */
export async function setMemberAccountStatus(
  db: TransactionalDatabase,
  actorId: string,
  userId: string,
  input: unknown
) {
  if (!db) throw new Error('STAFF_DATABASE_REQUIRED');
  const parsed = z
    .object({
      status: z.enum(['ACTIVE', 'SUSPENDED']),
      reason: z.string().trim().min(5).max(500),
      expectedUpdatedAt: z.string().datetime({ precision: 3 }),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    throw ApiError.badRequest(
      'Choose an account status and provide a reason and the displayed account version.'
    );
  if (actorId === userId) throw ApiError.forbidden('You cannot change your own account status.');
  await db.$transaction((tx) => assertPlatformAdminWith(tx, actorId));
  const { status, reason, expectedUpdatedAt } = parsed.data;
  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${actorId} FOR SHARE`;
    const actor = await tx.user.findUnique({
      where: { id: actorId },
      select: { role: true, status: true },
    });
    if (!actor || actor.status !== 'ACTIVE' || !['ADMIN', 'SUPER_ADMIN'].includes(actor.role))
      throw ApiError.forbidden('Admin privileges required.');
    await tx.$queryRaw`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
    const member = await tx.user.findUnique({
      where: { id: userId },
      select: { role: true, status: true, updatedAt: true },
    });
    if (!member) throw ApiError.notFound('Account not found.');
    if (member.role !== 'USER' || !['ACTIVE', 'SUSPENDED'].includes(member.status))
      throw ApiError.forbidden('Only active or suspended member accounts can be managed here.');
    if (member.updatedAt.toISOString() !== expectedUpdatedAt || member.status === status)
      throw ApiError.conflict('This account changed. Refresh its details before continuing.');
    // The database's owner-only status guard remains in force. No role or
    // financial record is changed. Keep bounded own-funds-return access valid.
    const updatedAt = new Date(Math.max(Date.now(), member.updatedAt.getTime() + 1));
    await tx.user.update({ where: { id: userId }, data: { status, updatedAt } });
    if (status === 'SUSPENDED') await tx.session.deleteMany({ where: { userId } });
    await tx.auditLog.create({
      data: {
        userId: actorId,
        action: status === 'ACTIVE' ? 'ADMIN_MEMBER_REACTIVATED' : 'ADMIN_MEMBER_SUSPENDED',
        entity: 'User',
        entityId: userId,
        oldData: { status: member.status },
        newData: { status, reason, refreshSessionsRevoked: status === 'SUSPENDED' },
      },
    });
    return { userId, status, updatedAt: updatedAt.toISOString() };
  });
  if (status === 'SUSPENDED') {
    try {
      getSocketServer()?.in(`user:${userId}`).disconnectSockets(true);
    } catch {
      /* Current status is checked on private access. */
    }
  }
  return result;
}
