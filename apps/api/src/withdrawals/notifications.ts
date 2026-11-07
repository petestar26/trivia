import type { Prisma } from '@socialplay/database';

/** Called inside the transition transaction; exact retries never create another notification. */
export async function notifyWithdrawalUpdate(tx: Prisma.TransactionClient, withdrawalId: string) {
  const order = await tx.withdrawal.findUniqueOrThrow({
    where: { id: withdrawalId },
    select: { userId: true, agent: { select: { userId: true } } },
  });
  const recipients = [
    ...new Set([order.userId, order.agent?.userId].filter((id): id is string => !!id)),
  ];
  await tx.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      type: 'SYSTEM',
      title: 'Payment order update',
      body: 'Payment order updated. Open the order to see its status and next step.',
      data: { withdrawalId, url: `/wallet/orders/withdrawal/${withdrawalId}` },
    })),
  });
}
