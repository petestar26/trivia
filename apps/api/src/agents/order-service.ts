import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { applyBalanceChanges, getOrCreateWallet } from '../economy/wallet-service';
import { reserveInventory, releaseReservedInventory, consumeReservedInventory } from './inventory-service';

export interface CreateAgentOrderArgs {
  agentId: string;
  countryId: string;
  paymentAccountId: string;
  fiatAmount: number;
  idempotencyKey: string;
}

function orderRequestFieldsMatch(order: { agentId: string; countryId: string; paymentAccountId: string; fiatAmount: number }, args: CreateAgentOrderArgs) {
  return (
    order.agentId === args.agentId &&
    order.countryId === args.countryId &&
    order.paymentAccountId === args.paymentAccountId &&
    order.fiatAmount === args.fiatAmount
  );
}

function validateCreateArgs(args: CreateAgentOrderArgs) {
  if (!args.agentId || typeof args.agentId !== 'string') throw ApiError.badRequest('agentId is required');
  if (!args.countryId || typeof args.countryId !== 'string') throw ApiError.badRequest('countryId is required');
  if (!args.paymentAccountId || typeof args.paymentAccountId !== 'string') {
    throw ApiError.badRequest('paymentAccountId is required');
  }
  if (!Number.isInteger(args.fiatAmount) || args.fiatAmount <= 0) {
    throw ApiError.badRequest('fiatAmount must be a positive integer');
  }
  if (!args.idempotencyKey || typeof args.idempotencyKey !== 'string') {
    throw ApiError.badRequest('idempotencyKey is required');
  }
}

/**
 * Generates the human-facing order number (schema: "AG-000123"). No
 * dedicated sequence exists in the schema, so this follows the same
 * "let the DB unique constraint be the source of truth, catch P2002 and
 * retry" discipline already established for Agent.userId in agent-service.ts
 * — orderNumber collisions are not a security concern, only a display
 * convenience, so a bounded retry is sufficient.
 */
async function nextOrderNumber(tx: any): Promise<string> {
  const count = await tx.agentOrder.count();
  return `AG-${String(count + 1).padStart(6, '0')}`;
}

/**
 * Create an Agent Order and atomically reserve the agent's inventory for it,
 * in one transaction — Phase E §2's flow describes creation and reservation
 * as a single step, and AgentReservation is 1:1 with AgentOrder, so a
 * failed reservation must never leave a partial order behind.
 *
 * Idempotency: [userId, idempotencyKey] is the request-identity key (Phase C
 * correction A — identifies the REQUEST, not the selected agent). A retry
 * with the same key and same meaningful fields returns the original order;
 * a retry with the same key and different fields is a deterministic conflict
 * that never mutates the original (Race A / Race B).
 */
export async function createAgentOrder(
  actorUserId: string,
  rawArgs: CreateAgentOrderArgs,
  context?: { ip?: string; userAgent?: string }
) {
  validateCreateArgs(rawArgs);
  const args = rawArgs;

  const existing = await prisma.agentOrder.findUnique({
    where: { userId_idempotencyKey: { userId: actorUserId, idempotencyKey: args.idempotencyKey } },
  });
  if (existing) {
    if (orderRequestFieldsMatch(existing, args)) {
      return { order: existing, idempotent: true };
    }
    throw ApiError.conflict('An order already exists for this idempotency key with different request data');
  }

  const agent = await prisma.agent.findUnique({ where: { id: args.agentId } });
  if (!agent) throw ApiError.badRequest('Invalid agent');
  if (agent.userId === actorUserId) {
    throw ApiError.forbidden('You cannot create an order against your own agent account');
  }
  if (agent.status !== 'ACTIVE') throw ApiError.badRequest('This agent is not currently accepting orders');
  if (agent.countryId !== args.countryId) throw ApiError.badRequest('This agent does not serve the selected country');

  if (agent.minOrderAmount != null && args.fiatAmount < agent.minOrderAmount) {
    throw ApiError.badRequest(`fiatAmount is below this agent's minimum order amount (${agent.minOrderAmount})`);
  }
  if (agent.maxOrderAmount != null && args.fiatAmount > agent.maxOrderAmount) {
    throw ApiError.badRequest(`fiatAmount exceeds this agent's maximum order amount (${agent.maxOrderAmount})`);
  }

  const country = await prisma.country.findUnique({ where: { id: args.countryId } });
  if (!country) throw ApiError.badRequest('Invalid country');
  if (!country.isActive || !country.agentPaymentEnabled) {
    throw ApiError.badRequest('Agent payments are not available for this country');
  }
  const fiatCurrency = country.currencyCode;

  const paymentAccount = await prisma.agentPaymentAccount.findUnique({
    where: { id: args.paymentAccountId },
    include: { methodDef: true },
  });
  if (!paymentAccount) throw ApiError.badRequest('Invalid payment account');
  if (paymentAccount.agentId !== agent.id) {
    throw ApiError.badRequest('This payment account does not belong to the selected agent');
  }
  if (paymentAccount.status !== 'APPROVED') {
    throw ApiError.badRequest('This payment account is not currently approved for use');
  }
  // Phase C correction C: countryId == methodDef.countryId, and the order's
  // own countryId == the selected account's countryId.
  if (paymentAccount.countryId !== args.countryId) {
    throw ApiError.badRequest('This payment account does not belong to the selected country');
  }
  if (!paymentAccount.methodDef.isActive || paymentAccount.methodDef.countryId !== args.countryId) {
    throw ApiError.badRequest('This payment account\'s payment method is not currently valid for the selected country');
  }

  // Deterministic exchange-rate selection (Phase C correction D, schema
  // comment on ExchangeRateConfig): country + fiatCurrency + isActive=true +
  // effectiveAt <= now(), ordered by effectiveAt DESC, take 1. Copied into
  // the order and never re-read.
  const rateConfig = await prisma.exchangeRateConfig.findFirst({
    where: { countryId: args.countryId, fiatCurrency, isActive: true, effectiveAt: { lte: new Date() } },
    orderBy: { effectiveAt: 'desc' },
  });
  if (!rateConfig) {
    throw ApiError.badRequest('No active exchange rate is configured for this country/currency');
  }

  // Schema: "coinAmount Int // floor(fiatAmount * exchangeRateValue), fixed
  // forever" — used verbatim, via Decimal arithmetic to avoid float error.
  const coinAmount = rateConfig.coinsPerUnit.mul(args.fiatAmount).floor().toNumber();
  if (coinAmount <= 0) {
    throw ApiError.badRequest('Computed coin amount must be positive');
  }

  const paymentSnapshot = paymentAccount.accountDetails;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const orderNumber = await nextOrderNumber(tx);

        const order = await tx.agentOrder.create({
          data: {
            orderNumber,
            userId: actorUserId,
            agentId: agent.id,
            countryId: args.countryId,
            paymentMethodDefId: paymentAccount.methodDefId,
            paymentAccountId: args.paymentAccountId,
            paymentSnapshot: paymentSnapshot as any,
            fiatAmount: args.fiatAmount,
            fiatCurrency,
            exchangeRateConfigId: rateConfig.id,
            exchangeRateValue: rateConfig.coinsPerUnit,
            coinAmount,
            status: 'CREATED',
            idempotencyKey: args.idempotencyKey,
          },
        });

        const reservation = await tx.agentReservation.create({
          data: {
            orderId: order.id,
            agentId: agent.id,
            amount: order.coinAmount,
            status: 'ACTIVE',
          },
        });

        await reserveInventory(tx, agent.id, order.coinAmount, order.id, reservation.id);

        await tx.auditLog.create({
          data: {
            userId: actorUserId,
            action: 'AGENT_ORDER_CREATED',
            entity: 'AgentOrder',
            entityId: order.id,
            newData: { agentId: agent.id, coinAmount: order.coinAmount, fiatAmount: order.fiatAmount, status: 'CREATED' },
            ip: context?.ip,
            userAgent: context?.userAgent,
          },
        });

        await tx.notification.create({
          data: {
            userId: agent.userId,
            type: 'AGENT_ORDER_CREATED',
            title: 'New Order Received',
            body: `A customer created an order for ${order.coinAmount} coins.`,
            data: { orderId: order.id, orderNumber: order.orderNumber, coinAmount: order.coinAmount },
          },
        });

        return { order, idempotent: false };
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'P2002') throw err;

      // A P2002 here is EITHER the [userId, idempotencyKey] unique constraint
      // (a concurrent duplicate request won the race — Race A/B) OR the
      // orderNumber unique constraint (an unrelated numbering collision).
      // Prisma's error `meta.target` shape for a compound constraint is not
      // stable across providers/versions, so rather than parse it, refetch
      // by the idempotency key directly: if a matching order now exists,
      // that IS what raced us (regardless of which constraint actually
      // fired), and we resolve it exactly like the pre-transaction check
      // above. If nothing is found, the P2002 must have been the
      // orderNumber collision — retry with a freshly computed number.
      const winner = await prisma.agentOrder.findUnique({
        where: { userId_idempotencyKey: { userId: actorUserId, idempotencyKey: args.idempotencyKey } },
      });
      if (winner) {
        if (orderRequestFieldsMatch(winner, args)) {
          return { order: winner, idempotent: true };
        }
        throw ApiError.conflict('An order already exists for this idempotency key with different request data');
      }
      if (attempt < 2) continue; // orderNumber race — retry, bounded
      throw err;
    }
  }
  throw ApiError.conflict('Could not allocate an order number — please retry');
}

async function requireOrderAccess(actorUserId: string, order: { userId: string; agentId: string }) {
  if (order.userId === actorUserId) return 'customer';
  const agent = await prisma.agent.findUnique({ where: { id: order.agentId }, select: { userId: true } });
  if (agent && agent.userId === actorUserId) return 'agent';
  const user = await prisma.user.findUnique({ where: { id: actorUserId }, select: { role: true } });
  if (user && (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN')) return 'admin';
  throw ApiError.forbidden('You do not have access to this order');
}

export async function getAgentOrderById(actorUserId: string, orderId: string) {
  const order = await prisma.agentOrder.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Order not found');
  await requireOrderAccess(actorUserId, order);
  return order;
}

export async function listOwnAgentOrders(actorUserId: string) {
  return prisma.agentOrder.findMany({ where: { userId: actorUserId }, orderBy: { createdAt: 'desc' } });
}

export async function listOrdersForOwnAgent(actorUserId: string) {
  const agent = await prisma.agent.findUnique({ where: { userId: actorUserId } });
  if (!agent) throw ApiError.forbidden('You do not have an agent account');
  return prisma.agentOrder.findMany({ where: { agentId: agent.id }, orderBy: { createdAt: 'desc' } });
}

/**
 * Customer confirms they have sent payment. CREATED -> PAYMENT_SUBMITTED
 * only; ownership resolved from the authenticated caller, never trusted
 * from the request body.
 */
export async function submitOrderPayment(
  actorUserId: string,
  orderId: string,
  context?: { ip?: string; userAgent?: string }
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.agentOrder.findUnique({ where: { id: orderId } });
    if (!before) throw ApiError.notFound('Order not found');
    if (before.userId !== actorUserId) throw ApiError.forbidden('Not your order');

    const claim = await tx.agentOrder.updateMany({
      where: { id: orderId, userId: actorUserId, status: 'CREATED' },
      data: { status: 'PAYMENT_SUBMITTED', paymentSubmittedAt: new Date() },
    });
    if (claim.count === 0) {
      const current = await tx.agentOrder.findUnique({ where: { id: orderId } });
      throw ApiError.conflict(`Order cannot have payment submitted in its current state (${current?.status})`);
    }

    const agent = await tx.agent.findUnique({ where: { id: before.agentId } });

    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'AGENT_ORDER_PAYMENT_SUBMITTED',
        entity: 'AgentOrder',
        entityId: orderId,
        oldData: { status: 'CREATED' },
        newData: { status: 'PAYMENT_SUBMITTED' },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    await tx.notification.create({
      data: {
        userId: agent!.userId,
        type: 'AGENT_PAYMENT_SUBMITTED',
        title: 'Payment Submitted',
        body: `A customer marked order ${before.orderNumber} as paid — please confirm receipt.`,
        data: { orderId, orderNumber: before.orderNumber },
      },
    });

    return { orderId, status: 'PAYMENT_SUBMITTED' };
  });
}

/**
 * Customer cancels their own order before payment is submitted. Releases
 * the reservation atomically in the same transaction — no time-based
 * expiry is implemented here (see Phase E report: timeout duration is not
 * recoverable from the repository), this is purely the customer-initiated
 * path, which is fully specified by AgentOrderStatus.CANCELLED and the
 * RELEASE_UNUSED ledger equation.
 */
export async function cancelAgentOrder(
  actorUserId: string,
  orderId: string,
  context?: { ip?: string; userAgent?: string }
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.agentOrder.findUnique({ where: { id: orderId } });
    if (!before) throw ApiError.notFound('Order not found');
    if (before.userId !== actorUserId) throw ApiError.forbidden('Not your order');

    const claim = await tx.agentOrder.updateMany({
      where: { id: orderId, userId: actorUserId, status: 'CREATED' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    if (claim.count === 0) {
      const current = await tx.agentOrder.findUnique({ where: { id: orderId } });
      throw ApiError.conflict(`Order cannot be cancelled in its current state (${current?.status})`);
    }

    const reservation = await tx.agentReservation.findUnique({ where: { orderId } });
    if (!reservation) throw ApiError.internal('Reservation missing for order during cancellation');

    const reservationClaim = await tx.agentReservation.updateMany({
      where: { orderId, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    if (reservationClaim.count === 0) {
      throw ApiError.conflict('Reservation already released or consumed');
    }

    await releaseReservedInventory(tx, before.agentId, reservation.amount, orderId, reservation.id);

    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'AGENT_ORDER_CANCELLED',
        entity: 'AgentOrder',
        entityId: orderId,
        oldData: { status: 'CREATED' },
        newData: { status: 'CANCELLED' },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    return { orderId, status: 'CANCELLED' };
  });
}

/**
 * Agent confirms payment received and releases coins to the customer.
 * PAYMENT_SUBMITTED -> COMPLETED, exactly once — the order's own atomic
 * claim (WHERE status='PAYMENT_SUBMITTED') is what makes this exactly-once;
 * AgentOrderSettlement.orderId's unique constraint is the backstop. Reuses
 * the existing applyBalanceChanges as the sole wallet-mutation path (schema:
 * "the WalletTransaction row applyBalanceChanges produced").
 *
 * Only the AGENT_RELEASE path is implemented — ADMIN_DISPUTE_RESOLUTION
 * requires the Dispute model, out of scope this phase (see Phase E report).
 */
export async function settleAgentOrder(
  actorUserId: string,
  orderId: string,
  context?: { ip?: string; userAgent?: string }
) {
  const agent = await prisma.agent.findUnique({ where: { userId: actorUserId } });
  if (!agent) throw ApiError.forbidden('You do not have an agent account');
  if (agent.status !== 'ACTIVE') throw ApiError.forbidden('Your agent account cannot settle orders in its current state');

  return prisma.$transaction(async (tx) => {
    const before = await tx.agentOrder.findUnique({ where: { id: orderId } });
    if (!before) throw ApiError.notFound('Order not found');
    if (before.agentId !== agent.id) throw ApiError.forbidden('Not your order');

    const claim = await tx.agentOrder.updateMany({
      where: { id: orderId, agentId: agent.id, status: 'PAYMENT_SUBMITTED' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    if (claim.count === 0) {
      const current = await tx.agentOrder.findUnique({ where: { id: orderId } });
      throw ApiError.conflict(`Order cannot be settled in its current state (${current?.status})`);
    }

    const reservation = await tx.agentReservation.findUnique({ where: { orderId } });
    if (!reservation) throw ApiError.internal('Reservation missing for order during settlement');

    const reservationClaim = await tx.agentReservation.updateMany({
      where: { orderId, status: 'ACTIVE' },
      data: { status: 'CONSUMED', consumedAt: new Date() },
    });
    if (reservationClaim.count === 0) {
      throw ApiError.conflict('Reservation already released or consumed');
    }

    await consumeReservedInventory(tx, agent.id, reservation.amount, orderId, reservation.id);

    // applyBalanceChanges requires the wallet row to already exist and
    // throws otherwise — unlike executeBalanceChange, it never creates one.
    // A customer's first-ever agent order may be their first economy
    // interaction at all, so the wallet must be created here, inside the
    // same transaction, before crediting it.
    await getOrCreateWallet(before.userId, tx);

    const balanceResult = await applyBalanceChanges(tx, before.userId, [
      {
        currency: 'COINS',
        amount: before.coinAmount,
        ledgerType: 'CREDIT',
        transactionType: 'COIN_CREDIT',
        referenceType: 'AGENT_ORDER',
        referenceId: before.id,
        description: `Coins purchased via agent order ${before.orderNumber}`,
      },
    ]);

    const settlement = await tx.agentOrderSettlement.create({
      data: {
        orderId,
        reservationId: reservation.id,
        coinAmount: before.coinAmount,
        walletTransactionId: balanceResult.transactions[0].id,
        resolvedVia: 'AGENT_RELEASE',
        releasedBy: actorUserId,
      },
    });

    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'AGENT_ORDER_SETTLED',
        entity: 'AgentOrder',
        entityId: orderId,
        oldData: { status: 'PAYMENT_SUBMITTED' },
        newData: { status: 'COMPLETED', coinAmount: before.coinAmount, settlementId: settlement.id },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    await tx.notification.create({
      data: {
        userId: before.userId,
        type: 'AGENT_COINS_RELEASED',
        title: 'Coins Released',
        body: `Your order ${before.orderNumber} is complete — ${before.coinAmount} coins have been added to your wallet.`,
        data: { orderId, orderNumber: before.orderNumber, coinAmount: before.coinAmount },
      },
    });

    return { orderId, status: 'COMPLETED', settlementId: settlement.id };
  });
}
