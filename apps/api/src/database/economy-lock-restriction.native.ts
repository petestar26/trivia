import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma as owner, PrismaClient } from '@socialplay/database';
import { verifyRuntimeAccessReadOnly } from '../scripts/ledger-runtime-access.js';

/**
 * docs/deployment/economy-lock-restriction.sql (dormant operator SQL). Disposable
 * local database and synthetic roles only; the function's original grants are
 * restored afterwards.
 */
const base = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(base.hostname) ||
  base.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw new Error('Disposable local database required');

const FILE = fileURLToPath(new URL('../../../../docs/deployment/economy-lock-restriction.sql', import.meta.url));
const FN = 'public.ledger_lock_economy_for_invariant_check()';
const s = randomUUID().replaceAll('-', '').slice(0, 10);
const roles = { runtime: `elr_runtime_${s}`, probe: `elr_probe_${s}`, earlier: `elr_earlier_${s}`, superuser: `elr_super_${s}` };
const passwords = { runtime: randomUUID(), probe: randomUUID() };
const exec = (sql: string) => owner.$executeRawUnsafe(sql);
const clients: PrismaClient[] = [];
/** Who could execute it before this suite (other suites, such as practice activation, may have changed it). */
let original: string[];
const target = (grantee: string) => (grantee === 'PUBLIC' ? 'PUBLIC' : `"${grantee.replaceAll('"', '""')}"`);

function url(role: string, password: string) {
  const u = new URL(base);
  u.username = role;
  u.password = password;
  return u.toString();
}
function clientFor(key: 'runtime' | 'probe') {
  const client = new PrismaClient({ datasourceUrl: url(roles[key], passwords[key]), log: [] });
  clients.push(client);
  return client;
}
/** Runs the operator file with psql, as the given connection. */
function apply(runtimeRole: string, connection = base.toString()) {
  return execFileSync('psql', [connection, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', `runtime_role=${runtimeRole}`, '-f', FILE], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function executors(): Promise<string[]> {
  const rows = await owner.$queryRaw<{ grantee: string }[]>`
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee
    FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    WHERE p.oid = pg_catalog.to_regprocedure(${FN}) AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
    ORDER BY 1`;
  return rows.map((r) => r.grantee);
}
const acl = async () =>
  (await owner.$queryRaw<{ acl: string | null }[]>`
    SELECT p.proacl::text AS acl FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(${FN})`)[0].acl;
/** Calls the function in a transaction, as the given login, and reports whether it held the locks. */
async function lockAs(client: PrismaClient) {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT ${FN}`);
    const [row] = await tx.$queryRaw<{ held: number }[]>`
      SELECT pg_catalog.count(*)::int AS held FROM pg_catalog.pg_locks
      WHERE pid = pg_catalog.pg_backend_pid() AND locktype = 'relation' AND mode = 'ShareLock'`;
    return row.held;
  });
}

let runtime: PrismaClient;
let probe: PrismaClient;

beforeAll(async () => {
  original = await executors();
  // Start from the release's grant, whatever earlier suites did.
  await exec(`GRANT EXECUTE ON FUNCTION ${FN} TO PUBLIC`);
  for (const key of ['runtime', 'probe'] as const)
    await exec(`CREATE ROLE "${roles[key]}" LOGIN PASSWORD '${passwords[key]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await exec(`CREATE ROLE "${roles.earlier}" NOLOGIN`);
  await exec(`CREATE ROLE "${roles.superuser}" LOGIN SUPERUSER`);
  await exec('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${roles.runtime})`;
  runtime = clientFor('runtime');
  probe = clientFor('probe');
});

afterAll(async () => {
  for (const client of clients) await client.$disconnect().catch(() => undefined);
  // Restore exactly who could execute it before this suite.
  for (const grantee of await executors()) await exec(`REVOKE EXECUTE ON FUNCTION ${FN} FROM ${target(grantee)}`).catch(() => undefined);
  for (const grantee of original) await exec(`GRANT EXECUTE ON FUNCTION ${FN} TO ${target(grantee)}`).catch(() => undefined);
  for (const name of Object.values(roles)) {
    await exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${name}'`).catch(() => undefined);
    await exec(`DROP OWNED BY "${name}"`).catch(() => undefined);
    await exec(`DROP ROLE IF EXISTS "${name}"`).catch(() => undefined);
  }
  await owner.$disconnect();
});

describe('before the restriction (release behaviour)', () => {
  it('lets a login with no table privilege take SHARE locks on the economy tables', async () => {
    const [row] = await owner.$queryRaw<{ allowed: boolean }[]>`
      SELECT pg_catalog.has_table_privilege(${roles.probe}, 'public.wallets', 'SELECT,INSERT,UPDATE,DELETE') AS allowed`;
    expect(row.allowed).toBe(false);
    expect(await executors()).toContain('PUBLIC');
    expect(await lockAs(probe)).toBeGreaterThanOrEqual(11);
  });
});

describe('refusals', () => {
  it('refuses anyone but the owner, and runtime roles that are missing, superusers or the owner, changing nothing', async () => {
    const before = await acl();
    expect(() => apply(roles.runtime, url(roles.probe, passwords.probe))).toThrow(/run this as the owner/);
    for (const bad of [`elr_missing_${s}`, roles.earlier, roles.superuser, base.username || 'postgres'])
      expect(() => apply(bad), bad).toThrow(/must be an existing login that is neither a superuser nor the owner/);
    expect(await acl()).toBe(before);
  });
});

describe('after the restriction', () => {
  beforeAll(async () => {
    // As practice activation would: an earlier role holding its own grant.
    await exec(`GRANT EXECUTE ON FUNCTION ${FN} TO "${roles.earlier}"`);
    apply(roles.runtime);
  });

  it('leaves EXECUTE with the owner and the runtime login only, per-role grants included', async () => {
    expect(await executors()).toEqual([roles.runtime]);
    await expect(lockAs(probe)).rejects.toThrow(/permission denied for function ledger_lock_economy_for_invariant_check/);
    expect(await lockAs(runtime)).toBeGreaterThanOrEqual(11);
  });

  it('survives re-applied runtime grants and leaves the preDeploy runtime access check passing', async () => {
    await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${roles.runtime})`;
    expect(await executors()).toEqual([roles.runtime]);
    expect(await lockAs(runtime)).toBeGreaterThanOrEqual(11);
    const findings = await runtime.$transaction((tx) => verifyRuntimeAccessReadOnly(tx, roles.runtime), {
      isolationLevel: 'RepeatableRead',
      timeout: 60_000,
    });
    expect(findings).toEqual([]);
  });

  it('is harmless to re-run, and rolls back with one GRANT to PUBLIC', async () => {
    const restricted = await acl();
    apply(roles.runtime);
    expect(await acl()).toBe(restricted);
    await exec(`GRANT EXECUTE ON FUNCTION ${FN} TO PUBLIC`);
    expect(await lockAs(probe)).toBeGreaterThanOrEqual(11);
    apply(roles.runtime);
    expect(await executors()).toEqual([roles.runtime]);
  });
});
