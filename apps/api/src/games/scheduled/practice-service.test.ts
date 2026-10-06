import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { settleSpin90Bets } from '@socialplay/shared';
import { tickPracticeStream } from './round-store.js';
import type { RoundDatabase, RoundTransaction } from './round-store.js';
import { PRACTICE_STREAM, practiceSnapshot, submitPracticeTicket } from './practice-service.js';

let pg: PGlite;
let db: RoundDatabase;
const wrap = (tx: Pick<Transaction, 'query'>): RoundTransaction => ({
  query: async <T extends object>(sql: string, values: unknown[] = []) =>
    (await tx.query<T>(sql, values)).rows,
});
const bets = [{ marketId: 'red', amount: 40 }];
let roundId: string;
beforeAll(async () => {
  pg = new PGlite();
  db = { ...wrap(pg), transaction: (run) => pg.transaction((tx) => run(wrap(tx))) };
  await pg.exec(
    "CREATE TABLE public.users(id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO public.users VALUES ('alice','ACTIVE'),('bob','ACTIVE'),('suspended','SUSPENDED')"
  );
  for (const migration of [
    '20260930110000_scheduled_practice_rounds',
    '20260930120000_scheduled_practice_tickets',
  ]) {
    await pg.exec(
      await readFile(
        new URL(
          `../../../../../packages/database/prisma/migrations/${migration}/migration.sql`,
          import.meta.url
        ),
        'utf8'
      )
    );
  }
});
afterAll(async () => {
  await pg?.close();
});

describe('practice admission and read-only recovery', () => {
  it('polls a disabled stream without opening it or generating rounds', async () => {
    expect(await practiceSnapshot(db, 'alice')).toMatchObject({
      enabled: false,
      coinsAccepted: false,
      rounds: [],
      nextOpensAt: null,
    });
    expect(await db.query('SELECT * FROM public.scheduled_game_rounds')).toEqual([]);
  });
  it('rejects inactive players even with a valid user ID', async () => {
    await expect(practiceSnapshot(db, 'suspended')).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      submitPracticeTicket(db, 'suspended', `${PRACTICE_STREAM}:0`, bets)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it('uses the database cutoff and locks a canonical ticket once', async () => {
    // Recreate the disabled seed with a short schedule in a test-only fresh database.
    // ALTER is owner-only fixture setup; guard stays enabled for all assertions.
    await pg.exec(
      'ALTER TABLE public.scheduled_game_streams DISABLE TRIGGER scheduled_stream_guard'
    );
    await db.query(
      `UPDATE public.scheduled_game_streams SET enabled=true,betting_ms=5000,reveal_ms=1000,result_ms=1000,
      anchor_ms=pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT WHERE id=$1`,
      [PRACTICE_STREAM]
    );
    await pg.exec(
      'ALTER TABLE public.scheduled_game_streams ENABLE TRIGGER scheduled_stream_guard'
    );
    roundId = (await tickPracticeStream(db, PRACTICE_STREAM)).created!;
    const ticket = await submitPracticeTicket(db, 'alice', roundId, bets);
    expect(ticket).toMatchObject({ roundId, bets, coinsAccepted: false, isReplay: false });
    expect(await submitPracticeTicket(db, 'alice', roundId, bets)).toMatchObject({
      isReplay: true,
      acceptedAt: ticket.acceptedAt,
    });
    await expect(
      submitPracticeTicket(db, 'alice', roundId, [{ marketId: 'black', amount: 40 }])
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await db.query('SELECT * FROM public.scheduled_practice_tickets')).toHaveLength(1);
  });
  it("never reveals another player's ticket, and polling changes nothing", async () => {
    const before = await db.query('SELECT * FROM public.scheduled_practice_tickets');
    const own = await practiceSnapshot(db, 'alice');
    expect(own.rounds[0].ticket).toMatchObject({ bets, stake: 40, payout: null });
    expect((await practiceSnapshot(db, 'bob')).rounds[0].ticket).toBeNull();
    expect(await db.query('SELECT * FROM public.scheduled_practice_tickets')).toEqual(before);
  });
  it.each([
    [{ marketId: 'red', amount: 41 }],
    [{ marketId: 'red', amount: 520 }],
    [{ marketId: 'missing', amount: 40 }],
    [
      { marketId: 'red', amount: 40 },
      { marketId: 'red', amount: 40 },
    ],
    [
      { marketId: 'red', amount: 280 },
      { marketId: 'black', amount: 240 },
    ],
  ])('rejects malformed/oversized selections without a ticket', async (...input) => {
    await expect(submitPracticeTicket(db, 'bob', roundId, input)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      db.query(
        'INSERT INTO public.scheduled_practice_tickets(round_id,user_id,bets) VALUES ($1,$2,$3::JSONB)',
        [roundId, 'bob', JSON.stringify(input)]
      )
    ).rejects.toThrow();
  });
  it('rejects edits, deletion and truncation', async () => {
    await expect(
      db.query("UPDATE public.scheduled_practice_tickets SET bets='[]'::JSONB")
    ).rejects.toThrow('immutable');
    await expect(db.query('DELETE FROM public.scheduled_practice_tickets')).rejects.toThrow(
      'immutable'
    );
    await expect(db.query('TRUNCATE public.scheduled_practice_tickets')).rejects.toThrow(
      'immutable'
    );
  });
  it('pause denies new tickets but preserves exact retry and recovery', async () => {
    await db.query('UPDATE public.scheduled_game_streams SET enabled=false WHERE id=$1', [
      PRACTICE_STREAM,
    ]);
    await expect(submitPracticeTicket(db, 'bob', roundId, bets)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await submitPracticeTicket(db, 'alice', roundId, bets)).isReplay).toBe(true);
  });
  it('settles display from the same immutable result for every viewer, never a wallet', async () => {
    // Wait for the real database cutoff; no changed round clock or disabled guard.
    const [row] = await db.query<{ wait: number }>(
      `SELECT GREATEST(0,closes_ms-pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000))::INTEGER AS wait FROM public.scheduled_game_rounds WHERE id=$1`,
      [roundId]
    );
    await new Promise((resolve) => setTimeout(resolve, row.wait + 10));
    await tickPracticeStream(db, PRACTICE_STREAM);
    const own = await practiceSnapshot(db, 'alice');
    const other = await practiceSnapshot(db, 'bob');
    expect(own.rounds[0].outcome).not.toBeNull();
    expect(other.rounds[0].outcome).toBe(own.rounds[0].outcome);
    expect(own.rounds[0].ticket?.payout).toBe(
      settleSpin90Bets(bets, own.rounds[0].outcome!).payout
    );
    expect((await submitPracticeTicket(db, 'alice', roundId, bets)).isReplay).toBe(true);
    await expect(submitPracticeTicket(db, 'bob', roundId, bets)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(
      await db.query(
        "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename LIKE '%wallet%'"
      )
    ).toEqual([]);
  }, 40000);
});
