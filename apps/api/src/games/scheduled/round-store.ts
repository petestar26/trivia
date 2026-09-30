import { SPIN90_RULES_ID } from '@socialplay/shared';
import { scheduledRound } from '../economics/round-clock.js';
import { generateRoundOutcome } from '../economics/round-outcome.js';
import { identifier } from '../economics/money.js';

export interface RoundTransaction {
  query<T extends object>(sql: string, values?: unknown[]): Promise<T[]>;
}
export interface RoundDatabase extends RoundTransaction {
  transaction<T>(run: (tx: RoundTransaction) => Promise<T>): Promise<T>;
}
interface Stream {
  id: string; game_key: string; rules_id: string; mode: string; enabled: boolean;
  anchor_ms: bigint; betting_ms: number; reveal_ms: number; result_ms: number;
}
interface StoredRound {
  id: string; stream_id: string; sequence: bigint; game_key: string; rules_id: string; mode: string;
  opens_ms: bigint; closes_ms: bigint; reveal_ends_ms: bigint; ends_ms: bigint;
  state: 'OPEN' | 'DRAWN'; outcome: number | null; drawn_at: Date | null;
}

async function databaseNow(tx: RoundTransaction): Promise<number> {
  const [row] = await tx.query<{ now_ms: bigint }>(
    'SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()) * 1000)::BIGINT AS now_ms',
  );
  const now = Number(row.now_ms);
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('Invalid database time');
  return now;
}

/**
 * One bounded transaction, safe for repeated calls and competing workers.
 * Emits nothing before commit. Retries return stored results, never redraw them.
 * No financial admission or settlement is implemented by this worker.
 */
export async function tickPracticeStream(db: RoundDatabase, streamId: string) {
  identifier(streamId, 'Stream ID');
  return db.transaction(async (tx) => {
    const [lock] = await tx.query<{ locked: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:' || $1::TEXT, 0)) AS locked",
      [streamId],
    );
    if (!lock.locked) return { busy: true, created: null, drawn: [] as string[] };
    const [stream] = await tx.query<Stream>('SELECT * FROM public.scheduled_game_streams WHERE id = $1', [streamId]);
    if (!stream) throw new RangeError('Unknown stream');
    if (stream.mode !== 'PRACTICE' || stream.game_key !== 'spin_win' || stream.rules_id !== SPIN90_RULES_ID) {
      throw new RangeError('Unsupported practice stream');
    }
    const now = await databaseNow(tx);
    const pending = await tx.query<StoredRound>(
      `SELECT * FROM public.scheduled_game_rounds WHERE stream_id = $1 AND state = 'OPEN'
       AND closes_ms <= $2::BIGINT ORDER BY sequence LIMIT 100 FOR UPDATE`, [streamId, now],
    );
    const drawn: string[] = [];
    for (const round of pending) {
      if (round.game_key !== stream.game_key || round.rules_id !== stream.rules_id || round.mode !== 'PRACTICE') {
        throw new RangeError('Stored round rules mismatch');
      }
      const result = generateRoundOutcome(round.game_key, round.rules_id);
      await tx.query(
        `UPDATE public.scheduled_game_rounds SET state = 'DRAWN', outcome = $2::SMALLINT
         WHERE id = $1 AND state = 'OPEN' RETURNING id`, [round.id, Number(result.outcomes[0])],
      );
      drawn.push(round.id);
    }
    let created: string | null = null;
    // Pausing stops creation only; previously opened rounds still finish.
    if (stream.enabled) {
      const currentTime = await databaseNow(tx);
      if (currentTime >= Number(stream.anchor_ms)) {
        const clock = scheduledRound(currentTime, {
          anchorMs: Number(stream.anchor_ms), bettingMs: stream.betting_ms,
          revealMs: stream.reveal_ms, resultMs: stream.result_ms,
        });
        if (clock.phase === 'OPEN') {
          const id = `${stream.id}:${clock.sequence}`;
          const [existing] = await tx.query<{ id: string }>('SELECT id FROM public.scheduled_game_rounds WHERE id = $1', [id]);
          if (!existing) {
            await tx.query(
              `INSERT INTO public.scheduled_game_rounds
               (id,stream_id,sequence,game_key,rules_id,mode,opens_ms,closes_ms,reveal_ends_ms,ends_ms)
               VALUES ($1,$2,$3::BIGINT,$4,$5,'PRACTICE',$6::BIGINT,$7::BIGINT,$8::BIGINT,$9::BIGINT) RETURNING id`,
              [id, stream.id, clock.sequence, stream.game_key, stream.rules_id,
                clock.opensAt, clock.closesAt, clock.revealEndsAt, clock.endsAt],
            );
            created = id;
          }
        }
      }
    }
    return { busy: false, created, drawn };
  });
}

/** Read-only polling; it never creates a round or triggers a draw. */
export async function readPracticeRound(db: RoundTransaction, roundId: string) {
  identifier(roundId, 'Round ID');
  const [row] = await db.query<StoredRound>('SELECT * FROM public.scheduled_game_rounds WHERE id = $1', [roundId]);
  if (!row) return null;
  if (row.mode !== 'PRACTICE') throw new RangeError('Unsupported round mode');
  const now = await databaseNow(db);
  return {
    id: row.id, streamId: row.stream_id, sequence: row.sequence.toString(),
    gameKey: row.game_key, rulesId: row.rules_id, mode: 'PRACTICE' as const,
    coinsAccepted: false, serverTime: now,
    opensAt: Number(row.opens_ms), closesAt: Number(row.closes_ms),
    revealEndsAt: Number(row.reveal_ends_ms), endsAt: Number(row.ends_ms),
    state: row.state,
    outcome: row.state === 'DRAWN' && now >= Number(row.closes_ms) ? row.outcome : null,
    drawnAt: row.drawn_at,
  };
}
