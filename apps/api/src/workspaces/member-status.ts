import { z } from 'zod';
import { ApiError } from '../middleware/api-error.js';
import { assertPlatformAdminWith } from '../agents/agent-service.js';
import { DatabaseIdentityError, type TransactionalDatabase } from '../database/identity.js';
import type { StatusApprovalSigner } from '../database/status-approval.js';
import { getSocketServer } from '../realtime/broadcast.js';

type StatusChange = { status: 'ACTIVE' | 'SUSPENDED'; reason: string; expectedUpdatedAt: string };
type StatusResult = { userId: string; status: StatusChange['status']; updatedAt: string };
/** What the authenticated route supplies for a signed (isolated) change. */
export type StatusApprovalContext = { actorTokenVersion: number; signer: StatusApprovalSigner | null };

/**
 * Suspend or reactivate a plain member. A restricted staff operation: the
 * caller supplies the staff database explicitly and this module imports no
 * client.
 *
 * Dormant (legacy credential client): the direct update below, unchanged.
 * Isolated staff identity: the owner-defined boundary
 * public.staff_set_member_status (docs/deployment/staff-member-status-boundary.sql),
 * called with an approval this API signs for the authenticated administrator
 * and their current tokenVersion. The database verifies the signature before
 * it trusts the actor ID; without a configured signer the change fails closed.
 * users_privilege_guard still refuses a direct status change by any
 * non-owner identity; the staff role gets EXECUTE on the boundary only, never
 * ownership or UPDATE on users. A missing boundary or grant fails closed (503).
 */
export async function setMemberAccountStatus(
  db: TransactionalDatabase,
  actorId: string,
  userId: string,
  input: unknown,
  approval?: StatusApprovalContext
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
  const change = parsed.data;
  const result = usesStatusBoundary(db)
    ? await changeThroughBoundary(db, actorId, userId, change, approval)
    : await changeDirectly(db, actorId, userId, change);
  if (change.status === 'SUSPENDED') {
    try {
      getSocketServer()?.in(`user:${userId}`).disconnectSockets(true);
    } catch {
      /* Current status is checked on private access. */
    }
  }
  return result;
}

/** Only an isolated (guarded) staff identity uses the boundary. */
function usesStatusBoundary(db: TransactionalDatabase): boolean {
  return (db as { mode?: unknown }).mode === 'isolated';
}

const unavailable = () =>
  ApiError.serviceUnavailable('Member status changes are temporarily unavailable');

const outcomes: Record<string, () => ApiError> = {
  INVALID: () =>
    ApiError.badRequest(
      'Choose an account status and provide a reason and the displayed account version.'
    ),
  SELF: () => ApiError.forbidden('You cannot change your own account status.'),
  ACTOR_FORBIDDEN: () => ApiError.forbidden('Admin privileges required.'),
  NOT_FOUND: () => ApiError.notFound('Account not found.'),
  NOT_MANAGEABLE: () =>
    ApiError.forbidden('Only active or suspended member accounts can be managed here.'),
  CONFLICT: () =>
    ApiError.conflict('This account changed. Refresh its details before continuing.'),
  APPROVAL_INVALID: () => ApiError.forbidden('This change could not be authorized.'),
  APPROVAL_EXPIRED: () => ApiError.conflict('This change took too long to confirm. Try again.'),
  APPROVAL_REPLAYED: () => ApiError.conflict('This change was already submitted. Refresh before continuing.'),
};

async function changeThroughBoundary(
  db: TransactionalDatabase,
  actorId: string,
  userId: string,
  { status, reason, expectedUpdatedAt }: StatusChange,
  approval?: StatusApprovalContext
): Promise<StatusResult> {
  if (!approval?.signer || !Number.isSafeInteger(approval.actorTokenVersion)) throw unavailable();
  const signed = approval.signer.sign({
    actorId,
    actorTokenVersion: approval.actorTokenVersion,
    memberId: userId,
    status,
    expectedUpdatedAt,
    reason,
  });
  let row: { outcome: string; updated_at: string | null } | undefined;
  try {
    [row] = await db.$transaction(
      (tx) => tx.$queryRaw<{ outcome: string; updated_at: string | null }[]>`
        SELECT outcome, updated_at FROM public.staff_set_member_status(
          ${signed.keyId}, ${signed.nonce}, ${signed.expiresAt}, ${signed.signature},
          ${actorId}, ${approval.actorTokenVersion}::integer,
          ${userId}, ${status}, ${expectedUpdatedAt}, ${reason})`
    );
  } catch (error) {
    if (error instanceof DatabaseIdentityError) throw error;
    // 42883: boundary not installed; 42501: EXECUTE not granted. Fail closed.
    const code = (error as { meta?: { code?: unknown } }).meta?.code;
    if (code === '42883' || code === '42501') throw unavailable();
    throw error;
  }
  if (row?.outcome === 'OK' && row.updated_at) return { userId, status, updatedAt: row.updated_at };
  const refusal = row && outcomes[row.outcome];
  if (refusal) throw refusal();
  throw ApiError.internal('Member status change could not be confirmed.');
}

async function changeDirectly(
  db: TransactionalDatabase,
  actorId: string,
  userId: string,
  { status, reason, expectedUpdatedAt }: StatusChange
): Promise<StatusResult> {
  return db.$transaction(async (tx) => {
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
}
