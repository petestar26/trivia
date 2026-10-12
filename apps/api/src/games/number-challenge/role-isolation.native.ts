import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { grantNumberRuntimeTables } from '../../scripts/number-runtime-grants.js';
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

it.each(['api', 'worker'] as const)('refuses %s authority through a temporary-table trigger', async (kind) =>
  roles(async (a, w, m) => {
    const { verifyNumberAccessReadOnly } = await import('../../scripts/number-runtime-grants.js');
    const runtime = kind === 'api' ? a : w;
    const rollback = new Error('fixture rollback');
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${m}"`);
        await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${m}" TO PUBLIC`);
        await tx.$executeRawUnsafe(`CREATE TABLE "${m}".owner_only(value integer)`);
        await tx.$executeRawUnsafe(`CREATE FUNCTION "${m}".escalate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN INSERT INTO "${m}".owner_only VALUES(1); RETURN NEW; END'`);
        const [direct] = await tx.$queryRawUnsafe<{ allowed: boolean }[]>(`SELECT has_table_privilege($1,$2,'INSERT') AS allowed`, runtime, `${m}.owner_only`);
        expect(direct.allowed).toBe(false);
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${runtime}"`);
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE "${m}"(value integer) ON COMMIT DROP`);
        await tx.$executeRawUnsafe(`CREATE TRIGGER escalate BEFORE INSERT ON "${m}" FOR EACH ROW EXECUTE FUNCTION "${m}".escalate()`);
        await tx.$executeRawUnsafe(`INSERT INTO "${m}" VALUES(1)`);
        await tx.$executeRawUnsafe('RESET ROLE');
        const [effect] = await tx.$queryRawUnsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM "${m}".owner_only`);
        expect(effect.count).toBe(1); // Proves indirect owner authority, without touching financial rows.
        await expect(verifyNumberAccessReadOnly(tx, runtime, kind)).rejects.toThrow('NUMBER_RUNTIME_GRANTS_INVALID');
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }));

const privilegedGuards = [
  'game_rules_validate_parent', 'game_rules_immutable', 'game_sessions_validate_rules_snapshot',
  'game_definitions_prevent_metadata_drift', 'coin_allocations_guard', 'coin_provenance_guard',
];
it.each(privilegedGuards)('does not let a draw worker attach privileged guard %s to its own table', async (guard) =>
  roles(async (_a, w, m) => {
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${w}"`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "${m}"(id text) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TRIGGER leak BEFORE INSERT ON "${m}" FOR EACH ROW EXECUTE FUNCTION public.${guard}()`);
    })).rejects.toThrow(/permission denied for function/);
  }));
it.each(['coin_allocations_guard', 'coin_provenance_guard'])('refuses restored worker EXECUTE on financial guard %s', async (guard) =>
  roles(async (a, w) => {
    await db.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION public.${guard}() TO "${w}"`);
    await expect(grantNumberRuntimeTables(db, a, w, false)).rejects.toThrow('NUMBER_RUNTIME_GRANTS_INVALID');
  }));
