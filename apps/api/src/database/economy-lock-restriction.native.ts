import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma as owner, PrismaClient } from '@socialplay/database';
import { verifyRuntimeAccessReadOnly } from '../scripts/ledger-runtime-access.js';
import { restrictKnownPublicCapabilities, type ActivationDb } from '../practice-activation/provision.js';

/**
 * docs/deployment/economy-lock-{restriction,rollback,verify}.sql (dormant
 * operator SQL) on a disposable local database with synthetic roles. Every case
 * asserts effective access by calling the function as real logins (directly,
 * through an inherited role and after SET ROLE), not only the ACL. The
 * function's original grants are restored afterwards.
 */
const base = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(base.hostname) ||
  base.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw new Error('Disposable local database required');

const doc = (name: string) => fileURLToPath(new URL(`../../../../docs/deployment/${name}`, import.meta.url));
const APPLY = doc('economy-lock-restriction.sql');
const ROLLBACK = doc('economy-lock-rollback.sql');
const VERIFY = doc('economy-lock-verify.sql');
const FN = 'public.ledger_lock_economy_for_invariant_check()';
const s = randomUUID().replaceAll('-', '').slice(0, 8);
const name = (tag: string) => `elr_${tag}_${s}`;
const logins = ['runtime', 'worker', 'setter', 'worker2', 'delegate', 'operator', 'setter16'] as const;
type Login = (typeof logins)[number];
const roles = Object.fromEntries(logins.map((l) => [l, name(l)])) as Record<Login, string>;
const group = name('group');
const passwords = Object.fromEntries(logins.map((l) => [l, randomUUID()])) as Record<Login, string>;
const exec = (sql: string) => owner.$executeRawUnsafe(sql);
const clients = {} as Record<Login, PrismaClient>;
let ownerName: string;
let pg16: boolean;
let original: string[];

const url = (login: Login) => {
  const u = new URL(base);
  u.username = roles[login];
  u.password = passwords[login];
  return u.toString();
};
/** Runs an operator file through psql; never throws. */
function run(file: string, vars: Record<string, string> = {}, connection = base.toString()) {
  const args = [connection, '-X', '-q', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]), '-f', file];
  const result = spawnSync('psql', args, { encoding: 'utf8' });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}
const apply = (vars: Record<string, string> = {}, connection?: string) =>
  run(APPLY, { runtime_role: roles.runtime, ...vars }, connection);
const verify = () => run(VERIFY, { runtime_role: roles.runtime });
const rollback = (connection?: string) => run(ROLLBACK, {}, connection);

/** Direct non-owner EXECUTE grants, "*" marking a grant option. */
async function direct(): Promise<string[]> {
  const rows = await owner.$queryRaw<{ entry: string }[]>`
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
           || CASE WHEN a.is_grantable THEN '*' ELSE '' END AS entry
    FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    WHERE p.oid = pg_catalog.to_regprocedure(${FN}) AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
    ORDER BY 1`;
  return rows.map((r) => r.entry);
}
const target = (entry: string) => (entry.replace('*', '') === 'PUBLIC' ? 'PUBLIC' : `"${entry.replace('*', '')}"`);
/** Throwaway database only: sets the function's grants and drops any capture. */
async function resetTo(entries: string[]) {
  for (const entry of await direct()) await exec(`REVOKE EXECUTE ON FUNCTION ${FN} FROM ${target(entry)} CASCADE`);
  for (const entry of entries)
    await exec(`GRANT EXECUTE ON FUNCTION ${FN} TO ${target(entry)}${entry.endsWith('*') ? ' WITH GRANT OPTION' : ''}`);
  await exec('DROP SCHEMA IF EXISTS economy_lock_restriction CASCADE');
}
const captures = async () =>
  (await owner.$queryRawUnsafe(
    `SELECT captured_entries AS entries, restored_at IS NULL AS active FROM economy_lock_restriction.acl_snapshots ORDER BY id`
  )) as { entries: { grantee: string; grantable: boolean }[]; active: boolean }[];
const captureExists = async () =>
  (await owner.$queryRaw<{ present: boolean }[]>`
    SELECT pg_catalog.to_regclass('economy_lock_restriction.acl_snapshots') IS NOT NULL AS present`)[0].present;
/** Whether the login can take the lock, optionally after SET ROLE. */
async function canLock(login: Login, setRole?: string) {
  try {
    await clients[login].$transaction(async (tx) => {
      if (setRole) await tx.$executeRawUnsafe(`SET LOCAL ROLE "${setRole}"`);
      await tx.$executeRawUnsafe(`SELECT ${FN}`);
    });
    return true;
  } catch (error) {
    // Refused either at SET ROLE (no path to that role) or at the function itself.
    if (/permission denied (for function ledger_lock_economy_for_invariant_check|to set role)/.test(String(error))) return false;
    throw error;
  }
}
/** A refused apply leaves the grants and the capture exactly as they were. */
async function expectRefused(result: { ok: boolean; out: string }, message: RegExp, grants: string[]) {
  expect(result.ok, result.out).toBe(false);
  expect(result.out).toMatch(message);
  expect(await direct()).toEqual(grants);
  expect(await captureExists()).toBe(false);
}

beforeAll(async () => {
  pg16 = Number((await owner.$queryRaw<{ v: string }[]>`SELECT pg_catalog.current_setting('server_version_num') AS v`)[0].v) >= 160000;
  ownerName = (await owner.$queryRaw<{ o: string }[]>`
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS o FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(${FN})`)[0].o;
  original = await direct();
  for (const login of logins) {
    // A NOINHERIT login can still SET ROLE to its roles: the "SET only" layout on every version.
    const inherit = login === 'setter' ? 'NOINHERIT' : 'INHERIT';
    await exec(`CREATE ROLE "${roles[login]}" LOGIN ${inherit} PASSWORD '${passwords[login]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
    clients[login] = new PrismaClient({ datasourceUrl: url(login), log: [] });
  }
  await exec(`CREATE ROLE "${group}" NOLOGIN`);
  await exec('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${roles.runtime})`;
});

afterAll(async () => {
  for (const client of Object.values(clients)) await client.$disconnect().catch(() => undefined);
  await resetTo(original).catch(() => undefined);
  for (const role of [...Object.values(roles), group]) {
    await exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`).catch(() => undefined);
    await exec(`DROP OWNED BY "${role}"`).catch(() => undefined);
    await exec(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
  }
  await owner.$disconnect();
});

describe('unsupported layouts fail closed and change nothing', () => {
  beforeEach(() => resetTo(['PUBLIC']));

  it('refuses when another login can inherit from or SET ROLE to the runtime, directly or through a group', async () => {
    const layouts: [string, string, RegExp][] = [
      [`GRANT "${roles.runtime}" TO "${roles.worker}"`, `REVOKE "${roles.runtime}" FROM "${roles.worker}"`, new RegExp(roles.worker)],
      [`GRANT "${roles.runtime}" TO "${roles.setter}"`, `REVOKE "${roles.runtime}" FROM "${roles.setter}"`, new RegExp(roles.setter)],
      [
        `GRANT "${roles.runtime}" TO "${group}"; GRANT "${group}" TO "${roles.worker}"`,
        `REVOKE "${group}" FROM "${roles.worker}"; REVOKE "${roles.runtime}" FROM "${group}"`,
        new RegExp(`${group}, ${roles.worker}`),
      ],
    ];
    if (pg16)
      layouts.push([
        `GRANT "${roles.runtime}" TO "${roles.setter16}" WITH INHERIT FALSE, SET TRUE`,
        `REVOKE "${roles.runtime}" FROM "${roles.setter16}"`,
        new RegExp(roles.setter16),
      ]);
    for (const [setup, undo, who] of layouts) {
      for (const statement of setup.split('; ')) await exec(statement);
      const result = apply();
      await expectRefused(result, /can inherit from or SET ROLE to runtime role/, ['PUBLIC']);
      expect(result.out, setup).toMatch(who);
      expect(verify().ok).toBe(false);
      for (const statement of undo.split('; ')) await exec(statement);
    }
  });

  it('refuses a runtime login that can act as the owner, and bad runtime roles', async () => {
    await exec(`GRANT "${ownerName}" TO "${roles.runtime}"`);
    await expectRefused(apply(), /runtime role .* can act as the owner/, ['PUBLIC']);
    await exec(`REVOKE "${ownerName}" FROM "${roles.runtime}"`);
    for (const bad of [name('missing'), group, ownerName])
      await expectRefused(apply({ runtime_role: bad }), /must be an existing login that is neither a superuser nor the owner/, ['PUBLIC']);
    await expectRefused(apply({}, url('worker')), /run this as the owner/, ['PUBLIC']);
    await expectRefused(run(APPLY), /pass -v runtime_role=/, ['PUBLIC']);
  });

  it('never revokes a named consumer it was not told about, and refuses grants it cannot revoke', async () => {
    await resetTo([group, roles.worker2]);
    for (const revoke of [undefined, '', group, `${group},${roles.worker2},${roles.worker}`]) {
      const vars: Record<string, string> = revoke === undefined ? {} : { revoke_roles: revoke };
      await expectRefused(apply(vars), /roles holding their own EXECUTE grant: \[elr_group_.*,elr_worker2_.*\]/, [group, roles.worker2].sort());
    }
    // A grant made by a grantee holding the grant option: the owner cannot revoke it.
    await resetTo([`${roles.delegate}*`]);
    const grant = spawnSync('psql', [url('delegate'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', `GRANT EXECUTE ON FUNCTION ${FN} TO "${roles.worker2}"`], { encoding: 'utf8' });
    expect(grant.status, grant.stderr).toBe(0);
    await expectRefused(apply({ revoke_roles: `${roles.delegate},${roles.worker2}` }), new RegExp(`EXECUTE was granted by ${roles.delegate}`), [`${roles.delegate}*`, roles.worker2].sort());
  });
});

describe('from an already restricted start (practice-activation style) through exact rollback', () => {
  beforeAll(async () => {
    await resetTo([group, `${roles.worker2}*`]);
    await exec(`GRANT "${group}" TO "${roles.worker}"`);
    await exec(`GRANT "${group}" TO "${roles.setter}"`);
    if (pg16) await exec(`GRANT "${group}" TO "${roles.setter16}" WITH INHERIT FALSE, SET TRUE`);
  });
  afterAll(async () => {
    for (const login of ['worker', 'setter', 'setter16'] as const) await exec(`REVOKE "${group}" FROM "${roles[login]}"`).catch(() => undefined);
  });

  const reachable = async () => ({
    worker: await canLock('worker'),
    setterDirect: await canLock('setter'),
    setterAfterSetRole: await canLock('setter', group),
    setter16AfterSetRole: pg16 ? await canLock('setter16', group) : null,
    worker2: await canLock('worker2'),
    runtime: await canLock('runtime'),
    unrelated: await canLock('operator'),
  });

  it('restricts effective access, inherited and SET ROLE paths included, and rolls back to exactly the captured grants', async () => {
    const before = await reachable();
    expect(before).toEqual({ worker: true, setterDirect: false, setterAfterSetRole: true, setter16AfterSetRole: pg16 ? true : null, worker2: true, runtime: false, unrelated: false });

    const applied = apply({ revoke_roles: `${roles.worker2},${group}` });
    expect(applied.ok, applied.out).toBe(true);
    expect(await direct()).toEqual([roles.runtime]);
    expect(await reachable()).toEqual({ worker: false, setterDirect: false, setterAfterSetRole: false, setter16AfterSetRole: pg16 ? false : null, worker2: false, runtime: true, unrelated: false });
    const checked = verify();
    expect(checked.ok, checked.out).toBe(true);
    expect(checked.out).toMatch(new RegExp(`runtime-only \\(${roles.runtime}\\)`));
    expect(await captures()).toEqual([
      { entries: [{ grantee: group, grantable: false }, { grantee: roles.worker2, grantable: true }].sort((a, b) => a.grantee.localeCompare(b.grantee)), active: true },
    ]);

    const restored = rollback();
    expect(restored.ok, restored.out).toBe(true);
    expect(await direct()).toEqual([group, `${roles.worker2}*`].sort());
    expect(await reachable()).toEqual(before);
    expect((await captures()).map((c) => c.active)).toEqual([false]);
    expect(rollback().out).toMatch(/every capture has already been restored/);
  });
});

describe('from the release state', () => {
  beforeEach(() => resetTo(['PUBLIC']));

  it('keeps the first capture across re-runs, restores PUBLIC exactly, and captures afresh next time', async () => {
    expect(await canLock('worker')).toBe(true);
    expect(apply().ok).toBe(true);
    expect(apply().ok).toBe(true);
    expect(await canLock('worker')).toBe(false);
    expect(await captures()).toEqual([{ entries: [{ grantee: 'PUBLIC', grantable: false }], active: true }]);
    expect(rollback().ok).toBe(true);
    expect(await direct()).toEqual(['PUBLIC']);
    expect(await canLock('worker')).toBe(true);
    expect(apply().ok).toBe(true);
    expect((await captures()).map((c) => c.active)).toEqual([false, true]);
  });

  it('never leaves the runtime a grant option it held before, and restores it on rollback', async () => {
    await resetTo(['PUBLIC', `${roles.runtime}*`]);
    expect(apply().ok).toBe(true);
    expect(await direct()).toEqual([roles.runtime]);
    expect(verify().ok).toBe(true);
    expect(rollback().ok).toBe(true);
    expect(await direct()).toEqual(['PUBLIC', `${roles.runtime}*`].sort());
  });

  it('refuses a rollback with nothing to restore, by a non-owner, or to a role that no longer exists, changing nothing', async () => {
    expect(rollback().out).toMatch(/nothing to roll back/);
    const temporary = name('gone');
    await exec(`CREATE ROLE "${temporary}" NOLOGIN`);
    await resetTo([temporary]);
    expect(apply({ revoke_roles: temporary }).ok).toBe(true);
    expect(rollback(url('worker')).out).toMatch(/run this as the owner/);
    await exec(`DROP ROLE "${temporary}"`);
    const refused = rollback();
    expect(refused.ok).toBe(false);
    expect(refused.out).toMatch(new RegExp(`captured grantees no longer exist: ${temporary}`));
    expect(await direct()).toEqual([roles.runtime]);
    expect((await captures()).map((c) => c.active)).toEqual([true]);
  });
});

describe('after the restriction: provisioning, migrations and drift', () => {
  beforeAll(async () => {
    await resetTo(['PUBLIC']);
  });

  it('is not re-granted by practice activation or runtime grants, and the preDeploy runtime check still passes', async () => {
    // The real practice-activation code, as a dry run: reads execute, changes are only recorded.
    const planned: string[] = [];
    const dryRun: ActivationDb = {
      query: async (sql, values) => (await owner.$queryRawUnsafe(sql, ...(values ?? []))) as never,
      execute: async (sql) => void planned.push(sql),
    };
    await restrictKnownPublicCapabilities(dryRun);
    expect(planned.filter((sql) => sql.includes('ledger_lock_economy_for_invariant_check')).length).toBeGreaterThan(0);

    expect(apply().ok).toBe(true);
    planned.length = 0;
    await restrictKnownPublicCapabilities(dryRun);
    expect(planned.filter((sql) => sql.includes('ledger_lock_economy_for_invariant_check'))).toEqual([]);
    // staging-practice-owner.ts selects only functions PUBLIC can still execute.
    const [publicAccess] = await owner.$queryRaw<{ allowed: boolean }[]>`
      SELECT pg_catalog.has_function_privilege('public', ${FN}, 'EXECUTE') AS allowed`;
    expect(publicAccess.allowed).toBe(false);

    await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${roles.runtime})`;
    expect(await direct()).toEqual([roles.runtime]);
    expect(verify().ok).toBe(true);
    const findings = await clients.runtime.$transaction((tx) => verifyRuntimeAccessReadOnly(tx, roles.runtime), {
      isolationLevel: 'RepeatableRead',
      timeout: 60_000,
    });
    expect(findings).toEqual([]);
  });

  it('survives CREATE OR REPLACE, is caught by verify after DROP and CREATE, and is restored by re-applying', async () => {
    const [definition] = await owner.$queryRaw<{ ddl: string }[]>`
      SELECT pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(${FN})) AS ddl`;
    await exec(definition.ddl);
    expect(verify().ok).toBe(true);
    await exec(`DROP FUNCTION ${FN}`);
    await exec(definition.ddl);
    // Even if someone also re-grants the runtime, PUBLIC is back and verify says so.
    await exec(`GRANT EXECUTE ON FUNCTION ${FN} TO "${roles.runtime}"`);
    const drifted = verify();
    expect(drifted.ok).toBe(false);
    expect(drifted.out).toMatch(/restriction not in effect: EXECUTE is held by PUBLIC/);
    expect(await canLock('worker')).toBe(true);
    expect(apply().ok).toBe(true);
    expect(await canLock('worker')).toBe(false);
    expect(verify().ok).toBe(true);
    // The original capture is kept, so a rollback still returns to the release state.
    expect(await captures()).toEqual([{ entries: [{ grantee: 'PUBLIC', grantable: false }], active: true }]);
  });

  it('is caught by verify when a login later gains a path to the runtime; re-applying refuses and changes nothing until the role layout is corrected', async () => {
    await resetTo(['PUBLIC']);
    const applied = apply();
    expect(applied.ok, applied.out).toBe(true);
    expect(verify().ok).toBe(true);
    const restricted = { direct: await direct(), captures: await captures() };
    expect(restricted.direct).toEqual([roles.runtime]);
    const drifts: [Login, string, () => Promise<boolean>][] = [
      ['worker', `GRANT "${roles.runtime}" TO "${roles.worker}"`, () => canLock('worker')],
      // SET ROLE only: has_function_privilege alone would miss this login.
      ['setter', `GRANT "${roles.runtime}" TO "${roles.setter}"`, () => canLock('setter', roles.runtime)],
    ];
    for (const [login, grant, takesLock] of drifts) {
      await exec(grant);
      expect(await takesLock(), login).toBe(true);
      const drifted = verify();
      expect(drifted.ok, login).toBe(false);
      expect(drifted.out).toMatch(new RegExp(`can execute it .*${roles[login]}`));

      // Re-applying the restriction is not a repair: it refuses (fail closed),
      // names the role, and changes neither the grants nor the original capture.
      const reapplied = apply();
      expect(reapplied.ok, login).toBe(false);
      expect(reapplied.out).toMatch(
        new RegExp(`unsupported layout: these roles can inherit from or SET ROLE to runtime role ${roles.runtime}: ${roles[login]}`)
      );
      expect(await direct()).toEqual(restricted.direct);
      expect(await captures()).toEqual(restricted.captures);
      expect(await takesLock(), `${login} still reaches the lock after the refused re-apply`).toBe(true);

      // Only the separately approved role-layout correction restores the
      // invariant; the restriction itself needs no re-apply.
      await exec(`REVOKE "${roles.runtime}" FROM "${roles[login]}"`);
      expect(await takesLock(), login).toBe(false);
      expect(verify().ok, login).toBe(true);
      expect(await direct()).toEqual(restricted.direct);
      expect(await captures()).toEqual(restricted.captures);
    }
  });
});
