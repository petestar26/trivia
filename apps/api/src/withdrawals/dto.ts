import type { Withdrawal, WithdrawalQuote, WithdrawalSettlement } from '@socialplay/database';

// W-1C route-boundary DTO serializers.
//
// Fastify's default response path is JSON.stringify, which throws on a
// raw BigInt — confirmed by inspection: no custom serializer is
// registered anywhere in this API (apps/api/src/server.ts only
// configures ajv for REQUEST validation), and grepping the whole repo
// found no prior BigInt-over-HTTP precedent to follow. Every BigInt and
// Prisma.Decimal field must be converted to a string here, at the route
// boundary, before reply.send() — never inside a withdrawals/*-service.ts
// function, which must keep returning real bigint/Decimal for correct
// internal arithmetic.

export interface SerializedWithdrawalQuote extends Omit<WithdrawalQuote, 'fiatAmount' | 'exchangeRateValue'> {
  fiatAmount: string;
  exchangeRateValue: string;
}

export interface SerializedWithdrawal extends Omit<Withdrawal, 'fiatAmount' | 'exchangeRateValue'> {
  fiatAmount: string;
  exchangeRateValue: string;
}

export interface SerializedWithdrawalSettlement extends Omit<WithdrawalSettlement, 'fiatAmount'> {
  fiatAmount: string;
}

export function serializeQuote(quote: WithdrawalQuote): SerializedWithdrawalQuote {
  return {
    ...quote,
    fiatAmount: quote.fiatAmount.toString(),
    exchangeRateValue: quote.exchangeRateValue.toString(),
  };
}

export function serializeWithdrawal(withdrawal: Withdrawal): SerializedWithdrawal {
  return {
    ...withdrawal,
    fiatAmount: withdrawal.fiatAmount.toString(),
    exchangeRateValue: withdrawal.exchangeRateValue.toString(),
  };
}

export function serializeSettlement(settlement: WithdrawalSettlement): SerializedWithdrawalSettlement {
  return {
    ...settlement,
    fiatAmount: settlement.fiatAmount.toString(),
  };
}

// W-1D2: admin-facing withdrawal serialization.
//
// Withdrawal.paymentSnapshot is the user's AUTHORITATIVE, UNMASKED payout
// destination (see withdrawal-service.ts) — legitimately unmasked on the
// withdrawing user's own routes (it's their own data) and on the assigned
// agent's routes (the agent needs the real account number to actually send
// the payout). serializeWithdrawal above is deliberately left as-is for
// both of those; this file makes no behavior change to owner/agent routes.
//
// W-1D2 is the first surface where a withdrawal becomes browsable by a
// party who is neither the owner nor the agent executing the payout — an
// ADMIN/SUPER_ADMIN reviewing or resolving a dispute does not need the raw
// account number to do that job. serializeAdminWithdrawal masks it before
// any admin route can echo it back.
//
// Mirrors payout-account-service.ts's maskAccountDetails exactly, kept as
// a local duplicate rather than exported cross-domain — matching this
// repo's existing precedent of small per-domain private helpers (see that
// file's own validateAccountDetails duplication note).
function maskPaymentSnapshotValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= 4) return '*'.repeat(value.length);
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

function maskPaymentSnapshot(paymentSnapshot: unknown): unknown {
  if (!paymentSnapshot || typeof paymentSnapshot !== 'object' || Array.isArray(paymentSnapshot)) {
    return paymentSnapshot;
  }
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(paymentSnapshot as Record<string, unknown>)) {
    masked[key] = maskPaymentSnapshotValue(value);
  }
  return masked;
}

export interface SerializedAdminWithdrawal extends Omit<SerializedWithdrawal, 'paymentSnapshot'> {
  paymentSnapshot: unknown;
}

export function serializeAdminWithdrawal(withdrawal: Withdrawal): SerializedAdminWithdrawal {
  return {
    ...serializeWithdrawal(withdrawal),
    paymentSnapshot: maskPaymentSnapshot(withdrawal.paymentSnapshot),
  };
}
