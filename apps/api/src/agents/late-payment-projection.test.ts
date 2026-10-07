import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ tx: {
  $queryRaw: vi.fn(),
  agentOrder: { findUnique: vi.fn() },
  latePaymentCase: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  dispute: { findFirst: vi.fn() },
  agentReservation: { findUnique: vi.fn() },
  agentOrderSettlement: { findUnique: vi.fn() },
  auditLog: { create: vi.fn() },
} }));
vi.mock('@socialplay/database', async (original) => ({
  ...(await original<typeof import('@socialplay/database')>()),
  prisma: { $transaction: (fn: any) => fn(state.tx) },
}));
import { listLatePayments, reportLatePayment } from './late-payment-service.js';

const args = {
  orderId: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'member-request-key',
  paymentReference: 'PAY-123', paidAmount: 100, paidAt: '2026-01-01T12:00:00.000Z',
  description: 'Payment sent after expiry',
};
const row = {
  ...args, id: 'case', paidAt: new Date(args.paidAt), status: 'REFUNDED',
  openedBy: 'member', assignedAdminId: 'reviewer', assignedAt: new Date(),
  resolutionKey: 'staff-request-key', internalFutureField: 'private',
  verifiedPaymentReference: 'PAY-123', verifiedAmount: 100, refundReference: 'REF-123',
  refundedAt: new Date(), resolutionNote: 'Returned to payer', resolvedAt: new Date(), openedAt: new Date(),
  order: { orderNumber: 'D-123', fiatCurrency: 'ETB', fiatAmount: 100, internalFutureField: 'private' },
};
beforeEach(() => {
  vi.resetAllMocks();
  state.tx.$queryRaw.mockResolvedValue([{ role: 'SUPER_ADMIN', status: 'ACTIVE' }]);
  state.tx.agentOrder.findUnique.mockResolvedValue({ id: args.orderId, userId: 'member',
    agent: { userId: 'agent' }, status: 'EXPIRED', createdAt: new Date('2026-01-01') });
  state.tx.agentReservation.findUnique.mockResolvedValue({ status: 'RELEASED' });
  state.tx.latePaymentCase.create.mockResolvedValue(row);
  state.tx.latePaymentCase.findMany.mockResolvedValue([row]);
});
function expectMember(result: unknown) {
  expect(result).toMatchObject({ id: 'case', status: 'REFUNDED', refundReference: 'REF-123',
    resolutionNote: 'Returned to payer', order: { orderNumber: 'D-123', fiatCurrency: 'ETB', fiatAmount: 100 } });
  const serialized = JSON.stringify(result);
  for (const field of ['assignedAdminId', 'assignedAt', 'resolutionKey', 'idempotencyKey', 'openedBy', 'internalFutureField']) {
    expect(serialized).not.toContain(field);
  }
}
it('filters internal fields from a newly submitted member report', async () => {
  expectMember(await reportLatePayment('member', args));
  expect(state.tx.auditLog.create).toHaveBeenCalledOnce();
});
it('filters an exact report retry even after staff have resolved the case', async () => {
  state.tx.latePaymentCase.findUnique.mockResolvedValue(row);
  expectMember(await reportLatePayment('member', args));
  expect(state.tx.latePaymentCase.create).not.toHaveBeenCalled();
  expect(state.tx.auditLog.create).not.toHaveBeenCalled();
});
it('uses the same allowlist for the member queue and its nested order', async () => {
  const rows = await listLatePayments('member');
  expectMember(rows[0]);
  expect(state.tx.latePaymentCase.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { openedBy: 'member' } }));
});
it('retains assignment details in the authorized staff queue', async () => {
  const rows = await listLatePayments('super-admin', true);
  expect(rows[0]).toEqual(row);
});
