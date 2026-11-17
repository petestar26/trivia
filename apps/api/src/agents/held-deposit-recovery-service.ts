/**
 * Held-deposit recovery.
 *
 * A safety hold is a deliberate fail-closed state and is NEVER cleared here.
 * A held order reaches a terminal state only through one adjudication row
 * that the database authorises (see migration 20261117000000) and that is
 * usable only inside the transaction that inserted it.
 *
 * Vocabulary is deliberate:
 *  - VERIFIED_UNPAID            order cancelled; the AGENT's reserved inventory
 *                               is released. This is not a refund: nobody paid.
 *  - VERIFIED_PAYMENT_RECEIVED  the existing settlement: reservation consumed,
 *                               PURCHASE credit, unique settlement witness.
 *  - VERIFIED_EXTERNAL_RETURN   an independently confirmed return of the fiat
 *                               is RECORDED; the reservation is released. No
 *                               Coin is issued and no transfer is performed.
 *  - PAYMENT_CLAIMED_UNKNOWN    investigation marker only; no financial effect.
 *
 * Every outcome is disabled by owner-controlled policy until approved.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma, type Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/api-error.js';
import { consumeStepUp } from '../security/step-up-service.js';
import { creditCoins, lockUserEconomicScope } from '../economy/coin-ledger-service.js';
import { consumeReservedInventory, releaseReservedInventory } from './inventory-service.js';
import { lockDepositReceivingAccount, MAX_PENDING_DEPOSITS } from './order-lifecycle.js';

type Tx = Prisma.TransactionClient;
type Context = { ip?: string; userAgent?: string };
export const HELD_OPEN_STATUSES = ['CREATED', 'PAYMENT_SUBMITTED', 'DISPUTE'] as const;
export const heldAdjudicationPurpose = (orderId: string) => `HELD_DEPOSIT_ADJUDICATION:${orderId}`;

const key = z.string().trim().min(8).max(128);
const reference = z.string().trim().min(3).max(128).regex(/^[A-Za-z0-9._/-]+$/).transform((v) => v.toUpperCase());
const amount = z.number().int().positive().max(2147483647);
const evidenceItem = z.object({
  kind: z.enum(['BANK_STATEMENT', 'PROVIDER_CONFIRMATION', 'AGENT_STATEMENT', 'MEMBER_STATEMENT', 'OTHER']),
  reference: z.string().trim().min(1).max(200),
  description: z.string().trim().min(3).max(1000),
}).strict();
const common = {
  idempotencyKey: key,
  expectedCaseVersion: z.number().int().positive(),
  reason: z.string().trim().min(10).max(4000),
  evidence: z.array(evidenceItem).min(1).max(20),
  // The administrator's explicit statement that they checked the evidence themselves.
  verified: z.literal(true),
};
export const adjudicationSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('VERIFIED_UNPAID'), ...common }).strict(),
  z.object({
    outcome: z.literal('VERIFIED_PAYMENT_RECEIVED'), ...common,
    verifiedPaymentReference: reference, verifiedAmount: amount, verifiedPaidAt: z.string().datetime(),
  }).strict(),
  z.object({
    outcome: z.literal('VERIFIED_EXTERNAL_RETURN'), ...common,
    verifiedPaymentReference: reference, verifiedAmount: amount, verifiedPaidAt: z.string().datetime(),
    returnReference: reference, returnedAmount: amount, returnedAt: z.string().datetime(),
  }).strict(),
]);
export type AdjudicationArgs = z.infer<typeof adjudicationSchema>;
const noteSchema = z.object({ expectedCaseVersion: z.number().int().positive(), note: z.string().trim().min(10).max(4000) }).strict();
const declarationSchema = z.object({ declaration: z.enum(['NOT_PAID', 'PAID']) }).strict();
const pageSchema = z.object({ page: z.coerce.number().int().min(0).max(100000).default(0) }).strict();

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw ApiError.badRequest(message);
  return result.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const requestHash = (orderId: string, args: AdjudicationArgs) =>
  createHash('sha256').update(canonical({ orderId, ...args })).digest('hex');

async function lockActor(tx: Tx, userId: string, level: 'member' | 'reviewer' | 'main') {
  const [u] = await tx.$queryRaw<Array<{ role: string; status: string }>>`
    SELECT role::text, status::text FROM users WHERE id=${userId} FOR SHARE`;
  if (u?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
  if (level === 'reviewer' && !['ADMIN', 'SUPER_ADMIN'].includes(u.role)) throw ApiError.forbidden('Active platform administrator required');
  if (level === 'main' && u.role !== 'SUPER_ADMIN') throw ApiError.forbidden('Only an active main administrator may handle held deposits');
  return u;
}

/** Account first, then order — the same order as disable → affected orders. */
async function lockHeldOrder(tx: Tx, orderId: string) {
  await lockDepositReceivingAccount(tx, orderId);
  await tx.$queryRaw`SELECT id FROM agent_orders WHERE id=${orderId} FOR UPDATE`;
  const order = await tx.agentOrder.findUnique({ where: { id: orderId }, include: { agent: { select: { userId: true } } } });
  if (!order) throw ApiError.notFound('Order not found');
  if (!order.safetyHold) throw ApiError.conflict('This order is not on safety hold');
  return order;
}
function assertNotParty(adminId: string, order: { userId: string; agent: { userId: string } }) {
  if (order.userId === adminId || order.agent.userId === adminId) throw ApiError.forbidden('You cannot handle a held deposit you are a party to');
}
async function event(tx: Tx, orderId: string, actorId: string, kind: string, caseVersion: number, detail: Prisma.InputJsonValue = {}) {
  await tx.heldDepositCaseEvent.create({ data: { id: randomUUID(), orderId, actorId, kind, caseVersion, detail } });
}
async function audit(tx: Tx, userId: string, orderId: string, action: string, newData: Prisma.InputJsonValue, context?: Context) {
  await tx.auditLog.create({ data: { userId, action, entity: 'HeldDepositCase', entityId: orderId, newData, ip: context?.ip, userAgent: context?.userAgent } });
}
async function ensureCase(tx: Tx, orderId: string, actorId: string) {
  const existing = await tx.heldDepositCase.findUnique({ where: { orderId } });
  if (existing) return existing;
  const created = await tx.heldDepositCase.create({ data: { orderId } });
  await event(tx, orderId, actorId, 'OPENED', created.version);
  return created;
}
async function lockCase(tx: Tx, orderId: string) {
  await tx.$queryRaw`SELECT "orderId" FROM held_deposit_cases WHERE "orderId"=${orderId} FOR UPDATE`;
  return tx.heldDepositCase.findUniqueOrThrow({ where: { orderId } });
}
/** A database safeguard refused the write: surface a stable 409, never raw SQL text. */
function refused(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const { code, name, message } = error as { code?: string; name?: string; message?: string };
  // Trigger refusals are SQLSTATE P0001; unique/foreign-key races are P2002/P2003.
  if (code === 'P2010' || code === 'P2002' || code === 'P2003'
      || (name === 'PrismaClientUnknownRequestError' && /P0001|RaiseException/.test(message ?? ''))) {
    throw ApiError.conflict('The held-deposit decision was refused by a safeguard. Reload the case and review it again.');
  }
  throw error;
}

/** Bounded, policy-controlled view used by order admission. Default: no exception. */
export async function heldAdmissionState(tx: Tx, userId: string) {
  const [pending, held, policy] = [
    await tx.agentOrder.count({ where: { userId, status: 'CREATED', safetyHold: false } }),
    await tx.agentOrder.count({ where: { userId, status: 'CREATED', safetyHold: true } }),
    await tx.heldDepositRecoveryPolicy.findUnique({ where: { id: true }, select: { admissionExceptionMax: true } }),
  ];
  // Held unpaid orders still count, except for at most the approved number.
  const excepted = Math.min(held, Math.max(0, Math.min(3, policy?.admissionExceptionMax ?? 0)));
  return { pending, held, excepted, blocked: pending + held - excepted >= MAX_PENDING_DEPOSITS };
}

/** What a member or agent may see: a state, never reasons or evidence. */
export async function heldCaseForParty(db: Tx, orderId: string, role: 'member' | 'agent' | 'admin', order: { safetyHold: boolean; status: string }) {
  if (!order.safetyHold) return null;
  const [row, adjudication] = [
    await db.heldDepositCase.findUnique({ where: { orderId }, select: { status: true, memberDeclaration: true } }),
    await db.heldDepositAdjudication.findUnique({ where: { orderId }, select: { outcome: true, createdAt: true } }),
  ];
  const open = (HELD_OPEN_STATUSES as readonly string[]).includes(order.status) && !adjudication;
  const state = adjudication?.outcome === 'VERIFIED_PAYMENT_RECEIVED' ? 'RESOLVED_COINS_CREDITED'
    : adjudication?.outcome === 'VERIFIED_EXTERNAL_RETURN' ? 'RESOLVED_EXTERNAL_RETURN_RECORDED'
    : adjudication?.outcome === 'VERIFIED_UNPAID' ? 'RESOLVED_UNPAID_CLOSED'
    : open ? 'UNDER_REVIEW' : 'HELD';
  return {
    state,
    resolvedAt: adjudication?.createdAt ?? null,
    memberDeclaration: role === 'agent' ? null : row?.memberDeclaration ?? null,
    canDeclareNotPaid: role === 'member' && open && order.status === 'CREATED' && !row?.memberDeclaration,
    canDeclarePaid: role === 'member' && open && row?.memberDeclaration !== 'PAID',
  };
}

/** Member's own positive statement. It changes no money and resolves nothing. */
export async function declareHeldPayment(userId: string, orderId: string, raw: unknown, context?: Context) {
  const args = parse(declarationSchema, raw, 'Choose whether you sent the payment');
  try {
    return await prisma.$transaction(async (tx) => {
      await lockActor(tx, userId, 'member');
      const order = await lockHeldOrder(tx, orderId);
      if (order.userId !== userId) throw ApiError.forbidden('Not your order');
      if (!(HELD_OPEN_STATUSES as readonly string[]).includes(order.status)) throw ApiError.conflict('This order is already closed');
      await ensureCase(tx, orderId, userId);
      const current = await lockCase(tx, orderId);
      if (current.status === 'RESOLVED') throw ApiError.conflict('This order is already closed');
      if (current.memberDeclaration === args.declaration) return heldCaseForParty(tx, orderId, 'member', order);
      if (current.memberDeclaration === 'PAID') throw ApiError.conflict('You already told us you paid. Payment support will investigate.');
      if (args.declaration === 'NOT_PAID' && (order.status !== 'CREATED' || order.paymentSubmittedAt))
        throw ApiError.conflict('This order was already marked as paid. Payment support will investigate.');
      const updated = await tx.heldDepositCase.update({ where: { orderId }, data: { memberDeclaration: args.declaration, memberDeclaredAt: new Date() } });
      await event(tx, orderId, userId, 'MEMBER_DECLARED', updated.version, { declaration: args.declaration });
      await audit(tx, userId, orderId, 'HELD_DEPOSIT_MEMBER_DECLARED', { declaration: args.declaration }, context);
      return heldCaseForParty(tx, orderId, 'member', order);
    });
  } catch (error) { refused(error); }
}

/** Queue for platform administrators: amounts, states and ages only. */
export async function listHeldCases(adminId: string, raw: unknown = {}) {
  const { page } = parse(pageSchema, raw, 'Invalid page');
  return prisma.$transaction(async (tx) => {
    const reviewer = await lockActor(tx, adminId, 'reviewer');
    const where = { safetyHold: true, status: { in: [...HELD_OPEN_STATUSES] } };
    const orders = await tx.agentOrder.findMany({
      where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 50, skip: page * 50,
      select: { id: true, orderNumber: true, status: true, fiatAmount: true, fiatCurrency: true, coinAmount: true, createdAt: true, paymentSubmittedAt: true, userId: true },
    });
    const cases = await tx.heldDepositCase.findMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
    const byOrder = new Map(cases.map((c) => [c.orderId, c]));
    const [totals] = await tx.$queryRaw<Array<{ open: number; reserved: bigint | null; oldest: Date | null; maxPerMember: number | null }>>`
      SELECT count(*)::int AS open, sum(o."coinAmount") AS reserved, min(o."createdAt") AS oldest,
        (SELECT max(n)::int FROM (SELECT count(*) AS n FROM agent_orders x
           WHERE x."safetyHold" AND x.status::text IN ('CREATED','PAYMENT_SUBMITTED','DISPUTE') GROUP BY x."userId") per) AS "maxPerMember"
      FROM agent_orders o WHERE o."safetyHold" AND o.status::text IN ('CREATED','PAYMENT_SUBMITTED','DISPUTE')`;
    return {
      canAdjudicate: reviewer.role === 'SUPER_ADMIN',
      monitoring: {
        openHeldOrders: totals?.open ?? 0, reservedCoins: Number(totals?.reserved ?? 0),
        oldestHeldAt: totals?.oldest ?? null, maxOpenHeldPerMember: totals?.maxPerMember ?? 0,
      },
      cases: orders.map((o) => {
        const c = byOrder.get(o.id);
        return {
          orderId: o.id, orderNumber: o.orderNumber, orderStatus: o.status, fiatAmount: o.fiatAmount, fiatCurrency: o.fiatCurrency,
          coinAmount: o.coinAmount, createdAt: o.createdAt, paymentSubmittedAt: o.paymentSubmittedAt,
          caseStatus: c?.status ?? 'OPEN', classification: c?.classification ?? 'UNREVIEWED',
          memberDeclaration: c?.memberDeclaration ?? null, assignedToMe: c?.assignedAdminId === adminId,
          assigned: Boolean(c?.assignedAdminId), caseVersion: c?.version ?? null,
          party: o.userId === adminId,
        };
      }),
    };
  });
}

/** Full case for the main administrator only: destination snapshot, trail, evidence index. */
export async function getHeldCase(adminId: string, orderId: string) {
  return prisma.$transaction(async (tx) => {
    await lockActor(tx, adminId, 'main');
    const order = await tx.agentOrder.findUnique({ where: { id: orderId }, include: { agent: { select: { userId: true, displayName: true } } } });
    if (!order) throw ApiError.notFound('Order not found');
    if (!order.safetyHold) throw ApiError.conflict('This order is not on safety hold');
    assertNotParty(adminId, order);
    const [row, events, adjudication, reservation, settlement, evidence, disputes, policy, account] = [
      await tx.heldDepositCase.findUnique({ where: { orderId } }),
      await tx.heldDepositCaseEvent.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 200 }),
      await tx.heldDepositAdjudication.findUnique({ where: { orderId } }),
      await tx.agentReservation.findUnique({ where: { orderId }, select: { id: true, status: true, amount: true } }),
      await tx.agentOrderSettlement.findUnique({ where: { orderId }, select: { id: true, coinAmount: true, settledAt: true } }),
      await tx.paymentEvidence.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, take: 50,
        select: { id: true, referenceNumber: true, paymentTimestamp: true, note: true, createdAt: true } }),
      await tx.dispute.findMany({ where: { orderId }, orderBy: { openedAt: 'asc' }, take: 20, select: { id: true, status: true, reason: true, openedAt: true } }),
      await tx.heldDepositRecoveryPolicy.findUnique({ where: { id: true } }),
      await tx.agentPaymentAccount.findUnique({ where: { id: order.paymentAccountId }, select: { status: true, safetyHold: true } }),
    ];
    return {
      order: {
        id: order.id, orderNumber: order.orderNumber, status: order.status, userId: order.userId, agentId: order.agentId,
        agentName: order.agent.displayName, fiatAmount: order.fiatAmount, fiatCurrency: order.fiatCurrency, coinAmount: order.coinAmount,
        createdAt: order.createdAt, paymentSubmittedAt: order.paymentSubmittedAt,
        // The immutable destination the member was shown. Never editable here.
        paymentSnapshot: order.paymentSnapshot, paymentAccountRevision: order.paymentAccountRevision,
      },
      receivingAccount: account ?? { status: 'MISSING', safetyHold: true },
      case: row ? { status: row.status, classification: row.classification, memberDeclaration: row.memberDeclaration,
        memberDeclaredAt: row.memberDeclaredAt, assignedToMe: row.assignedAdminId === adminId, assigned: Boolean(row.assignedAdminId),
        version: row.version, openedAt: row.openedAt, resolvedAt: row.resolvedAt } : null,
      reservation, settlement, memberEvidence: evidence, disputes, events,
      adjudication: adjudication ? { ...adjudication, authorizedTxid: undefined, requestHash: undefined, stepUpId: undefined } : null,
      policy: {
        unpaidReleaseEnabled: policy?.unpaidReleaseEnabled ?? false, coinCreditEnabled: policy?.coinCreditEnabled ?? false,
        externalReturnEnabled: policy?.externalReturnEnabled ?? false,
      },
      confirmationPurpose: heldAdjudicationPurpose(orderId),
    };
  });
}

/** OPEN → ASSIGNED for one main administrator. Idempotent for the assignee. */
export async function claimHeldCase(adminId: string, orderId: string, context?: Context) {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockActor(tx, adminId, 'main');
      const order = await lockHeldOrder(tx, orderId);
      assertNotParty(adminId, order);
      if (!(HELD_OPEN_STATUSES as readonly string[]).includes(order.status)) throw ApiError.conflict('This order is already closed');
      await ensureCase(tx, orderId, adminId);
      const current = await lockCase(tx, orderId);
      if (current.status === 'ASSIGNED' && current.assignedAdminId === adminId) return { orderId, status: current.status, version: current.version };
      if (current.status !== 'OPEN') throw ApiError.conflict('This case is already assigned or resolved');
      const updated = await tx.heldDepositCase.update({ where: { orderId }, data: { status: 'ASSIGNED', assignedAdminId: adminId, assignedAt: new Date() } });
      await event(tx, orderId, adminId, 'CLAIMED', updated.version);
      await audit(tx, adminId, orderId, 'HELD_DEPOSIT_CASE_CLAIMED', { version: updated.version }, context);
      return { orderId, status: updated.status, version: updated.version };
    });
  } catch (error) { refused(error); }
}

/** The assignee hands the case back; nothing financial changes. */
export async function releaseHeldCase(adminId: string, orderId: string, raw: unknown, context?: Context) {
  const args = parse(noteSchema, raw, 'A note of at least 10 characters and the displayed case version are required');
  try {
    return await prisma.$transaction(async (tx) => {
      await lockActor(tx, adminId, 'main');
      const order = await lockHeldOrder(tx, orderId);
      assertNotParty(adminId, order);
      const current = await lockCase(tx, orderId).catch(() => null);
      if (!current || current.status !== 'ASSIGNED' || current.assignedAdminId !== adminId) throw ApiError.conflict('Only the assigned administrator can release this case');
      if (current.version !== args.expectedCaseVersion) throw ApiError.conflict('Case changed; reload it and review again');
      const updated = await tx.heldDepositCase.update({ where: { orderId }, data: { status: 'OPEN', assignedAdminId: null, assignedAt: null } });
      await event(tx, orderId, adminId, 'RELEASED', updated.version, { note: args.note });
      await audit(tx, adminId, orderId, 'HELD_DEPOSIT_CASE_RELEASED', { version: updated.version }, context);
      return { orderId, status: updated.status, version: updated.version };
    });
  } catch (error) { refused(error); }
}

/** Marks "payment claimed / unknown": kept for investigation, no financial effect. */
export async function markHeldCaseUnknown(adminId: string, orderId: string, raw: unknown, context?: Context) {
  const args = parse(noteSchema, raw, 'A note of at least 10 characters and the displayed case version are required');
  try {
    return await prisma.$transaction(async (tx) => {
      await lockActor(tx, adminId, 'main');
      const order = await lockHeldOrder(tx, orderId);
      assertNotParty(adminId, order);
      const current = await lockCase(tx, orderId).catch(() => null);
      if (!current || current.status !== 'ASSIGNED' || current.assignedAdminId !== adminId) throw ApiError.conflict('Claim the case before recording an assessment');
      if (current.version !== args.expectedCaseVersion) throw ApiError.conflict('Case changed; reload it and review again');
      const updated = await tx.heldDepositCase.update({ where: { orderId }, data: { classification: 'PAYMENT_CLAIMED_UNKNOWN' } });
      await event(tx, orderId, adminId, 'CLASSIFIED', updated.version, { classification: 'PAYMENT_CLAIMED_UNKNOWN', note: args.note });
      await audit(tx, adminId, orderId, 'HELD_DEPOSIT_CASE_CLASSIFIED', { classification: 'PAYMENT_CLAIMED_UNKNOWN', version: updated.version }, context);
      return { orderId, status: updated.status, classification: updated.classification, version: updated.version };
    });
  } catch (error) { refused(error); }
}

type StoredAdjudication = { id: string; orderId: string; outcome: string; coinAmount: number; createdAt: Date };
function result(row: StoredAdjudication, idempotent: boolean) {
  const credited = row.outcome === 'VERIFIED_PAYMENT_RECEIVED';
  return {
    adjudicationId: row.id, orderId: row.orderId, outcome: row.outcome,
    orderStatus: credited ? 'COMPLETED' : 'CANCELLED',
    // Released inventory returns to the AGENT's available stock. It is not a refund.
    agentReservation: credited ? 'CONSUMED' : 'RELEASED',
    coinsCredited: credited ? row.coinAmount : 0,
    externalReturnRecorded: row.outcome === 'VERIFIED_EXTERNAL_RETURN',
    adjudicatedAt: row.createdAt, idempotent,
  };
}

/**
 * The single authorised way to resolve a held deposit. One transaction:
 * scope lock → users → account → order → case → confirmation → adjudication
 * (database-authorised) → references → order/reservation/ledger → case,
 * disputes, trail, audit and notifications.
 */
export async function adjudicateHeldDeposit(adminId: string, tokenIat: number, orderId: string, raw: unknown, context?: Context) {
  const args = parse(adjudicationSchema, raw, 'Check the outcome, reason, evidence, references, amounts and times');
  if (!Number.isSafeInteger(tokenIat) || tokenIat <= 0) throw ApiError.unauthorized('Fresh authentication required');
  const hash = requestHash(orderId, args);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockUserEconomicScope(tx, `agent_order:${orderId}`);
      // Retries return the original result without consuming another confirmation.
      const prior = await tx.heldDepositAdjudication.findUnique({ where: { orderId } });
      if (prior) {
        if (prior.adminId === adminId && prior.idempotencyKey === args.idempotencyKey && prior.requestHash === hash) return result(prior, true);
        throw ApiError.conflict('This order already has a different adjudication');
      }
      if (await tx.heldDepositAdjudication.findUnique({ where: { adminId_idempotencyKey: { adminId, idempotencyKey: args.idempotencyKey } }, select: { id: true } }))
        throw ApiError.conflict('Request key was already used for a different decision');

      const preview = await tx.agentOrder.findUnique({ where: { id: orderId }, select: { userId: true } });
      if (!preview) throw ApiError.notFound('Order not found');
      // L1: both users in ascending order, before any order, inventory or wallet lock.
      const participants = await tx.$queryRaw<Array<{ id: string; role: string; status: string }>>`
        SELECT id, role::text AS role, status::text AS status FROM users
        WHERE id = ${preview.userId} OR id = ${adminId} ORDER BY id FOR SHARE`;
      const admin = participants.find((u) => u.id === adminId);
      if (!admin || admin.status !== 'ACTIVE' || admin.role !== 'SUPER_ADMIN') throw ApiError.forbidden('Only an active main administrator may adjudicate held deposits');
      if (!participants.some((u) => u.id === preview.userId)) throw ApiError.internal('Buyer missing for held order');

      const order = await lockHeldOrder(tx, orderId);
      assertNotParty(adminId, order);
      if (!(HELD_OPEN_STATUSES as readonly string[]).includes(order.status)) throw ApiError.conflict(`Order cannot be adjudicated in its current state (${order.status})`);
      const current = await lockCase(tx, orderId).catch(() => null);
      if (!current || current.status !== 'ASSIGNED' || current.assignedAdminId !== adminId) throw ApiError.forbidden('Claim the case before adjudicating it');
      if (current.version !== args.expectedCaseVersion) throw ApiError.conflict('Case changed; reload it and review again');

      const policy = await tx.heldDepositRecoveryPolicy.findUnique({ where: { id: true } });
      const enabled = args.outcome === 'VERIFIED_UNPAID' ? policy?.unpaidReleaseEnabled
        : args.outcome === 'VERIFIED_PAYMENT_RECEIVED' ? policy?.coinCreditEnabled : policy?.externalReturnEnabled;
      if (!enabled) throw ApiError.conflict('This outcome is not enabled by approved policy. The order stays on hold.');

      const reservation = await tx.agentReservation.findUnique({ where: { orderId } });
      if (!reservation || reservation.status !== 'ACTIVE') throw ApiError.conflict('The order\'s reservation is not active');
      if (await tx.agentOrderSettlement.findUnique({ where: { orderId }, select: { id: true } })) throw ApiError.conflict('Order is already settled');

      const credited = args.outcome === 'VERIFIED_PAYMENT_RECEIVED';
      if (args.outcome === 'VERIFIED_UNPAID') {
        if (order.status !== 'CREATED' || order.paymentSubmittedAt || current.memberDeclaration !== 'NOT_PAID')
          throw ApiError.conflict('Non-payment is not verified: the member must have declared it and never marked the order paid');
      } else {
        if (credited && args.verifiedAmount !== order.fiatAmount)
          throw ApiError.conflict('The verified amount differs from the order amount. Keep the case under investigation.');
        if (args.outcome === 'VERIFIED_EXTERNAL_RETURN') {
          if (args.returnedAmount !== args.verifiedAmount) throw ApiError.conflict('Only a full return can be recorded. Keep the case under investigation.');
          if (args.returnReference === args.verifiedPaymentReference) throw ApiError.badRequest('Return and incoming payment must be different transfers');
        }
        const refs: Array<[string, 'PAYMENT' | 'RETURN']> = [[args.verifiedPaymentReference, 'PAYMENT']];
        if (args.outcome === 'VERIFIED_EXTERNAL_RETURN') refs.push([args.returnReference, 'RETURN']);
        for (const [ref, kind] of refs) {
          const clash = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT e.id FROM payment_evidence e JOIN agent_orders o ON o.id=e."orderId"
            WHERE o."paymentMethodDefId"=${order.paymentMethodDefId} AND upper(btrim(e."referenceNumber"))=${ref}
              AND (e."orderId"<>${order.id} OR ${kind}='RETURN') LIMIT 1`;
          if (clash.length) throw ApiError.conflict('Transfer reference appears in other deposit evidence. Keep the case under investigation.');
        }
      }

      // Fresh, case-specific and single-use; bound to this decision by a unique column.
      const stepUpId = await consumeStepUp({ userId: adminId, tokenIat }, heldAdjudicationPurpose(orderId), tx);
      const paid = args.outcome === 'VERIFIED_UNPAID' ? null : args;
      const returned = args.outcome === 'VERIFIED_EXTERNAL_RETURN' ? args : null;
      const adjudication = await tx.heldDepositAdjudication.create({
        data: {
          orderId, id: randomUUID(), outcome: args.outcome, adminId, idempotencyKey: args.idempotencyKey, requestHash: hash, stepUpId,
          caseVersion: current.version, orderStatusBefore: order.status, reservationId: reservation.id,
          coinAmount: order.coinAmount, fiatAmount: order.fiatAmount, reason: args.reason, evidence: args.evidence,
          verifiedPaymentReference: paid?.verifiedPaymentReference ?? null, verifiedAmount: paid?.verifiedAmount ?? null,
          verifiedPaidAt: paid ? new Date(paid.verifiedPaidAt) : null,
          returnReference: returned?.returnReference ?? null, returnedAmount: returned?.returnedAmount ?? null,
          returnedAt: returned ? new Date(returned.returnedAt) : null,
          authorizedTxid: 0n, // overwritten by the database with this transaction's id
        },
      });
      if (paid) await tx.heldDepositReferenceClaim.create({ data: { methodId: order.paymentMethodDefId, reference: paid.verifiedPaymentReference, orderId, kind: 'PAYMENT' } });
      if (returned) await tx.heldDepositReferenceClaim.create({ data: { methodId: order.paymentMethodDefId, reference: returned.returnReference, orderId, kind: 'RETURN' } });

      const now = new Date();
      const orderClaim = await tx.agentOrder.updateMany({
        where: { id: orderId, status: order.status, safetyHold: true },
        data: credited ? { status: 'COMPLETED', completedAt: now } : { status: 'CANCELLED', cancelledAt: now },
      });
      if (orderClaim.count === 0) throw ApiError.conflict('Order state changed; review the case again');
      const reservationClaim = await tx.agentReservation.updateMany({
        where: { id: reservation.id, orderId, status: 'ACTIVE' },
        data: credited ? { status: 'CONSUMED', consumedAt: now } : { status: 'RELEASED', releasedAt: now },
      });
      if (reservationClaim.count === 0) throw ApiError.conflict('Reservation already released or consumed');

      let settlementId: string | null = null;
      if (credited) {
        await consumeReservedInventory(tx, order.agentId, reservation.amount, orderId, reservation.id);
        const credit = await creditCoins(tx, order.userId, order.coinAmount, {
          type: 'PURCHASE', scopeType: 'AGENT_ORDER', scopeId: orderId, referenceType: 'AGENT_ORDER', referenceId: orderId,
          description: `Coins purchased via agent order ${order.orderNumber} (held-deposit adjudication)`,
          createdBy: adminId,
          completePurchaseProof: async (purchaseTx, walletTransactionId) => (await purchaseTx.agentOrderSettlement.create({
            data: { orderId, reservationId: reservation.id, coinAmount: order.coinAmount, walletTransactionId, resolvedVia: 'ADMIN_DISPUTE_RESOLUTION', releasedBy: adminId },
          })).id,
        });
        settlementId = credit.purchaseSettlementId ?? null;
        if (!settlementId) throw ApiError.internal('Held-deposit credit lacks a purchase witness');
      } else {
        // Returns the AGENT's reserved stock to available. No member balance changes.
        await releaseReservedInventory(tx, order.agentId, reservation.amount, orderId, reservation.id);
      }

      await tx.dispute.updateMany({
        where: { orderId, status: { in: ['OPEN', 'ASSIGNED'] } },
        data: { status: 'RESOLVED', resolution: credited ? 'RELEASE' : 'CANCEL', resolvedBy: adminId, resolvedAt: now,
          resolutionNote: `Closed by held-deposit adjudication ${adjudication.id}` },
      });
      const resolved = await tx.heldDepositCase.update({ where: { orderId }, data: { status: 'RESOLVED', classification: args.outcome } });
      const summary = { adjudicationId: adjudication.id, outcome: args.outcome, orderStatusBefore: order.status,
        orderStatusAfter: credited ? 'COMPLETED' : 'CANCELLED', agentReservation: credited ? 'CONSUMED' : 'RELEASED',
        coinsCredited: credited ? order.coinAmount : 0, settlementId };
      await event(tx, orderId, adminId, 'ADJUDICATED', resolved.version, { ...summary, reason: args.reason, evidence: args.evidence });
      // The general audit log carries the decision, not the sensitive evidence.
      await audit(tx, adminId, orderId, 'HELD_DEPOSIT_ADJUDICATED', summary, context);
      for (const userId of new Set([order.userId, order.agent.userId])) {
        await tx.notification.create({ data: {
          userId, type: 'SYSTEM', title: 'Payment order update',
          body: 'Payment order updated. Open the order to see its status and next step.',
          data: { orderId, orderNumber: order.orderNumber, url: `/wallet/orders/deposit/${orderId}` },
        } });
      }
      // Run the deferred completeness check now. Prisma does not surface an
      // error raised at COMMIT, so a refusal there could be reported as success.
      await tx.$executeRawUnsafe('SET CONSTRAINTS public.held_deposit_adjudication_complete IMMEDIATE');
      return result(adjudication, false);
    }, { timeout: 20_000 });
  } catch (error) { refused(error); }
}
