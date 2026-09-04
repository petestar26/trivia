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
