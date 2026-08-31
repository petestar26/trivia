import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { applyBalanceChanges, getOrCreateWallet } from '../economy/wallet-service';
import { assertPlatformAdmin } from './agent-service';
import { releaseReservedInventory, consumeReservedInventory } from './inventory-service';

// Phase F scope note: only the manually-initiated dispute path is
// implemented here (customer or agent opens a dispute; an admin claims and
// resolves it). The SYSTEM/auto-open-on-timeout path (Dispute.openedBy =
// "SYSTEM") is NOT implemented — it requires an authoritative timeout
// duration and scheduled-sweep infrastructure, neither of which exists
// anywhere in this repository (see the Phase F report). Everything below
// is reachable only from AgentOrderStatus.PAYMENT_SUBMITTED, entirely
// independent of that missing piece.

export type DisputeReason = 'PAYMENT_NOT_RECEIVED' | 'WRONG_AMOUNT' | 'AGENT_UNRESPONSIVE' | 'OTHER';

export interface OpenDisputeArgs {
  orderId: string;
  reason: DisputeReason;
  description: string;
  idempotencyKey: string;
}

function validateOpenArgs(args: OpenDisputeArgs) {
  if (!args.orderId || typeof args.orderId !== 'string') throw ApiError.badRequest('orderId is required');
  const validReasons: DisputeReason[] = ['PAYMENT_NOT_RECEIVED', 'WRONG_AMOUNT', 'AGENT_UNRESPONSIVE', 'OTHER'];
  if (!validReasons.includes(args.reason)) throw ApiError.badRequest('Invalid dispute reason');
  if (!args.description || args.description.trim().length === 0) {
    throw ApiError.badRequest('A description is required to open a dispute');
  }
  if (!args.idempotencyKey || typeof args.idempotencyKey !== 'string') {
    throw ApiError.badRequest('idempotencyKey is required');
  }
}

function disputeRequestFieldsMatch(dispute: { reason: string; description: string }, args: OpenDisputeArgs) {
  return dispute.reason === args.reason && dispute.description === args.description.trim();
}

/**
 * Resolves whether actorUserId is the order's customer or its own agent —
 * never trusted from the request, always re-derived. Only these two parties
 * may open a dispute on an order (schema: openedBy is "user, agent, or
 * SYSTEM" — SYSTEM is out of scope here).
 */
async function resolveDisputeParty(actorUserId: string, order: { userId: string; agentId: string }) {
  if (order.userId === actorUserId) return 'customer' as const;
  const agent = await prisma.agent.findUnique({ where: { id: order.agentId }, select: { userId: true } });
  if (agent && agent.userId === actorUserId) return 'agent' as const;
  throw ApiError.forbidden('You do not have access to this order');
}

/**
 * Open a dispute on an order. Legal only from PAYMENT_SUBMITTED (the
 * customer claims to have paid; something is now in disagreement between
 * the two parties). Atomically transitions the order to DISPUTE.
 *
 * Idempotency: [orderId, idempotencyKey] — a replay with matching fields
 * returns the original; a replay with different fields conflicts. A NEW
 * dispute attempt (different idempotencyKey) while one is already active is
 * rejected outright — the partial unique index (orderId WHERE status IN
 * ('OPEN','ASSIGNED'), added in the Phase C migration) is the DB-level
 * backstop against two concurrent opens ever both succeeding.
 */
export async function openDispute(
  actorUserId: string,
  rawArgs: OpenDisputeArgs,
  context?: { ip?: string; userAgent?: string }
) {
  validateOpenArgs(rawArgs);
  const args = rawArgs;

  const existing = await prisma.dispute.findUnique({
    where: { orderId_idempotencyKey: { orderId: args.orderId, idempotencyKey: args.idempotencyKey } },
  });
  if (existing) {
    if (disputeRequestFieldsMatch(existing, args)) {
      return { dispute: existing, idempotent: true };
    }
    throw ApiError.conflict('A dispute already exists for this idempotency key with different request data');
  }

  const order = await prisma.agentOrder.findUnique({ where: { id: args.orderId } });
  if (!order) throw ApiError.notFound('Order not found');
  const party = await resolveDisputeParty(actorUserId, order);

  const activeDispute = await prisma.dispute.findFirst({
    where: { orderId: args.orderId, status: { in: ['OPEN', 'ASSIGNED'] } },
  });
  if (activeDispute) {
    throw ApiError.conflict('An active dispute already exists for this order');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const claim = await tx.agentOrder.updateMany({
        where: { id: args.orderId, status: 'PAYMENT_SUBMITTED' },
        data: { status: 'DISPUTE' },
      });
      if (claim.count === 0) {
        const current = await tx.agentOrder.findUnique({ where: { id: args.orderId } });
        throw ApiError.conflict(`Order cannot enter dispute from its current state (${current?.status})`);
      }

      const dispute = await tx.dispute.create({
        data: {
          orderId: args.orderId,
          openedBy: actorUserId,
          reason: args.reason,
          description: args.description.trim(),
          status: 'OPEN',
          idempotencyKey: args.idempotencyKey,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: actorUserId,
          action: 'AGENT_DISPUTE_OPENED',
          entity: 'Dispute',
          entityId: dispute.id,
          newData: { orderId: args.orderId, reason: args.reason, openedByRole: party },
          ip: context?.ip,
          userAgent: context?.userAgent,
        },
      });

      // Notify whichever party did NOT open the dispute.
      const agent = await tx.agent.findUnique({ where: { id: order.agentId } });
      const notifyUserId = party === 'customer' ? agent!.userId : order.userId;
      await tx.notification.create({
        data: {
          userId: notifyUserId,
          type: 'AGENT_DISPUTE_OPENED',
          title: 'Dispute Opened',
          body: `A dispute was opened on order ${order.orderNumber}.`,
          data: { orderId: args.orderId, disputeId: dispute.id, reason: args.reason },
        },
      });

      return { dispute, idempotent: false };
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'P2002') throw err;

    // Same robust-refetch discipline as order creation (Phase E): don't
    // parse meta.target, just resolve by what we know must be true.
    const winner = await prisma.dispute.findUnique({
      where: { orderId_idempotencyKey: { orderId: args.orderId, idempotencyKey: args.idempotencyKey } },
    });
    if (winner) {
      if (disputeRequestFieldsMatch(winner, args)) {
        return { dispute: winner, idempotent: true };
      }
      throw ApiError.conflict('A dispute already exists for this idempotency key with different request data');
    }
    throw ApiError.conflict('An active dispute already exists for this order');
  }
}

async function requireDisputeAccess(actorUserId: string, dispute: { orderId: string }) {
  const order = await prisma.agentOrder.findUnique({ where: { id: dispute.orderId } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.userId === actorUserId) return 'customer';
  const agent = await prisma.agent.findUnique({ where: { id: order.agentId }, select: { userId: true } });
  if (agent && agent.userId === actorUserId) return 'agent';
  const user = await prisma.user.findUnique({ where: { id: actorUserId }, select: { role: true } });
  if (user && (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN')) return 'admin';
  throw ApiError.forbidden('You do not have access to this dispute');
}

export async function getDisputeById(actorUserId: string, disputeId: string) {
  const dispute = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!dispute) throw ApiError.notFound('Dispute not found');
  await requireDisputeAccess(actorUserId, dispute);
  return dispute;
}

export async function listOpenDisputesForAdmin() {
  return prisma.dispute.findMany({ where: { status: 'OPEN' }, orderBy: { openedAt: 'asc' } });
}

async function assertNotSelfDispute(adminId: string, orderId: string) {
  const order = await prisma.agentOrder.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.userId === adminId) throw ApiError.forbidden('You cannot act on a dispute for your own order');
  const agent = await prisma.agent.findUnique({ where: { id: order.agentId }, select: { userId: true } });
  if (agent && agent.userId === adminId) {
    throw ApiError.forbidden('You cannot act on a dispute for your own agent account');
  }
  return order;
}

/**
 * Admin claims an OPEN dispute (Phase B decision 5: "single-admin dispute
 * resolution" — one admin owns a dispute from claim through resolution).
 * Atomic: OPEN -> ASSIGNED only, self-review guarded.
 */
export async function claimDispute(
  adminId: string,
  disputeId: string,
  context?: { ip?: string; userAgent?: string }
) {
  await assertPlatformAdmin(adminId);

  return prisma.$transaction(async (tx) => {
    const before = await tx.dispute.findUnique({ where: { id: disputeId } });
    if (!before) throw ApiError.notFound('Dispute not found');
    await assertNotSelfDispute(adminId, before.orderId);

    const claim = await tx.dispute.updateMany({
      where: { id: disputeId, status: 'OPEN' },
      data: { status: 'ASSIGNED', assignedAdminId: adminId, assignedAt: new Date() },
    });
    if (claim.count === 0) {
      const current = await tx.dispute.findUnique({ where: { id: disputeId } });
      throw ApiError.conflict(`Dispute cannot be claimed in its current state (${current?.status})`);
    }

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'AGENT_DISPUTE_CLAIMED',
        entity: 'Dispute',
        entityId: disputeId,
        oldData: { status: 'OPEN' },
        newData: { status: 'ASSIGNED', assignedAdminId: adminId },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    return { disputeId, status: 'ASSIGNED' };
  });
}

export type DisputeResolutionValue = 'RELEASE' | 'CANCEL';

/**
 * Admin resolves a claimed dispute. Legal only from ASSIGNED, and only by
 * the SAME admin who claimed it (decision 5 — single-admin resolution: this
 * is what "single" means, not merely "some admin", otherwise two different
 * admins could contradict each other on the same dispute).
 *
 * RELEASE: the order settles exactly like Phase E's agent-release path, but
 * admin-triggered — reuses the same lower-level primitives
 * (consumeReservedInventory, applyBalanceChanges) directly rather than
 * modifying settleAgentOrder, per the explicit instruction not to rewrite
 * the existing settlement system. resolvedVia is ADMIN_DISPUTE_RESOLUTION,
 * releasedBy is the resolving admin's userId.
 *
 * CANCEL: the order is cancelled and the reservation released, mirroring
 * Phase E's cancelAgentOrder path but admin-triggered from DISPUTE instead
 * of customer-triggered from CREATED.
 */
export async function resolveDispute(
  adminId: string,
  disputeId: string,
  resolution: DisputeResolutionValue,
  resolutionNote: string,
  context?: { ip?: string; userAgent?: string }
) {
  if (resolution !== 'RELEASE' && resolution !== 'CANCEL') {
    throw ApiError.badRequest('resolution must be RELEASE or CANCEL');
  }
  if (!resolutionNote || resolutionNote.trim().length === 0) {
    throw ApiError.badRequest('A resolution note is required');
  }
  await assertPlatformAdmin(adminId);

  return prisma.$transaction(async (tx) => {
    const before = await tx.dispute.findUnique({ where: { id: disputeId } });
    if (!before) throw ApiError.notFound('Dispute not found');
    await assertNotSelfDispute(adminId, before.orderId);
    if (before.assignedAdminId !== adminId) {
      throw ApiError.forbidden('Only the admin who claimed this dispute may resolve it');
    }

    const claim = await tx.dispute.updateMany({
      where: { id: disputeId, status: 'ASSIGNED' },
      data: { status: 'RESOLVED', resolution, resolutionNote: resolutionNote.trim(), resolvedBy: adminId, resolvedAt: new Date() },
    });
    if (claim.count === 0) {
      const current = await tx.dispute.findUnique({ where: { id: disputeId } });
      throw ApiError.conflict(`Dispute cannot be resolved in its current state (${current?.status})`);
    }

    const order = await tx.agentOrder.findUnique({ where: { id: before.orderId } });
    if (!order) throw ApiError.internal('Order missing for dispute during resolution');

    const reservation = await tx.agentReservation.findUnique({ where: { orderId: order.id } });
    if (!reservation) throw ApiError.internal('Reservation missing for order during dispute resolution');

    if (resolution === 'RELEASE') {
      const orderClaim = await tx.agentOrder.updateMany({
        where: { id: order.id, status: 'DISPUTE' },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      if (orderClaim.count === 0) throw ApiError.internal('Order left DISPUTE unexpectedly during resolution');

      const reservationClaim = await tx.agentReservation.updateMany({
        where: { orderId: order.id, status: 'ACTIVE' },
        data: { status: 'CONSUMED', consumedAt: new Date() },
      });
      if (reservationClaim.count === 0) throw ApiError.conflict('Reservation already released or consumed');

      await consumeReservedInventory(tx, order.agentId, reservation.amount, order.id, reservation.id);
      await getOrCreateWallet(order.userId, tx);
      const balanceResult = await applyBalanceChanges(tx, order.userId, [
        {
          currency: 'COINS',
          amount: order.coinAmount,
          ledgerType: 'CREDIT',
          transactionType: 'COIN_CREDIT',
          referenceType: 'AGENT_ORDER',
          referenceId: order.id,
          description: `Coins purchased via agent order ${order.orderNumber} (dispute-resolved release)`,
        },
      ]);

      await tx.agentOrderSettlement.create({
        data: {
          orderId: order.id,
          reservationId: reservation.id,
          coinAmount: order.coinAmount,
          walletTransactionId: balanceResult.transactions[0].id,
          resolvedVia: 'ADMIN_DISPUTE_RESOLUTION',
          releasedBy: adminId,
        },
      });
    } else {
      const orderClaim = await tx.agentOrder.updateMany({
        where: { id: order.id, status: 'DISPUTE' },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      if (orderClaim.count === 0) throw ApiError.internal('Order left DISPUTE unexpectedly during resolution');

      const reservationClaim = await tx.agentReservation.updateMany({
        where: { orderId: order.id, status: 'ACTIVE' },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      if (reservationClaim.count === 0) throw ApiError.conflict('Reservation already released or consumed');

      await releaseReservedInventory(tx, order.agentId, reservation.amount, order.id, reservation.id);
    }

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'AGENT_DISPUTE_RESOLVED',
        entity: 'Dispute',
        entityId: disputeId,
        oldData: { status: 'ASSIGNED' },
        newData: { status: 'RESOLVED', resolution, resolutionNote: resolutionNote.trim() },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    const agent = await tx.agent.findUnique({ where: { id: order.agentId } });
    for (const userId of [order.userId, agent!.userId]) {
      await tx.notification.create({
        data: {
          userId,
          type: 'AGENT_DISPUTE_RESOLVED',
          title: 'Dispute Resolved',
          body: `The dispute on order ${order.orderNumber} was resolved: ${resolution === 'RELEASE' ? 'coins released to the customer' : 'order cancelled'}.`,
          data: { orderId: order.id, disputeId, resolution },
        },
      });
    }

    return { disputeId, status: 'RESOLVED', resolution, orderId: order.id };
  });
}
