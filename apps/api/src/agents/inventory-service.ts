import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { assertPlatformAdmin } from './agent-service';

/**
 * SUPER_ADMIN-only gate — stricter than assertPlatformAdmin, used
 * exclusively for direct inventory adjustment (Phase B decision 6: "SUPER_ADMIN
 * is the intended authority for direct inventory adjustment"). Reads
 * User.role fresh, same as assertPlatformAdmin, never trusted from the caller.
 */
export async function assertSuperAdmin(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!user) throw ApiError.unauthorized('Authentication required');
  if (user.role !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('SUPER_ADMIN privileges required');
  }
  return user;
}

async function loadTargetAgent(agentId: string, adminId: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw ApiError.notFound('Agent not found');
  if (agent.userId === adminId) {
    throw ApiError.forbidden('You cannot fund or adjust your own agent inventory');
  }
  return agent;
}

/**
 * First-ever funding of an agent's inventory (Phase B decision 2:
 * "admin-only inventory allocation at launch"). AgentInventory is
 * `Agent.inventory?` — optional — so "no row yet" is a real, distinct state.
 * Legal exactly once per agent: subsequent funding changes go through
 * adjustAgentInventory (SUPER_ADMIN-only, signed). Idempotent via the
 * ledger's `@@unique([agentId, idempotencyKey])`.
 */
export async function fundAgentInventory(
  adminId: string,
  agentId: string,
  amount: number,
  idempotencyKey: string,
  context?: { ip?: string; userAgent?: string }
) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw ApiError.badRequest('Funding amount must be a positive integer');
  }
  if (!idempotencyKey) {
    throw ApiError.badRequest('idempotencyKey is required');
  }
  await assertPlatformAdmin(adminId);
  const agent = await loadTargetAgent(agentId, adminId);

  const existingLedger = await prisma.agentInventoryLedger.findUnique({
    where: { agentId_idempotencyKey: { agentId, idempotencyKey } },
  });
  if (existingLedger) {
    return prisma.agentInventory.findUnique({ where: { agentId } });
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const existingInventory = await tx.agentInventory.findUnique({ where: { agentId: agent.id } });
      if (existingInventory) {
        throw ApiError.conflict('Agent inventory already exists — use the adjustment operation instead');
      }

      const inventory = await tx.agentInventory.create({
        data: { agentId: agent.id, totalBalance: amount, reservedBalance: 0 },
      });

      await tx.agentInventoryLedger.create({
        data: {
          agentId: agent.id,
          type: 'INITIAL_ALLOCATION',
          amount,
          totalBefore: 0,
          totalAfter: amount,
          reservedBefore: 0,
          reservedAfter: 0,
          performedByAdminId: adminId,
          idempotencyKey,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: adminId,
          action: 'AGENT_INVENTORY_FUNDED',
          entity: 'AgentInventory',
          entityId: inventory.id,
          newData: { agentId: agent.id, amount, totalAfter: amount },
          ip: context?.ip,
          userAgent: context?.userAgent,
        },
      });

      return inventory;
    });
  } catch (err) {
    // Two concurrent first-time-funding attempts for the same agent can
    // both pass the existingInventory check above before either commits —
    // AgentInventory.agentId's unique constraint is the real backstop
    // preventing a double-funded row; this just converts that race into
    // the same friendly conflict the sequential check already produces,
    // rather than leaking a raw P2002.
    if ((err as { code?: string }).code === 'P2002') {
      throw ApiError.conflict('Agent inventory already exists — use the adjustment operation instead');
    }
    throw err;
  }
}

/**
 * Signed inventory adjustment for an agent that already has inventory
 * (Phase B decision 6: SUPER_ADMIN-only). A deduction may never take
 * totalBalance below the current reservedBalance — coins already promised
 * to live orders cannot be clawed back. Version-pinned atomic update,
 * mirroring Wallet's applyBalanceChanges (schema: "version ... mirrors
 * Wallet.version"). Idempotent via the ledger's unique [agentId, idempotencyKey].
 */
export async function adjustAgentInventory(
  adminId: string,
  agentId: string,
  signedAmount: number,
  reason: string,
  idempotencyKey: string,
  context?: { ip?: string; userAgent?: string }
) {
  if (!Number.isInteger(signedAmount) || signedAmount === 0) {
    throw ApiError.badRequest('Adjustment amount must be a non-zero integer');
  }
  if (!reason || reason.trim().length === 0) {
    throw ApiError.badRequest('A reason is required for an inventory adjustment');
  }
  if (!idempotencyKey) {
    throw ApiError.badRequest('idempotencyKey is required');
  }
  await assertSuperAdmin(adminId);
  const agent = await loadTargetAgent(agentId, adminId);

  const existingLedger = await prisma.agentInventoryLedger.findUnique({
    where: { agentId_idempotencyKey: { agentId, idempotencyKey } },
  });
  if (existingLedger) {
    return prisma.agentInventory.findUnique({ where: { agentId } });
  }

  return prisma.$transaction(async (tx) => {
    const inventory = await tx.agentInventory.findUnique({ where: { agentId: agent.id } });
    if (!inventory) {
      throw ApiError.conflict('Agent has no inventory yet — use the funding operation first');
    }

    const newTotal = inventory.totalBalance + signedAmount;
    if (newTotal < 0) {
      throw ApiError.badRequest('Adjustment would take totalBalance negative');
    }
    if (newTotal < inventory.reservedBalance) {
      throw ApiError.badRequest(
        'Adjustment would take totalBalance below reservedBalance — coins already reserved for live orders cannot be removed'
      );
    }

    const claim = await tx.agentInventory.updateMany({
      where: { id: inventory.id, version: inventory.version },
      data: { totalBalance: newTotal, version: { increment: 1 } },
    });
    if (claim.count === 0) {
      throw ApiError.conflict('Concurrent inventory modification — please retry');
    }

    await tx.agentInventoryLedger.create({
      data: {
        agentId: agent.id,
        type: 'ADMIN_ADJUSTMENT',
        amount: Math.abs(signedAmount),
        totalBefore: inventory.totalBalance,
        totalAfter: newTotal,
        reservedBefore: inventory.reservedBalance,
        reservedAfter: inventory.reservedBalance,
        reason: reason.trim(),
        performedByAdminId: adminId,
        idempotencyKey,
      },
    });

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'AGENT_INVENTORY_ADJUSTED',
        entity: 'AgentInventory',
        entityId: inventory.id,
        oldData: { totalBalance: inventory.totalBalance },
        newData: { totalBalance: newTotal, signedAmount, reason: reason.trim() },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    return tx.agentInventory.findUnique({ where: { id: inventory.id } });
  });
}

/**
 * Atomically reserve `amount` of an agent's inventory for a specific order.
 * Called from within the caller's own transaction (order creation), never
 * opens its own. Version-pinned, mirroring applyBalanceChanges exactly:
 * read, check `available = totalBalance - reservedBalance >= amount` in
 * application code, then a version-pinned updateMany. A lost race (someone
 * else changed the row between read and write) throws Conflict — the
 * caller's transaction rolls back, so no partial order/reservation survives.
 */
export async function reserveInventory(
  tx: any,
  agentId: string,
  amount: number,
  orderId: string,
  reservationId: string
) {
  const inventory = await tx.agentInventory.findUnique({ where: { agentId } });
  if (!inventory) {
    throw ApiError.badRequest('This agent has no available inventory');
  }

  const available = inventory.totalBalance - inventory.reservedBalance;
  if (available < amount) {
    throw ApiError.badRequest(`Insufficient agent inventory: available ${available}, requested ${amount}`);
  }

  const claim = await tx.agentInventory.updateMany({
    where: { id: inventory.id, version: inventory.version },
    data: { reservedBalance: { increment: amount }, version: { increment: 1 } },
  });
  if (claim.count === 0) {
    throw ApiError.conflict('Agent inventory changed concurrently — please retry');
  }

  await tx.agentInventoryLedger.create({
    data: {
      agentId,
      type: 'RESERVE',
      amount,
      totalBefore: inventory.totalBalance,
      totalAfter: inventory.totalBalance,
      reservedBefore: inventory.reservedBalance,
      reservedAfter: inventory.reservedBalance + amount,
      reservationId,
      orderId,
    },
  });
}

/**
 * Release a reservation's inventory back to available (order cancelled
 * before payment, or — not yet implemented, see Phase E report — a future
 * time-based expiry). Version-pinned, ledger type RELEASE_UNUSED.
 */
export async function releaseReservedInventory(
  tx: any,
  agentId: string,
  amount: number,
  orderId: string,
  reservationId: string
) {
  const inventory = await tx.agentInventory.findUnique({ where: { agentId } });
  if (!inventory) {
    throw ApiError.internal('Agent inventory row missing during release');
  }

  const claim = await tx.agentInventory.updateMany({
    where: { id: inventory.id, version: inventory.version },
    data: { reservedBalance: { decrement: amount }, version: { increment: 1 } },
  });
  if (claim.count === 0) {
    throw ApiError.conflict('Agent inventory changed concurrently — please retry');
  }

  await tx.agentInventoryLedger.create({
    data: {
      agentId,
      type: 'RELEASE_UNUSED',
      amount,
      totalBefore: inventory.totalBalance,
      totalAfter: inventory.totalBalance,
      reservedBefore: inventory.reservedBalance,
      reservedAfter: inventory.reservedBalance - amount,
      reservationId,
      orderId,
    },
  });
}

/**
 * Consume a reservation on settlement — the only ledger type that touches
 * BOTH totalBalance and reservedBalance in one entry (schema equation:
 * totalBalance -= amount, reservedBalance -= amount). Version-pinned.
 */
export async function consumeReservedInventory(
  tx: any,
  agentId: string,
  amount: number,
  orderId: string,
  reservationId: string
) {
  const inventory = await tx.agentInventory.findUnique({ where: { agentId } });
  if (!inventory) {
    throw ApiError.internal('Agent inventory row missing during settlement');
  }

  const claim = await tx.agentInventory.updateMany({
    where: { id: inventory.id, version: inventory.version },
    data: {
      totalBalance: { decrement: amount },
      reservedBalance: { decrement: amount },
      version: { increment: 1 },
    },
  });
  if (claim.count === 0) {
    throw ApiError.conflict('Agent inventory changed concurrently — please retry');
  }

  await tx.agentInventoryLedger.create({
    data: {
      agentId,
      type: 'CONSUME_ON_SETTLEMENT',
      amount,
      totalBefore: inventory.totalBalance,
      totalAfter: inventory.totalBalance - amount,
      reservedBefore: inventory.reservedBalance,
      reservedAfter: inventory.reservedBalance - amount,
      reservationId,
      orderId,
    },
  });
}

export async function getAgentInventory(agentId: string) {
  const inventory = await prisma.agentInventory.findUnique({ where: { agentId } });
  if (!inventory) {
    return { agentId, totalBalance: 0, reservedBalance: 0, available: 0, version: 0, exists: false };
  }
  return {
    agentId,
    totalBalance: inventory.totalBalance,
    reservedBalance: inventory.reservedBalance,
    available: inventory.totalBalance - inventory.reservedBalance,
    version: inventory.version,
    exists: true,
  };
}

export async function getAgentInventoryLedger(agentId: string, limit = 50) {
  return prisma.agentInventoryLedger.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
