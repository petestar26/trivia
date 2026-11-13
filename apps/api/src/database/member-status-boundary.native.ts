import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma as owner, PrismaClient } from '@socialplay/database';
import { config } from '@socialplay/config';
import { generateTokens, hashPassword } from '../utils/auth.js';
import { GuardedDatabase } from './identity.js';
import {
  createStatusApprovalSigner,
  type SignedStatusApproval,
  type StatusApprovalClaims,
  type StatusApprovalSigner,
} from './status-approval.js';
import { setMemberAccountStatus } from '../workspaces/member-status.js';
import { credentialDb } from '../agents/credential-database.js';
import { buildServer } from '../server.js';

/**
 * Narrow, signed member-status boundary (v2) on real PostgreSQL. Disposable
 * local database, synthetic roles, keys and accounts only; all removed after.
 */
const base = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(base.hostname) ||
  base.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw new Error('Disposable local database required');

const INSTALL = readFileSync(
  new URL('../../../../docs/deployment/staff-member-status-boundary.sql', import.meta.url),
  'utf8'
);
const SIGNATURE = 'public.staff_set_member_status(text,text,text,text,text,integer,text,text,text,text)';
const UNINSTALL = `DROP FUNCTION IF EXISTS ${SIGNATURE}`;
/** Throwaway database only: also removes keys and evidence. */
const PURGE = 'DROP SCHEMA IF EXISTS staff_status_approval CASCADE';
const s = randomUUID().replaceAll('-', '').slice(0, 10);
const roles = { runtime: `msb_runtime_${s}`, staff: `msb_staff_${s}` };
const passwords = { runtime: randomUUID(), staff: randomUUID() };
const KEY_ID = `msb-key-${s}`;
const KEY_HEX = randomBytes(32).toString('hex');
const signer = createStatusApprovalSigner({ STAFF_STATUS_APPROVAL_KEY_ID: KEY_ID, STAFF_STATUS_APPROVAL_KEY: KEY_HEX })!;
const clients: PrismaClient[] = [];
const servers: { close(): Promise<unknown> }[] = [];
const exec = (sql: string) => owner.$executeRawUnsafe(sql);

function urlFor(key: keyof typeof roles) {
  const url = new URL(base);
  url.username = roles[key];
  url.password = passwords[key];
  return url.toString();
}
function clientFor(key: keyof typeof roles) {
  const client = new PrismaClient({ datasourceUrl: urlFor(key), log: [] });
  clients.push(client);
  return client;
}

/**
 * Every privilege held by anyone but the users owner, in schema public and in
 * the boundary's private schema (whose objects must add nothing to this).
 */
async function nonOwnerPrivileges(): Promise<string[]> {
  const rows = await owner.$queryRaw<{ entry: string }[]>`
    WITH ns AS (
      SELECT n.oid, n.nspname, n.nspacl, n.nspowner FROM pg_catalog.pg_namespace n
      WHERE n.nspname IN ('public', 'staff_status_approval')),
    acl AS (
      SELECT 'relation ' || c.oid::regclass::text AS obj, (pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner)))).*
      FROM pg_catalog.pg_class c JOIN ns ON ns.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      UNION ALL
      SELECT 'column ' || c.oid::regclass::text || '.' || a.attname, (pg_catalog.aclexplode(a.attacl)).*
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN ns ON ns.oid = c.relnamespace
      WHERE a.attacl IS NOT NULL
      UNION ALL
      SELECT 'function ' || p.oid::regprocedure::text,
             (pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner)))).*
      FROM pg_catalog.pg_proc p JOIN ns ON ns.oid = p.pronamespace
      UNION ALL
      SELECT 'schema ' || ns.nspname, (pg_catalog.aclexplode(COALESCE(ns.nspacl, pg_catalog.acldefault('n', ns.nspowner)))).*
      FROM ns)
    SELECT obj || ' ' || CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(grantee) END
           || ' ' || privilege_type AS entry
    FROM acl
    WHERE grantee <> (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.users'::regclass)
    ORDER BY 1`;
  return rows.map((r) => r.entry);
}
/** users_privilege_guard's definition and trigger state. */
async function guardState(): Promise<string> {
  const [row] = await owner.$queryRaw<{ state: string }[]>`
    SELECT pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) || ':' ||
           pg_catalog.string_agg(t.tgname::text || '=' || t.tgenabled::text, ',' ORDER BY t.tgname) AS state
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.users'::regclass AND p.proname = 'users_privilege_guard'
    GROUP BY p.oid`;
  return row.state;
}
const canExecute = async (grantee: string, signature = SIGNATURE) => {
  const [row] = await owner.$queryRaw<{ allowed: boolean }[]>`
    SELECT pg_catalog.has_function_privilege(${grantee}, ${signature}, 'EXECUTE') AS allowed`;
  return row.allowed;
};

let staffDb: GuardedDatabase;
let runtimeDb: PrismaClient;
let before: string[];
let guardBefore: string;
type Account = { id: string; email: string | null; username: string; tokenVersion: number };
const accounts = {} as Record<'admin' | 'admin2' | 'suspendedAdmin' | 'plainActor' | 'adminTarget' | 'pending' | 'banned', Account>;
const current = (id: string) => owner.user.findUniqueOrThrow({ where: { id } });
async function member(tag: string, password?: string) {
  return owner.user.create({
    data: {
      username: `msb_${tag}_${s}`.slice(0, 30),
      email: `${tag}_${s}@fixture.invalid`,
      ...(password ? { passwordHash: await hashPassword(password) } : {}),
    },
  });
}
const change = (status: 'ACTIVE' | 'SUSPENDED', updatedAt: Date | string) => ({
  status,
  reason: 'synthetic review',
  expectedUpdatedAt: typeof updatedAt === 'string' ? updatedAt : updatedAt.toISOString(),
});
/** What the authenticated route passes: the actor's current tokenVersion and the signer. */
const approved = async (actorId: string, withSigner: StatusApprovalSigner | null = signer) => ({
  actorTokenVersion: (await current(actorId)).tokenVersion,
  signer: withSigner,
});
const claimsFor = async (actor: string, memberId: string, status: 'ACTIVE' | 'SUSPENDED', updatedAt: Date) =>
  ({
    actorId: actor,
    actorTokenVersion: (await current(actor)).tokenVersion,
    memberId,
    status,
    expectedUpdatedAt: updatedAt.toISOString(),
    reason: 'synthetic review',
  }) satisfies StatusApprovalClaims;
/** Calls the boundary directly as the staff login, optionally tampering after signing. */
async function call(claims: StatusApprovalClaims, signed: SignedStatusApproval, tamper: Partial<StatusApprovalClaims> = {}) {
  const c = { ...claims, ...tamper };
  const [row] = await staffDb.$transaction((tx) =>
    tx.$queryRawUnsafe<{ outcome: string }[]>(
      'SELECT outcome FROM public.staff_set_member_status($1, $2, $3, $4, $5, $6::integer, $7, $8, $9, $10)',
      signed.keyId, signed.nonce, signed.expiresAt, signed.signature,
      c.actorId, c.actorTokenVersion, c.memberId, c.status, c.expectedUpdatedAt, c.reason
    )
  );
  return row?.outcome;
}

beforeAll(async () => {
  await exec(UNINSTALL);
  await exec(PURGE);
  for (const key of ['runtime', 'staff'] as const)
    await exec(
      `CREATE ROLE "${roles[key]}" LOGIN PASSWORD '${passwords[key]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`
    );
  await exec('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${roles.runtime})`;
  // The staff login needs only to read users (identity guard, admin pre-check)
  // plus, at activation, EXECUTE on the boundary. No UPDATE on users at all.
  await exec(`GRANT USAGE ON SCHEMA public TO "${roles.staff}"`);
  await exec(`GRANT SELECT ON public.users TO "${roles.staff}"`);
  runtimeDb = clientFor('runtime');
  staffDb = GuardedDatabase.bind('Staff', clientFor('staff'), { role: roles.staff, distinctFrom: [roles.runtime] });
  const make = (tag: string, role: 'USER' | 'ADMIN', status = 'ACTIVE') =>
    owner.user.create({
      data: { username: `msb_${tag}_${s}`.slice(0, 30), email: `${tag}_${s}@fixture.invalid`, role, status: status as never },
    });
  accounts.admin = await make('admin', 'ADMIN');
  accounts.admin2 = await make('admin2', 'ADMIN');
  accounts.suspendedAdmin = await make('sadmin', 'ADMIN', 'SUSPENDED');
  accounts.plainActor = await make('plain', 'USER');
  accounts.adminTarget = await make('atarget', 'ADMIN');
  accounts.pending = await make('pending', 'USER', 'PENDING_VERIFICATION');
  accounts.banned = await make('banned', 'USER', 'BANNED');
  before = await nonOwnerPrivileges();
  guardBefore = await guardState();
});

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => undefined);
  for (const client of clients) await client.$disconnect().catch(() => undefined);
  await exec(UNINSTALL).catch(() => undefined);
  await exec(PURGE).catch(() => undefined);
  for (const name of Object.values(roles)) {
    await exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${name}'`).catch(() => undefined);
    await exec(`DROP OWNED BY "${name}"`).catch(() => undefined);
    await exec(`DROP ROLE IF EXISTS "${name}"`).catch(() => undefined);
  }
  await credentialDb.$disconnect();
  await owner.$disconnect();
});

describe('installation', () => {
  it('refuses installation by anyone but the owner of public.users, leaving nothing behind', async () => {
    await expect(runtimeDb.$executeRawUnsafe(INSTALL)).rejects.toThrow(/must be installed by the owner of public\.users/);
    const [row] = await owner.$queryRaw<{ present: boolean }[]>`
      SELECT pg_catalog.to_regprocedure(${SIGNATURE}) IS NOT NULL AS present`;
    expect(row.present).toBe(false);
  });

  it('installs atomically, grants nothing and leaves every runtime, worker and member privilege unchanged', async () => {
    await exec(INSTALL);
    const [fn] = await owner.$queryRaw<{ definer: boolean; config: string[]; owner: string; usersOwner: string }[]>`
      SELECT p.prosecdef AS definer, p.proconfig AS config, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
             pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.users'::regclass)) AS "usersOwner"
      FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(${SIGNATURE})`;
    expect(fn).toMatchObject({ definer: true, config: ['search_path=pg_catalog, pg_temp'] });
    expect(fn.owner).toBe(fn.usersOwner);
    expect(await nonOwnerPrivileges()).toEqual(before);
    await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${roles.runtime})`;
    expect(await nonOwnerPrivileges()).toEqual(before);
    for (const grantee of ['public', roles.runtime, roles.staff]) {
      expect(await canExecute(grantee)).toBe(false);
      expect(await canExecute(grantee, 'staff_status_approval.install_key(text,bytea)')).toBe(false);
      expect(await canExecute(grantee, 'staff_status_approval.retire_key(text)')).toBe(false);
    }
    // The unsigned v1 entry point does not exist.
    const [v1] = await owner.$queryRaw<{ present: boolean }[]>`
      SELECT pg_catalog.to_regprocedure('public.staff_set_member_status(text,text,text,text,text)') IS NOT NULL AS present`;
    expect(v1.present).toBe(false);
    await exec(INSTALL);
    expect(await nonOwnerPrivileges()).toEqual(before);
    expect(await guardState()).toBe(guardBefore);
  });

  it('keeps the key and evidence out of the runtime login even after runtime grants are re-applied', async () => {
    // ledger_apply_runtime_grants grants DML on every table in public; the
    // private schema is outside its reach and has no USAGE for anyone else.
    for (let round = 0; round < 2; round++) {
      await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${roles.runtime})`;
      for (const grantee of ['public', roles.runtime, roles.staff]) {
        const [row] = await owner.$queryRaw<{ usage: boolean; keys: boolean; approvals: boolean }[]>`
          SELECT pg_catalog.has_schema_privilege(${grantee}, 'staff_status_approval', 'USAGE') AS usage,
                 pg_catalog.has_any_column_privilege(${grantee}, 'staff_status_approval.keys', 'SELECT,INSERT,UPDATE') AS keys,
                 pg_catalog.has_any_column_privilege(${grantee}, 'staff_status_approval.approvals', 'SELECT,INSERT,UPDATE') AS approvals`;
        expect(row, grantee).toEqual({ usage: false, keys: false, approvals: false });
      }
      await expect(runtimeDb.$queryRawUnsafe('SELECT secret FROM staff_status_approval.keys')).rejects.toThrow(/permission denied/);
    }
  });

  it('refuses a planted privilege, object or schema in the private schema, atomically', async () => {
    const intruder = `msb_intruder_${s}`;
    await exec(`CREATE ROLE "${intruder}" NOLOGIN`);
    const definition = async () => {
      const [row] = await owner.$queryRaw<{ def: string }[]>`
        SELECT pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(${SIGNATURE}))) AS def`;
      return row.def;
    };
    const installed = await definition();
    try {
      for (const [plant, undo, found] of [
        [`GRANT USAGE ON SCHEMA staff_status_approval TO "${intruder}"`, `REVOKE USAGE ON SCHEMA staff_status_approval FROM "${intruder}"`, /schema staff_status_approval/],
        [`GRANT SELECT ON staff_status_approval.keys TO "${intruder}"`, `REVOKE SELECT ON staff_status_approval.keys FROM "${intruder}"`, /relation staff_status_approval\.keys/],
        [`GRANT SELECT (secret) ON staff_status_approval.keys TO "${intruder}"`, `REVOKE SELECT (secret) ON staff_status_approval.keys FROM "${intruder}"`, /column staff_status_approval\.keys\.secret/],
        [`GRANT EXECUTE ON FUNCTION staff_status_approval.install_key(text,bytea) TO "${intruder}"`, `REVOKE EXECUTE ON FUNCTION staff_status_approval.install_key(text,bytea) FROM "${intruder}"`, /function staff_status_approval\.install_key/],
        [`CREATE TABLE staff_status_approval.planted (x int); ALTER TABLE staff_status_approval.planted OWNER TO "${intruder}"`, 'DROP TABLE staff_status_approval.planted', /relation staff_status_approval\.planted/],
      ] as const) {
        for (const statement of plant.split('; ')) await exec(statement);
        await expect(exec(INSTALL), plant).rejects.toThrow(found);
        expect(await definition()).toBe(installed);
        await exec(undo);
      }
      // A same-named schema owned by anyone else is refused before anything is created in it.
      await exec('ALTER SCHEMA staff_status_approval RENAME TO staff_status_approval_moved');
      await exec(`CREATE SCHEMA staff_status_approval AUTHORIZATION "${intruder}"`);
      await expect(exec(INSTALL)).rejects.toThrow(/not owned by the owner of public\.users/);
      await exec('DROP SCHEMA staff_status_approval');
      await exec('ALTER SCHEMA staff_status_approval_moved RENAME TO staff_status_approval');
    } finally {
      await exec(`DROP ROLE IF EXISTS "${intruder}"`);
    }
    await exec(INSTALL);
    expect(await nonOwnerPrivileges()).toEqual(before);
  });
});

describe('signed approvals under an isolated staff identity', () => {
  beforeAll(async () => {
    // Activation steps simulated in the throwaway database only.
    await owner.$executeRaw`SELECT staff_status_approval.install_key(${KEY_ID}, decode(${KEY_HEX}, 'hex'))`;
    await exec(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO "${roles.staff}"`);
  });

  it('suspends and reactivates with a signed approval and no direct status privilege, draining refresh sessions', async () => {
    const [direct] = await owner.$queryRaw<{ allowed: boolean }[]>`
      SELECT pg_catalog.has_column_privilege(${roles.staff}, 'public.users', 'status', 'UPDATE') AS allowed`;
    expect(direct.allowed).toBe(false);
    const target = await member('lifecycle');
    await owner.session.create({ data: { userId: target.id, refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });

    const suspended = await setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt), await approved(accounts.admin.id));
    expect(suspended).toMatchObject({ userId: target.id, status: 'SUSPENDED' });
    const afterSuspend = await current(target.id);
    expect(afterSuspend).toMatchObject({ status: 'SUSPENDED', role: 'USER', tokenVersion: target.tokenVersion });
    expect(afterSuspend.updatedAt.toISOString()).toBe(suspended.updatedAt);
    expect(await owner.session.count({ where: { userId: target.id } })).toBe(0);
    const audit = await owner.auditLog.findFirstOrThrow({ where: { entityId: target.id, action: 'ADMIN_MEMBER_SUSPENDED' } });
    expect(audit).toMatchObject({
      userId: accounts.admin.id,
      oldData: { status: 'ACTIVE' },
      newData: { status: 'SUSPENDED', reason: 'synthetic review', refreshSessionsRevoked: true, boundary: 'staff_set_member_status/v2', approvalKeyId: KEY_ID, databaseLogin: roles.staff },
    });
    const [approval] = await owner.$queryRaw<{ admission: string; actor_id: string; database_login: string }[]>`
      SELECT admission, actor_id, database_login FROM staff_status_approval.approvals
      WHERE nonce = ${(audit.newData as { approvalNonce: string }).approvalNonce}`;
    expect(approval).toEqual({ admission: 'ADMITTED', actor_id: accounts.admin.id, database_login: roles.staff });

    const reactivated = await setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('ACTIVE', suspended.updatedAt), await approved(accounts.admin.id));
    expect(reactivated.status).toBe('ACTIVE');
    expect(await current(target.id)).toMatchObject({ status: 'ACTIVE', role: 'USER' });
  });

  it('never accepts a caller-supplied administrator ID without a valid, fresh, single-use signature', async () => {
    const target = await member('forgery');
    const claims = await claimsFor(accounts.admin.id, target.id, 'SUSPENDED', target.updatedAt);
    const auditCount = () => owner.auditLog.count({ where: { entityId: target.id } });
    const wrongKey = createStatusApprovalSigner({ STAFF_STATUS_APPROVAL_KEY_ID: KEY_ID, STAFF_STATUS_APPROVAL_KEY: randomBytes(32).toString('hex') })!;
    const unknownKey = createStatusApprovalSigner({ STAFF_STATUS_APPROVAL_KEY_ID: `unknown-${s}`, STAFF_STATUS_APPROVAL_KEY: KEY_HEX })!;
    const valid = signer.sign(claims);
    const cases: Array<[string, () => Promise<string | undefined>, string]> = [
      ['no real signature', () => call(claims, { ...valid, signature: '0'.repeat(64) }), 'APPROVAL_INVALID'],
      ['wrong key under the right key ID', () => call(claims, wrongKey.sign(claims)), 'APPROVAL_INVALID'],
      ['unknown key ID', () => call(claims, unknownKey.sign(claims)), 'APPROVAL_INVALID'],
      ['another administrator as actor', () => call(claims, signer.sign(claims), { actorId: accounts.admin2.id }), 'APPROVAL_INVALID'],
      ['actor tokenVersion changed', () => call(claims, signer.sign(claims), { actorTokenVersion: claims.actorTokenVersion + 1 }), 'APPROVAL_INVALID'],
      ['another member', () => call(claims, signer.sign(claims), { memberId: accounts.plainActor.id }), 'APPROVAL_INVALID'],
      ['another status', () => call(claims, signer.sign(claims), { status: 'ACTIVE' }), 'APPROVAL_INVALID'],
      ['another expected version', () => call(claims, signer.sign(claims), { expectedUpdatedAt: new Date(0).toISOString() }), 'APPROVAL_INVALID'],
      ['another reason', () => call(claims, signer.sign(claims), { reason: 'different reason' }), 'APPROVAL_INVALID'],
      ['expired', () => call(claims, signer.sign(claims, new Date(Date.now() - 120_000))), 'APPROVAL_EXPIRED'],
      ['too far in the future', () => call(claims, signer.sign(claims, new Date(Date.now() + 10 * 60_000))), 'APPROVAL_EXPIRED'],
    ];
    for (const [label, run, outcome] of cases) expect(await run(), label).toBe(outcome);
    expect(await current(target.id)).toMatchObject({ status: 'ACTIVE' });
    expect(await auditCount()).toBe(0);

    // A valid approval works once; replaying it is refused and changes nothing more.
    expect(await call(claims, valid)).toBe('OK');
    expect(await call(claims, valid)).toBe('APPROVAL_REPLAYED');
    expect(await auditCount()).toBe(1);

    // A retired key stops verifying at once.
    const retiredId = `retired-${s}`;
    const retiredHex = randomBytes(32).toString('hex');
    await owner.$executeRaw`SELECT staff_status_approval.install_key(${retiredId}, decode(${retiredHex}, 'hex'))`;
    const retired = createStatusApprovalSigner({ STAFF_STATUS_APPROVAL_KEY_ID: retiredId, STAFF_STATUS_APPROVAL_KEY: retiredHex })!;
    const reactivate = await claimsFor(accounts.admin.id, target.id, 'ACTIVE', (await current(target.id)).updatedAt);
    await owner.$executeRaw`SELECT staff_status_approval.retire_key(${retiredId})`;
    expect(await call(reactivate, retired.sign(reactivate))).toBe('APPROVAL_INVALID');
    expect(await current(target.id)).toMatchObject({ status: 'SUSPENDED' });
  });

  it('voids an approval when the administrator signs out or is revoked after signing', async () => {
    const target = await member('stale');
    const claims = await claimsFor(accounts.admin2.id, target.id, 'SUSPENDED', target.updatedAt);
    const signed = signer.sign(claims);
    // The administrator logs out (tokenVersion advances) before the change runs.
    await owner.$executeRaw`UPDATE users SET "tokenVersion" = "tokenVersion" + 1 WHERE id = ${accounts.admin2.id}`;
    expect(await call(claims, signed)).toBe('ACTOR_FORBIDDEN');
    expect(await current(target.id)).toMatchObject({ status: 'ACTIVE' });
    // Through the service, a route-supplied stale tokenVersion is likewise refused.
    await expect(
      setMemberAccountStatus(staffDb, accounts.admin2.id, target.id, change('SUSPENDED', target.updatedAt), {
        actorTokenVersion: claims.actorTokenVersion,
        signer,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('keeps the key and approval evidence out of the staff and runtime logins’ reach and append-only', async () => {
    for (const sql of [
      'SELECT secret FROM staff_status_approval.keys LIMIT 1',
      'SELECT nonce FROM staff_status_approval.approvals LIMIT 1',
      "SELECT staff_status_approval.install_key('x-key', decode(repeat('ab', 32), 'hex'))",
      `SELECT staff_status_approval.retire_key('${KEY_ID}')`,
    ])
    {
      await expect(staffDb.$transaction((tx) => tx.$queryRawUnsafe(sql)), sql).rejects.toThrow(/permission denied/);
      await expect(runtimeDb.$queryRawUnsafe(sql), sql).rejects.toThrow(/permission denied/);
    }
    await expect(exec('UPDATE staff_status_approval.approvals SET admission = admission')).rejects.toThrow(/append-only/);
    await expect(exec('DELETE FROM staff_status_approval.approvals')).rejects.toThrow(/append-only/);
    await expect(exec('TRUNCATE staff_status_approval.approvals')).rejects.toThrow(/append-only/);
  });

  it('refuses every out-of-scope request and changes nothing', async () => {
    const target = await member('scope');
    const snapshot = async () =>
      (await owner.user.findMany({
        where: { id: { in: [target.id, ...Object.values(accounts).map((a) => a.id)] } },
        select: { id: true, role: true, status: true, updatedAt: true },
        orderBy: { id: 'asc' },
      })).map((u) => `${u.id}:${u.role}:${u.status}:${u.updatedAt.toISOString()}`);
    const auditCount = () => owner.auditLog.count({ where: { action: { in: ['ADMIN_MEMBER_SUSPENDED', 'ADMIN_MEMBER_REACTIVATED'] } } });
    const stateBefore = await snapshot();
    const auditBefore = await auditCount();
    const fresh = target.updatedAt;
    const as = (actor: string) => approved(actor);
    const cases: Array<[string, () => Promise<unknown>, number]> = [
      ['non-admin actor', async () => setMemberAccountStatus(staffDb, accounts.plainActor.id, target.id, change('SUSPENDED', fresh), await as(accounts.plainActor.id)), 403],
      ['suspended admin', async () => setMemberAccountStatus(staffDb, accounts.suspendedAdmin.id, target.id, change('SUSPENDED', fresh), await as(accounts.suspendedAdmin.id)), 403],
      ['unknown actor', async () => setMemberAccountStatus(staffDb, randomUUID(), target.id, change('SUSPENDED', fresh), { actorTokenVersion: 0, signer }), 401],
      ['self', async () => setMemberAccountStatus(staffDb, accounts.admin.id, accounts.admin.id, change('SUSPENDED', fresh), await as(accounts.admin.id)), 403],
      ['admin target', async () => setMemberAccountStatus(staffDb, accounts.admin.id, accounts.adminTarget.id, change('SUSPENDED', fresh), await as(accounts.admin.id)), 403],
      ['pending target', async () => setMemberAccountStatus(staffDb, accounts.admin.id, accounts.pending.id, change('ACTIVE', fresh), await as(accounts.admin.id)), 403],
      ['banned target', async () => setMemberAccountStatus(staffDb, accounts.admin.id, accounts.banned.id, change('ACTIVE', fresh), await as(accounts.admin.id)), 403],
      ['unknown member', async () => setMemberAccountStatus(staffDb, accounts.admin.id, randomUUID(), change('SUSPENDED', fresh), await as(accounts.admin.id)), 404],
      ['stale version', async () => setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('SUSPENDED', new Date(fresh.getTime() - 1)), await as(accounts.admin.id)), 409],
      ['same status', async () => setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('ACTIVE', fresh), await as(accounts.admin.id)), 409],
      ['role in input', async () => setMemberAccountStatus(staffDb, accounts.admin.id, target.id, { ...change('SUSPENDED', fresh), role: 'ADMIN' }, await as(accounts.admin.id)), 400],
      ['other status', async () => setMemberAccountStatus(staffDb, accounts.admin.id, target.id, { ...change('SUSPENDED', fresh), status: 'BANNED' }, await as(accounts.admin.id)), 400],
    ];
    for (const [label, run, statusCode] of cases) await expect(run(), label).rejects.toMatchObject({ statusCode });

    // Directly, as the staff login, with correctly signed approvals.
    const direct = async (actor: string, memberId: string, status: string, updatedAt: Date) => {
      const c = { ...(await claimsFor(actor, memberId, 'SUSPENDED', updatedAt)), status } as StatusApprovalClaims;
      return call(c, signer.sign(c));
    };
    for (const [label, run, outcome] of [
      ['role as status', () => direct(accounts.admin.id, target.id, 'ADMIN', fresh), 'INVALID'],
      ['banned as status', () => direct(accounts.admin.id, target.id, 'BANNED', fresh), 'INVALID'],
      ['self', () => direct(target.id, target.id, 'SUSPENDED', fresh), 'SELF'],
      ['member as actor', () => direct(accounts.plainActor.id, target.id, 'SUSPENDED', fresh), 'ACTOR_FORBIDDEN'],
      ['suspended admin as actor', () => direct(accounts.suspendedAdmin.id, target.id, 'SUSPENDED', fresh), 'ACTOR_FORBIDDEN'],
      ['admin as target', () => direct(accounts.admin.id, accounts.adminTarget.id, 'SUSPENDED', fresh), 'NOT_MANAGEABLE'],
      ['stale version', () => direct(accounts.admin.id, target.id, 'SUSPENDED', new Date(fresh.getTime() - 1)), 'CONFLICT'],
    ] as const)
      expect(await run(), label).toBe(outcome);
    const shape = await claimsFor(accounts.admin.id, target.id, 'SUSPENDED', fresh);
    for (const [label, tamper] of [
      ['short reason', { reason: ' abc' }],
      ['malformed time', { expectedUpdatedAt: '2026-13-45T99:99:99.999Z' }],
      ['offset time', { expectedUpdatedAt: '2026-01-01T00:00:00.000+03:00' }],
    ] as const) {
      const c = { ...shape, ...tamper };
      expect(await call(c, signer.sign(c)), label).toBe('INVALID');
    }

    expect(await snapshot()).toEqual(stateBefore);
    expect(await auditCount()).toBe(auditBefore);
  });

  it('keeps users_privilege_guard and ordinary access unchanged', async () => {
    const target = await member('guard');
    await expect(
      staffDb.$transaction((tx) => tx.user.update({ where: { id: target.id }, data: { status: 'SUSPENDED' } }))
    ).rejects.toThrow(/permission denied/);
    // The runtime grants have no UPDATE on users.status: PostgreSQL refuses
    // before the guard; either layer must refuse.
    await expect(
      runtimeDb.user.update({ where: { id: target.id }, data: { status: 'SUSPENDED' } })
    ).rejects.toThrow(/permission denied|only the database owner/);
    // Pre-existing: today's direct (dormant) path cannot work under the
    // restricted runtime identity the deploy docs require. Unchanged here.
    await expect(
      setMemberAccountStatus(runtimeDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt))
    ).rejects.toThrow(/permission denied/);
    await expect(runtimeDb.user.create({ data: { username: `msb_admin3_${s}`, role: 'ADMIN' } })).rejects.toThrow(/only the database owner/);
    await expect(runtimeDb.user.create({ data: { username: `msb_reg_${s}` } })).resolves.toMatchObject({ role: 'USER', status: 'ACTIVE' });
    expect(await current(target.id)).toMatchObject({ status: 'ACTIVE' });
    expect(await canExecute(roles.runtime)).toBe(false);
  });

  it('lets exactly one of two concurrent suspensions win', async () => {
    const target = await member('race');
    const results = await Promise.allSettled(
      [1, 2].map(async () =>
        setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt), await approved(accounts.admin.id))
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } });
    expect(await owner.auditLog.count({ where: { entityId: target.id, action: 'ADMIN_MEMBER_SUSPENDED' } })).toBe(1);
  });

  it('drains a member end to end over HTTP with a configured key, and returns 503 without one', async () => {
    const STAFF_KEYS = ['STAFF_DATABASE_ISOLATION', 'STAFF_DATABASE_URL', 'STAFF_DATABASE_ROLE', 'STAFF_STATUS_APPROVAL_KEY_ID', 'STAFF_STATUS_APPROVAL_KEY'] as const;
    async function serverWith(env: Partial<Record<(typeof STAFF_KEYS)[number], string>>) {
      const saved = Object.fromEntries(STAFF_KEYS.map((k) => [k, process.env[k]]));
      for (const key of STAFF_KEYS) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
      }
      try {
        const server = await buildServer();
        await server.ready();
        servers.push(server);
        return server;
      } finally {
        for (const key of STAFF_KEYS) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    }
    const isolation = { STAFF_DATABASE_ISOLATION: 'enforce', STAFF_DATABASE_URL: urlFor('staff'), STAFF_DATABASE_ROLE: roles.staff };
    const server = await serverWith({ ...isolation, STAFF_STATUS_APPROVAL_KEY_ID: KEY_ID, STAFF_STATUS_APPROVAL_KEY: KEY_HEX });
    const unsigned = await serverWith(isolation);
    const api = config.API_PREFIX;
    const password = 'Synthetic-Member-1!';
    const target = await member('http', password);
    const login = () => server.inject({ method: 'POST', url: `${api}/auth/login`, payload: { email: target.email, password } });
    const adminNow = await current(accounts.admin.id);
    const admin = { authorization: `Bearer ${generateTokens(adminNow.id, adminNow.email, adminNow.username, ['ADMIN'], adminNow.tokenVersion).accessToken}` };
    const setStatus = async (on: typeof server, status: 'ACTIVE' | 'SUSPENDED') =>
      on.inject({
        method: 'POST',
        url: `${api}/workspaces/admin/accounts/${target.id}/status`,
        headers: admin,
        payload: change(status, (await current(target.id)).updatedAt),
      });

    const signedIn = await login();
    expect(signedIn.statusCode).toBe(200);
    const { accessToken, refreshToken } = signedIn.json().data;
    expect((await setStatus(unsigned, 'SUSPENDED')).statusCode).toBe(503);
    expect(await current(target.id)).toMatchObject({ status: 'ACTIVE' });

    const suspend = await setStatus(server, 'SUSPENDED');
    expect(suspend.statusCode, suspend.body).toBe(200);
    expect((await server.inject({ method: 'POST', url: `${api}/auth/refresh`, payload: { refreshToken } })).statusCode).toBe(401);
    expect((await server.inject({ url: `${api}/auth/me`, headers: { authorization: `Bearer ${accessToken}` } })).statusCode).toBe(403);
    expect((await login()).statusCode).toBe(403);
    expect((await setStatus(server, 'ACTIVE')).statusCode).toBe(200);
    expect((await login()).statusCode).toBe(200);
  });

  it('fails closed without the grant or the boundary, recovers, and leaves the dormant path untouched', async () => {
    const target = await member('recovery');
    await exec(`REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM "${roles.staff}"`);
    await expect(
      setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt), await approved(accounts.admin.id))
    ).rejects.toMatchObject({ statusCode: 503 });
    await exec(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO "${roles.staff}"`);

    await exec(UNINSTALL);
    await expect(
      setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt), await approved(accounts.admin.id))
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(await current(target.id)).toMatchObject({ status: 'ACTIVE' });
    // No signer: isolated changes stay closed even with the boundary installed.
    await expect(
      setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt), await approved(accounts.admin.id, null))
    ).rejects.toMatchObject({ statusCode: 503 });
    // Dormant mode never depends on the boundary or a key.
    const dormant = await setMemberAccountStatus(credentialDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt));
    expect(dormant.status).toBe('SUSPENDED');

    // Reinstall: dropping removed the grant; the key and evidence survived.
    await exec(INSTALL);
    expect(await canExecute(roles.staff)).toBe(false);
    await exec(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO "${roles.staff}"`);
    const restored = await setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('ACTIVE', dormant.updatedAt), await approved(accounts.admin.id));
    expect(restored.status).toBe('ACTIVE');
  });
});
