import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { applyRuntimeAccess, verifyRuntimeAccessReadOnly } from './ledger-runtime-access.js';
import { prismaRoundDatabase } from '../games/scheduled/prisma-round-store.js';
import { PRACTICE_STREAM, practiceSnapshot } from '../games/scheduled/practice-service.js';
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
    let originalPracticeEnabled: boolean | undefined;
    let cryptoSchema: string | undefined;
    const extensionSchema = `predeploy_crypto_${suffix}`;
    let extensionSchemaCreated = false;
    let publicCatalogGrant = false;
    try {
      const url = new URL(process.env.DATABASE_URL!);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.pathname !== '/playqube_scheduled_throwaway'
        || process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway') {
        throw new Error('Runtime privilege regressions require the acknowledged loopback throwaway database');
      }
      const database = decodeURIComponent(url.pathname.slice(1)).replaceAll('"', '""');
      await owner.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      roleCreated = true;
      await owner.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
      // Use the actual owner setup after migrations, without hand-granting reads.
      expect(await applyRuntimeAccess(owner, role, process.env.LEDGER_APPROVAL_KEY_ID ?? 'primary',
        process.env.LEDGER_APPROVAL_SIGNING_KEY!)).toEqual([]);
      url.username = role;
      url.password = password;
      runtime = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).resolves.toBeUndefined();

      const [practice] = await owner.$queryRawUnsafe<{ enabled: boolean }[]>(
        'SELECT enabled FROM public.scheduled_game_streams WHERE id=$1', PRACTICE_STREAM);
      originalPracticeEnabled = practice.enabled;
      await owner.$executeRawUnsafe('UPDATE public.scheduled_game_streams SET enabled=false WHERE id=$1', PRACTICE_STREAM);
      const user = await owner.user.create({ data: { username: `predeploy-${suffix}` } });
      const counts = () => owner.$queryRawUnsafe(`SELECT
        (SELECT count(*) FROM public.scheduled_game_rounds)::text AS rounds,
        (SELECT count(*) FROM public.scheduled_practice_tickets)::text AS tickets,
        (SELECT count(*) FROM public.economic_operations)::text AS operations`);
      const before = await counts();
      await expect(practiceSnapshot(prismaRoundDatabase(runtime), user.id))
        .resolves.toMatchObject({ mode: 'PRACTICE', enabled: false, coinsAccepted: false, nextOpensAt: null });
      expect(await counts()).toEqual(before);
      for (const table of ['scheduled_game_streams', 'scheduled_game_rounds', 'scheduled_practice_tickets', 'users']) {
        await owner.$executeRawUnsafe(`REVOKE SELECT ON public."${table}" FROM "${role}"`);
        await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');
        await expect(practiceSnapshot(prismaRoundDatabase(runtime), user.id)).rejects.toThrow('permission denied');
        await owner.$transaction(async (tx) => {
          await tx.$queryRawUnsafe("SELECT set_config('playqube.repair_role', $1, true)", role);
          await tx.$executeRawUnsafe(readFileSync(new URL('../../../../docs/deployment/repair-practice-runtime-reads.sql', import.meta.url), 'utf8'));
          expect(await verifyRuntimeAccessReadOnly(tx, role)).toEqual([]);
        });
        await expect(verifyLedgerRuntimeIdentity(runtime, role)).resolves.toBeUndefined();
      }
      // Positive readiness also preserves the existing owner's write contract.
      await owner.$executeRawUnsafe(`REVOKE INSERT ON public.economic_operations FROM "${role}"`);
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');
      await owner.$executeRawUnsafe(`GRANT INSERT ON public.economic_operations TO "${role}"`);

      // The owner resolves names in pg_catalog as well as public.
      await owner.$executeRawUnsafe(`GRANT CREATE ON SCHEMA pg_catalog TO "${role}"`);
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');
      await owner.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA pg_catalog FROM "${role}"`);
      await owner.$executeRawUnsafe('GRANT CREATE ON SCHEMA pg_catalog TO PUBLIC');
      publicCatalogGrant = true;
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');
      await owner.$executeRawUnsafe('REVOKE CREATE ON SCHEMA pg_catalog FROM PUBLIC');
      publicCatalogGrant = false;

      // A relocated pgcrypto schema must be checked too, including ownership
      // of an object retained after the CREATE grant was removed.
      const [extension] = await owner.$queryRawUnsafe<{ schema: string }[]>(`
        SELECT n.nspname::text AS schema FROM pg_extension e
        JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'`);
      cryptoSchema = extension.schema;
      await owner.$executeRawUnsafe(`CREATE SCHEMA "${extensionSchema}"`);
      extensionSchemaCreated = true;
      await owner.$executeRawUnsafe(`ALTER EXTENSION pgcrypto SET SCHEMA "${extensionSchema}"`);
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).resolves.toBeUndefined();
      await owner.$executeRawUnsafe(`GRANT CREATE ON SCHEMA "${extensionSchema}" TO "${role}"`);
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');
      await owner.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA "${extensionSchema}" FROM "${role}"`);
      await owner.$executeRawUnsafe(`CREATE FUNCTION "${extensionSchema}".runtime_marker() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
      await owner.$executeRawUnsafe(`ALTER FUNCTION "${extensionSchema}".runtime_marker() OWNER TO "${role}"`);
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');
      await owner.$executeRawUnsafe(`DROP FUNCTION "${extensionSchema}".runtime_marker()`);
      await owner.$executeRawUnsafe(`ALTER EXTENSION pgcrypto SET SCHEMA "${cryptoSchema.replaceAll('"', '""')}"`);
      await owner.$executeRawUnsafe(`DROP SCHEMA "${extensionSchema}"`);
      extensionSchemaCreated = false;
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

      await owner.$executeRawUnsafe(`REVOKE SELECT ("secret") ON public.ledger_approval_keys FROM "${holder}"`);
      await owner.$executeRawUnsafe(`GRANT CREATE ON SCHEMA pg_catalog TO "${holder}"`);
      const [directCreate] = await runtime.$queryRawUnsafe<{ granted: boolean }[]>(
        `SELECT has_schema_privilege(current_user, 'pg_catalog', 'CREATE') AS granted`);
      expect(directCreate.granted).toBe(false);
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).rejects.toThrow('runtime identity verification failed');
      await owner.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA pg_catalog FROM "${holder}"`);
      await expect(verifyLedgerRuntimeIdentity(runtime, role)).resolves.toBeUndefined();

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
      if (publicCatalogGrant) await owner.$executeRawUnsafe('REVOKE CREATE ON SCHEMA pg_catalog FROM PUBLIC');
      if (extensionSchemaCreated) {
        await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${extensionSchema}".runtime_marker()`);
        await owner.$executeRawUnsafe(`ALTER EXTENSION pgcrypto SET SCHEMA "${cryptoSchema!.replaceAll('"', '""')}"`);
        await owner.$executeRawUnsafe(`DROP SCHEMA "${extensionSchema}"`);
      }
      if (originalPracticeEnabled !== undefined) {
        await owner.$executeRawUnsafe('UPDATE public.scheduled_game_streams SET enabled=$1 WHERE id=$2', originalPracticeEnabled, PRACTICE_STREAM);
      }
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
