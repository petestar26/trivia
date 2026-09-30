import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { prismaRoundDatabase } from './prisma-round-store.js';
import { PRACTICE_STREAM, practiceSnapshot, submitPracticeTicket } from './practice-service.js';
import { readPracticeRound, tickPracticeStream } from './round-store.js';

const source = process.env.DATABASE_URL;
const url = source ? new URL(source) : null;
if (
  !url ||
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
) {
  throw new Error(
    'Native tests require an explicitly acknowledged loopback playqube_scheduled_throwaway database'
  );
}
const owner = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
const role = `scheduled_test_${randomUUID().replaceAll('-', '')}`;
const password = randomBytes(24).toString('hex');
const runtimeUrl = new URL(url);
runtimeUrl.username = role;
runtimeUrl.password = password;
const first = new PrismaClient({ datasourceUrl: runtimeUrl.toString(), log: [] });
const second = new PrismaClient({ datasourceUrl: runtimeUrl.toString(), log: [] });
let roleCreated = false;

async function stream(bettingMs = 60_000) {
  const id = `native-${randomUUID()}`;
  await owner.$executeRawUnsafe(
    `INSERT INTO public.scheduled_game_streams
    (id,game_key,rules_id,enabled,anchor_ms,betting_ms,reveal_ms,result_ms)
    VALUES ($1,'spin_win',$2,true,pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT,$3,10000,10000)`,
    id,
    SPIN90_RULES_ID,
    bettingMs
  );
  return id;
}
async function afterClose(id: string) {
  const [row] = await owner.$queryRawUnsafe<{ wait: number }[]>(
    `SELECT
    GREATEST(0, closes_ms - pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000))::INTEGER AS wait
    FROM public.scheduled_game_rounds WHERE id=$1`,
    id
  );
  await new Promise((resolve) => setTimeout(resolve, row.wait + 20));
}

beforeAll(async () => {
  const [version] = await owner.$queryRawUnsafe<{ version: string }[]>(
    "SELECT pg_catalog.current_setting('server_version') AS version"
  );
  expect(Number.parseInt(version.version, 10)).toBeGreaterThanOrEqual(13);
  // Generated identifiers/password contain only alphanumeric characters.
  await owner.$executeRawUnsafe(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
  );
  roleCreated = true;
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await owner.$executeRawUnsafe(
    `GRANT SELECT ON public.scheduled_game_streams, public.scheduled_game_rounds TO "${role}"`
  );
  await owner.$executeRawUnsafe(
    `GRANT SELECT ON public.scheduled_practice_tickets, public.users TO "${role}"`
  );
  await owner.$executeRawUnsafe(`GRANT INSERT ON public.scheduled_practice_tickets TO "${role}"`);
  await owner.$executeRawUnsafe(`GRANT UPDATE ("displayName") ON public.users TO "${role}"`);
  await owner.$executeRawUnsafe(`GRANT INSERT ON public.scheduled_game_rounds TO "${role}"`);
  await owner.$executeRawUnsafe(
    `GRANT UPDATE (state,outcome,drawn_at) ON public.scheduled_game_rounds TO "${role}"`
  );
});
afterAll(async () => {
  await Promise.all([first.$disconnect(), second.$disconnect()]);
  try {
    if (roleCreated) {
      await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await owner.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
  } finally {
    await owner.$disconnect();
  }
});

describe('native scheduled rounds', () => {
  it('uses a non-owner runtime role and gives no signing-key access', async () => {
    const [permissions] = await first.$queryRawUnsafe<{ superuser: boolean; key: boolean }[]>(`
      SELECT r.rolsuper AS superuser, pg_catalog.has_table_privilege(current_user,'public.ledger_approval_keys','SELECT') AS key
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    expect(permissions).toEqual({ superuser: false, key: false });
  });
  it('a competing connection skips a held lock and acquires it after commit', async () => {
    const id = await stream();
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = owner.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          "SELECT 1 FROM (SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:' || $1::TEXT,0))) AS held",
          id
        );
        ready();
        await finish;
      },
      { timeout: 15_000 }
    );
    try {
      await Promise.race([held, holder]);
      expect(await tickPracticeStream(prismaRoundDatabase(first), id)).toEqual({
        busy: true,
        created: null,
        drawn: [],
      });
    } finally {
      release();
      await holder;
    }
    expect((await tickPracticeStream(prismaRoundDatabase(first), id)).created).toBe(`${id}:0`);
  });
  it('two connections create exactly one round and publish exactly one stored draw', async () => {
    const id = await stream(1500);
    const workers = [prismaRoundDatabase(first), prismaRoundDatabase(second)];
    const created = await Promise.all(workers.map((db) => tickPracticeStream(db, id)));
    expect(created.filter((result) => result.created !== null)).toHaveLength(1);
    await owner.$executeRawUnsafe(
      'UPDATE public.scheduled_game_streams SET enabled=false WHERE id=$1',
      id
    );
    await afterClose(`${id}:0`);
    const drawn = await Promise.all(workers.map((db) => tickPracticeStream(db, id)));
    expect(drawn.flatMap((result) => result.drawn)).toEqual([`${id}:0`]);
    const stored = await readPracticeRound(workers[0], `${id}:0`);
    expect(stored?.state).toBe('DRAWN');
    await first.$disconnect();
    expect((await readPracticeRound(prismaRoundDatabase(first), `${id}:0`))?.outcome).toBe(
      stored?.outcome
    );
    expect((await tickPracticeStream(workers[1], id)).drawn).toEqual([]);
    await expect(
      first.$executeRawUnsafe(
        'UPDATE public.scheduled_game_rounds SET outcome=(outcome+1)%37 WHERE id=$1',
        `${id}:0`
      )
    ).rejects.toThrow('invalid round transition');
  });
  it('an aborted Prisma transaction leaves no draw and retry finishes it', async () => {
    const id = await stream(1500);
    const db = prismaRoundDatabase(first);
    await tickPracticeStream(db, id);
    await afterClose(`${id}:0`);
    const failing = {
      ...db,
      transaction: async <T>(run: Parameters<typeof db.transaction<T>>[0]): Promise<T> =>
        first.$transaction(async (tx) => {
          await run({
            query: <R extends object>(sql: string, values: unknown[] = []) =>
              tx.$queryRawUnsafe<R[]>(sql, ...values),
          });
          throw new Error('forced native rollback');
        }),
    };
    await expect(tickPracticeStream(failing, id)).rejects.toThrow('forced native rollback');
    expect(await readPracticeRound(db, `${id}:0`)).toMatchObject({ state: 'OPEN', outcome: null });
    expect((await tickPracticeStream(prismaRoundDatabase(second), id)).drawn).toEqual([`${id}:0`]);
  });
});

describe('native practice ticket transactions', () => {
  let userId: string;
  let id: string;
  beforeAll(async () => {
    userId = (await owner.user.create({ data: { username: `practice-${randomUUID()}` } })).id;
    await owner.$executeRawUnsafe(
      'UPDATE public.scheduled_game_streams SET enabled=true WHERE id=$1',
      PRACTICE_STREAM
    );
    // Choose a real open interval with at least five seconds left. Never change
    // the schedule or disable a trigger to make the native race pass.
    for (;;) {
      const [clock] = await owner.$queryRawUnsafe<{ remaining: number }[]>(
        `SELECT (45000 - pg_catalog.mod(pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT,60000))::INTEGER AS remaining`
      );
      if (clock.remaining > 5000) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, clock.remaining + 15000 + 10))
      );
    }
    await tickPracticeStream(prismaRoundDatabase(first), PRACTICE_STREAM);
    id = (await practiceSnapshot(prismaRoundDatabase(first), userId)).rounds[0].id;
  });
  it('concurrent retries create one ticket through restricted Prisma connections', async () => {
    const bets = [{ marketId: 'red', amount: 40 }];
    const results = await Promise.all(
      [first, second].map((client) =>
        submitPracticeTicket(prismaRoundDatabase(client), userId, id, bets)
      )
    );
    expect(results.map((r) => r.isReplay).sort()).toEqual([false, true]);
    expect(results[0].acceptedAt).toEqual(results[1].acceptedAt);
    await expect(
      submitPracticeTicket(prismaRoundDatabase(second), userId, id, [
        { marketId: 'black', amount: 40 },
      ])
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await owner.scheduledPracticeTicket.count({ where: { roundId: id, userId } })).toBe(1);
  });
  it('a request waiting on the stream lock rechecks the database cutoff', async () => {
    const lateUser = (await owner.user.create({ data: { username: `late-${randomUUID()}` } })).id;
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Wait outside the transaction until just before close, keeping transaction
    // duration below the real adapter timeout.
    const [clock] = await owner.$queryRawUnsafe<{ wait: number }[]>(
      `SELECT GREATEST(0,closes_ms-pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)-3000)::INTEGER AS wait FROM public.scheduled_game_rounds WHERE id=$1`,
      id
    );
    await new Promise((resolve) => setTimeout(resolve, clock.wait));
    const holder = owner.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          "SELECT 1 FROM (SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:' || $1::TEXT,0))) AS held",
          PRACTICE_STREAM
        );
        ready();
        await finish;
      },
      { timeout: 10000 }
    );
    let request: Promise<unknown> | undefined;
    try {
      await Promise.race([held, holder]);
      request = submitPracticeTicket(prismaRoundDatabase(first), lateUser, id, [
        { marketId: 'red', amount: 40 },
      ]);
      // Attach the rejection assertion before releasing to avoid an unhandled rejection.
      const rejected = expect(request).rejects.toMatchObject({ statusCode: 409 });
      let waiting = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const [activity] = await owner.$queryRawUnsafe<{ waiting: boolean }[]>(
          "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND wait_event='advisory') AS waiting",
          role
        );
        if (activity.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await afterClose(id);
      release();
      await holder;
      await rejected;
    } finally {
      release();
      await holder;
      await request?.catch(() => undefined);
    }
    expect(
      await owner.scheduledPracticeTicket.count({ where: { roundId: id, userId: lateUser } })
    ).toBe(0);
    expect(
      (
        await submitPracticeTicket(prismaRoundDatabase(second), userId, id, [
          { marketId: 'red', amount: 40 },
        ])
      ).isReplay
    ).toBe(true);
  });
});
