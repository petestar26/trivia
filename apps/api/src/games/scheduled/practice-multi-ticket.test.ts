import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { settleSpin90Bets } from '@socialplay/shared';
import type { RoundDatabase, RoundTransaction } from './round-store.js';
import { tickPracticeStream } from './round-store.js';
import { PRACTICE_STREAM, practiceSnapshot, submitPracticeTicket } from './practice-service.js';

let pg: PGlite, db: RoundDatabase, roundId: string;
const wrap = (tx: Pick<Transaction, 'query'>): RoundTransaction => ({
  query: async <T extends object>(sql: string, values: unknown[] = []) =>
    (await tx.query<T>(sql, values)).rows,
});
const migration = async (name: string) =>
  pg.exec(
    await readFile(
      new URL(
        `../../../../../packages/database/prisma/migrations/${name}/migration.sql`,
        import.meta.url
      ),
      'utf8'
    )
  );
const red = [{ marketId: 'red', amount: 40 }];
let legacy: unknown;
beforeAll(async () => {
  pg = new PGlite();
  db = { ...wrap(pg), transaction: (run) => pg.transaction((tx) => run(wrap(tx))) };
  await pg.exec(`CREATE TABLE users(id text PRIMARY KEY,status text NOT NULL);
    INSERT INTO users VALUES ('alice','ACTIVE'),('bob','ACTIVE'),('legacy','ACTIVE'),('inactive','SUSPENDED');
    CREATE TABLE wallet_sentinel(balance integer); INSERT INTO wallet_sentinel VALUES (7281);`);
  await migration('20260930110000_scheduled_practice_rounds');
  await migration('20260930120000_scheduled_practice_tickets');
  await migration('20261003020000_practice_admission_read_scope');
  // Fixture-only schedule; all ticket and round guards remain active for assertions.
  await pg.exec('ALTER TABLE scheduled_game_streams DISABLE TRIGGER scheduled_stream_guard');
  await db.query(
    `UPDATE scheduled_game_streams SET enabled=true,betting_ms=9000,reveal_ms=1000,result_ms=1000,
    anchor_ms=floor(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT WHERE id=$1`,
    [PRACTICE_STREAM]
  );
  await pg.exec('ALTER TABLE scheduled_game_streams ENABLE TRIGGER scheduled_stream_guard');
  roundId = (await tickPracticeStream(db, PRACTICE_STREAM)).created!;
  legacy = (
    await db.query(
      `INSERT INTO scheduled_practice_tickets(round_id,user_id,bets) VALUES($1,'legacy',$2::jsonb) RETURNING *`,
      [roundId, JSON.stringify(red)]
    )
  )[0];
  await migration('20261105150000_spin_practice_multi_ticket');
});
afterAll(async () => {
  await pg?.close();
});
it('preserves historical receipts as Bet 1 and keeps legacy retries compatible', async () => {
  const [row] = await db.query('SELECT * FROM scheduled_practice_tickets WHERE user_id=$1', [
    'legacy',
  ]);
  expect(row).toEqual({ ...(legacy as object), slot: 1 });
  expect(await submitPracticeTicket(db, 'legacy', roundId, red)).toMatchObject({
    slot: 1,
    isReplay: true,
  });
});
it('accepts ten distinct immutable tickets with different selections and amounts', async () => {
  for (let slot = 1; slot <= 10; slot++) {
    const bets = [{ marketId: `number:${slot}`, amount: slot * 40 }];
    expect(await submitPracticeTicket(db, 'alice', roundId, bets, slot)).toMatchObject({
      slot,
      bets,
      isReplay: false,
    });
  }
  const result = await practiceSnapshot(db, 'alice');
  expect(result.maxTickets).toBe(10);
  expect(result.rounds).toHaveLength(1);
  expect(result.rounds[0].tickets?.map((t) => [t.slot, t.stake])).toEqual(
    Array.from({ length: 10 }, (_, i) => [i + 1, (i + 1) * 40])
  );
  expect(result.rounds[0].ticket).toMatchObject({
    bets: [{ marketId: 'number:1', amount: 40 }],
    stake: 40,
  });
});
it('replays the same slot once and rejects changed contents without affecting other tickets', async () => {
  const requests = await Promise.all(
    Array.from({ length: 4 }, () => submitPracticeTicket(db, 'bob', roundId, red, 2))
  );
  expect(requests.filter((r) => !r.isReplay)).toHaveLength(1);
  expect(new Set(requests.map((r) => String(r.acceptedAt))).size).toBe(1);
  await expect(
    submitPracticeTicket(db, 'bob', roundId, [{ marketId: 'black', amount: 40 }], 2)
  ).rejects.toMatchObject({ statusCode: 409 });
  await submitPracticeTicket(db, 'bob', roundId, [{ marketId: 'black', amount: 80 }], 3);
  expect((await practiceSnapshot(db, 'bob')).rounds[0].tickets).toHaveLength(2);
  expect((await practiceSnapshot(db, 'bob')).rounds[0].ticket).toBeNull();
});
it.each([0, 11, -1, 1.5, NaN])('rejects slot %s before admission', async (slot) => {
  await expect(submitPracticeTicket(db, 'bob', roundId, red, slot)).rejects.toMatchObject({
    statusCode: 400,
  });
});
it('enforces slot, stake and immutability constraints on direct SQL writes', async () => {
  for (const slot of [0, 11])
    await expect(
      db.query(
        `INSERT INTO scheduled_practice_tickets(round_id,user_id,bets,slot) VALUES($1,'bob',$2::jsonb,$3)`,
        [roundId, JSON.stringify(red), slot]
      )
    ).rejects.toThrow();
  await expect(
    submitPracticeTicket(
      db,
      'bob',
      roundId,
      [
        { marketId: 'red', amount: 280 },
        { marketId: 'black', amount: 240 },
      ],
      4
    )
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(
    db.query(
      `INSERT INTO scheduled_practice_tickets(round_id,user_id,bets,slot) VALUES($1,'bob','[{"marketId":"red","amount":520}]',4)`,
      [roundId]
    )
  ).rejects.toThrow();
  await expect(
    db.query("UPDATE scheduled_practice_tickets SET slot=5 WHERE user_id='bob' AND slot=2")
  ).rejects.toThrow('immutable');
  await expect(
    db.query("DELETE FROM scheduled_practice_tickets WHERE user_id='bob'")
  ).rejects.toThrow('immutable');
  await expect(db.query('TRUNCATE scheduled_practice_tickets')).rejects.toThrow('immutable');
});
it('keeps independent viewers isolated and old inserts default to Bet 1', async () => {
  await db.query(
    `INSERT INTO scheduled_practice_tickets(round_id,user_id,bets) VALUES($1,'bob',$2::jsonb)`,
    [roundId, JSON.stringify(red)]
  );
  const a = await practiceSnapshot(db, 'alice'),
    b = await practiceSnapshot(db, 'bob');
  expect(a.rounds[0].tickets).toHaveLength(10);
  expect(b.rounds[0].tickets?.map((t) => t.slot)).toEqual([1, 2, 3]);
  expect(b.rounds[0].ticket).toMatchObject({ stake: 40 });
  await expect(submitPracticeTicket(db, 'inactive', roundId, red, 5)).rejects.toMatchObject({
    statusCode: 403,
  });
});
it('preserves exact replay while paused and rejects new slots', async () => {
  await db.query('UPDATE scheduled_game_streams SET enabled=false WHERE id=$1', [PRACTICE_STREAM]);
  await expect(submitPracticeTicket(db, 'bob', roundId, red, 4)).rejects.toMatchObject({
    statusCode: 409,
  });
  expect((await submitPracticeTicket(db, 'bob', roundId, red, 2)).isReplay).toBe(true);
});
it('returns each ticket against the same result after cutoff without changing any wallet', async () => {
  const [timing] = await db.query<{ wait: number }>(
    `SELECT GREATEST(0,closes_ms-floor(EXTRACT(EPOCH FROM clock_timestamp())*1000))::int AS wait FROM scheduled_game_rounds WHERE id=$1`,
    [roundId]
  );
  await new Promise((resolve) => setTimeout(resolve, timing.wait + 20));
  await tickPracticeStream(db, PRACTICE_STREAM);
  const a = await practiceSnapshot(db, 'alice'),
    b = await practiceSnapshot(db, 'bob');
  const round = a.rounds.find((r) => r.id === roundId)!;
  expect(round.outcome).not.toBeNull();
  expect(b.rounds.find((r) => r.id === roundId)?.outcome).toBe(round.outcome);
  for (const t of round.tickets!)
    expect(t.payout).toBe(settleSpin90Bets(t.bets, round.outcome!).payout);
  await tickPracticeStream(db, PRACTICE_STREAM);
  expect(
    (await practiceSnapshot(db, 'alice')).rounds.find((r) => r.id === roundId)?.tickets
  ).toEqual(round.tickets);
  expect(
    (await submitPracticeTicket(db, 'alice', roundId, [{ marketId: 'number:10', amount: 400 }], 10))
      .isReplay
  ).toBe(true);
  await expect(submitPracticeTicket(db, 'bob', roundId, red, 4)).rejects.toMatchObject({
    statusCode: 409,
  });
  expect(await db.query('SELECT balance FROM wallet_sentinel')).toEqual([{ balance: 7281 }]);
}, 20000);
