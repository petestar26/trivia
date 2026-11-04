import { parseSpin90Bets, settleSpin90Bets, SCHEDULED_SPIN_MAX_TICKETS } from '@socialplay/shared';
import type { ScheduledPracticeSnapshot, SpinBet } from '@socialplay/shared';
import type { RoundDatabase, RoundTransaction } from './round-store.js';

export const PRACTICE_STREAM = 'spin-win-practice-v1';
export class PracticeError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}
interface TicketRow {
  slot: number;
  bets: SpinBet[];
  accepted_at: Date;
}

export async function submitPracticeTicket(
  db: RoundDatabase,
  userId: string,
  roundId: string,
  input: unknown,
  slot = 1
) {
  if (typeof roundId !== 'string' || !/^spin-win-practice-v1:[0-9]{1,16}$/.test(roundId)) {
    throw new PracticeError(400, 'Invalid practice round');
  }
  if (!Number.isInteger(slot) || slot < 1 || slot > SCHEDULED_SPIN_MAX_TICKETS) {
    throw new PracticeError(400, 'Choose Bet 1 to Bet 10');
  }
  let bets: SpinBet[];
  try {
    bets = parseSpin90Bets(input);
    if (bets.reduce((sum, bet) => sum + bet.amount, 0) > 480) throw new Error('limit');
  } catch {
    throw new PracticeError(400, 'Choose valid practice bets in multiples of 40, up to 480 total');
  }
  return db
    .transaction(async (tx) => {
      await tx.query(
        "SELECT 1 FROM (SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:' || $1::TEXT,0))) AS held",
        [PRACTICE_STREAM]
      );
      const [user] = await tx.query(
        "SELECT id FROM public.users WHERE id=$1 AND status::TEXT='ACTIVE' FOR SHARE",
        [userId]
      );
      if (!user) throw new PracticeError(403, 'An active account is required');
      // Each player/round/slot is one immutable idempotency identity.
      // Retry is allowed after cutoff/pause/draw; changed selections are not.
      const [prior] = await tx.query<TicketRow>(
        'SELECT slot,bets,accepted_at FROM public.scheduled_practice_tickets WHERE round_id=$1 AND user_id=$2 AND slot=$3',
        [roundId, userId, slot]
      );
      if (prior) {
        if (JSON.stringify(parseSpin90Bets(prior.bets)) !== JSON.stringify(bets)) {
          throw new PracticeError(409, `Bet ${slot} already has a different locked ticket`);
        }
        return {
          roundId,
          slot,
          bets: prior.bets,
          acceptedAt: prior.accepted_at,
          coinsAccepted: false,
          isReplay: true,
        };
      }
      const [round] = await tx.query<{ accepts: boolean }>(
        `SELECT
      s.enabled AND r.state='OPEN' AND r.mode='PRACTICE'
      AND pg_catalog.clock_timestamp() >= pg_catalog.to_timestamp(r.opens_ms/1000.0)
      AND pg_catalog.clock_timestamp() < pg_catalog.to_timestamp(r.closes_ms/1000.0) AS accepts
      FROM public.scheduled_game_rounds r JOIN public.scheduled_game_streams s ON s.id=r.stream_id
      WHERE r.id=$1 AND s.id=$2`,
        [roundId, PRACTICE_STREAM]
      );
      if (!round) throw new PracticeError(404, 'Practice round not found');
      if (!round.accepts) throw new PracticeError(409, 'This practice round is closed');
      const [ticket] = await tx.query<TicketRow>(
        `INSERT INTO public.scheduled_practice_tickets(round_id,user_id,bets,slot)
      VALUES ($1,$2,$3::JSONB,$4) RETURNING slot,bets,accepted_at`,
        [roundId, userId, JSON.stringify(bets), slot]
      );
      return {
        roundId,
        slot,
        bets: ticket.bets,
        acceptedAt: ticket.accepted_at,
        coinsAccepted: false,
        isReplay: false,
      };
    })
    .catch((error: unknown) => {
      // The trigger rechecks database time at insertion, closing the cutoff race.
      const dbError = error as { code?: string; meta?: { code?: string } };
      if (dbError.code === '23514' || dbError.meta?.code === '23514') {
        throw new PracticeError(409, 'Practice entry closed or account eligibility changed');
      }
      throw error;
    });
}

interface SnapshotRow {
  enabled: boolean;
  anchor_ms: bigint;
  duration_ms: bigint;
  now_ms: bigint;
  rounds: Array<{
    id: string;
    sequence: string;
    opensAt: number;
    closesAt: number;
    revealEndsAt: number;
    endsAt: number;
    state: 'OPEN' | 'DRAWN';
    outcome: number | null;
    tickets: { slot: number; bets: SpinBet[]; acceptedAt: string }[];
  }>;
}
/** One SELECT snapshot. No polling call creates a round, draws, or settles money. */
export async function practiceSnapshot(
  db: RoundTransaction,
  userId: string
): Promise<ScheduledPracticeSnapshot> {
  const [row] = await db.query<SnapshotRow>(
    `SELECT s.enabled,s.anchor_ms,
    (s.betting_ms::BIGINT+s.reveal_ms+s.result_ms) AS duration_ms,
    pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT AS now_ms,
    COALESCE((SELECT pg_catalog.jsonb_agg(x.payload ORDER BY x.sequence DESC) FROM (
      SELECT r.sequence, pg_catalog.jsonb_build_object(
        'id',r.id,'sequence',r.sequence::TEXT,'opensAt',r.opens_ms,'closesAt',r.closes_ms,
        'revealEndsAt',r.reveal_ends_ms,'endsAt',r.ends_ms,'state',r.state,'outcome',r.outcome,
        'tickets',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'slot',t.slot,'bets',t.bets,'acceptedAt',t.accepted_at) ORDER BY t.slot)
          FROM public.scheduled_practice_tickets t WHERE t.round_id=r.id AND t.user_id=$2),'[]'::JSONB)
      ) AS payload FROM public.scheduled_game_rounds r
      WHERE r.stream_id=s.id ORDER BY r.sequence DESC LIMIT 12
    ) x),'[]'::JSONB) AS rounds
    FROM public.scheduled_game_streams s WHERE s.id=$1
    AND EXISTS(SELECT 1 FROM public.users u WHERE u.id=$2 AND u.status::TEXT='ACTIVE')`,
    [PRACTICE_STREAM, userId]
  );
  if (!row) throw new PracticeError(403, 'Practice stream unavailable or account inactive');
  const now = Number(row.now_ms);
  const anchor = Number(row.anchor_ms);
  const duration = Number(row.duration_ms);
  return {
    streamId: PRACTICE_STREAM,
    mode: 'PRACTICE',
    coinsAccepted: false,
    maxTickets: SCHEDULED_SPIN_MAX_TICKETS,
    enabled: row.enabled,
    serverTime: now,
    nextOpensAt: row.enabled
      ? now < anchor
        ? anchor
        : anchor + (Math.floor((now - anchor) / duration) + 1) * duration
      : null,
    rounds: row.rounds.map((round) => {
      const outcome = round.state === 'DRAWN' && now >= round.closesAt ? round.outcome : null;
      const tickets = round.tickets.map((ticket) => ({
        ...ticket,
        stake: ticket.bets.reduce((sum, bet) => sum + bet.amount, 0),
        payout: outcome === null ? null : settleSpin90Bets(ticket.bets, outcome).payout,
      }));
      return {
        ...round,
        outcome,
        tickets,
        ticket: tickets.find((ticket) => ticket.slot === 1) ?? null,
      };
    }),
  };
}
