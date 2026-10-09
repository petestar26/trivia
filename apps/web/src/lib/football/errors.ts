import type { FootballReason } from './reasons';

export interface FootballError {
  status: number;
  code: string;
  reason: FootballReason | null;
  message: string;
}

const REASONS: readonly string[] = [
  'BAD_SHAPE',
  'RULES_MISMATCH',
  'DUPLICATE_LEG',
  'DUPLICATE_LINE',
  'MULTIPLE_SHAPE',
  'STAKE_LIMIT',
  'STALE_FIXTURE',
  'UNAVAILABLE_SELECTION',
  'PRICE_CHANGED',
  'ODDS_LIMIT',
  'RETURN_LIMIT',
  'CLOSED',
  'INSUFFICIENT_CREDITS',
  'RECEIPT_CONFLICT',
  'MATCHWEEK_NOT_FOUND',
  'TICKET_LIMIT',
  'RULES_STALE',
];

/** The API client throws `Error(JSON.stringify({ status, code, message, details }))`. */
export function parseFootballError(error: unknown): FootballError {
  const fallback: FootballError = { status: 0, code: 'NETWORK', reason: null, message: '' };
  if (!(error instanceof Error)) return fallback;
  try {
    const value = JSON.parse(error.message) as {
      status?: unknown;
      code?: unknown;
      message?: unknown;
      details?: { reason?: unknown } | null;
    };
    const reason = value.details && typeof value.details === 'object' ? value.details.reason : null;
    return {
      status: typeof value.status === 'number' ? value.status : 0,
      code: typeof value.code === 'string' ? value.code : 'UNKNOWN',
      reason:
        typeof reason === 'string' && REASONS.includes(reason) ? (reason as FootballReason) : null,
      message: typeof value.message === 'string' ? value.message : '',
    };
  } catch {
    return fallback;
  }
}

/**
 * True only when the server definitively refused the request, so no receipt can exist for
 * this key. Network failures, timeouts, rate limits and unexplained 5xx stay unresolved and
 * must be retried with the identical payload.
 */
export function isDefinitiveRefusal(error: FootballError): boolean {
  // Authentication, permissions and feature gates run before the receipt lookup.
  // A refusal there cannot establish whether an earlier identical request was accepted.
  if (error.status < 400 || [401, 403, 429].includes(error.status)) return false;
  return error.reason !== null;
}

export function refusalMessage(error: FootballError): string {
  switch (error.reason) {
    case 'CLOSED':
      return 'Selections for this matchweek have closed. Nothing was charged.';
    case 'INSUFFICIENT_CREDITS':
      return 'Not enough practice credits for this ticket. Nothing was charged.';
    case 'PRICE_CHANGED':
    case 'RULES_STALE':
    case 'RULES_MISMATCH':
      return 'Prices or rules were updated. Review the refreshed selections. Nothing was charged.';
    case 'TICKET_LIMIT':
      return 'You have reached the ticket limit for this matchweek. Nothing was charged.';
    case 'RECEIPT_CONFLICT':
      return 'That confirmation key was already used for a different ticket. Review your slip and confirm again. Nothing new was charged.';
    case 'MATCHWEEK_NOT_FOUND':
    case 'STALE_FIXTURE':
      return 'That matchweek is no longer open for selections. Nothing was charged.';
    case 'ODDS_LIMIT':
    case 'RETURN_LIMIT':
    case 'STAKE_LIMIT':
      return `${error.message || 'A ticket limit was exceeded.'} Nothing was charged.`;
    case 'UNAVAILABLE_SELECTION':
      return 'A selection is not available any more. Remove it and review again. Nothing was charged.';
    default:
      return 'The ticket was not accepted. Review your slip and try again. Nothing was charged.';
  }
}
