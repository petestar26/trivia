import { depositEntryDeadline, depositClock, assertDepositReady, MAX_PENDING_DEPOSITS } from './order-lifecycle.js';
import { assertPlatformAdmin } from './agent-service.js';
import { selectPaymentRate } from './usd-config-service.js';
import { parseUsdPolicy, priceUsdPayment } from './usd-pricing.js';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware/index.js';
import { creditCoins, lockUserEconomicScope } from '../economy/coin-ledger-service.js';
import { reserveInventory, releaseReservedInventory, consumeReservedInventory } from './inventory-service.js';

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
  if (!args || typeof args !== 'object') throw ApiError.badRequest('Order details are required');
  if (!args.agentId || typeof args.agentId !== 'string') throw ApiError.badRequest('agentId is required');
  if (!args.countryId || typeof args.countryId !== 'string') throw ApiError.badRequest('countryId is required');
  if (!args.paymentAccountId || typeof args.paymentAccountId !== 'string') {
    throw ApiError.badRequest('paymentAccountId is required');
  }
  if (!Number.isSafeInteger(args.fiatAmount) || args.fiatAmount <= 0 || args.fiatAmount > 2_147_483_647) {
    throw ApiError.badRequest('fiatAmount must be a positive integer');
  }
  if (!args.idempotencyKey || typeof args.idempotencyKey !== 'string' || args.idempotencyKey.length > 128) {
    throw ApiError.badRequest('idempotencyKey is required');
  }
}

/**
 * Generates the human-facing order number (schema: "AG-000123") from the
 * dedicated `agent_order_number_seq` Postgres sequence (migration
 * 20260902000000_agent_order_number_sequence).
 *
 * The previous implementation used `tx.agentOrder.count()` as a proxy for
 * "next number". That is unsound independent of concurrency: test cleanup
 * (and any real-world hard-delete of an order) performs a SCOPED delete, not
 * a table reset, so the row count can legitimately drop below a value it
 * held when an earlier, still-surviving order was numbered — the next
 * count()+1 then collides with that surviving order's orderNumber and the
 * unique constraint throws, with zero concurrent callers involved.
 *
 * `nextval()` is immune to this: it is monotonic for the sequence's
 * lifetime regardless of later deletes, and it is NOT transactional (a
 * rolled-back transaction does not return its consumed value), so two
 * concurrent callers can never observe the same value either. This
 * intentionally allows gaps in the numbering, never duplicates — the
 * correct tradeoff for a value already documented as "not a security
 * concern, only a display convenience". The P2002 retry in
 * createAgentOrder is kept as defense-in-depth, not removed.
 */
async function nextOrderNumber(tx: any): Promise<string> {
  const rows = await tx.$queryRaw<{ nextval: bigint | number | string }[]>`
    SELECT nextval('agent_order_number_seq') AS nextval
  `;
  const n = Number(rows[0].nextval);
  return `AG-${String(n).padStart(6, '0')}`;
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
  const rateConfig = await selectPaymentRate(prisma, country);
  const usdPrice = priceUsdPayment(parseUsdPolicy(rateConfig.pricingPolicy), 'deposit', args.fiatAmount);
  const coinAmount = usdPrice.coinAmount;
  if (!Number.isSafeInteger(coinAmount) || coinAmount <= 0 || coinAmount > 1_000_000_000) {
    throw ApiError.badRequest('Computed coin amount must be positive');
  }


  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await lockUserEconomicScope(tx, `deposit-admission:${actorUserId}`);
        const replay = await tx.agentOrder.findUnique({
          where: { userId_idempotencyKey: { userId: actorUserId, idempotencyKey: args.idempotencyKey } },
        });
        if (replay) {
          if (orderRequestFieldsMatch(replay, args)) return { order: replay, idempotent: true };
          throw ApiError.conflict('An order already exists for this idempotency key with different request data');
        }
        if (await tx.agentOrder.count({ where: { userId: actorUserId, status: 'CREATED' } }) >= MAX_PENDING_DEPOSITS) {
          throw ApiError.conflict('Finish or cancel your pending deposits before creating another (maximum 3)');
        }
        // Admission is revalidated under row locks. Preflight data alone can
        // become stale while an agent/account/country is being disabled.
        const [buyer] = await tx.$queryRaw<Array<{status:string}>>`
          SELECT status::text FROM users WHERE id=${actorUserId} FOR SHARE`;
        if (!buyer || buyer.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
        const [currentAgent] = await tx.$queryRaw<Array<{status:string;countryId:string;minOrderAmount:number|null;maxOrderAmount:number|null}>>`
          SELECT status::text, "countryId", "minOrderAmount", "maxOrderAmount" FROM agents WHERE id=${agent.id} FOR SHARE`;
        if (!currentAgent || currentAgent.status !== 'ACTIVE' || currentAgent.countryId !== args.countryId ||
            (currentAgent.minOrderAmount !== null && args.fiatAmount < currentAgent.minOrderAmount) ||
            (currentAgent.maxOrderAmount !== null && args.fiatAmount > currentAgent.maxOrderAmount)) {
          throw ApiError.conflict('Agent availability or order limits changed; review the order again');
        }
        const [currentCountry] = await tx.$queryRaw<Array<{isActive:boolean;agentPaymentEnabled:boolean;currencyCode:string;usdPricingEnabled:boolean}>>`
          SELECT "isActive", "agentPaymentEnabled", "currencyCode", "usdPricingEnabled" FROM countries WHERE id=${args.countryId} FOR SHARE`;
        if (!currentCountry?.isActive || !currentCountry.agentPaymentEnabled || currentCountry.currencyCode !== fiatCurrency) {
          throw ApiError.conflict('Country payment availability changed');
        }
        const [currentAccount] = await tx.$queryRaw<Array<{status:string;agentId:string;countryId:string;methodDefId:string;accountDetails:unknown}>>`
          SELECT status::text, "agentId", "countryId", "methodDefId", "accountDetails" FROM agent_payment_accounts WHERE id=${args.paymentAccountId} FOR SHARE`;
        if (!currentAccount || currentAccount.status !== 'APPROVED' || currentAccount.agentId !== agent.id ||
            currentAccount.countryId !== args.countryId || currentAccount.methodDefId !== paymentAccount.methodDefId) {
          throw ApiError.conflict('Payment account changed; review the order again');
        }
        const [currentMethod] = await tx.$queryRaw<Array<{isActive:boolean;countryId:string}>>`
          SELECT "isActive", "countryId" FROM payment_method_definitions WHERE id=${paymentAccount.methodDefId} FOR SHARE`;
        if (!currentMethod?.isActive || currentMethod.countryId !== args.countryId) throw ApiError.conflict('Payment method is no longer available');
        if (currentCountry.usdPricingEnabled !== country.usdPricingEnabled) {
          throw ApiError.conflict('Pricing policy changed; review the order again');
        }
        if (usdPrice) {
          const selectedRate = await selectPaymentRate(tx, { ...currentCountry, id: args.countryId });
          if (selectedRate.id !== rateConfig.id) throw ApiError.conflict('Exchange rate changed; request a fresh price');
          const [lockedRate] = await tx.$queryRaw<Array<{ isActive: boolean }>>`
            SELECT "isActive" FROM exchange_rate_configs WHERE id=${rateConfig.id} FOR SHARE`;
          if (!lockedRate?.isActive) throw ApiError.conflict('Exchange rate was disabled; request a fresh price');
          parseUsdPolicy(rateConfig.pricingPolicy);
        }
        const orderNumber = await nextOrderNumber(tx);

        const order = await tx.agentOrder.create({
          data: {
            orderNumber,
            userId: actorUserId,
            agentId: agent.id,
            countryId: args.countryId,
            paymentMethodDefId: paymentAccount.methodDefId,
            paymentAccountId: args.paymentAccountId,
            paymentSnapshot: currentAccount.accountDetails as any,
            fiatAmount: args.fiatAmount,
            fiatCurrency,
            exchangeRateConfigId: rateConfig.id,
            exchangeRateValue: rateConfig.coinsPerUnit,
            coinAmount,
            ...(usdPrice ? { pricingSnapshot: usdPrice.snapshot } : {}),
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
    const [actor] = await tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM users WHERE id=${actorUserId} FOR SHARE`;
    if (actor?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
    await tx.$queryRaw`SELECT id FROM agent_orders WHERE id=${orderId} FOR UPDATE`;
    const before = await tx.agentOrder.findUnique({ where: { id: orderId } });
    if (!before) throw ApiError.notFound('Order not found');
    if (before.userId !== actorUserId) throw ApiError.forbidden('Not your order');
    if (before.status !== 'CREATED') throw ApiError.conflict('Order is no longer awaiting payment');
    await assertDepositReady(tx, before);
    if (depositEntryDeadline(before) <= await depositClock(tx)) throw ApiError.conflict('Payment window expired. Do not send money; contact payment support if already paid.');

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
 * Cancel only unpaid CREATED orders, or expire their 15-minute payment window.
 * Order state, reservation release and ledger movement commit atomically.
 * PAYMENT_SUBMITTED orders are never released by this path.
 */
type OrderContext = { ip?: string; userAgent?: string };
export function cancelAgentOrder(actorUserId: string, orderId: string, context?: OrderContext, mode?: 'customer' | 'staff', reason?: string): Promise<{ orderId: string; status: string }>;
export function cancelAgentOrder(actorUserId: string, orderId: string, context: OrderContext | undefined, mode: 'expiry', reason?: string): Promise<{ orderId: string; status: string } | null>;
export async function cancelAgentOrder(
  actorUserId: string,
  orderId: string,
  context?: { ip?: string; userAgent?: string },
  mode: 'customer' | 'staff' | 'expiry' = 'customer',
  reason?: string,
) {
  if (mode === 'staff') {
    await assertPlatformAdmin(actorUserId);
    if (!reason?.trim()) throw ApiError.badRequest('A cancellation reason is required');
  }
  return prisma.$transaction(async (tx) => {
    if (mode === 'staff') {
      const [admin] = await tx.$queryRaw<{ role: string; status: string }[]>`SELECT role::text, status::text FROM users WHERE id=${actorUserId} FOR SHARE`;
      if (admin?.status !== 'ACTIVE' || !['ADMIN', 'SUPER_ADMIN'].includes(admin.role)) throw ApiError.forbidden('Active admin privileges required');
    }
    await tx.$queryRaw`SELECT id FROM agent_orders WHERE id=${orderId} FOR UPDATE`;
    const before = await tx.agentOrder.findUnique({ where: { id: orderId } });
    if (!before) throw ApiError.notFound('Order not found');
    if (mode === 'customer' && before.userId !== actorUserId) throw ApiError.forbidden('Not your order');
    const operationNow = await depositClock(tx);
    if (mode === 'expiry' && depositEntryDeadline(before) > operationNow) return null;

    const claim = await tx.agentOrder.updateMany({
      where: { id: orderId, status: 'CREATED' },
      data: mode === 'expiry' ? { status: 'EXPIRED', expiredAt: operationNow } : { status: 'CANCELLED', cancelledAt: operationNow },
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
        action: mode === 'expiry' ? 'AGENT_ORDER_EXPIRED' : 'AGENT_ORDER_CANCELLED',
        entity: 'AgentOrder',
        entityId: orderId,
        oldData: { status: 'CREATED' },
        newData: { status: mode === 'expiry' ? 'EXPIRED' : 'CANCELLED', mode, reason: reason?.trim() },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    return { orderId, status: mode === 'expiry' ? 'EXPIRED' : 'CANCELLED' };
  });
}

/**
 * Agent confirms payment received and releases coins to the customer.
 * PAYMENT_SUBMITTED -> COMPLETED, exactly once — the order's own atomic
 * claim (WHERE status='PAYMENT_SUBMITTED') is what makes this exactly-once;
 * AgentOrderSettlement.orderId's unique constraint is the backstop. Reuses
 * the shared PURCHASE ledger helper so the wallet credit and withdrawable
 * source lot are committed together.
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
    await lockUserEconomicScope(tx, `agent_order:${orderId}`);
    const before = await tx.agentOrder.findUnique({ where: { id: orderId } });
    if (!before) throw ApiError.notFound('Order not found');
    if (before.agentId !== agent.id) throw ApiError.forbidden('Not your order');
    const [actor] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status::text FROM users WHERE id=${actorUserId} FOR SHARE`;
    if (actor?.status !== 'ACTIVE') throw ApiError.forbidden('An active user account is required');
    // L1: buyer authority precedes the L4 order/inventory claim and L5 wallet.
    // A completed payment remains owed even if the buyer was later suspended.
    const buyerRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${before.userId} FOR SHARE
    `;
    if (!buyerRows[0]) throw ApiError.internal('Buyer missing for paid agent order');

    // Agent suspension updates this row. Recheck under a shared row lock in
    // the settlement transaction so a concurrent suspension and Coin mint
    // have one serial authority order.
    const currentAgents = await tx.$queryRaw<{ id: string; userId: string; status: string }[]>`
      SELECT id, "userId", status::text AS status
      FROM agents WHERE id = ${agent.id} FOR SHARE
    `;
    if (!currentAgents[0] || currentAgents[0].userId !== actorUserId) {
      throw ApiError.forbidden('You do not have an agent account');
    }
    if (currentAgents[0].status !== 'ACTIVE') {
      throw ApiError.forbidden('Your agent account cannot settle orders in its current state');
    }

    await assertDepositReady(tx, before);
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

    const credit = await creditCoins(tx, before.userId, before.coinAmount, {
      type: 'PURCHASE',
      scopeType: 'AGENT_ORDER',
      scopeId: before.id,
      referenceType: 'AGENT_ORDER',
      referenceId: before.id,
      description: `Coins purchased via agent order ${before.orderNumber}`,
      createdBy: actorUserId,
      completePurchaseProof: async (purchaseTx, walletTransactionId) => {
        const settlement = await purchaseTx.agentOrderSettlement.create({
          data: {
            orderId,
            reservationId: reservation.id,
            coinAmount: before.coinAmount,
            walletTransactionId,
            resolvedVia: 'AGENT_RELEASE',
            releasedBy: actorUserId,
          },
        });
        return settlement.id;
      },
    });
    const settlementId = credit.purchaseSettlementId;
    if (!settlementId) throw ApiError.internal('Settled Agent order lacks a purchase witness');

    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'AGENT_ORDER_SETTLED',
        entity: 'AgentOrder',
        entityId: orderId,
        oldData: { status: 'PAYMENT_SUBMITTED' },
        newData: { status: 'COMPLETED', coinAmount: before.coinAmount, settlementId },
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

    return { orderId, status: 'COMPLETED', settlementId };
  });
}

/** Expires only unsubmitted reservations; paid/disputed orders remain held for review. */
export async function sweepExpiredAgentOrders() {
  const candidates = await prisma.agentOrder.findMany({ where: { status: 'CREATED' }, orderBy: { createdAt: 'asc' }, take: 200 });
  let expired = 0;
  for (const order of candidates) {
    try {
      const result = await cancelAgentOrder(order.userId, order.id, undefined, 'expiry');
      if (result?.status === 'EXPIRED') expired++;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 409) throw error;
    }
  }
  return { examined: candidates.length, expired };
}
