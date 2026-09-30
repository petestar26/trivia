import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '@electric-sql/pglite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { readPracticeRound, tickPracticeStream } from './round-store.js';
import type { RoundDatabase, RoundTransaction } from './round-store.js';

// Executes actual PostgreSQL SQL/PLpgSQL in WASM, not mocked query responses.
// PGlite serializes transactions: this is NOT a native multi-connection lock test.
let pg: PGlite;
let directory: string;
let db: RoundDatabase;
let suffix = 0;
const wrap = (tx: Pick<Transaction, 'query'>): RoundTransaction => ({
  query: async <T extends object>(sql: string, values: unknown[] = []) => (await tx.query<T>(sql, values)).rows,
});
const connect = () => {
  db = { ...wrap(pg), transaction: (run) => pg.transaction((tx) => run(wrap(tx))) };
};
async function createStream(bettingMs = 60_000, enabled = true) {
  const id = `test-stream-${++suffix}`;
  await db.query(`INSERT INTO public.scheduled_game_streams
    (id,game_key,rules_id,enabled,anchor_ms,betting_ms,reveal_ms,result_ms)
    VALUES ($1,'spin_win',$2,$3,pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT,$4,10000,10000)`,
  [id, SPIN90_RULES_ID, enabled, bettingMs]);
  return id;
}
async function closeEntries(roundId: string) {
  const [row] = await db.query<{ wait_ms: number }>(`SELECT
    GREATEST(0, closes_ms - pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000))::INTEGER AS wait_ms
    FROM public.scheduled_game_rounds WHERE id=$1`, [roundId]);
  await new Promise((resolve) => setTimeout(resolve, row.wait_ms + 25));
}
async function rejectsSql(sql: string, values: unknown[] = []) {
  await expect(db.query(sql, values)).rejects.toThrow();
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'scheduled-practice-'));
  pg = new PGlite(directory);
  connect();
  const migration = await readFile(new URL('../../../../../packages/database/prisma/migrations/20260930110000_scheduled_practice_rounds/migration.sql', import.meta.url), 'utf8');
  await pg.exec(migration);
});
afterAll(async () => {
  await pg?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('durable practice stream', () => {
  it('installs a disabled seed and creates nothing until enabled', async () => {
    const before = await tickPracticeStream(db, 'spin-win-practice-v1');
    expect(before).toEqual({ busy: false, created: null, drawn: [] });
    expect(await db.query('SELECT id FROM public.scheduled_game_rounds')).toEqual([]);
  });
  it('creates once, and read-only polling and repeated ticks do not duplicate it', async () => {
    const stream = await createStream();
    const first = await tickPracticeStream(db, stream);
    expect(first.created).toBe(`${stream}:0`);
    const before = await db.query('SELECT * FROM public.scheduled_game_rounds WHERE stream_id=$1', [stream]);
    expect((await tickPracticeStream(db, stream)).created).toBeNull();
    expect(await readPracticeRound(db, first.created!)).toMatchObject({ state: 'OPEN', outcome: null, coinsAccepted: false });
    expect(await db.query('SELECT * FROM public.scheduled_game_rounds WHERE stream_id=$1', [stream])).toEqual(before);
    expect(await readPracticeRound(db, 'missing:0')).toBeNull();
  });
  it('rejects early draws and freezes schedule and round snapshots in SQL', async () => {
    const stream = await createStream();
    const { created } = await tickPracticeStream(db, stream);
    await rejectsSql("UPDATE public.scheduled_game_rounds SET state='DRAWN',outcome=7 WHERE id=$1", [created]);
    await rejectsSql('UPDATE public.scheduled_game_rounds SET closes_ms=closes_ms+1 WHERE id=$1', [created]);
    await rejectsSql('UPDATE public.scheduled_game_streams SET betting_ms=betting_ms+1 WHERE id=$1', [stream]);
    await rejectsSql("UPDATE public.scheduled_game_streams SET mode='COINS' WHERE id=$1", [stream]);
    await rejectsSql("UPDATE public.scheduled_game_rounds SET mode='COINS' WHERE id=$1", [created]);
  });
  it('rejects Coin mode at creation, independently of the worker feature switch', async () => {
    await expect(db.query(`INSERT INTO public.scheduled_game_streams
      (id,game_key,rules_id,mode,anchor_ms,betting_ms,reveal_ms,result_ms)
      VALUES ('coin-stream','spin_win',$1,'COINS',0,45000,10000,5000)`, [SPIN90_RULES_ID]))
      .rejects.toThrow(/check constraint/);
  });
  it('creates the current interval after downtime without fabricating missed rounds', async () => {
    const stream = `test-stream-${++suffix}`;
    await db.query(`INSERT INTO public.scheduled_game_streams
      (id,game_key,rules_id,enabled,anchor_ms,betting_ms,reveal_ms,result_ms)
      VALUES ($1,'spin_win',$2,true,pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT-8000000,60000,10000,10000)`,
    [stream, SPIN90_RULES_ID]);
    expect((await tickPracticeStream(db, stream)).created).toBe(`${stream}:100`);
    expect(await db.query('SELECT id FROM public.scheduled_game_rounds WHERE stream_id=$1', [stream]))
      .toEqual([{ id: `${stream}:100` }]);
  });
  it('completes opened rounds after pause; a committed result survives restart and cannot be rewritten', async () => {
    const stream = await createStream(800);
    const { created } = await tickPracticeStream(db, stream);
    expect(created).not.toBeNull();
    await db.query('UPDATE public.scheduled_game_streams SET enabled=false WHERE id=$1', [stream]);
    await closeEntries(created!);
    await expect(db.query("UPDATE public.scheduled_game_rounds SET state='DRAWN',outcome=37 WHERE id=$1", [created]))
      .rejects.toThrow('invalid round transition');
    expect((await tickPracticeStream(db, stream)).drawn).toEqual([created]);
    const before = await readPracticeRound(db, created!);
    expect(before?.state).toBe('DRAWN');
    expect(before?.outcome).toBeGreaterThanOrEqual(0);
    expect(before?.outcome).toBeLessThanOrEqual(36);
    await pg.close();
    pg = new PGlite(directory);
    connect();
    const after = await readPracticeRound(db, created!);
    expect(after?.outcome).toBe(before?.outcome);
    expect(after?.drawnAt).toEqual(before?.drawnAt);
    expect((await tickPracticeStream(db, stream)).drawn).toEqual([]);
    await rejectsSql('UPDATE public.scheduled_game_rounds SET outcome=(outcome+1)%37 WHERE id=$1', [created]);
    await rejectsSql("UPDATE public.scheduled_game_rounds SET state='OPEN',outcome=NULL,drawn_at=NULL WHERE id=$1", [created]);
    await rejectsSql('DELETE FROM public.scheduled_game_rounds WHERE id=$1', [created]);
    await rejectsSql('TRUNCATE public.scheduled_game_rounds');
    await rejectsSql('TRUNCATE public.scheduled_game_streams CASCADE');
  });
  it('rolls back a failed tick and recovers the outstanding round on retry', async () => {
    const stream = await createStream(800);
    const { created } = await tickPracticeStream(db, stream);
    await closeEntries(created!);
    const failing: RoundDatabase = { ...db, transaction: (run) => pg.transaction(async (tx) => {
      await run(wrap(tx));
      throw new Error('forced failure before commit');
    }) };
    await expect(tickPracticeStream(failing, stream)).rejects.toThrow('forced failure before commit');
    expect(await readPracticeRound(db, created!)).toMatchObject({ state: 'OPEN', outcome: null });
    expect((await tickPracticeStream(db, stream)).drawn).toEqual([created]);
  });
  it('rejects unknown streams and forged inserts, including pre-published results', async () => {
    await expect(tickPracticeStream(db, 'unknown')).rejects.toThrow('Unknown stream');
    const stream = await createStream();
    const { created } = await tickPracticeStream(db, stream);
    await rejectsSql(`INSERT INTO public.scheduled_game_rounds
      SELECT id || '-forged',stream_id,sequence+1,game_key,rules_id,mode,opens_ms,closes_ms,reveal_ends_ms,ends_ms,state,outcome,drawn_at
      FROM public.scheduled_game_rounds WHERE id=$1`, [created]);
    await rejectsSql(`INSERT INTO public.scheduled_game_rounds
      SELECT id || '-forged',stream_id,sequence+1,game_key,rules_id,mode,opens_ms,closes_ms,reveal_ends_ms,ends_ms,'DRAWN',7,pg_catalog.clock_timestamp()
      FROM public.scheduled_game_rounds WHERE id=$1`, [created]);
    await rejectsSql('DELETE FROM public.scheduled_game_streams WHERE id=$1', [stream]);
  });
  it('serializes queued duplicate tick requests without duplicating a round (single-connection test)', async () => {
    const stream = await createStream();
    const results = await Promise.all(Array.from({ length: 5 }, () => tickPracticeStream(db, stream)));
    expect(results.filter((result) => result.created !== null)).toHaveLength(1);
    expect(await db.query('SELECT id FROM public.scheduled_game_rounds WHERE stream_id=$1', [stream])).toHaveLength(1);
  });
  it('returns busy without proceeding if the database refuses the stream lock', async () => {
    let calls = 0;
    const locked: RoundDatabase = { ...db, transaction: (run) => run({ query: async <T extends object>() => {
      calls++;
      if (calls > 1) throw new Error('proceeded without lock');
      return [{ locked: false }] as unknown as T[];
    } }) };
    expect(await tickPracticeStream(locked, 'busy-stream')).toEqual({ busy: true, created: null, drawn: [] });
    expect(calls).toBe(1);
  });
});
