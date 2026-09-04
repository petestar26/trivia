import { describe, it, expect } from 'vitest';
import { Prisma, PaymentSubmissionSource, WithdrawalSettlementOutcome } from '@socialplay/database';

// ─── W-1D2A: generated Prisma client RUNTIME surface check ─────
//
// These are RUNTIME assertions against the generated client. They are NOT a
// TypeScript type check, and nothing in this repository type-checks during a
// test run: Vitest transpiles TS with esbuild, which strips type annotations
// without verifying them, `pnpm --filter api test` is plain `vitest run`, and
// there is no CI workflow running `tsc --noEmit`.
//
// That distinction is the whole point of this file. An earlier version only
// declared typed object literals (`const x: Prisma.WithdrawalSettlementCreateInput = {...}`)
// and asserted on the literals it had just written, claiming that a stale or
// regressed `prisma generate` would fail the build. It would not have — the
// annotations are erased before the test runs, so that version stayed green
// regardless of what the generated client actually contained (Opus review R1).
//
// Everything below instead inspects real emitted values — the generated enum
// objects and `Prisma.dmmf.datamodel` — so a stale client, a dropped field, or
// an accidental physical-column rename fails these tests for real.
//
// No database connection is required: nothing here opens a client or queries.
// Note the enums live as TOP-LEVEL exports of the generated client (re-exported
// by @socialplay/database), not as properties of the `Prisma` namespace —
// `Prisma.PaymentSubmissionSource` is undefined at runtime.

/** Looks up a model in the generated datamodel, failing loudly if absent. */
function model(name: string) {
  const found = Prisma.dmmf.datamodel.models.find((m) => m.name === name);
  if (!found) throw new Error(`Model ${name} is missing from the generated Prisma datamodel`);
  return found;
}

/** Looks up a field on a model in the generated datamodel. */
function field(modelName: string, fieldName: string) {
  return model(modelName).fields.find((f) => f.name === fieldName);
}

describe('W-1D2A: generated Prisma client exposes the new withdrawal schema surface', () => {
  it('emits the PaymentSubmissionSource enum with both members', () => {
    expect(PaymentSubmissionSource.AGENT_SUBMITTED).toBe('AGENT_SUBMITTED');
    expect(PaymentSubmissionSource.ADMIN_VERIFIED).toBe('ADMIN_VERIFIED');

    const dmmfEnum = Prisma.dmmf.datamodel.enums.find((e) => e.name === 'PaymentSubmissionSource');
    expect(dmmfEnum).toBeDefined();
    expect(dmmfEnum!.values.map((v) => v.name).sort()).toEqual(['ADMIN_VERIFIED', 'AGENT_SUBMITTED']);
  });

  it('emits the WithdrawalSettlementOutcome enum with both members', () => {
    expect(WithdrawalSettlementOutcome.COMPLETED).toBe('COMPLETED');
    expect(WithdrawalSettlementOutcome.CANCELLED).toBe('CANCELLED');

    const dmmfEnum = Prisma.dmmf.datamodel.enums.find((e) => e.name === 'WithdrawalSettlementOutcome');
    expect(dmmfEnum).toBeDefined();
    expect(dmmfEnum!.values.map((v) => v.name).sort()).toEqual(['CANCELLED', 'COMPLETED']);
  });

  it('carries every new W-1D2A field in the datamodel, with the expected type and optionality', () => {
    const expected: { model: string; field: string; type: string; required: boolean }[] = [
      { model: 'WithdrawalPaymentSubmission', field: 'source', type: 'PaymentSubmissionSource', required: true },
      { model: 'WithdrawalPaymentSubmission', field: 'paymentOccurredAt', type: 'DateTime', required: false },
      { model: 'WithdrawalDispute', field: 'openedFromStatus', type: 'WithdrawalStatus', required: false },
      { model: 'WithdrawalDispute', field: 'escalationReason', type: 'String', required: false },
      { model: 'WithdrawalSettlement', field: 'outcome', type: 'WithdrawalSettlementOutcome', required: true },
      { model: 'WithdrawalSettlement', field: 'disputeId', type: 'String', required: false },
      { model: 'WithdrawalSettlement', field: 'refundWalletTransactionId', type: 'String', required: false },
      { model: 'WithdrawalSettlement', field: 'resolvedByUserId', type: 'String', required: true },
    ];

    for (const spec of expected) {
      const f = field(spec.model, spec.field);
      expect(f, `${spec.model}.${spec.field} is missing from the generated datamodel`).toBeDefined();
      expect(f!.type, `${spec.model}.${spec.field} type`).toBe(spec.type);
      expect(f!.isRequired, `${spec.model}.${spec.field} isRequired`).toBe(spec.required);
    }
  });

  it('keeps resolvedByUserId mapped to the already-deployed physical column completedByUserId', () => {
    // The W-1D2A rename is Prisma-field-only via @map — the migration performs
    // no ALTER/RENAME. If a later change dropped the @map (a real physical
    // rename), this fails.
    const f = field('WithdrawalSettlement', 'resolvedByUserId');
    expect(f).toBeDefined();
    expect(f!.dbName).toBe('completedByUserId');

    // ...and the old Prisma field name is gone from the datamodel.
    expect(field('WithdrawalSettlement', 'completedByUserId')).toBeUndefined();
  });

  it('gives settlement.outcome no default, so every settlement write must supply it', () => {
    // Matches the migration: pre-existing rows are backfilled to COMPLETED and
    // NOT NULL is applied WITHOUT a persisted default, so a new settlement can
    // never silently default to COMPLETED.
    const outcome = field('WithdrawalSettlement', 'outcome');
    expect(outcome!.hasDefaultValue).toBe(false);
  });

  it('defaults payment-submission source to AGENT_SUBMITTED for the W-1D1 agent path', () => {
    // W-1D1's submitPayment never sets `source`; the default keeps that path
    // working and correctly labelled.
    const source = field('WithdrawalPaymentSubmission', 'source');
    expect(source!.hasDefaultValue).toBe(true);
    expect(source!.default).toBe('AGENT_SUBMITTED');
  });
});
