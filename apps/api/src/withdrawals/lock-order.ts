import { ApiError } from '../middleware/error-handler.js';

/** Lock both parties' User rows before taking any withdrawal business lock.
 * The initial withdrawal read is only used to discover its immutable userId;
 * every caller re-reads and validates the withdrawal under FOR UPDATE. */
export async function lockWithdrawalParticipants(
  tx: any,
  withdrawalId: string,
  actorUserId: string
): Promise<void> {
  const target = await tx.withdrawal.findUnique({
    where: { id: withdrawalId },
    select: { userId: true },
  });
  if (!target) throw ApiError.notFound('Withdrawal not found');
  const userIds = [...new Set([target.userId, actorUserId])].sort();
  for (const userId of userIds) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${userId} FOR SHARE
    `;
    if (!rows[0]) throw ApiError.unauthorized('Authentication required');
  }
}
