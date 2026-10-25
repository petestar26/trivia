import type { SkyCrashLeaderboard } from '@socialplay/shared';

type ReturnTicket = SkyCrashLeaderboard['tickets'][number];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function integerIn(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

/**
 * Only public settled-ticket fields enter the dashboard. This is the existing
 * rolling 24-hour practice feed, not a calendar-day or unique-player ranking.
 * Validate the complete response before displaying any of it; never salvage a
 * partial ranking from a malformed feed.
 */
export function parseDashboardReturns(value: unknown): SkyCrashLeaderboard {
  if (
    !record(value) ||
    value.period !== '24h' ||
    !Array.isArray(value.tickets) ||
    value.tickets.length > 50
  ) {
    throw new Error('Top returns response is invalid');
  }

  const identities = new Set<string>();
  const tickets: ReturnTicket[] = [];
  for (const ticket of value.tickets) {
    if (
      !record(ticket) ||
      !boundedText(ticket.player, 80) ||
      !boundedText(ticket.roundId, 64) ||
      !integerIn(ticket.stake, 10, 500) ||
      !integerIn(ticket.payout, 1, Number.MAX_SAFE_INTEGER) ||
      // Manual cash-outs may settle at 1.00x; only auto targets start at 1.01x.
      !integerIn(ticket.paidCents, 100, 2000)
    ) {
      throw new Error('Top returns response is invalid');
    }
    const identity = JSON.stringify([ticket.roundId, ticket.player]);
    if (identities.has(identity))
      throw new Error('Top returns response contains duplicate tickets');
    identities.add(identity);
    // Deliberately project rather than spread: additive API fields are allowed,
    // but account identifiers or other extra data are not retained here.
    tickets.push({
      player: ticket.player,
      roundId: ticket.roundId,
      stake: ticket.stake,
      payout: ticket.payout,
      paidCents: ticket.paidCents,
    });
  }
  return { period: '24h', tickets };
}

/** Highest ten individual ticket returns; ties keep the server's receipt order. */
export function topDashboardReturns(feed: SkyCrashLeaderboard): ReturnTicket[] {
  return feed.tickets
    .map((ticket, order) => ({ ticket, order }))
    .sort((a, b) => b.ticket.payout - a.ticket.payout || a.order - b.order)
    .slice(0, 10)
    .map(({ ticket }) => ({ ...ticket }));
}
