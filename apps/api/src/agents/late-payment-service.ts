import { prisma, type Prisma } from '@socialplay/database';
import { z } from 'zod';
import { ApiError } from '../middleware/index.js';
import { requireStepUp } from '../security/step-up-service.js';

type Tx = Prisma.TransactionClient;
const reference = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .transform((v) => v.toUpperCase());
const key = z.string().trim().min(8).max(128);
const amount = z.number().int().positive().max(2147483647);
export const reportSchema = z
  .object({
    orderId: z.string().uuid(),
    idempotencyKey: key,
    paymentReference: reference,
    paidAmount: amount,
    paidAt: z.string().datetime(),
    description: z.string().trim().min(3).max(4000),
  })
  .strict();
export const refundSchema = z
  .object({
    idempotencyKey: key,
    verifiedPaymentReference: reference,
    verifiedAmount: amount,
    refundReference: reference,
    refundedAt: z.string().datetime(),
    resolutionNote: z.string().trim().min(3).max(4000),
    verified: z.literal(true),
  })
  .strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw ApiError.badRequest('Check the transfer reference, amount, time and description');
  return result.data;
}
async function actor(tx: Tx, userId: string, admin = false) {
  const [u] = await tx.$queryRaw<Array<{ role: string; status: string }>>`
    SELECT role::text, status::text FROM users WHERE id=${userId} FOR SHARE`;
  if (u?.status !== 'ACTIVE' || (admin && !['ADMIN', 'SUPER_ADMIN'].includes(u.role))) {
    throw ApiError.forbidden(
      admin ? 'Active platform administrator required' : 'Active account required'
    );
  }
  return u;
}
async function orderAccess(tx: Tx, userId: string, orderId: string, admin = false) {
  const order = await tx.agentOrder.findUnique({
    where: { id: orderId },
    include: { agent: { select: { userId: true } } },
  });
  if (!order) throw ApiError.notFound('Order not found');
  if (admin) {
    if (order.userId === userId || order.agent.userId === userId)
      throw ApiError.forbidden('You cannot review your own payment case');
  } else if (order.userId !== userId)
    throw ApiError.forbidden('You do not have access to this order');
  return order;
}
function validTime(value: string, earliest: Date) {
  const time = new Date(value);
  if (time < earliest || time.getTime() > Date.now())
    throw ApiError.badRequest('Transfer time must follow the order and cannot be in the future');
  return time;
}
async function audit(tx: Tx, userId: string, id: string, action: string) {
  await tx.auditLog.create({ data: { userId, action, entity: 'LatePaymentCase', entityId: id } });
}
export async function reportLatePayment(userId: string, raw: unknown) {
  const args = parse(reportSchema, raw);
  return prisma.$transaction(async (tx) => {
    await actor(tx, userId);
    // Serialize reports on the immutable order identity. No order state is changed.
    await tx.$queryRaw`SELECT id FROM agent_orders WHERE id=${args.orderId} FOR UPDATE`;
    const order = await orderAccess(tx, userId, args.orderId);
    const existing = await tx.latePaymentCase.findUnique({ where: { orderId: order.id } });
    if (existing) {
      if (
        existing.idempotencyKey === args.idempotencyKey &&
        existing.paymentReference === args.paymentReference &&
        existing.paidAmount === args.paidAmount &&
        existing.paidAt.getTime() === new Date(args.paidAt).getTime() &&
        existing.description === args.description
      )
        return existing;
      throw ApiError.conflict('A recovery case already exists for this order. Review its status.');
    }
    if (!['EXPIRED', 'CANCELLED'].includes(order.status))
      throw ApiError.conflict('Recovery requires an expired or cancelled deposit order');
    const reservation = await tx.agentReservation.findUnique({ where: { orderId: order.id } });
    const settlement = await tx.agentOrderSettlement.findUnique({ where: { orderId: order.id } });
    if (reservation?.status !== 'RELEASED' || settlement)
      throw ApiError.conflict('This order requires a different payment investigation');
    const row = await tx.latePaymentCase.create({
      data: {
        ...args,
        paidAt: validTime(args.paidAt, order.createdAt),
        openedBy: userId,
      },
    });
    await audit(tx, userId, row.id, 'LATE_PAYMENT_REPORTED');
    return row;
  });
}
export const queueSchema = z.object({ page: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
export const supervisionSchema = z.object({ idempotencyKey: key, reason: z.string().trim().min(3).max(4000) }).strict();
export async function listLatePayments(userId: string, admin = false, raw: unknown = {}) {
  const { page } = parse(queueSchema, raw);
  return prisma.$transaction(async (tx) => {
    const reviewer = await actor(tx, userId, admin);
    const rows = await tx.latePaymentCase.findMany({
      where: admin
        ? (reviewer.role === 'SUPER_ADMIN' ? {} : { OR: [{ status: 'OPEN' }, { assignedAdminId: userId }] })
        : { openedBy: userId },
      orderBy: admin ? [{ openedAt: 'asc' }, { id: 'asc' }] : [{ openedAt: 'desc' }, { id: 'desc' }],
      take: 50, skip: (page ?? 0) * 50,
      include: { order: { select: { orderNumber: true, fiatCurrency: true, fiatAmount: true } } },
    });
    if (admin) return rows;
    return rows.map(({ assignedAdminId, assignedAt, resolutionKey, idempotencyKey, ...member }) => member);
  });
}
export async function claimLatePayment(userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    await actor(tx, userId, true);
    await tx.$queryRaw`SELECT id FROM late_payment_cases WHERE id=${id} FOR UPDATE`;
    const row = await tx.latePaymentCase.findUnique({ where: { id } });
    if (!row) throw ApiError.notFound('Recovery case not found');
    await orderAccess(tx, userId, row.orderId, true);
    if (row.status === 'ASSIGNED' && row.assignedAdminId === userId) return row;
    if (row.status !== 'OPEN')
      throw ApiError.conflict('Recovery case is already assigned or resolved');
    const result = await tx.latePaymentCase.update({
      where: { id },
      data: { status: 'ASSIGNED', assignedAdminId: userId, assignedAt: new Date() },
    });
    await audit(tx, userId, id, 'LATE_PAYMENT_CLAIMED');
    return result;
  });
}
export async function recordLatePaymentRefund(
  userId: string,
  tokenIat: number,
  id: string,
  raw: unknown
) {
  const args = parse(refundSchema, raw);
  if (!Number.isSafeInteger(tokenIat) || tokenIat <= 0)
    throw ApiError.unauthorized('Fresh authentication required');
  return prisma.$transaction(async (tx) => {
    await actor(tx, userId, true);
    await tx.$queryRaw`SELECT id FROM late_payment_cases WHERE id=${id} FOR UPDATE`;
    const row = await tx.latePaymentCase.findUnique({ where: { id } });
    if (!row) throw ApiError.notFound('Recovery case not found');
    const order = await orderAccess(tx, userId, row.orderId, true);
    if (row.assignedAdminId !== userId)
      throw ApiError.forbidden('Only the assigned administrator may resolve this case');
    const refundedAt = validTime(args.refundedAt, row.paidAt);
    if (row.status === 'REFUNDED') {
      if (
        row.resolutionKey === args.idempotencyKey &&
        row.verifiedPaymentReference === args.verifiedPaymentReference &&
        row.verifiedAmount === args.verifiedAmount &&
        row.refundReference === args.refundReference &&
        row.refundedAt?.getTime() === refundedAt.getTime() &&
        row.resolutionNote === args.resolutionNote
      )
        return row;
      throw ApiError.conflict('This case already has a different resolution');
    }
    if (row.status !== 'ASSIGNED')
      throw ApiError.conflict('Claim the recovery case before resolution');
    if (args.refundReference === args.verifiedPaymentReference)
      throw ApiError.badRequest('Refund and incoming payment must be different transfers');
    // Mandatory, case-specific single-use verification; successful retries above
    // return the existing record without consuming a second verification.
    await requireStepUp({ userId, tokenIat }, `LATE_PAYMENT_REFUND:${id}`, tx);
    for (const [ref, kind] of [
      [args.verifiedPaymentReference, 'PAYMENT'],
      [args.refundReference, 'REFUND'],
    ] as const) {
      const inserted = await tx.$executeRaw`
        INSERT INTO late_payment_reference_claims ("methodId",reference,"caseId",kind)
        VALUES (${order.paymentMethodDefId},${ref},${id},${kind}) ON CONFLICT DO NOTHING`;
      if (inserted !== 1)
        throw ApiError.conflict(
          'This transfer reference is already recorded in another recovery case'
        );
    }
    const result = await tx.latePaymentCase.update({
      where: { id },
      data: {
        status: 'REFUNDED',
        resolutionKey: args.idempotencyKey,
        verifiedPaymentReference: args.verifiedPaymentReference,
        verifiedAmount: args.verifiedAmount,
        refundReference: args.refundReference,
        refundedAt,
        resolutionNote: args.resolutionNote,
        resolvedAt: new Date(),
      },
    });
    await audit(tx, userId, id, 'LATE_PAYMENT_EXTERNAL_REFUND_RECORDED');
    // Recording an externally verified full refund is not a bank transfer.
    // Never change the order, reservation, inventory or financial wallet here.
    return result;
  });
}

/** Supervisors release an assignment; the next reviewer claims it normally. */
export async function superviseLatePayment(userId: string, id: string, operation: 'release' | 'reject', raw: unknown) {
  const args = parse(supervisionSchema, raw);
  return prisma.$transaction(async (tx) => {
    const reviewer = await actor(tx, userId, true);
    if (reviewer.role !== 'SUPER_ADMIN') throw ApiError.forbidden('Active super administrator required');
    await tx.$queryRaw`SELECT id FROM late_payment_cases WHERE id=${id} FOR UPDATE`;
    const row = await tx.latePaymentCase.findUnique({where: {id}});
    if (!row) throw ApiError.notFound('Recovery case not found');
    await orderAccess(tx, userId, row.orderId, true);
    const action = operation === 'release' ? 'LATE_PAYMENT_ASSIGNMENT_RELEASED' : 'LATE_PAYMENT_REJECTED';
    const previous = await tx.auditLog.findFirst({where: {
      userId, entity: 'LatePaymentCase', entityId: id,
      action: {in: ['LATE_PAYMENT_ASSIGNMENT_RELEASED','LATE_PAYMENT_REJECTED']},
      newData: {path: ['idempotencyKey'], equals: args.idempotencyKey},
    }});
    if (previous) {
      if (previous.action !== action || (previous.newData as {reason?: string})?.reason !== args.reason)
        throw ApiError.conflict('Request key was already used for a different decision');
      return row;
    }
    if (row.status !== 'ASSIGNED') throw ApiError.conflict('Only an assigned investigation can be released or rejected');
    if (operation === 'reject' && row.assignedAdminId !== userId)
      throw ApiError.forbidden('Release and claim the investigation before rejecting it');
    const result = await tx.latePaymentCase.update({where: {id}, data: operation === 'release'
      ? {status: 'OPEN', assignedAdminId: null, assignedAt: null}
      : {status: 'REJECTED', resolutionKey: args.idempotencyKey, resolutionNote: args.reason, resolvedAt: new Date()},
    });
    await tx.auditLog.create({data: {userId, action, entity: 'LatePaymentCase', entityId: id,
      newData: {idempotencyKey: args.idempotencyKey, reason: args.reason, previousAssignee: row.assignedAdminId},
    }});
    return result;
  });
}
