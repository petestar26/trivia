import type { TicketErrorCode } from '@socialplay/shared';

/** Mirrors the API's machine-readable `error.details.reason` values. */
export type FootballReason =
  | TicketErrorCode
  | 'CLOSED'
  | 'INSUFFICIENT_CREDITS'
  | 'RECEIPT_CONFLICT'
  | 'MATCHWEEK_NOT_FOUND'
  | 'TICKET_LIMIT'
  | 'RULES_STALE';
