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
        await db.$executeRawUnsafe(`ALTER ROLE "${name}" LOGIN`);
        const target = new URL(url);
        target.username = name;
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
