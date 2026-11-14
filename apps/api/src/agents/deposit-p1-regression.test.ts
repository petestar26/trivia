import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  agentOrder: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  agentPaymentAccount: { findUnique: vi.fn(), updateMany: vi.fn() },
  agent: { findUnique: vi.fn() },
  agentReservation: { findUnique: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
  notification: { create: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  release: vi.fn(),
  credit: vi.fn(),
  consume: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: m }));
vi.mock('../middleware/index.js', async () => ({
  ApiError: (await import('../middleware/api-error.js')).ApiError,
}));
vi.mock('./agent-service.js', () => ({
  assertPlatformAdmin: vi.fn(),
  AGENT_SELF_SERVICE_STATUSES: ['ACTIVE'],
}));
vi.mock('./usd-config-service.js', () => ({ selectPaymentRate: vi.fn() }));
vi.mock('../economy/coin-ledger-service.js', () => ({
  creditCoins: m.credit,
  lockUserEconomicScope: vi.fn(),
}));
vi.mock('./inventory-service.js', () => ({
  releaseReservedInventory: m.release,
  consumeReservedInventory: m.consume,
  reserveInventory: vi.fn(),
}));
import { sweepExpiredAgentOrders, settleAgentOrder } from './order-service.js';
import { disableOwnPaymentAccount, adminDisablePaymentAccount } from './payment-account-service.js';

const now = new Date('2026-11-13T12:00:00.000Z');
beforeEach(() => {
  vi.resetAllMocks();
  m.$transaction.mockImplementation((fn) => fn(m));
  m.$queryRaw.mockResolvedValue([{ now }]);
  m.agent.findUnique.mockResolvedValue({ id: 'agent', userId: 'agent-user', status: 'ACTIVE' });
  m.agentOrder.updateMany.mockResolvedValue({ count: 1 });
  m.agentReservation.findUnique.mockResolvedValue({ id: 'reservation', amount: 100 });
  m.agentReservation.updateMany.mockResolvedValue({ count: 1 });
});

it('expires an eligible order behind 200 older held expired orders, leaving every held row untouched', async () => {
  const held = Array.from({ length: 200 }, (_, i) => ({
    id: `held-${i}`,
    userId: 'buyer',
    agentId: 'agent',
    status: 'CREATED',
    safetyHold: true,
    createdAt: new Date(now.getTime() - 3_600_000 - i),
    pricingSnapshot: null,
  }));
  const eligible = {
    ...held[0],
    id: 'eligible',
    safetyHold: false,
    createdAt: new Date(now.getTime() - 1_800_000),
  };
  const all = [...held, eligible];
  const before = structuredClone(held);
  // Apply the actual service's selection predicate before its LIMIT.
  m.agentOrder.findMany.mockImplementation(({ where, take }) =>
    all
      .filter(
        (row) =>
          row.status === where.status &&
          (where.safetyHold === undefined || row.safetyHold === where.safetyHold)
      )
      .sort((a, b) => +a.createdAt - +b.createdAt)
      .slice(0, take)
  );
  m.agentOrder.findUnique.mockImplementation(({ where }) => all.find((row) => row.id === where.id));
  m.agentOrder.updateMany.mockImplementation(({ where, data }) => {
    const row = all.find(
      (row) =>
        row.id === where.id && row.status === where.status && row.safetyHold === where.safetyHold
    );
    if (!row) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  expect(await sweepExpiredAgentOrders()).toEqual({ examined: 1, expired: 1, failed: 0 });
  expect(eligible.status).toBe('EXPIRED');
  expect(held).toEqual(before);
  expect(m.release).toHaveBeenCalledTimes(1);
  expect(m.release).toHaveBeenCalledWith(m, 'agent', 100, 'eligible', 'reservation');
  expect(m.auditLog.create).toHaveBeenCalledTimes(1);
});

it('rechecks safety inside cancellation when an eligible selected order becomes held', async () => {
  const row = {
    id: 'raced',
    userId: 'buyer',
    agentId: 'agent',
    status: 'CREATED',
    safetyHold: false,
    createdAt: new Date(now.getTime() - 3_600_000),
    pricingSnapshot: null,
  };
  m.agentOrder.findMany.mockResolvedValue([row]);
  m.agentOrder.findUnique.mockResolvedValue({ ...row, safetyHold: true });
  expect(await sweepExpiredAgentOrders()).toEqual({ examined: 1, expired: 0, failed: 0 });
  expect(m.agentOrder.updateMany).not.toHaveBeenCalled();
  expect(m.release).not.toHaveBeenCalled();
  expect(m.auditLog.create).not.toHaveBeenCalled();
});

it.each(['owner', 'admin'])(
  '%s can safety-disable REJECTED without altering its review state; stale retries have no effects',
  async (actor) => {
    const row = {
      id: 'account',
      agentId: 'agent',
      status: 'REJECTED',
      safetyHold: false,
      updatedAt: now,
    };
    const version = row.updatedAt.toISOString();
    m.agentPaymentAccount.findUnique.mockImplementation(() => ({ ...row }));
    m.agentPaymentAccount.updateMany.mockImplementation(({ where, data }) => {
      const statusMatches =
        !where.status ||
        (typeof where.status === 'string'
          ? where.status === row.status
          : where.status.in.includes(row.status));
      if (
        !statusMatches ||
        where.updatedAt.getTime() !== row.updatedAt.getTime() ||
        where.safetyHold !== row.safetyHold
      )
        return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
    const disable = () =>
      actor === 'owner'
        ? disableOwnPaymentAccount('agent-user', row.id, version)
        : adminDisablePaymentAccount('admin', row.id, version);
    await expect(disable()).resolves.toEqual({
      accountId: 'account',
      status: 'REJECTED',
      safetyHold: true,
    });
    expect(row.status).toBe('REJECTED');
    expect(row.safetyHold).toBe(true);
    expect(m.auditLog.create).toHaveBeenCalledTimes(1);
    await expect(disable()).rejects.toMatchObject({ statusCode: 409 });
    expect(m.auditLog.create).toHaveBeenCalledTimes(1);
  }
);

it('denies settlement of a pinned paid order on safety hold before inventory, credit, notification or audit writes', async () => {
  m.agentOrder.findUnique.mockResolvedValue({
    id: 'pinned',
    userId: 'buyer',
    agentId: 'agent',
    status: 'PAYMENT_SUBMITTED',
    paymentAccountRevision: 1,
    paymentSnapshot: { number: 'original' },
    safetyHold: true,
  });
  m.$queryRaw.mockImplementation((sql) => {
    const text = sql.join('?');
    if (text.includes('FROM agents'))
      return [{ id: 'agent', userId: 'agent-user', status: 'ACTIVE' }];
    return [{ id: 'buyer', status: 'ACTIVE' }];
  });
  await expect(settleAgentOrder('agent-user', 'pinned')).rejects.toMatchObject({ statusCode: 409 });
  for (const fn of [
    m.agentOrder.updateMany,
    m.agentReservation.updateMany,
    m.release,
    m.consume,
    m.credit,
    m.notification.create,
    m.auditLog.create,
  ])
    expect(fn).not.toHaveBeenCalled();
});
