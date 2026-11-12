import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma as owner, PrismaClient } from '@socialplay/database';
import { config } from '@socialplay/config';
import { generateTokens, hashPassword } from '../utils/auth.js';
import { GuardedDatabase } from './identity.js';
import { setMemberAccountStatus } from '../workspaces/member-status.js';
import { credentialDb } from '../agents/credential-database.js';
import { buildServer } from '../server.js';

/**
 * Narrow member-status boundary on real PostgreSQL. Disposable local database,
 * synthetic roles and accounts only; everything is removed afterwards.
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
const SIGNATURE = 'public.staff_set_member_status(text,text,text,text,text)';
const UNINSTALL = `DROP FUNCTION IF EXISTS ${SIGNATURE}`;
const s = randomUUID().replaceAll('-', '').slice(0, 10);
const roles = { runtime: `msb_runtime_${s}`, staff: `msb_staff_${s}` };
const passwords = { runtime: randomUUID(), staff: randomUUID() };
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

/** Every privilege held by anyone but the users owner, in schema public. */
async function nonOwnerPrivileges(): Promise<string[]> {
  const rows = await owner.$queryRaw<{ entry: string }[]>`
    WITH acl AS (
      SELECT 'relation ' || c.oid::regclass::text AS obj, (pg_catalog.aclexplode(c.relacl)).*
      FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relacl IS NOT NULL
      UNION ALL
      SELECT 'column ' || c.oid::regclass::text || '.' || a.attname, (pg_catalog.aclexplode(a.attacl)).*
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL
      UNION ALL
      SELECT 'function ' || p.oid::regprocedure::text,
             (pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner)))).*
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'schema public', (pg_catalog.aclexplode(n.nspacl)).*
      FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public')
    SELECT obj || ' ' || CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(grantee) END
           || ' ' || privilege_type AS entry
    FROM acl
    WHERE grantee <> (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.users'::regclass)
    ORDER BY 1`;
  return rows.map((r) => r.entry);
}
const canExecute = async (grantee: string) => {
  const [row] = await owner.$queryRaw<{ allowed: boolean }[]>`
    SELECT pg_catalog.has_function_privilege(${grantee}, ${SIGNATURE}, 'EXECUTE') AS allowed`;
  return row.allowed;
};

let staffDb: GuardedDatabase;
let runtimeDb: PrismaClient;
let before: string[];
let guardBefore: string;
/** users_privilege_guard's definition and trigger state, to prove installation leaves it alone. */
async function guardState(): Promise<string> {
  const [row] = await owner.$queryRaw<{ state: string }[]>`
    SELECT pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) || ':' ||
           pg_catalog.string_agg(t.tgname::text || '=' || t.tgenabled::text, ',' ORDER BY t.tgname) AS state
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.users'::regclass AND p.proname = 'users_privilege_guard'
    GROUP BY p.oid`;
  return row.state;
}
const accounts = {} as Record<
  'admin' | 'suspendedAdmin' | 'plainActor' | 'adminTarget' | 'pending' | 'banned',
  { id: string; email: string | null; username: string; tokenVersion: number }
>;
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
const current = (id: string) => owner.user.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  await exec(UNINSTALL);
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
  staffDb = GuardedDatabase.bind('Staff', clientFor('staff'), {
    role: roles.staff,
    distinctFrom: [roles.runtime],
  });
  const make = (tag: string, role: 'USER' | 'ADMIN', status = 'ACTIVE') =>
    owner.user.create({
      data: { username: `msb_${tag}_${s}`.slice(0, 30), email: `${tag}_${s}@fixture.invalid`, role, status: status as never },
    });
  accounts.admin = await make('admin', 'ADMIN');
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
    // Re-applying the production runtime grants does not reach the boundary.
    await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${roles.runtime})`;
    expect(await nonOwnerPrivileges()).toEqual(before);
    for (const grantee of ['public', roles.runtime, roles.staff]) expect(await canExecute(grantee)).toBe(false);
    await expect(
      runtimeDb.$queryRawUnsafe(`SELECT * FROM ${SIGNATURE.replace('(text,text,text,text,text)', '')}('a','b','ACTIVE','2026-01-01T00:00:00.000Z','synthetic')`)
    ).rejects.toThrow(/permission denied/);
    // Reinstalling is idempotent and still grants nothing.
    await exec(INSTALL);
    expect(await nonOwnerPrivileges()).toEqual(before);
    expect(await guardState()).toBe(guardBefore);
  });
});

describe('boundary under an isolated staff identity', () => {
  beforeAll(async () => {
    // Activation step simulated in the throwaway database only.
    await exec(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO "${roles.staff}"`);
  });

  it('suspends and reactivates a member with no direct status privilege, draining refresh sessions', async () => {
    const [direct] = await owner.$queryRaw<{ allowed: boolean }[]>`
      SELECT pg_catalog.has_column_privilege(${roles.staff}, 'public.users', 'status', 'UPDATE') AS allowed`;
    expect(direct.allowed).toBe(false);
    const target = await member('lifecycle');
    await owner.session.create({ data: { userId: target.id, refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });

    const suspended = await setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt));
    expect(suspended).toMatchObject({ userId: target.id, status: 'SUSPENDED' });
    const afterSuspend = await current(target.id);
    expect(afterSuspend).toMatchObject({ status: 'SUSPENDED', role: 'USER', tokenVersion: target.tokenVersion });
    expect(afterSuspend.updatedAt.toISOString()).toBe(suspended.updatedAt);
    expect(await owner.session.count({ where: { userId: target.id } })).toBe(0);
    const audit = await owner.auditLog.findFirstOrThrow({ where: { entityId: target.id, action: 'ADMIN_MEMBER_SUSPENDED' } });
    expect(audit).toMatchObject({
      userId: accounts.admin.id,
      entity: 'User',
      oldData: { status: 'ACTIVE' },
      newData: { status: 'SUSPENDED', reason: 'synthetic review', refreshSessionsRevoked: true, boundary: 'staff_set_member_status', databaseLogin: roles.staff },
    });

    const reactivated = await setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('ACTIVE', suspended.updatedAt));
    expect(reactivated.status).toBe('ACTIVE');
    expect(await current(target.id)).toMatchObject({ status: 'ACTIVE', role: 'USER' });
    expect(await owner.auditLog.count({ where: { entityId: target.id, action: 'ADMIN_MEMBER_REACTIVATED' } })).toBe(1);
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
    const cases: Array<[string, () => Promise<unknown>, number]> = [
      ['non-admin actor', () => setMemberAccountStatus(staffDb, accounts.plainActor.id, target.id, change('SUSPENDED', fresh)), 403],
      ['suspended admin', () => setMemberAccountStatus(staffDb, accounts.suspendedAdmin.id, target.id, change('SUSPENDED', fresh)), 403],
      ['unknown actor', () => setMemberAccountStatus(staffDb, randomUUID(), target.id, change('SUSPENDED', fresh)), 401],
      ['self', () => setMemberAccountStatus(staffDb, accounts.admin.id, accounts.admin.id, change('SUSPENDED', fresh)), 403],
      ['admin target', () => setMemberAccountStatus(staffDb, accounts.admin.id, accounts.adminTarget.id, change('SUSPENDED', fresh)), 403],
      ['pending target', () => setMemberAccountStatus(staffDb, accounts.admin.id, accounts.pending.id, change('ACTIVE', fresh)), 403],
      ['banned target', () => setMemberAccountStatus(staffDb, accounts.admin.id, accounts.banned.id, change('ACTIVE', fresh)), 403],
      ['unknown member', () => setMemberAccountStatus(staffDb, accounts.admin.id, randomUUID(), change('SUSPENDED', fresh)), 404],
      ['stale version', () => setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('SUSPENDED', new Date(fresh.getTime() - 1))), 409],
      ['same status', () => setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('ACTIVE', fresh)), 409],
      ['role in input', () => setMemberAccountStatus(staffDb, accounts.admin.id, target.id, { ...change('SUSPENDED', fresh), role: 'ADMIN' }), 400],
      ['other status', () => setMemberAccountStatus(staffDb, accounts.admin.id, target.id, { ...change('SUSPENDED', fresh), status: 'BANNED' }), 400],
    ];
    for (const [label, run, statusCode] of cases)
      await expect(run(), label).rejects.toMatchObject({ statusCode });

    // The function itself, called directly by the staff login, rejects malformed input.
    const call = (...args: (string | null)[]) =>
      staffDb.$transaction((tx) => tx.$queryRawUnsafe<{ outcome: string }[]>(
        'SELECT outcome FROM public.staff_set_member_status($1, $2, $3, $4, $5)', ...args));
    const iso = fresh.toISOString();
    for (const [label, args, outcome] of [
      ['role as status', [accounts.admin.id, target.id, 'ADMIN', iso, 'synthetic review'], 'INVALID'],
      ['banned as status', [accounts.admin.id, target.id, 'BANNED', iso, 'synthetic review'], 'INVALID'],
      ['short reason', [accounts.admin.id, target.id, 'SUSPENDED', iso, ' abc '], 'INVALID'],
      ['malformed time', [accounts.admin.id, target.id, 'SUSPENDED', '2026-13-45T99:99:99.999Z', 'synthetic review'], 'INVALID'],
      ['offset time', [accounts.admin.id, target.id, 'SUSPENDED', '2026-01-01T00:00:00.000+03:00', 'synthetic review'], 'INVALID'],
      ['null actor', [null, target.id, 'SUSPENDED', iso, 'synthetic review'], 'INVALID'],
      ['self', [target.id, target.id, 'SUSPENDED', iso, 'synthetic review'], 'SELF'],
      ['member as actor', [accounts.plainActor.id, target.id, 'SUSPENDED', iso, 'synthetic review'], 'ACTOR_FORBIDDEN'],
      ['suspended admin as actor', [accounts.suspendedAdmin.id, target.id, 'SUSPENDED', iso, 'synthetic review'], 'ACTOR_FORBIDDEN'],
      ['admin as target', [accounts.admin.id, accounts.adminTarget.id, 'SUSPENDED', iso, 'synthetic review'], 'NOT_MANAGEABLE'],
      ['stale version', [accounts.admin.id, target.id, 'SUSPENDED', new Date(fresh.getTime() - 1).toISOString(), 'synthetic review'], 'CONFLICT'],
    ] as const)
      expect((await call(...args))[0]?.outcome, label).toBe(outcome);

    expect(await snapshot()).toEqual(stateBefore);
    expect(await auditCount()).toBe(auditBefore);
  });

  it('keeps users_privilege_guard and ordinary access unchanged', async () => {
    const target = await member('guard');
    await expect(
      staffDb.$transaction((tx) => tx.user.update({ where: { id: target.id }, data: { status: 'SUSPENDED' } }))
    ).rejects.toThrow(/permission denied/);
    // The runtime grants have no UPDATE on users.status at all, so PostgreSQL
    // refuses before the guard trigger; either layer must refuse.
    await expect(
      runtimeDb.user.update({ where: { id: target.id }, data: { status: 'SUSPENDED' } })
    ).rejects.toThrow(/permission denied|only the database owner/);
    // Pre-existing: today's direct (dormant) path cannot work under the
    // restricted runtime identity the deploy docs require. Unchanged here.
    await expect(
      setMemberAccountStatus(runtimeDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt))
    ).rejects.toThrow(/permission denied/);
    await expect(runtimeDb.user.create({ data: { username: `msb_admin2_${s}`, role: 'ADMIN' } })).rejects.toThrow(/only the database owner/);
    await expect(runtimeDb.user.create({ data: { username: `msb_reg_${s}` } })).resolves.toMatchObject({ role: 'USER', status: 'ACTIVE' });
    expect(await current(target.id)).toMatchObject({ status: 'ACTIVE' });
    expect(await canExecute(roles.runtime)).toBe(false);
  });

  it('lets exactly one of two concurrent suspensions win', async () => {
    const target = await member('race');
    const results = await Promise.allSettled(
      [1, 2].map(() => setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt)))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } });
    expect(await owner.auditLog.count({ where: { entityId: target.id, action: 'ADMIN_MEMBER_SUSPENDED' } })).toBe(1);
  });

  it('drains a member end to end over HTTP and restores sign-in on reactivation', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { STAFF_DATABASE_ISOLATION: 'enforce', STAFF_DATABASE_URL: urlFor('staff'), STAFF_DATABASE_ROLE: roles.staff });
    let server: Awaited<ReturnType<typeof buildServer>>;
    try {
      server = await buildServer();
      await server.ready();
      servers.push(server);
    } finally {
      for (const key of ['STAFF_DATABASE_ISOLATION', 'STAFF_DATABASE_URL', 'STAFF_DATABASE_ROLE'])
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
    const api = config.API_PREFIX;
    const password = 'Synthetic-Member-1!';
    const target = await member('http', password);
    const login = () => server.inject({ method: 'POST', url: `${api}/auth/login`, payload: { email: target.email, password } });
    const admin = { authorization: `Bearer ${generateTokens(accounts.admin.id, accounts.admin.email, accounts.admin.username, ['ADMIN'], accounts.admin.tokenVersion).accessToken}` };
    const setStatus = async (status: 'ACTIVE' | 'SUSPENDED') =>
      server.inject({
        method: 'POST',
        url: `${api}/workspaces/admin/accounts/${target.id}/status`,
        headers: admin,
        payload: change(status, (await current(target.id)).updatedAt),
      });

    const signedIn = await login();
    expect(signedIn.statusCode).toBe(200);
    const { accessToken, refreshToken } = signedIn.json().data;

    const suspend = await setStatus('SUSPENDED');
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json().data.status).toBe('SUSPENDED');
    expect((await server.inject({ method: 'POST', url: `${api}/auth/refresh`, payload: { refreshToken } })).statusCode).toBe(401);
    expect((await server.inject({ url: `${api}/auth/me`, headers: { authorization: `Bearer ${accessToken}` } })).statusCode).toBe(403);
    expect((await login()).statusCode).toBe(403);

    expect((await setStatus('ACTIVE')).statusCode).toBe(200);
    expect((await login()).statusCode).toBe(200);
  });

  it('fails closed without the grant or the boundary, recovers, and leaves the dormant path untouched', async () => {
    const target = await member('recovery');
    await exec(`REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM "${roles.staff}"`);
    await expect(
      setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt))
    ).rejects.toMatchObject({ statusCode: 503 });
    await exec(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO "${roles.staff}"`);

    await exec(UNINSTALL);
    await expect(
      setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt))
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(await current(target.id)).toMatchObject({ status: 'ACTIVE' });
    // Dormant mode never depends on the boundary.
    const dormant = await setMemberAccountStatus(credentialDb, accounts.admin.id, target.id, change('SUSPENDED', target.updatedAt));
    expect(dormant.status).toBe('SUSPENDED');

    // Reinstall: dropping removed the grant, so EXECUTE must be granted again explicitly.
    await exec(INSTALL);
    expect(await canExecute(roles.staff)).toBe(false);
    await exec(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO "${roles.staff}"`);
    const restored = await setMemberAccountStatus(staffDb, accounts.admin.id, target.id, change('ACTIVE', dormant.updatedAt));
    expect(restored.status).toBe('ACTIVE');
  });
});
