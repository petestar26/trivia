import { createHash } from 'node:crypto';
import { prisma, type Prisma } from '@socialplay/database';
import { z } from 'zod';
import { ApiError } from '../middleware/index.js';
import { depositEntryDeadline } from './order-lifecycle.js';
import { serializeAdminWithdrawal, serializeWithdrawal } from '../withdrawals/dto.js';

export type PaymentKind = 'deposit' | 'withdrawal';
type Db = Prisma.TransactionClient;
const MAX_FILE = 2 * 1024 * 1024;
const messageSelect = {
  id: true,
  authorId: true,
  authorRole: true,
  body: true,
  createdAt: true,
  attachmentName: true,
  attachmentMime: true,
} as const;
export const paymentMessageSchema = z
  .object({
    body: z.string().trim().max(4000).default(''),
    idempotencyKey: z.string().trim().min(8).max(128),
    attachment: z
      .object({
        name: z.string().trim().min(1).max(160),
        mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        base64: z
          .string()
          .min(16)
          .max(Math.ceil(MAX_FILE / 3) * 4),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => v.body.length > 0 || !!v.attachment, 'A message or receipt is required');

export async function paymentRoomAccess(db: Db, actorId: string, kind: PaymentKind, id: string) {
  const actor = await db.user.findUnique({
    where: { id: actorId },
    select: { status: true, role: true },
  });
  if (actor?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
  const payment =
    kind === 'deposit'
      ? await db.agentOrder.findUnique({ where: { id } })
      : await db.withdrawal.findUnique({ where: { id } });
  if (!payment) throw ApiError.notFound('Payment order not found');
  const agent = payment.agentId
    ? await db.agent.findUnique({
        where: { id: payment.agentId },
        select: { userId: true, displayName: true, status: true },
      })
    : null;
  const role =
    payment.userId === actorId
      ? 'member'
      : agent?.userId === actorId
        ? 'agent'
        : ['ADMIN', 'SUPER_ADMIN'].includes(actor.role)
          ? 'support'
          : null;
  if (!role) throw ApiError.forbidden('You do not have access to this payment order');
  return { payment, agent, role };
}

function messageView(
  message: {
    id: string;
    authorId: string;
    authorRole: string;
    body: string;
    createdAt: Date;
    attachmentName: string | null;
    attachmentMime: string | null;
  },
  actorId: string,
  kind: PaymentKind,
  id: string
) {
  return {
    id: message.id,
    role: message.authorRole,
    mine: message.authorId === actorId,
    body: message.body,
    createdAt: message.createdAt,
    attachment: message.attachmentName
      ? {
          name: message.attachmentName,
          mimeType: message.attachmentMime,
          url: `/api/v1/payment-orders/${kind}/${id}/attachments/${message.id}`,
        }
      : null,
  };
}

export async function getPaymentRoom(
  actorId: string,
  kind: PaymentKind,
  id: string,
  before?: string
) {
  // One consistent read prevents a new status being paired with old appeal/hold data.
  return prisma.$transaction(
    async (db) => {
      const { payment, agent, role } = await paymentRoomAccess(db, actorId, kind, id);
      const where = kind === 'deposit' ? { orderId: id } : { withdrawalId: id };
      const disputes =
        kind === 'deposit'
          ? await db.dispute.findMany({
              where: { orderId: id },
              orderBy: { openedAt: 'desc' },
              take: 10,
            })
          : await db.withdrawalDispute.findMany({
              where: { withdrawalId: id },
              orderBy: { openedAt: 'desc' },
              take: 10,
            });
      const cursor = before
        ? await db.paymentOrderMessage.findFirst({
            where: { ...where, id: before },
            select: { id: true, createdAt: true },
          })
        : null;
      if (before && !cursor) throw ApiError.badRequest('Invalid conversation cursor');
      const messages = await db.paymentOrderMessage.findMany({
        where: {
          ...where,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        select: messageSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 51,
      });
      const nextCursor = messages.length > 50 ? messages[49].id : null;
      const page = messages.slice(0, 50);
      const depositHold =
        kind === 'deposit'
          ? await db.agentReservation.findUnique({ where: { orderId: id } })
          : null;
      const withdrawalHold =
        kind === 'withdrawal'
          ? await db.withdrawalHold.findUnique({ where: { withdrawalId: id } })
          : null;
      const submission =
        kind === 'withdrawal'
          ? await db.withdrawalPaymentSubmission.findUnique({
              where: { withdrawalId: id },
              select: {
                referenceNumber: true,
                submittedAt: true,
                paymentOccurredAt: true,
                note: true,
              },
            })
          : null;
      const recovery =
        kind === 'deposit'
          ? await db.latePaymentCase.findUnique({
              where: { orderId: id },
              select: {
                id: true,
                status: true,
                description: true,
                resolutionNote: true,
                openedAt: true,
                resolvedAt: true,
                assignedAdminId: true,
              },
            })
          : null;
      const member = await db.user.findUnique({
        where: { id: payment.userId },
        select: { username: true, displayName: true },
      });
      const now = new Date();
      const deadline = kind === 'deposit' ? depositEntryDeadline(payment) : null;
      const activeDispute = disputes.find((d) => ['OPEN', 'ASSIGNED'].includes(d.status));
      const ownRole = role !== 'support';
      const normalized =
        kind === 'deposit'
          ? {
              ...payment,
              exchangeRateValue: payment.exchangeRateValue.toString(),
              fiatAmount: payment.fiatAmount.toString(),
            }
          : role === 'support'
            ? serializeAdminWithdrawal(payment as any)
            : serializeWithdrawal(payment as any);
      // Do not spread database records at this API boundary: keep party identities,
      // idempotency keys and internal operation references private.
      return {
        id,
        kind,
        role,
        status: payment.status,
        number: 'orderNumber' in payment ? payment.orderNumber : payment.withdrawalNumber,
        coinAmount: payment.coinAmount,
        fiatAmount: normalized.fiatAmount,
        fiatCurrency: payment.fiatCurrency,
        paymentSnapshot:
          role === 'support' && kind === 'deposit' ? null : normalized.paymentSnapshot,
        pricingSnapshot: payment.pricingSnapshot,
        createdAt: payment.createdAt,
        serverNow: now,
        deadline:
          deadline ??
          ('paymentSubmissionDeadlineAt' in payment ? payment.paymentSubmissionDeadlineAt : null),
        confirmationDeadline:
          'confirmationDeadlineAt' in payment ? payment.confirmationDeadlineAt : null,
        memberName: member?.displayName || member?.username || '',
        agentName: agent?.displayName || '',
        hold: {
          status: depositHold?.status ?? withdrawalHold?.status ?? null,
          amount: depositHold?.amount ?? withdrawalHold?.coinAmount ?? 0,
        },
        submission,
        recovery: recovery
          ? {
              id: recovery.id,
              status: recovery.status,
              description: recovery.description,
              resolutionNote: recovery.resolutionNote,
              openedAt: recovery.openedAt,
              resolvedAt: recovery.resolvedAt,
            }
          : null,
        appeals: disputes.map((d) => ({
          id: d.id,
          reason: d.reason,
          description: d.description,
          status: d.status,
          openedAt: d.openedAt,
          resolution: d.resolution,
          resolutionNote: d.resolutionNote,
          resolvedAt: d.resolvedAt,
        })),
        messages: page.reverse().map((m) => messageView(m, actorId, kind, id)),
        nextCursor,
        actions: {
          markPaid:
            kind === 'deposit' &&
            role === 'member' &&
            payment.status === 'CREATED' &&
            deadline! > now,
          release:
            kind === 'deposit' &&
            role === 'agent' &&
            agent?.status === 'ACTIVE' &&
            payment.status === 'PAYMENT_SUBMITTED',
          cancel: role === 'member' && payment.status === (kind === 'deposit' ? 'CREATED' : 'HELD'),
          claim:
            kind === 'withdrawal' &&
            role === 'agent' &&
            agent?.status === 'ACTIVE' &&
            payment.status === 'HELD',
          submitPayout:
            kind === 'withdrawal' &&
            role === 'agent' &&
            agent?.status === 'ACTIVE' &&
            payment.status === 'PAYOUT_IN_PROGRESS',
          confirmReceipt:
            kind === 'withdrawal' && role === 'member' && payment.status === 'PAYMENT_SUBMITTED',
          appeal:
            ownRole &&
            !activeDispute &&
            (kind === 'deposit'
              ? ['CREATED', 'PAYMENT_SUBMITTED']
              : ['HELD', 'PAYOUT_IN_PROGRESS', 'PAYMENT_SUBMITTED']
            ).includes(payment.status),
          latePayment:
            ownRole &&
            kind === 'deposit' &&
            ['CANCELLED', 'EXPIRED'].includes(payment.status) &&
            !recovery &&
            !disputes.length,
          message:
            ownRole ||
            disputes.some(d => d.assignedAdminId === actorId) ||
            recovery?.assignedAdminId === actorId,
        },
      };
    },
    { isolationLevel: 'RepeatableRead' }
  );
}

function receiptBytes(attachment: z.infer<typeof paymentMessageSchema>['attachment']) {
  if (!attachment) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.base64) || attachment.base64.length % 4 !== 0)
    throw ApiError.badRequest('Invalid receipt image');
  const bytes = Buffer.from(attachment.base64, 'base64');
  if (
    bytes.length < 12 ||
    bytes.length > MAX_FILE ||
    bytes.toString('base64') !== attachment.base64
  )
    throw ApiError.badRequest('Receipt images must be at most 2 MB');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!(
    (attachment.mimeType === 'image/png' && png) ||
    (attachment.mimeType === 'image/jpeg' && jpeg) ||
    (attachment.mimeType === 'image/webp' && webp)
  ))
    throw ApiError.badRequest('The receipt must be a PNG, JPEG or WebP image');
  return bytes;
}

export async function postPaymentMessage(
  actorId: string,
  kind: PaymentKind,
  id: string,
  raw: unknown
) {
  const parsed = paymentMessageSchema.safeParse(raw);
  if (!parsed.success)
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid message');
  const args = parsed.data,
    bytes = receiptBytes(args.attachment);
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ kind, id, body: args.body, attachment: args.attachment ?? null }))
    .digest('hex');
  return prisma.$transaction(async (db) => {
    await db.$queryRaw`SELECT id FROM users WHERE id=${actorId} FOR SHARE`;
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-chat-key:${actorId}:${args.idempotencyKey}`},0))::text`;
    // Serialize message limits and duplicate retries, without taking wallet locks.
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-chat:${kind}:${id}`},0))::text`;
    const { payment, agent, role } = await paymentRoomAccess(db, actorId, kind, id);
    const where = kind === 'deposit' ? { orderId: id } : { withdrawalId: id };
    if (role === 'support') {
      const assigned =
        kind === 'deposit'
          ? await db.dispute.findFirst({ where: { orderId: id, assignedAdminId: actorId } })
          : await db.withdrawalDispute.findFirst({
              where: { withdrawalId: id, assignedAdminId: actorId },
            });
      const recovery =
        kind === 'deposit'
          ? await db.latePaymentCase.findFirst({ where: { orderId: id, assignedAdminId: actorId } })
          : null;
      if (!assigned && !recovery) throw ApiError.forbidden('Claim this appeal before replying');
    }
    const previous = await db.paymentOrderMessage.findUnique({
      where: {
        authorId_idempotencyKey: { authorId: actorId, idempotencyKey: args.idempotencyKey },
      },
      select: { ...messageSelect, requestHash: true },
    });
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw ApiError.conflict('This message request has different content');
      return { message: messageView(previous, actorId, kind, id), idempotent: true };
    }
    if ((await db.paymentOrderMessage.count({ where })) >= 500)
      throw ApiError.conflict('This conversation is full. Contact support with the order number.');
    if (
      bytes &&
      (await db.paymentOrderMessage.count({
        where: { ...where, attachmentName: { not: null } },
      })) >= 10
    )
      throw ApiError.conflict('This order already has 10 receipt images');
    const message = await db.paymentOrderMessage.create({
      data: {
        ...where,
        authorId: actorId,
        authorRole: role,
        body: args.body,
        idempotencyKey: args.idempotencyKey,
        requestHash,
        ...(bytes && args.attachment
          ? {
              attachmentName: args.attachment.name.replace(/[\u0000-\u001f\u007f/\\]/g, '_'),
              attachmentMime: args.attachment.mimeType,
              attachmentBytes: bytes,
            }
          : {}),
      },
      select: messageSelect,
    });
    const reviewer =
      kind === 'deposit'
        ? await db.dispute.findFirst({
            where: { orderId: id, status: 'ASSIGNED' },
            select: { assignedAdminId: true },
          })
        : await db.withdrawalDispute.findFirst({
            where: { withdrawalId: id, status: 'ASSIGNED' },
            select: { assignedAdminId: true },
          });
    const recoveryReviewer =
      kind === 'deposit'
        ? await db.latePaymentCase.findFirst({
            where: { orderId: id, status: 'ASSIGNED' },
            select: { assignedAdminId: true },
          })
        : null;
    const recipients = [
      payment.userId,
      agent?.userId,
      reviewer?.assignedAdminId,
      recoveryReviewer?.assignedAdminId,
    ].filter((u): u is string => !!u && u !== actorId);
    for (const userId of [...new Set(recipients)])
      await db.notification.create({
        data: {
          userId,
          type: 'SYSTEM',
          title: 'Payment order update',
          body: 'Payment order updated. Open the order to see its status and next step.',
          data: { orderId: id, kind, url: `/wallet/orders/${kind}/${id}` },
        },
      });
    return { message: messageView(message, actorId, kind, id), idempotent: false };
  });
}

export async function getPaymentAttachment(
  actorId: string,
  kind: PaymentKind,
  id: string,
  messageId: string
) {
  await paymentRoomAccess(prisma, actorId, kind, id);
  const attachment = await prisma.paymentOrderMessage.findFirst({
    where: { id: messageId, ...(kind === 'deposit' ? { orderId: id } : { withdrawalId: id }) },
    select: { attachmentBytes: true, attachmentMime: true },
  });
  if (!attachment?.attachmentBytes || !attachment.attachmentMime)
    throw ApiError.notFound('Receipt not found');
  return attachment;
}
