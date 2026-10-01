import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { verifyLedgerRuntimeIdentity } from './ledger-runtime-identity-check.js';

const restricted = {
  role: 'playqube_app', session_role: 'playqube_app', rolsuper: false, rolbypassrls: false,
  key_read: false, migration_insert: false, migration_update: false,
  migration_delete: false,
};

function reader(rows: unknown[]) {
  return { $queryRawUnsafe: async <T>() => rows as T } as unknown as Prisma.TransactionClient;
}

describe('predeploy runtime identity', () => {
  it('accepts only the named role without owner or migration rights', async () => {
    await expect(verifyLedgerRuntimeIdentity(reader([restricted]), 'playqube_app', async () => []))
      .resolves.toBeUndefined();
    for (const change of [
      { role: 'postgres' }, { session_role: 'postgres' }, { rolsuper: true },
      { rolbypassrls: true }, { key_read: true },
      { migration_insert: true }, { migration_update: true }, { migration_delete: true },
      { key_read: null }, { migration_insert: null },
    ]) {
      await expect(verifyLedgerRuntimeIdentity(reader([{ ...restricted, ...change }]), 'playqube_app', async () => []))
        .rejects.toThrow('runtime identity verification failed');
    }
    await expect(verifyLedgerRuntimeIdentity(reader([restricted]), 'playqube_app', async () => ['unsafe role']))
      .rejects.toThrow('runtime identity verification failed');
  });

  it('rejects missing, ambiguous or unsafe expected roles', async () => {
    for (const rows of [[], [restricted, restricted]]) {
      await expect(verifyLedgerRuntimeIdentity(reader(rows), 'playqube_app', async () => []))
        .rejects.toThrow('runtime identity verification failed');
    }
    await expect(verifyLedgerRuntimeIdentity(reader([restricted]), 'playqube_app;DROP ROLE', async () => []))
      .rejects.toThrow('runtime identity verification failed');
  });

  it.skipIf(!process.env.DATABASE_URL)('rejects post-setup grants, role drift and owner sessions in PostgreSQL', async () => {
    const suffix = randomBytes(5).toString('hex');
    const role = `playqube_predeploy_${suffix}`;
    const holder = `playqube_holder_${suffix}`;
    const marker = `predeploy_marker_${suffix}`;
    const password = randomBytes(20).toString('hex');
    const owner = new PrismaClient({ log: [] });
    let runtime: PrismaClient | undefined;
    let roleCreated = false;
    let holderCreated = false;
    let markerCreated = false;
    try {
      const url = new URL(process.env.DATABASE_URL!);
      const database = decodeURIComponent(url.pathname.slice(1)).replaceAll('"', '""');
      await owner.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      roleCreated = true;
      await owner.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
      await owner.$executeRawUnsafe(`SELECT public.ledger_apply_runtime_grants($1)`, role);
      url.username = role;
      url.password = password;
      runtime = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).resolves.toBeUndefined();

      // Table-level checks alone miss SELECT(secret) and UPDATE(finished_at).
      await owner.$executeRawUnsafe(`GRANT SELECT ("secret") ON public.ledger_approval_keys TO "${role}"`);
      const [columnRead] = await runtime.$queryRawUnsafe<{ whole: boolean; any: boolean }[]>(`
        SELECT has_table_privilege(current_user,'public.ledger_approval_keys','SELECT') AS whole,
               has_any_column_privilege(current_user,'public.ledger_approval_keys','SELECT') AS any`);
      expect(columnRead).toEqual({ whole: false, any: true });
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');
      await owner.$executeRawUnsafe(`REVOKE SELECT ("secret") ON public.ledger_approval_keys FROM "${role}"`);
      await owner.$executeRawUnsafe(`GRANT UPDATE ("finished_at") ON public._prisma_migrations TO "${role}"`);
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');
      await owner.$executeRawUnsafe(`REVOKE UPDATE ("finished_at") ON public._prisma_migrations FROM "${role}"`);

      await owner.$executeRawUnsafe(`CREATE ROLE "${holder}" NOLOGIN`);
      holderCreated = true;
      await owner.$executeRawUnsafe(`GRANT SELECT ("secret") ON public.ledger_approval_keys TO "${holder}"`);
      const [{ version }] = await owner.$queryRawUnsafe<{ version: number }[]>(
        `SELECT current_setting('server_version_num')::int AS version`);
      if (version >= 160000) {
        await owner.$executeRawUnsafe(`GRANT "${holder}" TO "${role}" WITH INHERIT FALSE, SET TRUE`);
      } else {
        await owner.$executeRawUnsafe(`ALTER ROLE "${role}" NOINHERIT`);
        await owner.$executeRawUnsafe(`GRANT "${holder}" TO "${role}"`);
      }
      const [inherited] = await runtime.$queryRawUnsafe<{ keyRead: boolean }[]>(`
        SELECT has_any_column_privilege(current_user, 'public.ledger_approval_keys', 'SELECT') AS "keyRead"`);
      expect(inherited.keyRead).toBe(false);
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');

      // A post-setup owner membership on an otherwise unrelated relation is
      // equally unsafe: after SET ROLE it could replace that relation's guards.
      await owner.$executeRawUnsafe(`CREATE TABLE public."${marker}" (id int)`);
      markerCreated = true;
      await owner.$executeRawUnsafe(`ALTER TABLE public."${marker}" OWNER TO "${holder}"`);
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');
      await owner.$executeRawUnsafe(`REVOKE SELECT ("secret") ON public.ledger_approval_keys FROM "${holder}"`);
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');

      // The connection logged in as the owner can SET ROLE to the restricted
      // user. Both identities must match before API predeploy is accepted.
      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
        const [who] = await tx.$queryRawUnsafe<{ current: string; session: string }[]>(
          'SELECT current_user AS current, session_user AS session');
        expect(who).toEqual({ current: role, session: new URL(process.env.DATABASE_URL!).username });
        await expect(verifyLedgerRuntimeIdentity(tx, role)).rejects.toThrow('runtime identity verification failed');
      });
    } finally {
      await runtime?.$disconnect();
      if (markerCreated) await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${marker}"`);
      if (holderCreated) {
        await owner.$executeRawUnsafe(`REVOKE "${holder}" FROM "${role}"`);
        await owner.$executeRawUnsafe(`DROP OWNED BY "${holder}"`);
        await owner.$executeRawUnsafe(`DROP ROLE "${holder}"`);
      }
      if (roleCreated) {
        await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
        await owner.$executeRawUnsafe(`DROP ROLE "${role}"`);
      }
      await owner.$disconnect();
    }
  }, 120_000);
});
