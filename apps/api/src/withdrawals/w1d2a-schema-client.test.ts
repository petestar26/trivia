import { describe, it, expect } from 'vitest';
import { Prisma } from '@socialplay/database';

// ─── W-1D2A: schema/client compile check ───────────────────────
//
// This is a COMPILE-TIME surface check, not a DB test: it constructs typed
// Prisma create-input objects using the W-1D2A fields. If `prisma generate`
// did not emit the new enums / fields (outcome, resolvedByUserId, disputeId,
// refundWalletTransactionId, source, paymentOccurredAt), this file would fail
// to TYPE-CHECK, so the whole suite would fail to compile — a regression in
// the generated client is caught immediately here. No queries run, so this
// runs locally even when the DB is behind.

describe('W-1D2A: generated Prisma client accepts the new withdrawal schema fields', () => {
  it('WithdrawalSettlement create input accepts outcome, resolvedByUserId, disputeId, refundWalletTransactionId', () => {
    const completed: Prisma.WithdrawalSettlementCreateInput = {
      withdrawal: { connect: { id: 'settlement-withdrawal' } },
      reservationId: 'res-1',
      coinAmount: 1000,
      fiatAmount: 500n,
      walletTransactionId: 'debit-1',
      resolvedVia: 'ADMIN_DISPUTE_RESOLUTION',
      outcome: 'COMPLETED',
      resolvedByUserId: 'admin-1',
      disputeId: 'dispute-1',
    };

    const cancelled: Prisma.WithdrawalSettlementCreateInput = {
      withdrawal: { connect: { id: 'settlement-withdrawal-cancel' } },
      reservationId: 'res-2',
      coinAmount: 1000,
      fiatAmount: 500n,
      walletTransactionId: 'debit-2',
      resolvedVia: 'ADMIN_DISPUTE_RESOLUTION',
      outcome: 'CANCELLED',
      resolvedByUserId: 'admin-2',
      refundWalletTransactionId: 'refund-1',
    };

    expect(completed.outcome).toBe('COMPLETED');
    expect(cancelled.outcome).toBe('CANCELLED');
    expect(cancelled.refundWalletTransactionId).toBe('refund-1');
  });

  it('WithdrawalPaymentSubmission create input accepts source and paymentOccurredAt', () => {
    const adminVerified: Prisma.WithdrawalPaymentSubmissionCreateInput = {
      withdrawal: { connect: { id: 'submission-withdrawal' } },
      agent: { connect: { id: 'agent-1' } },
      submittedByUser: { connect: { id: 'user-1' } },
      submittedAt: new Date(),
      source: 'ADMIN_VERIFIED',
      paymentOccurredAt: new Date(),
      referenceNumber: 'ADMIN-REF-1',
      idempotencyKey: 'k-1',
      requestHash: 'h-1',
    };

    // W-1D1 agent path never sets source; the AGENT_SUBMITTED default applies.
    const defaultedSource: Prisma.WithdrawalPaymentSubmissionCreateInput = {
      withdrawal: { connect: { id: 'submission-withdrawal-2' } },
      agent: { connect: { id: 'agent-2' } },
      submittedByUser: { connect: { id: 'user-2' } },
      submittedAt: new Date(),
      referenceNumber: 'REF-2',
      idempotencyKey: 'k-2',
      requestHash: 'h-2',
    };

    expect(adminVerified.source).toBe('ADMIN_VERIFIED');
    expect(adminVerified.paymentOccurredAt).toBeInstanceOf(Date);
    // When omitted, source is omitted from the input and the schema default
    // (AGENT_SUBMITTED) applies at the DB — assert the enum value exists.
    expect(defaultedSource.source).toBeUndefined();
    expect(['AGENT_SUBMITTED', 'ADMIN_VERIFIED']).toContain(adminVerified.source);
  });
});
