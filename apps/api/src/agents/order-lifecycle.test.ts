import { beforeEach, expect, it, vi } from 'vitest';
import { assertDepositReady, depositEntryDeadline } from './order-lifecycle.js';
const state = vi.hoisted(() => ({
  tx: {
    $queryRaw: vi.fn(),
    agentOrder: { findUnique: vi.fn(), updateMany: vi.fn() },
    agentReservation: { findUnique: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  release: vi.fn(),
}));
vi.mock('@socialplay/database', async (original) => ({
  ...(await original<typeof import('@socialplay/database')>()),
  prisma: { $transaction: (fn: any) => fn(state.tx) },
}));
vi.mock('./inventory-service.js', () => ({
  releaseReservedInventory: state.release,
  reserveInventory: vi.fn(),
  consumeReservedInventory: vi.fn(),
}));
import { cancelAgentOrder } from './order-service.js';
const now = new Date('2026-10-07T12:00:00Z');
const order = {
  id: 'order',
  userId: 'buyer',
  agentId: 'agent',
  countryId: 'country',
  paymentAccountId: 'account',
  paymentMethodDefId: 'method',
  exchangeRateConfigId: 'rate',
  fiatCurrency: 'ETB',
  status: 'CREATED',
  createdAt: new Date(now.getTime() - 16 * 60_000),
  pricingSnapshot: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  state.tx.$queryRaw.mockResolvedValue([{ now }]);
  state.tx.agentOrder.findUnique.mockResolvedValue(order);
  state.tx.agentOrder.updateMany.mockResolvedValue({ count: 1 });
  state.tx.agentReservation.findUnique.mockResolvedValue({ id: 'reservation', amount: 100 });
  state.tx.agentReservation.updateMany.mockResolvedValue({ count: 1 });
});
it('uses the earlier of the payment window and locked rate expiry', () => {
  const createdAt = now;
  expect(depositEntryDeadline({ createdAt, pricingSnapshot: null }).getTime()).toBe(
    now.getTime() + 900000
  );
  expect(
    depositEntryDeadline({
      createdAt,
      pricingSnapshot: { expiresAt: new Date(now.getTime() + 1000).toISOString() },
    }).getTime()
  ).toBe(now.getTime() + 1000);
});
it('expires unpaid orders and releases the reservation through the ledger helper once', async () => {
  expect(await cancelAgentOrder('buyer', 'order', undefined, 'expiry')).toEqual({
    orderId: 'order',
    status: 'EXPIRED',
  });
  expect(state.release).toHaveBeenCalledWith(state.tx, 'agent', 100, 'order', 'reservation');
  state.tx.agentOrder.updateMany.mockResolvedValue({ count: 0 });
  await expect(cancelAgentOrder('buyer', 'order', undefined, 'expiry')).rejects.toThrow(
    /cannot be cancelled/
  );
  expect(state.release).toHaveBeenCalledOnce();
});
it('leaves an open payment window untouched', async () => {
  state.tx.agentOrder.findUnique.mockResolvedValue({ ...order, createdAt: now });
  expect(await cancelAgentOrder('buyer', 'order', undefined, 'expiry')).toBeNull();
  expect(state.tx.agentOrder.updateMany).not.toHaveBeenCalled();
  expect(state.release).not.toHaveBeenCalled();
});
it('never releases a submitted payment or a reservation already consumed', async () => {
  state.tx.agentOrder.findUnique.mockResolvedValue({ ...order, status: 'PAYMENT_SUBMITTED' });
  state.tx.agentOrder.updateMany.mockResolvedValue({ count: 0 });
  await expect(cancelAgentOrder('buyer', 'order', undefined, 'expiry')).rejects.toThrow();
  expect(state.release).not.toHaveBeenCalled();
  state.tx.agentOrder.updateMany.mockResolvedValue({ count: 1 });
  state.tx.agentReservation.updateMany.mockResolvedValue({ count: 0 });
  await expect(cancelAgentOrder('buyer', 'order', undefined, 'expiry')).rejects.toThrow(
    /already released or consumed/
  );
  expect(state.release).not.toHaveBeenCalled();
});
it('rejects cancellation by another customer before any status claim', async () => {
  await expect(cancelAgentOrder('other', 'order')).rejects.toThrow(/Not your order/);
  expect(state.tx.agentOrder.updateMany).not.toHaveBeenCalled();
});
function readinessRows() {
  return [
    [{ status: 'ACTIVE', userStatus: 'ACTIVE', countryId: 'country' }],
    [{ isActive: true, agentPaymentEnabled: true, usdPricingEnabled: true, currencyCode: 'ETB' }],
    [{ status: 'APPROVED', agentId: 'agent', countryId: 'country', methodDefId: 'method' }],
    [{ isActive: true, countryId: 'country' }],
    [{ now }],
  ];
}
function terms() {
  return {
    version: 'USD_V1',
    coinsPerUsd: 96,
    localPerUsd: '150',
    minorDigits: 2,
    source: 'Test pricing',
    observedAt: new Date(now.getTime() - 1000).toISOString(),
    expiresAt: new Date(now.getTime() + 1000).toISOString(),
    p2pDepositMinUsdCents: 200,
    p2pWithdrawalAboveUsdCents: 400,
    cryptoDepositMinUsdCents: 1000,
    cryptoWithdrawalAboveUsdCents: 2000,
    feeMinor: 0,
  };
}
it.each([0, 1, 2, 3])('rejects removed payment prerequisite %i', async (missing) => {
  const rows = readinessRows();
  rows[missing] = [] as any;
  const tx = { $queryRaw: vi.fn() };
  for (const row of rows) tx.$queryRaw.mockResolvedValueOnce(row);
  await expect(
    assertDepositReady(tx as any, { ...order, pricingSnapshot: terms() })
  ).rejects.toThrow(/configuration changed/);
});
it('checks original pricing at database time and rejects expired terms', async () => {
  for (const expiresAt of [new Date(now.getTime() + 1000).toISOString(), now.toISOString()]) {
    const tx = { $queryRaw: vi.fn() };
    for (const row of readinessRows()) tx.$queryRaw.mockResolvedValueOnce(row);
    const result = assertDepositReady(tx as any, {
      ...order,
      pricingSnapshot: { ...terms(), expiresAt, derivedValue: 'ignored' },
    });
    if (expiresAt === now.toISOString()) await expect(result).rejects.toMatchObject({statusCode: 409});
    else await expect(result).resolves.toBeUndefined();
  }
});

it('settles an on-time submission after expiry using the original price', async () => {
  const tx = { $queryRaw: vi.fn() };
  for (const row of readinessRows()) tx.$queryRaw.mockResolvedValueOnce(row);
  await expect(assertDepositReady(tx as any, {
    ...order, createdAt: new Date(now.getTime() - 900),
    status: 'PAYMENT_SUBMITTED', paymentSubmittedAt: new Date(now.getTime() - 500),
    pricingSnapshot: {...terms(), expiresAt: now.toISOString()}, fiatAmount: 30000, coinAmount: 192,
  }, 'settlement')).resolves.toBeUndefined();
});
it.each(['late', 'missing', 'wrong-price'])('rejects %s settlement with a staff-review conflict', async (kind) => {
  const tx = { $queryRaw: vi.fn() };
  for (const row of readinessRows()) tx.$queryRaw.mockResolvedValueOnce(row);
  await expect(assertDepositReady(tx as any, {
    ...order, createdAt: new Date(now.getTime() - 900), status: 'PAYMENT_SUBMITTED',
    paymentSubmittedAt: kind === 'missing' ? null : new Date(now.getTime() - (kind === 'late' ? 0 : 500)),
    pricingSnapshot: {...terms(), expiresAt: now.toISOString()}, fiatAmount: 30000,
    coinAmount: kind === 'wrong-price' ? 193 : 192,
  }, 'settlement')).rejects.toMatchObject({statusCode: 409});
});
