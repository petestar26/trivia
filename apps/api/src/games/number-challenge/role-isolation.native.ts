import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  grantNumberRuntimeTables,
  verifyNumberRuntimeIdentity,
  verifyNumberAccessReadOnly,
} from '../../scripts/number-runtime-grants.js';
const url = new URL(process.env.DATABASE_URL ?? 'https://invalid');
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Acknowledged throwaway database required');
const db = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
afterAll(() => db.$disconnect());
async function roles(
  run: (api: string, worker: string, middle: string, version: number) => Promise<void>
) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
    names = ['api', 'draw', 'middle'].map((n) => `number_${n}_${suffix}`);
  try {
    for (const name of names) {
      await db.$executeRawUnsafe(`CREATE ROLE "${name}" NOLOGIN NOINHERIT`);
      await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${name}"`);
    }
    const [{ v }] = await db.$queryRaw<
      { v: number }[]
    >`SELECT current_setting('server_version_num')::int AS v`;
    await db.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await grantNumberRuntimeTables(db, names[0], names[1]);
    await run(names[0], names[1], names[2], v);
  } finally {
    for (const name of names) {
      await db.$executeRawUnsafe(`DROP OWNED BY "${name}"`);
      await db.$executeRawUnsafe(`DROP ROLE "${name}"`);
    }
  }
}
it.each([false, true])('refuses %s transitive SET-only API -> draw authority', async (transitive) =>
  roles(async (a, w, m, v) => {
    const options = v >= 160000 ? ' WITH INHERIT FALSE, SET TRUE' : '';
    if (transitive) await db.$executeRawUnsafe(`GRANT "${w}" TO "${m}"${options}`);
    await db.$executeRawUnsafe(`GRANT "${transitive ? m : w}" TO "${a}"${options}`);
    await expect(grantNumberRuntimeTables(db, a, w, false)).rejects.toThrow();
  })
);
it('refuses draw-worker financial rights through a SET-only role', async () =>
  roles(async (a, w, m, v) => {
    await db.$executeRawUnsafe(`GRANT UPDATE("coinsBalance") ON wallets TO "${m}"`);
    await db.$executeRawUnsafe(
      `GRANT "${m}" TO "${w}"${v >= 160000 ? ' WITH INHERIT FALSE, SET TRUE' : ''}`
    );
    await expect(grantNumberRuntimeTables(db, a, w, false)).rejects.toThrow();
  }));
it('accepts inert PG16 memberships while refusing usable ADMIN reach', async () =>
  roles(async (a, w, m, v) => {
    if (v < 160000) {
      expect(v).toBeLessThan(160000);
      return;
    }
    await db.$executeRawUnsafe(`GRANT "${w}" TO "${a}" WITH INHERIT FALSE, SET FALSE, ADMIN FALSE`);
    await expect(grantNumberRuntimeTables(db, a, w, false)).resolves.toBeUndefined();
    await db.$executeRawUnsafe(`GRANT "${w}" TO "${a}" WITH ADMIN TRUE`);
    await expect(grantNumberRuntimeTables(db, a, w, false)).rejects.toThrow();
  }));
it('refuses inherited API draw authority', async () =>
  roles(async (a, w, _m, v) => {
    await db.$executeRawUnsafe(`ALTER ROLE "${a}" INHERIT`);
    await db.$executeRawUnsafe(
      `GRANT "${w}" TO "${a}"${v >= 160000 ? ' WITH INHERIT TRUE, SET FALSE' : ''}`
    );
    await expect(grantNumberRuntimeTables(db, a, w, false)).rejects.toThrow();
  }));
it.each(['public-draw', 'public-wallet', 'schema', 'function', 'owner'])(
  'refuses %s effective authority',
  async (mode) =>
    roles(async (a, w, m) => {
      // Temporary grants/functions/ownership are rolled back, including on assertion failure.
      const rollback = new Error('fixture rollback');
      try {
        await db.$transaction(async (tx) => {
          if (mode === 'public-draw')
            await tx.$executeRawUnsafe('GRANT UPDATE(target) ON number_timed_rounds TO PUBLIC');
          if (mode === 'public-wallet')
            await tx.$executeRawUnsafe('GRANT UPDATE("coinsBalance") ON wallets TO PUBLIC');
          if (mode === 'schema')
            await tx.$executeRawUnsafe(`GRANT CREATE ON SCHEMA public TO "${w}"`);
          if (mode === 'function')
            await tx.$executeRawUnsafe(
              `CREATE FUNCTION public."${m}"() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'UPDATE public.number_timed_rounds SET target=50 WHERE target IS NULL'`
            );
          if (mode === 'owner')
            await tx.$executeRawUnsafe(`ALTER TABLE number_timed_rounds OWNER TO "${w}"`);
          await expect(
            grantNumberRuntimeTables(tx as unknown as PrismaClient, a, w, false)
          ).rejects.toThrow();
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
    })
);
it('checks the actual session at runtime and rejects drift after setup', async () =>
  roles(async (a, w, m, v) => {
    const { verifyNumberRuntimeIdentity } = await import('../../scripts/number-runtime-grants.js');
    const clients: PrismaClient[] = [];
    try {
      for (const name of [a, w]) {
        const password = randomUUID();
        await db.$executeRawUnsafe(`ALTER ROLE "${name}" LOGIN PASSWORD '${password}'`);
        const target = new URL(url);
        target.username = name;
        target.password = password;
        clients.push(new PrismaClient({ datasourceUrl: target.toString(), log: [] }));
      }
      await expect(verifyNumberRuntimeIdentity(clients[0], 'api')).resolves.toBeUndefined();
      await expect(verifyNumberRuntimeIdentity(clients[1], 'worker')).resolves.toBeUndefined();
      await db.$executeRawUnsafe(
        `GRANT "${w}" TO "${m}"${v >= 160000 ? ' WITH INHERIT FALSE, SET TRUE' : ''}`
      );
      await db.$executeRawUnsafe(
        `GRANT "${m}" TO "${a}"${v >= 160000 ? ' WITH INHERIT FALSE, SET TRUE' : ''}`
      );
      await expect(verifyNumberRuntimeIdentity(clients[0], 'api')).rejects.toThrow();
      await expect(verifyNumberRuntimeIdentity(db, 'worker')).rejects.toThrow();
    } finally {
      for (const client of clients) await client.$disconnect();
    }
  }));

it.each([
  ['api', 'function'],
  ['worker', 'function'],
  ['api', 'view'],
  ['worker', 'view'],
] as const)('refuses %s authority through a %s in another schema', async (kind, object) =>
  roles(async (a, w, m) => {
    const { verifyNumberAccessReadOnly } = await import('../../scripts/number-runtime-grants.js');
    const rollback = new Error('fixture rollback');
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${m}"`);
        await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${m}" TO PUBLIC`);
        if (object === 'function') {
          const body =
            kind === 'api'
              ? 'UPDATE public.number_timed_rounds SET target=50 WHERE target IS NULL'
              : 'UPDATE public.wallets SET "coinsBalance"="coinsBalance"+1';
          // PUBLIC EXECUTE is PostgreSQL's default, even outside the public schema.
          await tx.$executeRawUnsafe(
            `CREATE FUNCTION "${m}".escalate() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS '${body}'`
          );
        } else {
          const table = kind === 'api' ? 'number_timed_rounds' : 'wallets';
          await tx.$executeRawUnsafe(`CREATE VIEW "${m}".bridge AS SELECT * FROM public.${table}`);
          await tx.$executeRawUnsafe(
            `GRANT SELECT,UPDATE ON "${m}".bridge TO "${kind === 'api' ? a : w}"`
          );
        }
        await expect(verifyNumberAccessReadOnly(tx, kind === 'api' ? a : w, kind)).rejects.toThrow(
          'NUMBER_RUNTIME_GRANTS_INVALID'
        );
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  })
);

it('a failed setup rolls back every grant it attempted', async () =>
  roles(async (a, w) => {
    await db.$executeRawUnsafe(`REVOKE SELECT ON number_practice_rounds FROM "${a}"`);
    await db.$executeRawUnsafe(`GRANT INSERT ON wallets TO "${w}"`);
    const snapshot = () =>
      db.$queryRaw`SELECT relname,relacl::text AS acl FROM pg_class WHERE relname IN ('number_practice_rounds','number_timed_rounds','number_timed_entries') ORDER BY relname`;
    const before = await snapshot();
    await expect(grantNumberRuntimeTables(db, a, w, true)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }));

it('refuses an API grant on an updatable public view of the draw table', async () =>
  roles(async (a, w, m) => {
    const rollback = new Error('fixture rollback');
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `CREATE VIEW public."${m}" AS SELECT * FROM public.number_timed_rounds`
        );
        await tx.$executeRawUnsafe(`GRANT SELECT,UPDATE ON public."${m}" TO "${a}"`);
        await expect(
          grantNumberRuntimeTables(tx as unknown as PrismaClient, a, w, false)
        ).rejects.toThrow('NUMBER_RUNTIME_GRANTS_INVALID');
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }));

it.each(['api', 'worker'] as const)(
  'refuses %s authority through a temporary-table trigger',
  async (kind) =>
    roles(async (a, w, m) => {
      const { verifyNumberAccessReadOnly } = await import('../../scripts/number-runtime-grants.js');
      const runtime = kind === 'api' ? a : w;
      const rollback = new Error('fixture rollback');
      try {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${m}"`);
          await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${m}" TO PUBLIC`);
          await tx.$executeRawUnsafe(`CREATE TABLE "${m}".owner_only(value integer)`);
          await tx.$executeRawUnsafe(
            `CREATE FUNCTION "${m}".escalate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN INSERT INTO "${m}".owner_only VALUES(1); RETURN NEW; END'`
          );
          const [direct] = await tx.$queryRawUnsafe<{ allowed: boolean }[]>(
            `SELECT has_table_privilege($1,$2,'INSERT') AS allowed`,
            runtime,
            `${m}.owner_only`
          );
          expect(direct.allowed).toBe(false);
          await tx.$executeRawUnsafe(`SET LOCAL ROLE "${runtime}"`);
          await tx.$executeRawUnsafe(`CREATE TEMP TABLE "${m}"(value integer) ON COMMIT DROP`);
          await tx.$executeRawUnsafe(
            `CREATE TRIGGER escalate BEFORE INSERT ON "${m}" FOR EACH ROW EXECUTE FUNCTION "${m}".escalate()`
          );
          await tx.$executeRawUnsafe(`INSERT INTO "${m}" VALUES(1)`);
          await tx.$executeRawUnsafe('RESET ROLE');
          const [effect] = await tx.$queryRawUnsafe<{ count: number }[]>(
            `SELECT count(*)::int AS count FROM "${m}".owner_only`
          );
          expect(effect.count).toBe(1); // Proves indirect owner authority, without touching financial rows.
          await expect(verifyNumberAccessReadOnly(tx, runtime, kind)).rejects.toThrow(
            'NUMBER_RUNTIME_GRANTS_INVALID'
          );
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
    })
);

const privilegedGuards = [
  'game_rules_validate_parent',
  'game_rules_immutable',
  'game_sessions_validate_rules_snapshot',
  'game_definitions_prevent_metadata_drift',
  'coin_allocations_guard',
  'coin_provenance_guard',
];
it.each(privilegedGuards)(
  'does not let a draw worker attach privileged guard %s to its own table',
  async (guard) =>
    roles(async (_a, w, m) => {
      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE "${w}"`);
          await tx.$executeRawUnsafe(`CREATE TEMP TABLE "${m}"(id text) ON COMMIT DROP`);
          await tx.$executeRawUnsafe(
            `CREATE TRIGGER leak BEFORE INSERT ON "${m}" FOR EACH ROW EXECUTE FUNCTION public.${guard}()`
          );
        })
      ).rejects.toThrow(/permission denied for function/);
    })
);
it.each(['coin_allocations_guard', 'coin_provenance_guard'])(
  'refuses restored worker EXECUTE on financial guard %s',
  async (guard) =>
    roles(async (a, w) => {
      await db.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION public.${guard}() TO "${w}"`);
      await expect(grantNumberRuntimeTables(db, a, w, false)).rejects.toThrow(
        'NUMBER_RUNTIME_GRANTS_INVALID'
      );
    })
);

it('independent review: rejects pre-attached definer trigger despite revoked EXECUTE', async () =>
  roles(async (a, w, m) => {
    const { verifyNumberAccessReadOnly } = await import('../../scripts/number-runtime-grants.js');
    const rollback = new Error('fixture rollback');
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${m}"`);
        await tx.$executeRawUnsafe(`CREATE TABLE "${m}".owner_only(value integer)`);
        await tx.$executeRawUnsafe(
          `CREATE FUNCTION "${m}".effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS 'BEGIN INSERT INTO "${m}".owner_only VALUES(1); RETURN NEW; END'`
        );
        await tx.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${m}".effect() FROM PUBLIC`);
        await tx.$executeRawUnsafe(
          `CREATE TRIGGER "${m}" AFTER INSERT ON public.number_timed_rounds FOR EACH ROW EXECUTE FUNCTION "${m}".effect()`
        );
        await expect(verifyNumberAccessReadOnly(tx, w, 'worker')).rejects.toThrow(
          'NUMBER_RUNTIME_GRANTS_INVALID'
        );
        throw rollback;
      });
    } catch (e) {
      if (e !== rollback) throw e;
    }
  }));

async function login(role: string) {
  const password = randomUUID();
  await db.$executeRawUnsafe(`ALTER ROLE "${role}" LOGIN PASSWORD '${password}'`);
  const target = new URL(url);
  target.username = role;
  target.password = password;
  return new PrismaClient({ datasourceUrl: target.toString(), log: [] });
}

it.each(['api', 'worker'] as const)(
  'refuses an already attached private trigger at actual %s startup and atomically during setup',
  async (kind) =>
    roles(async (a, w, m) => {
      const runtime = await login(kind === 'api' ? a : w);
      const roundNumber = 1_000_000 + Math.floor(Math.random() * 1_000_000);
      const roundId = `number-v2:${roundNumber}`;
      const table = kind === 'api' ? 'number_timed_entries' : 'number_timed_rounds';
      try {
        await expect(verifyNumberRuntimeIdentity(runtime, kind)).resolves.toBeUndefined();
        await db.$executeRawUnsafe(`CREATE SCHEMA "${m}"`);
        await db.$executeRawUnsafe(`CREATE TABLE "${m}".owner_only(value integer)`);
        const body =
          kind === 'api'
            ? `UPDATE public.number_timed_rounds SET target=50 WHERE id='${roundId}'`
            : `INSERT INTO "${m}".owner_only VALUES(1)`;
        await db.$executeRawUnsafe(
          `CREATE FUNCTION "${m}".effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$ BEGIN ${body}; RETURN NEW; END $body$`
        );
        await db.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${m}".effect() FROM PUBLIC`);
        await db.$executeRawUnsafe(`CREATE TRIGGER "${m}" ${kind === 'api' ? 'BEFORE' : 'AFTER'} INSERT
        ON public.${table} FOR EACH ${kind === 'api' ? 'STATEMENT' : 'ROW'} EXECUTE FUNCTION "${m}".effect()`);
        const [functionRow] = await db.$queryRawUnsafe<{ oid: number }[]>(
          `SELECT '"${m}".effect()'::regprocedure::oid::int AS oid`
        );
        const [privateTable] = await db.$queryRawUnsafe<{ oid: number }[]>(
          `SELECT '"${m}".owner_only'::regclass::oid::int AS oid`
        );
        const [authority] = await runtime.$queryRawUnsafe<
          {
            execute: boolean;
            usage: boolean;
            direct: boolean;
          }[]
        >(
          `SELECT has_function_privilege(current_user,$1::oid,'EXECUTE') AS execute,
        has_schema_privilege(current_user,$2,'USAGE') AS usage,
        ${
          kind === 'api'
            ? "has_column_privilege(current_user,'public.number_timed_rounds','target','UPDATE')"
            : `has_table_privilege(current_user,${privateTable.oid}::oid,'INSERT')`
        } AS direct`,
          functionRow.oid,
          m
        );
        expect(authority).toEqual({ execute: false, usage: false, direct: false });
        const insertRound = `INSERT INTO public.number_timed_rounds(id,round_number,opens_at,closes_at,ends_at)
        VALUES('${roundId}',${roundNumber},to_timestamp(${roundNumber}*60::double precision),
          to_timestamp(${roundNumber}*60::double precision)+interval '30 seconds',
          to_timestamp(${roundNumber}*60::double precision)+interval '60 seconds')`;
        if (kind === 'api') {
          await db.$executeRawUnsafe(insertRound);
          // The statement trigger fires with zero entries, and the genuine round
          // integrity guard accepts the closed-round transition it performs.
          await runtime.$executeRawUnsafe(`INSERT INTO public.number_timed_entries(id,user_id,round_id,request_id,guess)
          SELECT NULL,NULL,NULL,NULL,NULL WHERE false`);
          expect(
            await runtime.$queryRaw`SELECT target FROM number_timed_rounds WHERE id=${roundId}`
          ).toEqual([{ target: 50 }]);
        } else {
          await runtime.$executeRawUnsafe(insertRound); // Genuine INSERT guard remains enabled.
          expect(await db.$queryRawUnsafe(`SELECT value FROM "${m}".owner_only`)).toEqual([
            { value: 1 },
          ]);
        }
        await expect(verifyNumberRuntimeIdentity(runtime, kind)).rejects.toMatchObject({
          message: 'NUMBER_RUNTIME_GRANTS_INVALID',
          failures: expect.arrayContaining([
            expect.stringContaining('unreviewed privileged trigger'),
          ]),
        });
        await db.$executeRawUnsafe(`REVOKE SELECT ON number_practice_rounds FROM "${a}"`);
        const snapshot = () => db.$queryRaw`SELECT relname,relacl::text AS acl FROM pg_class
        WHERE relname IN ('number_practice_rounds','number_timed_rounds','number_timed_entries') ORDER BY relname`;
        const before = await snapshot();
        await expect(grantNumberRuntimeTables(db, a, w)).rejects.toMatchObject({
          failures: expect.arrayContaining([
            expect.stringContaining('unreviewed privileged trigger'),
          ]),
        });
        expect(await snapshot()).toEqual(before);
      } finally {
        await runtime.$disconnect();
        await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${m}" ON public.${table}`);
        await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${m}" CASCADE`);
      }
    })
);

it.each(['partition', 'cascade'] as const)(
  'finds a private privileged trigger through %s writes without child grants',
  async (mode) =>
    roles(async (a, _w, m) => {
      const runtime = await login(a);
      try {
        await db.$executeRawUnsafe(`CREATE SCHEMA "${m}"`);
        await db.$executeRawUnsafe(`CREATE TABLE "${m}".owner_only(value integer)`);
        await db.$executeRawUnsafe(
          `CREATE TABLE public."${m}"(id integer PRIMARY KEY) ${mode === 'partition' ? 'PARTITION BY RANGE(id)' : ''}`
        );
        if (mode === 'partition')
          await db.$executeRawUnsafe(
            `CREATE TABLE "${m}".child PARTITION OF public."${m}" FOR VALUES FROM(0) TO(100)`
          );
        else {
          await db.$executeRawUnsafe(
            `CREATE TABLE "${m}".child(id integer REFERENCES public."${m}"(id) ON UPDATE CASCADE ON DELETE CASCADE)`
          );
          await db.$executeRawUnsafe(`INSERT INTO public."${m}" VALUES(1)`);
          await db.$executeRawUnsafe(`INSERT INTO "${m}".child VALUES(1)`);
        }
        await db.$executeRawUnsafe(
          `CREATE FUNCTION "${m}".effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS 'BEGIN INSERT INTO "${m}".owner_only VALUES(1); RETURN NEW; END'`
        );
        await db.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${m}".effect() FROM PUBLIC`);
        await db.$executeRawUnsafe(
          `CREATE TRIGGER effect AFTER ${mode === 'partition' ? 'INSERT' : 'UPDATE'} ON "${m}".child FOR EACH ROW EXECUTE FUNCTION "${m}".effect()`
        );
        await db.$executeRawUnsafe(`GRANT SELECT,INSERT,UPDATE(id) ON public."${m}" TO "${a}"`);
        const [child] = await db.$queryRawUnsafe<{ oid: number }[]>(
          `SELECT '"${m}".child'::regclass::oid::int AS oid`
        );
        expect(
          await runtime.$queryRawUnsafe(
            `SELECT has_table_privilege(current_user,${child.oid}::oid,'${mode === 'partition' ? 'INSERT' : 'UPDATE'}') AS allowed`
          )
        ).toEqual([{ allowed: false }]);
        await runtime.$executeRawUnsafe(
          mode === 'partition'
            ? `INSERT INTO public."${m}" VALUES(1)`
            : `UPDATE public."${m}" SET id=2 WHERE id=1`
        );
        expect(await db.$queryRawUnsafe(`SELECT value FROM "${m}".owner_only`)).toEqual([
          { value: 1 },
        ]);
        await expect(verifyNumberRuntimeIdentity(runtime, 'api')).rejects.toMatchObject({
          failures: expect.arrayContaining([expect.stringContaining(`${m}.child.effect`)]),
        });
      } finally {
        await runtime.$disconnect();
        await db.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${m}" CASCADE`);
        await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${m}" CASCADE`);
      }
    })
);

it.each(['UPDATE OF target', 'INSERT OR UPDATE OF target'])(
  'matches attached trigger columns independently for %s',
  async (event) =>
    roles(async (a, w, m) => {
      const rollback = new Error('fixture rollback');
      try {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${m}"`);
          await tx.$executeRawUnsafe(
            `CREATE FUNCTION "${m}".effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS 'BEGIN RETURN NEW; END'`
          );
          await tx.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${m}".effect() FROM PUBLIC`);
          await tx.$executeRawUnsafe(
            `CREATE TRIGGER effect AFTER ${event} ON number_timed_rounds FOR EACH ROW EXECUTE FUNCTION "${m}".effect()`
          );
          // The API updates id only. Its INSERT on entries cannot fire a round
          // trigger. The worker's INSERT/target UPDATE can fire either form.
          await expect(verifyNumberAccessReadOnly(tx, a, 'api')).resolves.toBeUndefined();
          await expect(verifyNumberAccessReadOnly(tx, w, 'worker')).rejects.toThrow(
            'NUMBER_RUNTIME_GRANTS_INVALID'
          );
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
    })
);

it('does not let an UPDATE column list hide the same trigger’s INSERT event', async () =>
  roles(async (a, _w, m) => {
    const rollback = new Error('fixture rollback');
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${m}"`);
        await tx.$executeRawUnsafe(
          `CREATE FUNCTION "${m}".effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS 'BEGIN RETURN NEW; END'`
        );
        await tx.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${m}".effect() FROM PUBLIC`);
        await tx.$executeRawUnsafe(`CREATE TRIGGER effect AFTER INSERT OR UPDATE OF guess ON number_timed_entries
          FOR EACH ROW EXECUTE FUNCTION "${m}".effect()`);
        await expect(verifyNumberAccessReadOnly(tx, a, 'api')).rejects.toMatchObject({
          failures: expect.arrayContaining([
            expect.stringContaining('number_timed_entries.effect'),
          ]),
        });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }));

it.each(['inherit', 'transitive-set'] as const)(
  'finds attached trigger authority reachable through %s membership at actual login',
  async (mode) =>
    roles(async (a, _w, m, version) => {
      const runtime = await login(a);
      const middle = `${m}_hop`;
      try {
        await db.$executeRawUnsafe(`CREATE ROLE "${middle}" NOLOGIN NOINHERIT`);
        await db.$executeRawUnsafe(`CREATE SCHEMA "${m}"`);
        await db.$executeRawUnsafe(`CREATE TABLE public."${m}"(value integer)`);
        await db.$executeRawUnsafe(`CREATE TABLE "${m}".owner_only(value integer)`);
        await db.$executeRawUnsafe(
          `CREATE FUNCTION "${m}".effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS 'BEGIN INSERT INTO "${m}".owner_only VALUES(1); RETURN NEW; END'`
        );
        await db.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${m}".effect() FROM PUBLIC`);
        await db.$executeRawUnsafe(
          `CREATE TRIGGER effect AFTER INSERT ON public."${m}" FOR EACH STATEMENT EXECUTE FUNCTION "${m}".effect()`
        );
        await db.$executeRawUnsafe(`GRANT INSERT ON public."${m}" TO "${m}"`);
        if (mode === 'inherit') {
          await db.$executeRawUnsafe(`ALTER ROLE "${a}" INHERIT`);
          await db.$executeRawUnsafe(
            `GRANT "${m}" TO "${a}"${version >= 160000 ? ' WITH INHERIT TRUE, SET FALSE' : ''}`
          );
          await runtime.$executeRawUnsafe(`INSERT INTO public."${m}" VALUES(1)`);
        } else {
          const options = version >= 160000 ? ' WITH INHERIT FALSE, SET TRUE' : '';
          await db.$executeRawUnsafe(`GRANT "${m}" TO "${middle}"${options}`);
          await db.$executeRawUnsafe(`GRANT "${middle}" TO "${a}"${options}`);
          await runtime.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE "${m}"`);
            await tx.$executeRawUnsafe(`INSERT INTO public."${m}" VALUES(1)`);
          });
        }
        expect(await db.$queryRawUnsafe(`SELECT value FROM "${m}".owner_only`)).toEqual([
          { value: 1 },
        ]);
        await expect(verifyNumberRuntimeIdentity(runtime, 'api')).rejects.toMatchObject({
          failures: expect.arrayContaining([expect.stringContaining(`${m}.effect`)]),
        });
      } finally {
        await runtime.$disconnect();
        await db.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${m}" CASCADE`);
        await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${m}" CASCADE`);
        await db.$executeRawUnsafe(`DROP OWNED BY "${middle}"`);
        await db.$executeRawUnsafe(`DROP ROLE "${middle}"`);
      }
    })
);

it('preserves exact audited guards at actual API startup without granting EXECUTE', async () =>
  roles(async (a, _w) => {
    const runtime = await login(a);
    try {
      await db.$executeRawUnsafe(
        `GRANT INSERT ON game_sessions,coin_allocations,coin_provenance TO "${a}"`
      );
      await db.$executeRawUnsafe(
        `GRANT SELECT,UPDATE("currentRulesVersion") ON game_definitions TO "${a}"`
      );
      const [guard] = await runtime.$queryRaw<
        { allowed: boolean }[]
      >`SELECT has_function_privilege(current_user,
        'public.game_definitions_prevent_metadata_drift()','EXECUTE') AS allowed`;
      expect(guard.allowed).toBe(false);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
      await expect(
        runtime.$executeRawUnsafe(`UPDATE game_definitions SET "currentRulesVersion"=2147483647
        WHERE id=(SELECT id FROM game_definitions ORDER BY id LIMIT 1)`)
      ).rejects.toThrow(/points to missing game_rules/);
    } finally {
      await runtime.$disconnect();
    }
  }));

it('refuses a reused audited guard name with an altered privileged body', async () =>
  roles(async (a, _w) => {
    const rollback = new Error('fixture rollback');
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`GRANT INSERT ON game_sessions TO "${a}"`);
        await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION game_sessions_validate_rules_snapshot()
          RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN NEW; END'`);
        await expect(verifyNumberAccessReadOnly(tx, a, 'api')).rejects.toMatchObject({
          failures: expect.arrayContaining([
            expect.stringContaining('game_sessions_insert_validate'),
          ]),
        });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }));

it('independent re-review: partition key UPDATE cannot bypass attached INSERT guard scan', async () =>
  roles(async (a, w, m) => {
    const runtime = await login(a);
    try {
      await db.$executeRawUnsafe(`CREATE SCHEMA "${m}"`);
      await db.$executeRawUnsafe(`CREATE TABLE "${m}".effect_log(value integer)`);
      await db.$executeRawUnsafe(
        `CREATE TABLE public."${m}"(id integer PRIMARY KEY) PARTITION BY RANGE(id)`
      );
      await db.$executeRawUnsafe(
        `CREATE TABLE "${m}".p1 PARTITION OF public."${m}" FOR VALUES FROM (0) TO (100)`
      );
      await db.$executeRawUnsafe(
        `CREATE TABLE "${m}".p2 PARTITION OF public."${m}" FOR VALUES FROM (100) TO (200)`
      );
      await db.$executeRawUnsafe(`INSERT INTO public."${m}" VALUES(1)`);
      await db.$executeRawUnsafe(
        `CREATE FUNCTION "${m}".effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS 'BEGIN INSERT INTO "${m}".effect_log VALUES(1); RETURN NEW; END'`
      );
      await db.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${m}".effect() FROM PUBLIC`);
      await db.$executeRawUnsafe(
        `CREATE TRIGGER effect AFTER INSERT ON "${m}".p2 FOR EACH ROW EXECUTE FUNCTION "${m}".effect()`
      );
      await db.$executeRawUnsafe(`GRANT SELECT, UPDATE(id) ON public."${m}" TO "${a}"`);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).rejects.toThrow(
        'NUMBER_RUNTIME_GRANTS_INVALID'
      );
      await runtime.$executeRawUnsafe(`UPDATE public."${m}" SET id=101 WHERE id=1`);
      expect(await db.$queryRawUnsafe(`SELECT * FROM "${m}".effect_log`)).toEqual([{ value: 1 }]);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).rejects.toThrow(
        'NUMBER_RUNTIME_GRANTS_INVALID'
      );
    } finally {
      await runtime.$disconnect();
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${m}" CASCADE`);
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${m}" CASCADE`);
    }
  }));

it.each(['owner', 'settings', 'attachment', 'body'])(
  'independent re-review: all six audited guards reject changed %s',
  async (mode) =>
    roles(async (a, w, m) => {
      const guards = [
        ['coin_allocations', 'coin_allocations_guard', 'coin_allocations_guard'],
        ['coin_provenance', 'coin_provenance_guard', 'coin_provenance_guard'],
        [
          'game_definitions',
          'game_definitions_prevent_metadata_drift',
          'game_definitions_prevent_metadata_drift',
        ],
        ['game_rules', 'game_rules_immutable', 'game_rules_immutable'],
        ['game_rules', 'game_rules_insert_validate', 'game_rules_validate_parent'],
        ['game_sessions', 'game_sessions_insert_validate', 'game_sessions_validate_rules_snapshot'],
      ];
      for (const [table, trigger, fn] of guards) {
        const rollback = Error('rollback');
        try {
          await db.$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe(`GRANT INSERT,UPDATE,DELETE ON public.${table} TO "${a}"`);
              await verifyNumberAccessReadOnly(tx, a, 'api');
              if (mode === 'owner')
                await tx.$executeRawUnsafe(`ALTER FUNCTION public.${fn}() OWNER TO "${m}"`);
              if (mode === 'settings')
                await tx.$executeRawUnsafe(
                  `ALTER FUNCTION public.${fn}() SET search_path TO public`
                );
              if (mode === 'attachment')
                await tx.$executeRawUnsafe(
                  `ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER ${trigger}`
                );
              if (mode === 'body')
                await tx.$executeRawUnsafe(
                  `CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN NEW; END'`
                );
              await expect(verifyNumberAccessReadOnly(tx, a, 'api')).rejects.toMatchObject({
                failures: expect.arrayContaining([expect.stringContaining(table + '.' + trigger)]),
              });
              throw rollback;
            },
            { timeout: 60000 }
          );
        } catch (e) {
          if (e !== rollback) throw e;
        }
      }
    })
);

async function partitionMovement(
  nested: boolean,
  key: 'id' | 'lane',
  run: (fixture: {
    runtime: PrismaClient;
    api: string;
    worker: string;
    schema: string;
    source: string;
    destination: string;
    move: string;
  }) => Promise<void>
) {
  await roles(async (api, worker, schema) => {
    const runtime = await login(api);
    try {
      await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await db.$executeRawUnsafe(`CREATE TABLE "${schema}".effect_log(operation text)`);
      await db.$executeRawUnsafe(`CREATE TABLE public."${schema}"(id integer,lane integer,value integer)
        PARTITION BY RANGE(id)`);
      for (const [partition, lower, upper] of [
        ['p1', 0, 100],
        ['p2', 100, 200],
      ] as const) {
        await db.$executeRawUnsafe(`CREATE TABLE "${schema}".${partition} PARTITION OF public."${schema}"
          FOR VALUES FROM (${lower}) TO (${upper}) ${nested ? 'PARTITION BY RANGE(lane)' : ''}`);
        if (nested) {
          await db.$executeRawUnsafe(`CREATE TABLE "${schema}".${partition}a PARTITION OF "${schema}".${partition}
            FOR VALUES FROM (0) TO (10)`);
          await db.$executeRawUnsafe(`CREATE TABLE "${schema}".${partition}b PARTITION OF "${schema}".${partition}
            FOR VALUES FROM (10) TO (20)`);
        }
      }
      await db.$executeRawUnsafe(`INSERT INTO public."${schema}" VALUES(1,1,0)`);
      await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".effect() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path=pg_catalog AS $body$
          BEGIN INSERT INTO "${schema}".effect_log VALUES(TG_OP); RETURN NULL; END $body$`);
      await db.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${schema}".effect() FROM PUBLIC`);
      await db.$executeRawUnsafe(`GRANT SELECT,UPDATE(${key}) ON public."${schema}" TO "${api}"`);
      const source = nested ? 'p1a' : 'p1';
      const destination = nested ? (key === 'id' ? 'p2a' : 'p1b') : 'p2';
      const [objects] = await db.$queryRawUnsafe<
        { function: number; source: number; destination: number }[]
      >(
        `SELECT '"${schema}".effect()'::regprocedure::oid::int AS function,
          '"${schema}".${source}'::regclass::oid::int AS source,
          '"${schema}".${destination}'::regclass::oid::int AS destination`
      );
      expect(
        await runtime.$queryRawUnsafe(
          `SELECT
        has_function_privilege(current_user,$1::oid,'EXECUTE') AS execute,
        has_schema_privilege(current_user,$2,'USAGE') AS usage,
        has_table_privilege(current_user,$3::oid,'INSERT,DELETE,UPDATE') AS source,
        has_table_privilege(current_user,$4::oid,'INSERT,DELETE,UPDATE') AS destination,
        has_table_privilege(current_user,$5,'INSERT,DELETE') AS parent`,
          objects.function,
          schema,
          objects.source,
          objects.destination,
          `public."${schema}"`
        )
      ).toEqual([
        { execute: false, usage: false, source: false, destination: false, parent: false },
      ]);
      await run({
        runtime,
        api,
        worker,
        schema,
        source,
        destination,
        move: `UPDATE public."${schema}" SET ${key}=${key === 'id' ? 101 : 11} WHERE id=1`,
      });
    } finally {
      await runtime.$disconnect();
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${schema}" CASCADE`);
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });
}

it.each([
  { event: 'INSERT', nested: false, key: 'id' },
  { event: 'DELETE', nested: false, key: 'id' },
  { event: 'INSERT', nested: true, key: 'id' },
  { event: 'DELETE', nested: true, key: 'id' },
  { event: 'INSERT', nested: true, key: 'lane' },
  { event: 'DELETE', nested: true, key: 'lane' },
] as const)(
  'refuses partition movement $event (nested=$nested, key=$key) at actual login and atomically during setup',
  async ({ event, nested, key }) =>
    partitionMovement(
      nested,
      key,
      async ({ runtime, api, worker, schema, source, destination, move }) => {
        const child = event === 'INSERT' ? destination : source;
        await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER ${event} ON "${schema}".${child}
        FOR EACH ROW EXECUTE FUNCTION "${schema}".effect()`);
        const rejection = {
          failures: expect.arrayContaining([expect.stringContaining(`${schema}.${child}.effect`)]),
        };
        await expect(verifyNumberRuntimeIdentity(runtime, 'api')).rejects.toMatchObject(rejection);
        // Execute as the restricted LOGIN solely to establish the hidden trigger
        // path in this disposable database; application startup has refused it.
        expect(await runtime.$executeRawUnsafe(move)).toBe(1);
        expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual([
          { operation: event },
        ]);
        await db.$executeRawUnsafe(`REVOKE SELECT ON number_practice_rounds FROM "${api}"`);
        const snapshot = () => db.$queryRaw`SELECT c.relname,c.relacl::text AS acl,
        ARRAY(SELECT a.attname||':'||coalesce(a.attacl::text,'') FROM pg_attribute a
          WHERE a.attrelid=c.oid AND a.attnum>0 ORDER BY a.attnum) AS columns
        FROM pg_class c WHERE c.relname IN ('number_practice_rounds','number_timed_rounds','number_timed_entries')
        ORDER BY c.relname`;
        const before = await snapshot();
        await expect(grantNumberRuntimeTables(db, api, worker)).rejects.toMatchObject(rejection);
        expect(await snapshot()).toEqual(before);
      }
    )
);

it.each([false, true])(
  'partition movement (nested=%s) does not fire child statement INSERT/DELETE triggers',
  async (nested) =>
    partitionMovement(nested, 'id', async ({ runtime, schema, source, destination, move }) => {
      for (const [child, event] of [
        [source, 'DELETE'],
        [destination, 'INSERT'],
      ])
        await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER ${event} ON "${schema}".${child}
          FOR EACH STATEMENT EXECUTE FUNCTION "${schema}".effect()`);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
      expect(await runtime.$executeRawUnsafe(move)).toBe(1);
      expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual([]);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
    })
);

it.each([false, true])(
  'non-key UPDATE (nested=%s) does not imply partition movement trigger authority',
  async (nested) =>
    partitionMovement(nested, 'id', async ({ runtime, api, schema, source, destination }) => {
      for (const child of [source, destination])
        await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER INSERT OR DELETE ON "${schema}".${child}
          FOR EACH ROW EXECUTE FUNCTION "${schema}".effect()`);
      await db.$executeRawUnsafe(`REVOKE UPDATE(id) ON public."${schema}" FROM "${api}"`);
      await db.$executeRawUnsafe(`GRANT UPDATE(value) ON public."${schema}" TO "${api}"`);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
      expect(
        await runtime.$executeRawUnsafe(`UPDATE public."${schema}" SET value=1 WHERE id=1`)
      ).toBe(1);
      expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual([]);
    })
);

it('ordinary inheritance UPDATE does not imply child row INSERT/DELETE authority', async () =>
  roles(async (api, _worker, schema) => {
    const runtime = await login(api);
    try {
      await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await db.$executeRawUnsafe(`CREATE TABLE "${schema}".effect_log(operation text)`);
      await db.$executeRawUnsafe(`CREATE TABLE public."${schema}"(id integer)`);
      await db.$executeRawUnsafe(`CREATE TABLE "${schema}".child() INHERITS(public."${schema}")`);
      await db.$executeRawUnsafe(`INSERT INTO "${schema}".child VALUES(1)`);
      await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".effect() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path=pg_catalog AS $body$
          BEGIN INSERT INTO "${schema}".effect_log VALUES(TG_OP); RETURN NULL; END $body$`);
      await db.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${schema}".effect() FROM PUBLIC`);
      await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER INSERT OR DELETE ON "${schema}".child
        FOR EACH ROW EXECUTE FUNCTION "${schema}".effect()`);
      await db.$executeRawUnsafe(`GRANT SELECT,UPDATE(id) ON public."${schema}" TO "${api}"`);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
      expect(
        await runtime.$executeRawUnsafe(`UPDATE public."${schema}" SET id=101 WHERE id=1`)
      ).toBe(1);
      expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual([]);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
    } finally {
      await runtime.$disconnect();
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${schema}" CASCADE`);
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }));

it('partition movement follows the server version’s actual FK actions at restricted login', async () =>
  partitionMovement(true, 'id', async ({ runtime, api, schema, move }) => {
    await db.$executeRawUnsafe(`ALTER TABLE public."${schema}" ADD PRIMARY KEY(id,lane)`);
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}".referencing(id integer,lane integer,
      FOREIGN KEY(id,lane) REFERENCES public."${schema}"(id,lane) ON UPDATE CASCADE ON DELETE CASCADE)`);
    await db.$executeRawUnsafe(`INSERT INTO "${schema}".referencing VALUES(1,1)`);
    await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER DELETE ON "${schema}".referencing
      FOR EACH STATEMENT EXECUTE FUNCTION "${schema}".effect()`);
    const [child] = await db.$queryRawUnsafe<{ oid: number }[]>(
      `SELECT '"${schema}".referencing'::regclass::oid::int AS oid`
    );
    expect(
      await runtime.$queryRawUnsafe(
        `SELECT
      has_table_privilege(current_user,$1::oid,'UPDATE,DELETE') AS direct`,
        child.oid
      )
    ).toEqual([{ direct: false }]);
    const [{ version }] = await runtime.$queryRaw<{ version: number }[]>`
      SELECT pg_catalog.current_setting('server_version_num')::int AS version`;
    const legacyDelete = version < 150000;
    const refusal = {
      failures: expect.arrayContaining([expect.stringContaining(`${schema}.referencing.effect`)]),
    };
    if (legacyDelete)
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).rejects.toMatchObject(refusal);
    else await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
    expect(await runtime.$executeRawUnsafe(move)).toBe(1);
    expect(await db.$queryRawUnsafe(`SELECT id,lane FROM "${schema}".referencing`)).toEqual(
      legacyDelete ? [] : [{ id: 101, lane: 1 }]
    );
    expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual(
      legacyDelete ? [{ operation: 'DELETE' }] : []
    );
    if (legacyDelete)
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).rejects.toMatchObject(refusal);
    else await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
    // Establish the same valid fixture before testing a genuine DELETE on all
    // supported versions. Only the owner repairs the legacy cascade's effect.
    await db.$executeRawUnsafe(`DELETE FROM "${schema}".effect_log`);
    if (legacyDelete)
      await db.$executeRawUnsafe(`INSERT INTO "${schema}".referencing VALUES(101,1)`);
    await db.$executeRawUnsafe(`GRANT DELETE ON public."${schema}" TO "${api}"`);
    await expect(verifyNumberRuntimeIdentity(runtime, 'api')).rejects.toMatchObject({
      failures: expect.arrayContaining([expect.stringContaining(`${schema}.referencing.effect`)]),
    });
    expect(await runtime.$executeRawUnsafe(`DELETE FROM public."${schema}" WHERE id=101`)).toBe(1);
    expect(await db.$queryRawUnsafe(`SELECT id,lane FROM "${schema}".referencing`)).toEqual([]);
    expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual([
      { operation: 'DELETE' },
    ]);
  }));

const mutatorCases = [
  { nested: false, key: 'id', attachment: 'parent' },
  { nested: false, key: 'id', attachment: 'leaf' },
  { nested: true, key: 'id', attachment: 'parent' },
  { nested: true, key: 'id', attachment: 'middle' },
  { nested: true, key: 'id', attachment: 'leaf' },
  { nested: true, key: 'lane', attachment: 'parent' },
  { nested: true, key: 'lane', attachment: 'middle' },
  { nested: true, key: 'lane', attachment: 'leaf' },
] as const;

it.each(
  mutatorCases.flatMap((fixture) => ['DELETE', 'INSERT'].map((event) => ({ ...fixture, event })))
)(
  'refuses invoker key rewrite to $event (nested=$nested, key=$key, attachment=$attachment) with atomic table/column ACL rollback',
  async ({ nested, key, attachment, event }) =>
    partitionMovement(
      nested,
      key,
      async ({ runtime, api, worker, schema, source, destination }) => {
        // The original SET column is deliberately outside every routing key.
        // PostgreSQL permits an attached invoker trigger to rewrite NEW anyway.
        await db.$executeRawUnsafe(`REVOKE UPDATE(${key}) ON public."${schema}" FROM "${api}"`);
        await db.$executeRawUnsafe(`GRANT UPDATE(value) ON public."${schema}" TO "${api}"`);
        await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".move_key() RETURNS trigger LANGUAGE plpgsql
        SECURITY INVOKER SET search_path=pg_catalog AS $body$
          BEGIN NEW.${key}:=${key === 'id' ? 101 : 11}; RETURN NEW; END $body$`);
        await db.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${schema}".move_key() FROM PUBLIC`);
        const attachedTo =
          attachment === 'parent'
            ? `public."${schema}"`
            : `"${schema}".${attachment === 'middle' ? 'p1' : source}`;
        await db.$executeRawUnsafe(`CREATE TRIGGER move_key BEFORE UPDATE OF value ON ${attachedTo}
        FOR EACH ROW EXECUTE FUNCTION "${schema}".move_key()`);
        const effectChild = event === 'DELETE' ? source : destination;
        await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER ${event} ON "${schema}".${effectChild}
        FOR EACH ROW EXECUTE FUNCTION "${schema}".effect()`);
        const [functionRow] = await db.$queryRawUnsafe<{ oid: number }[]>(
          `SELECT '"${schema}".move_key()'::regprocedure::oid::int AS oid`
        );
        expect(
          await runtime.$queryRawUnsafe(
            `SELECT
        has_function_privilege(current_user,$1::oid,'EXECUTE') AS execute,
        has_schema_privilege(current_user,$2,'USAGE') AS usage,
        has_column_privilege(current_user,$3,'id','UPDATE') AS outer_key,
        has_column_privilege(current_user,$3,'lane','UPDATE') AS inner_key,
        has_column_privilege(current_user,$3,'value','UPDATE') AS value`,
            functionRow.oid,
            schema,
            `public."${schema}"`
          )
        ).toEqual([
          { execute: false, usage: false, outer_key: false, inner_key: false, value: true },
        ]);
        const rejection = {
          message: 'NUMBER_RUNTIME_GRANTS_INVALID',
          failures: expect.arrayContaining([expect.stringContaining('move_key')]),
        };
        await expect(verifyNumberRuntimeIdentity(runtime, 'api')).rejects.toMatchObject(rejection);
        // Establish the hidden path as an actual LOGIN only in the throwaway fixture.
        expect(
          await runtime.$executeRawUnsafe(`UPDATE public."${schema}" SET value=1 WHERE id=1`)
        ).toBe(1);
        expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual([
          { operation: event },
        ]);
        expect(
          await runtime.$queryRawUnsafe(`SELECT id,lane,value FROM public."${schema}"`)
        ).toEqual([{ id: key === 'id' ? 101 : 1, lane: key === 'lane' ? 11 : 1, value: 1 }]);
        // Setup will try to restore both a table ACL and a column ACL. Refusal
        // must roll back both attempts, including the intentionally absent grants.
        await db.$executeRawUnsafe(`REVOKE SELECT ON number_practice_rounds FROM "${api}"`);
        await db.$executeRawUnsafe(`REVOKE UPDATE(target) ON number_timed_rounds FROM "${worker}"`);
        const missing = () =>
          db.$queryRawUnsafe(
            `SELECT
        has_table_privilege($1,'number_practice_rounds','SELECT') AS table_grant,
        has_column_privilege($2,'number_timed_rounds','target','UPDATE') AS column_grant`,
            api,
            worker
          );
        expect(await missing()).toEqual([{ table_grant: false, column_grant: false }]);
        const snapshot = () => db.$queryRaw`SELECT c.relname,c.relacl::text AS acl,
        ARRAY(SELECT a.attname||':'||coalesce(a.attacl::text,'') FROM pg_attribute a
          WHERE a.attrelid=c.oid AND a.attnum>0 ORDER BY a.attnum) AS columns
        FROM pg_class c WHERE c.relname IN ('number_practice_rounds','number_timed_rounds','number_timed_entries')
        ORDER BY c.relname`;
        const before = await snapshot();
        await expect(grantNumberRuntimeTables(db, api, worker)).rejects.toMatchObject(rejection);
        expect(await snapshot()).toEqual(before);
        expect(await missing()).toEqual([{ table_grant: false, column_grant: false }]);
      }
    )
);

it.each(['disjoint-column', 'before-statement'] as const)(
  'preserves partition non-key UPDATE with a %s invoker trigger',
  async (mode) =>
    partitionMovement(true, 'id', async ({ runtime, api, schema, source, destination }) => {
      await db.$executeRawUnsafe(`REVOKE UPDATE(id) ON public."${schema}" FROM "${api}"`);
      await db.$executeRawUnsafe(`GRANT UPDATE(value) ON public."${schema}" TO "${api}"`);
      await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".move_key() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog AS $body$
        BEGIN ${mode === 'disjoint-column' ? 'NEW.id:=101; RETURN NEW;' : 'RETURN NULL;'} END $body$`);
      await db.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${schema}".move_key() FROM PUBLIC`);
      await db.$executeRawUnsafe(`CREATE TRIGGER move_key BEFORE UPDATE OF ${mode === 'disjoint-column' ? 'id' : 'value'}
      ON public."${schema}" FOR EACH ${mode === 'disjoint-column' ? 'ROW' : 'STATEMENT'}
      EXECUTE FUNCTION "${schema}".move_key()`);
      for (const child of [source, destination])
        await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER INSERT OR DELETE ON "${schema}".${child}
        FOR EACH ROW EXECUTE FUNCTION "${schema}".effect()`);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
      expect(
        await runtime.$executeRawUnsafe(`UPDATE public."${schema}" SET value=1 WHERE id=1`)
      ).toBe(1);
      expect(await runtime.$queryRawUnsafe(`SELECT id,lane,value FROM public."${schema}"`)).toEqual(
        [{ id: 1, lane: 1, value: 1 }]
      );
      expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual([]);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
    })
);

it('ordinary inheritance invoker key rewrite remains UPDATE without row movement', async () =>
  roles(async (api, _worker, schema) => {
    const runtime = await login(api);
    try {
      await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await db.$executeRawUnsafe(`CREATE TABLE "${schema}".effect_log(operation text)`);
      await db.$executeRawUnsafe(`CREATE TABLE public."${schema}"(id integer,value integer)`);
      await db.$executeRawUnsafe(`CREATE TABLE "${schema}".child() INHERITS(public."${schema}")`);
      await db.$executeRawUnsafe(`INSERT INTO "${schema}".child VALUES(1,0)`);
      await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".move_key() RETURNS trigger LANGUAGE plpgsql
        SECURITY INVOKER SET search_path=pg_catalog AS 'BEGIN NEW.id:=101; RETURN NEW; END'`);
      await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".effect() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path=pg_catalog AS $body$
          BEGIN INSERT INTO "${schema}".effect_log VALUES(TG_OP); RETURN NULL; END $body$`);
      for (const fn of ['move_key', 'effect'])
        await db.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${schema}".${fn}() FROM PUBLIC`);
      await db.$executeRawUnsafe(`CREATE TRIGGER move_key BEFORE UPDATE OF value ON "${schema}".child
        FOR EACH ROW EXECUTE FUNCTION "${schema}".move_key()`);
      await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER INSERT OR DELETE ON "${schema}".child
        FOR EACH ROW EXECUTE FUNCTION "${schema}".effect()`);
      await db.$executeRawUnsafe(`GRANT SELECT,UPDATE(value) ON public."${schema}" TO "${api}"`);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
      expect(
        await runtime.$executeRawUnsafe(`UPDATE public."${schema}" SET value=1 WHERE id=1`)
      ).toBe(1);
      expect(await runtime.$queryRawUnsafe(`SELECT id,value FROM public."${schema}"`)).toEqual([
        { id: 101, value: 1 },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual([]);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
    } finally {
      await runtime.$disconnect();
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${schema}" CASCADE`);
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }));

type OrdinaryFkFixture = {
  runtime: PrismaClient;
  api: string;
  worker: string;
  schema: string;
  authorityRole: string;
  update: () => Promise<number>;
};

async function ordinaryFkMutation(
  action: 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION' | 'RESTRICT',
  kind: 'api' | 'worker',
  indirect: boolean,
  run: (fixture: OrdinaryFkFixture) => Promise<void>
) {
  await roles(async (api, worker, schema, version) => {
    const runtime = await login(kind === 'api' ? api : worker);
    const hop = `${schema}_hop`;
    const authorityRole = indirect ? schema : kind === 'api' ? api : worker;
    try {
      if (indirect) {
        await db.$executeRawUnsafe(`CREATE ROLE "${hop}" NOLOGIN NOINHERIT`);
        const options = version >= 160000 ? ' WITH INHERIT FALSE, SET TRUE' : '';
        await db.$executeRawUnsafe(`GRANT "${schema}" TO "${hop}"${options}`);
        await db.$executeRawUnsafe(
          `GRANT "${hop}" TO "${kind === 'api' ? api : worker}"${options}`
        );
      }
      await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await db.$executeRawUnsafe(`CREATE TABLE "${schema}".effect_log(operation text)`);
      await db.$executeRawUnsafe(
        `CREATE TABLE public."${schema}"(id integer PRIMARY KEY,value integer)`
      );
      await db.$executeRawUnsafe(`CREATE TABLE "${schema}".child(id integer DEFAULT 0
        REFERENCES public."${schema}"(id) ON UPDATE ${action})`);
      // SET DEFAULT has a valid default parent; all effects therefore complete
      // rather than being hidden behind an expected constraint violation.
      await db.$executeRawUnsafe(`INSERT INTO public."${schema}" VALUES(0,0),(1,0)`);
      await db.$executeRawUnsafe(`INSERT INTO "${schema}".child VALUES(1)`);
      await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".move_key() RETURNS trigger LANGUAGE plpgsql
        SECURITY INVOKER SET search_path=pg_catalog AS 'BEGIN NEW.id:=101; RETURN NEW; END'`);
      await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".effect() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path=pg_catalog AS $body$
          BEGIN INSERT INTO "${schema}".effect_log VALUES(TG_OP); RETURN NULL; END $body$`);
      for (const fn of ['move_key', 'effect'])
        await db.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${schema}".${fn}() FROM PUBLIC`);
      await db.$executeRawUnsafe(
        `GRANT SELECT,UPDATE(value) ON public."${schema}" TO "${authorityRole}"`
      );
      const [{ mutator, effect, child }] = await db.$queryRawUnsafe<
        { mutator: number; effect: number; child: number }[]
      >(`SELECT '"${schema}".move_key()'::regprocedure::oid::int AS mutator,
        '"${schema}".effect()'::regprocedure::oid::int AS effect,
        '"${schema}".child'::regclass::oid::int AS child`);
      // Check the reachable role separately from the LOGIN. SET-only authority
      // must not be mistaken for directly inherited table or column authority.
      const privilegeSql = `SELECT
        has_function_privilege(current_user,$1::oid,'EXECUTE') AS mutator,
        has_function_privilege(current_user,$2::oid,'EXECUTE') AS effect,
        has_schema_privilege(current_user,$3,'USAGE') AS usage,
        has_column_privilege(current_user,$4,'id','UPDATE') AS key,
        has_column_privilege(current_user,$4,'value','UPDATE') AS value,
        has_table_privilege(current_user,$5::oid,'UPDATE') AS child`;
      const privilegeArgs = [mutator, effect, schema, `public."${schema}"`, child];
      expect(await runtime.$queryRawUnsafe(privilegeSql, ...privilegeArgs)).toEqual([
        { mutator: false, effect: false, usage: false, key: false, value: !indirect, child: false },
      ]);
      if (indirect)
        await runtime.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE "${authorityRole}"`);
          expect(await tx.$queryRawUnsafe(privilegeSql, ...privilegeArgs)).toEqual([
            { mutator: false, effect: false, usage: false, key: false, value: true, child: false },
          ]);
        });
      const update = () =>
        indirect
          ? runtime.$transaction(async (tx) => {
              await tx.$executeRawUnsafe(`SET LOCAL ROLE "${authorityRole}"`);
              return tx.$executeRawUnsafe(`UPDATE public."${schema}" SET value=1 WHERE id=1`);
            })
          : runtime.$executeRawUnsafe(`UPDATE public."${schema}" SET value=1 WHERE id=1`);
      await run({ runtime, api, worker, schema, authorityRole, update });
    } finally {
      await runtime.$disconnect();
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${schema}" CASCADE`);
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      if (indirect) {
        await db.$executeRawUnsafe(`DROP OWNED BY "${hop}"`);
        await db.$executeRawUnsafe(`DROP ROLE "${hop}"`);
      }
    }
  });
}

const ordinaryFkRefusals = [
  ...(['CASCADE', 'SET NULL', 'SET DEFAULT'] as const).flatMap((action) =>
    [false, true].map((indirect) => ({ action, indirect, kind: 'api' as const }))
  ),
] as const;

it.each(ordinaryFkRefusals)(
  'refuses ordinary invoker key rewrite through $action ($kind, indirect=$indirect) and atomically rolls back table/column grants',
  async ({ action, kind, indirect }) =>
    ordinaryFkMutation(action, kind, indirect, async ({ runtime, api, worker, schema, update }) => {
      await db.$executeRawUnsafe(`CREATE TRIGGER move_key BEFORE UPDATE OF value ON public."${schema}"
        FOR EACH ROW EXECUTE FUNCTION "${schema}".move_key()`);
      await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER UPDATE ON "${schema}".child
        FOR EACH ROW EXECUTE FUNCTION "${schema}".effect()`);
      // Establish the supplied exploit using the real restricted LOGIN. Trigger
      // execution and FK owner rights do not require direct EXECUTE or child ACLs.
      expect(await update()).toBe(1);
      expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual([
        { operation: 'UPDATE' },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT id FROM "${schema}".child`)).toEqual([
        { id: action === 'CASCADE' ? 101 : action === 'SET DEFAULT' ? 0 : null },
      ]);
      const rejection = {
        message: 'NUMBER_RUNTIME_GRANTS_INVALID',
        failures: expect.arrayContaining([expect.stringContaining(`${schema}.child.effect`)]),
      };
      await expect(verifyNumberRuntimeIdentity(runtime, kind)).rejects.toMatchObject(rejection);
      await db.$executeRawUnsafe(`REVOKE SELECT ON number_practice_rounds FROM "${api}"`);
      await db.$executeRawUnsafe(`REVOKE UPDATE(target) ON number_timed_rounds FROM "${worker}"`);
      const missing = () =>
        db.$queryRawUnsafe(
          `SELECT
        has_table_privilege($1,'number_practice_rounds','SELECT') AS table_grant,
        has_column_privilege($2,'number_timed_rounds','target','UPDATE') AS column_grant`,
          api,
          worker
        );
      expect(await missing()).toEqual([{ table_grant: false, column_grant: false }]);
      const snapshot = () => db.$queryRaw`SELECT c.relname,c.relacl::text AS acl,
        ARRAY(SELECT a.attname||':'||coalesce(a.attacl::text,'') FROM pg_attribute a
          WHERE a.attrelid=c.oid AND a.attnum>0 ORDER BY a.attnum) AS columns
        FROM pg_class c WHERE c.relname IN ('number_practice_rounds','number_timed_rounds','number_timed_entries')
        ORDER BY c.relname`;
      const before = await snapshot();
      await expect(grantNumberRuntimeTables(db, api, worker)).rejects.toMatchObject(rejection);
      expect(await snapshot()).toEqual(before);
      expect(await missing()).toEqual([{ table_grant: false, column_grant: false }]);
    })
);

it.each([
  'no-mutator',
  'disjoint-column',
  'disabled',
  'after-row',
  'before-statement',
  'harmless-cascade',
  'parent-key-event',
] as const)('preserves ordinary FK UPDATE with %s control', async (mode) =>
  ordinaryFkMutation('CASCADE', 'api', false, async ({ runtime, api, worker, schema, update }) => {
    if (mode !== 'no-mutator') {
      if (mode === 'before-statement')
        await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "${schema}".move_key() RETURNS trigger
            LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS 'BEGIN RETURN NULL; END'`);
      await db.$executeRawUnsafe(`CREATE TRIGGER move_key ${mode === 'after-row' ? 'AFTER' : 'BEFORE'}
          UPDATE OF ${mode === 'disjoint-column' ? 'id' : 'value'} ON public."${schema}"
          FOR EACH ${mode === 'before-statement' ? 'STATEMENT' : 'ROW'} EXECUTE FUNCTION "${schema}".move_key()`);
      if (mode === 'disabled')
        await db.$executeRawUnsafe(`ALTER TABLE public."${schema}" DISABLE TRIGGER move_key`);
    }
    if (mode === 'harmless-cascade' || mode === 'parent-key-event') {
      await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".harmless() RETURNS trigger LANGUAGE plpgsql
          SECURITY INVOKER SET search_path=pg_catalog AS 'BEGIN RETURN NEW; END'`);
      await db.$executeRawUnsafe(`REVOKE ALL ON FUNCTION "${schema}".harmless() FROM PUBLIC`);
      await db.$executeRawUnsafe(`CREATE TRIGGER harmless AFTER UPDATE ON "${schema}".child
          FOR EACH ROW EXECUTE FUNCTION "${schema}".harmless()`);
      if (mode === 'parent-key-event')
        // A NEW.id rewrite is not an original SET(id) event: the parent's
        // column-specific privileged trigger must remain unreachable.
        await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER UPDATE OF id ON public."${schema}"
            FOR EACH ROW EXECUTE FUNCTION "${schema}".effect()`);
    } else
      await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER UPDATE ON "${schema}".child
          FOR EACH ROW EXECUTE FUNCTION "${schema}".effect()`);
    await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
    expect(await update()).toBe(1);
    const moved = mode === 'harmless-cascade' || mode === 'parent-key-event';
    expect(await db.$queryRawUnsafe(`SELECT id FROM "${schema}".child`)).toEqual([
      { id: moved ? 101 : 1 },
    ]);
    expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual([]);
    await expect(grantNumberRuntimeTables(db, api, worker)).resolves.toBeUndefined();
    await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
  })
);

it.each(['NO ACTION', 'RESTRICT'] as const)(
  'ordinary invoker key rewrite with FK %s does not expose child UPDATE triggers',
  async (action) =>
    ordinaryFkMutation(action, 'api', false, async ({ runtime, api, worker, schema, update }) => {
      await db.$executeRawUnsafe(`CREATE TRIGGER move_key BEFORE UPDATE OF value ON public."${schema}"
        FOR EACH ROW EXECUTE FUNCTION "${schema}".move_key()`);
      await db.$executeRawUnsafe(`CREATE TRIGGER effect AFTER UPDATE ON "${schema}".child
        FOR EACH ROW EXECUTE FUNCTION "${schema}".effect()`);
      await expect(verifyNumberRuntimeIdentity(runtime, 'api')).resolves.toBeUndefined();
      await expect(update()).rejects.toThrow(/foreign key constraint/);
      expect(await db.$queryRawUnsafe(`SELECT id FROM "${schema}".child`)).toEqual([{ id: 1 }]);
      expect(await db.$queryRawUnsafe(`SELECT operation FROM "${schema}".effect_log`)).toEqual([]);
      await expect(grantNumberRuntimeTables(db, api, worker)).resolves.toBeUndefined();
    })
);
