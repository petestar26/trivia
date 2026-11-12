import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma as owner, PrismaClient } from '@socialplay/database';
import { config } from '@socialplay/config';
import { generateTokens, hashPassword } from '../utils/auth.js';
import { DatabaseIdentityError, GuardedDatabase, type GuardableClient } from './identity.js';
import { resolveStaffDatabase, type StaffDatabase } from './staff-database.js';
import {
  activateAdminAgent,
  createAdminAgent,
  listPendingAgentAccounts,
} from '../agents/admin-account-service.js';
import { setMemberAccountStatus } from '../workspaces/member-status.js';
import { buildServer } from '../server.js';

/**
 * Staff database identity on real PostgreSQL. Disposable local database only:
 * every role, database and account here is synthetic and removed afterwards.
 */
const base = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(base.hostname) ||
  base.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw new Error('Disposable local database required');

const s = randomUUID().replaceAll('-', '').slice(0, 10);
const role = (name: string) => `sid_${name}_${s}`;
const roles = {
  runtime: role('runtime'),
  staff: role('staff'),
  other: role('other'),
  switcher: role('switcher'),
  createrole: role('createrole'),
  bypass: role('bypass'),
  datawide: role('datawide'),
  superreach: role('superreach'),
  dbowner: role('dbowner'),
};
const ownedDatabase = `sid_owned_${s}`;
const passwords = Object.fromEntries(Object.keys(roles).map((k) => [k, randomUUID()])) as Record<
  keyof typeof roles,
  string
>;
const clients: GuardableClient[] = [];
const servers: { close(): Promise<unknown> }[] = [];

function urlFor(key: keyof typeof roles, extra: { database?: string; params?: string } = {}) {
  const url = new URL(base);
  url.username = roles[key];
  url.password = passwords[key];
  if (extra.database) url.pathname = `/${extra.database}`;
  url.search = extra.params ?? '';
  return url.toString();
}
function clientFor(url: string) {
  const client = new PrismaClient({ datasourceUrl: url, log: [] });
  clients.push(client);
  return client;
}
const exec = (sql: string) => owner.$executeRawUnsafe(sql);

let ownerRole: string;
let hasDataWideRole = false;
let runtimeDb: PrismaClient;
let staffDb: StaffDatabase;
let countryId: string;
let admin: { id: string; email: string | null; username: string; tokenVersion: number };

function enforceEnv(change: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: urlFor('runtime'),
    STAFF_DATABASE_ISOLATION: 'enforce',
    STAFF_DATABASE_URL: urlFor('staff'),
    STAFF_DATABASE_ROLE: roles.staff,
    ...change,
  };
}
function agentInput(tag: string) {
  return {
    username: `sid_${tag}_${s}`.slice(0, 30),
    email: `${tag}_${s}@fixture.invalid`,
    displayName: 'Synthetic Agent',
    temporaryPassword: 'Synthetic-Temp-1!',
    countryId,
  };
}

beforeAll(async () => {
  [{ current: ownerRole }] = await owner.$queryRaw<{ current: string }[]>`SELECT current_user::text AS current`;
  [{ exists: hasDataWideRole }] = await owner.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pg_write_all_data') AS exists`;
  const login = (key: keyof typeof roles, attrs = '') =>
    exec(
      `CREATE ROLE "${roles[key]}" LOGIN PASSWORD '${passwords[key]}' NOSUPERUSER NOCREATEDB NOREPLICATION ${attrs}`
    );

  // Runtime: the production grant path, unchanged by this work.
  await login('runtime', 'NOCREATEROLE');
  await exec('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${roles.runtime})`;

  // Staff: only what provisioning needs. UPDATE on users.status is granted on
  // purpose so the owner-only users_privilege_guard, not a missing grant, is
  // what refuses status changes below.
  await login('staff', 'NOCREATEROLE NOINHERIT');
  for (const sql of [
    `GRANT USAGE ON SCHEMA public TO "${roles.staff}"`,
    `GRANT SELECT, INSERT ON public.users, public.user_auth_identities, public.agents, public.agent_applications, public.agent_account_setups, public.audit_logs TO "${roles.staff}"`,
    `GRANT SELECT ON public.countries, public.sessions TO "${roles.staff}"`,
    `GRANT UPDATE ("updatedAt", "status") ON public.users TO "${roles.staff}"`,
    `GRANT UPDATE ("updatedAt") ON public.countries TO "${roles.staff}"`,
    `GRANT UPDATE ON public.agent_account_setups TO "${roles.staff}"`,
    `GRANT DELETE ON public.sessions TO "${roles.staff}"`,
  ])
    await exec(sql);

  // Incorrect identities.
  await login('other', 'NOCREATEROLE');
  await login('switcher', 'NOCREATEROLE');
  await exec(`GRANT "${roles.other}" TO "${roles.switcher}"`);
  await login('createrole', 'CREATEROLE');
  await login('bypass', 'NOCREATEROLE BYPASSRLS');
  await login('datawide', 'NOCREATEROLE');
  if (hasDataWideRole) await exec(`GRANT pg_write_all_data TO "${roles.datawide}"`);
  await login('superreach', 'NOCREATEROLE');
  await exec(`GRANT "${ownerRole}" TO "${roles.superreach}"`);
  await login('dbowner', 'NOCREATEROLE');
  await exec(`CREATE DATABASE "${ownedDatabase}" OWNER "${roles.dbowner}"`);

  runtimeDb = clientFor(urlFor('runtime'));
  staffDb = resolveStaffDatabase(enforceEnv(), { legacy: owner });
  clients.push(staffDb);

  countryId = (
    await owner.country.create({
      data: { code: s.slice(0, 8).toUpperCase(), name: 'Synthetic', currencyCode: 'ETB', isActive: true },
    })
  ).id;
  admin = await owner.user.create({
    data: { username: `sid_admin_${s}`, email: `admin_${s}@fixture.invalid`, role: 'ADMIN' },
  });
});

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => undefined);
  for (const client of clients) await client.$disconnect().catch(() => undefined);
  await exec(`DROP DATABASE IF EXISTS "${ownedDatabase}" WITH (FORCE)`).catch(() => undefined);
  for (const name of Object.values(roles)) {
    await exec(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${name}'`
    ).catch(() => undefined);
    await exec(`DROP OWNED BY "${name}"`).catch(() => undefined);
    await exec(`DROP ROLE IF EXISTS "${name}"`).catch(() => undefined);
  }
  await owner.$disconnect();
});

describe('identity guard on PostgreSQL', () => {
  it('accepts the configured staff identity and runs work as that role', async () => {
    expect(staffDb.mode).toBe('isolated');
    await expect(staffDb.verify()).resolves.toEqual({ role: roles.staff });
    const [row] = await staffDb.$transaction(
      (tx) => tx.$queryRaw<{ current: string; session: string }[]>`
        SELECT current_user::text AS current, session_user::text AS session`
    );
    expect(row).toEqual({ current: roles.staff, session: roles.staff });
  });

  it('refuses every incorrect identity before any work runs', async () => {
    const marker = `sid_marker_${s}`;
    const cases: Array<[string, string, string, string]> = [
      ['runtime role as staff', urlFor('runtime'), roles.staff, 'SHARED_IDENTITY'],
      ['unrelated role', urlFor('other'), roles.staff, 'ROLE_MISMATCH'],
      ['superuser owner', base.toString(), ownerRole, 'ELEVATED'],
      ['CREATEROLE', urlFor('createrole'), roles.createrole, 'ELEVATED'],
      ['BYPASSRLS', urlFor('bypass'), roles.bypass, 'ELEVATED'],
      ['can SET ROLE to a superuser', urlFor('superreach'), roles.superreach, 'ELEVATED'],
      ['database owner', urlFor('dbowner', { database: ownedDatabase }), roles.dbowner, 'OWNER'],
    ];
    if (hasDataWideRole)
      cases.push(['pg_write_all_data member', urlFor('datawide'), roles.datawide, 'ELEVATED']);
    for (const [label, url, expected, reason] of cases) {
      const guarded = GuardedDatabase.bind('Staff', clientFor(url), {
        role: expected,
        distinctFrom: [roles.runtime],
      });
      const work = vi.fn(async (tx: any) =>
        tx.auditLog.create({ data: { action: marker, entity: 'Synthetic', entityId: label } })
      );
      const error = await guarded.$transaction(work).catch((e) => e);
      expect(error, label).toBeInstanceOf(DatabaseIdentityError);
      expect(error.reason, label).toBe(reason);
      expect(work, label).not.toHaveBeenCalled();
    }
    expect(await owner.auditLog.count({ where: { action: marker } })).toBe(0);
  });

  it('refuses a role elevated after construction and accepts the repair without a restart', async () => {
    await expect(staffDb.verify()).resolves.toBeTruthy();
    await exec(`ALTER ROLE "${roles.staff}" CREATEROLE`);
    try {
      await expect(staffDb.verify()).rejects.toMatchObject({ reason: 'ELEVATED' });
    } finally {
      await exec(`ALTER ROLE "${roles.staff}" NOCREATEROLE`);
    }
    await expect(staffDb.verify()).resolves.toEqual({ role: roles.staff });
  });

  it('refuses a pooled connection left switched to another role', async () => {
    const client = clientFor(urlFor('switcher', { params: '?connection_limit=1' }));
    const guarded = GuardedDatabase.bind('Staff', client, { role: roles.switcher, distinctFrom: [] });
    await expect(guarded.verify()).resolves.toBeTruthy();
    await client.$executeRawUnsafe(`SET ROLE "${roles.other}"`);
    await expect(guarded.verify()).rejects.toMatchObject({ reason: 'ROLE_SWITCHED' });
    await client.$executeRawUnsafe('RESET ROLE');
    await expect(guarded.verify()).resolves.toBeTruthy();
  });

  it('reports a failed staff login as UNVERIFIED without exposing it', async () => {
    const wrong = new URL(urlFor('staff'));
    wrong.password = 'not-the-password';
    const guarded = resolveStaffDatabase(enforceEnv({ STAFF_DATABASE_URL: wrong.toString() }), {
      legacy: owner,
    });
    clients.push(guarded);
    const error = await guarded.verify().catch((e) => e);
    expect(error).toMatchObject({ name: 'DatabaseIdentityError', reason: 'UNVERIFIED' });
    expect(error.message).not.toContain(roles.staff);
    expect(error.message).not.toContain('not-the-password');
  });
});

describe('isolation across consumers', () => {
  it('provisions through the staff identity while agents and members use the runtime identity', async () => {
    const input = agentInput('iso');
    const created = await createAdminAgent(staffDb, admin.id, input);
    expect(created).toMatchObject({ status: 'ACTIVATION_REQUIRED' });

    // Negative control: without its own grant the staff identity cannot
    // provision, and nothing is left behind. Writes really go through it.
    await exec(`REVOKE INSERT ON public.agent_account_setups FROM "${roles.staff}"`);
    try {
      const blocked = agentInput('blocked');
      await expect(createAdminAgent(staffDb, admin.id, blocked)).rejects.toMatchObject({ statusCode: 500 });
      expect(await owner.user.count({ where: { username: blocked.username } })).toBe(0);
    } finally {
      await exec(`GRANT INSERT ON public.agent_account_setups TO "${roles.staff}"`);
    }

    // The agent activates through the ordinary runtime identity.
    await activateAdminAgent(runtimeDb, {
      email: input.email,
      temporaryPassword: input.temporaryPassword,
      newPassword: 'Synthetic-Private-1!',
    });
    expect(await owner.user.findUniqueOrThrow({ where: { id: created!.userId } })).toMatchObject({
      status: 'ACTIVE',
      role: 'USER',
    });

    // Concurrent consumers each keep their own identity.
    const whoami = (db: { $transaction: StaffDatabase['$transaction'] }) =>
      db.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ current: string }[]>`SELECT current_user::text AS current`;
        return row.current;
      });
    const [staffRole, runtimeRole, pending] = await Promise.all([
      whoami(staffDb),
      whoami(runtimeDb),
      listPendingAgentAccounts(staffDb, admin.id),
    ]);
    expect([staffRole, runtimeRole]).toEqual([roles.staff, roles.runtime]);
    expect(Array.isArray(pending)).toBe(true);
  });

  it('keeps ordinary-user protections: no status change or privileged user through any non-owner identity', async () => {
    const member = await owner.user.create({
      data: { username: `sid_member_${s}`, email: `member_${s}@fixture.invalid` },
    });
    await owner.session.create({
      data: { userId: member.id, refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
    });
    await expect(
      setMemberAccountStatus(staffDb, admin.id, member.id, {
        status: 'SUSPENDED',
        reason: 'synthetic review',
        expectedUpdatedAt: member.updatedAt.toISOString(),
      })
    ).rejects.toThrow(/only the database owner/);
    expect(await owner.user.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ status: 'ACTIVE' });
    expect(await owner.session.count({ where: { userId: member.id } })).toBe(1);
    expect(
      await owner.auditLog.count({ where: { entityId: member.id, action: 'ADMIN_MEMBER_SUSPENDED' } })
    ).toBe(0);

    await expect(
      staffDb.$transaction((tx) => tx.user.create({ data: { username: `sid_x_${s}`, role: 'ADMIN' } }))
    ).rejects.toThrow(/only the database owner/);
    await expect(
      runtimeDb.user.create({ data: { username: `sid_y_${s}`, role: 'ADMIN' } })
    ).rejects.toThrow(/only the database owner/);
    // Ordinary registration through the runtime identity is unchanged.
    await expect(runtimeDb.user.create({ data: { username: `sid_z_${s}` } })).resolves.toMatchObject({
      role: 'USER',
    });
  });
});

describe('HTTP fail-closed behaviour, recovery and rollback', () => {
  const STAFF_KEYS = ['STAFF_DATABASE_ISOLATION', 'STAFF_DATABASE_URL', 'STAFF_DATABASE_ROLE'] as const;
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
  const api = config.API_PREFIX;
  const adminHeaders = () => ({
    authorization: `Bearer ${generateTokens(admin.id, admin.email, admin.username, ['ADMIN'], admin.tokenVersion).accessToken}`,
  });
  const memberPassword = 'Synthetic-Member-1!';
  let memberEmail: string;
  beforeAll(async () => {
    memberEmail = `login_${s}@fixture.invalid`;
    await owner.user.create({
      data: { username: `sid_login_${s}`, email: memberEmail, passwordHash: await hashPassword(memberPassword) },
    });
  });
  const createAgent = (server: Awaited<ReturnType<typeof buildServer>>, tag: string) =>
    server.inject({ method: 'POST', url: `${api}/agents/admin/accounts`, headers: adminHeaders(), payload: agentInput(tag) });
  const memberLogin = (server: Awaited<ReturnType<typeof buildServer>>) =>
    server.inject({ method: 'POST', url: `${api}/auth/login`, payload: { email: memberEmail, password: memberPassword } });

  it('returns 503 for staff routes when enforcement is misconfigured, while members still sign in', async () => {
    for (const env of [
      { STAFF_DATABASE_ISOLATION: 'enforce' },
      { STAFF_DATABASE_ISOLATION: 'enforce', STAFF_DATABASE_URL: base.toString(), STAFF_DATABASE_ROLE: ownerRole },
      { STAFF_DATABASE_ISOLATION: 'Enforce' },
    ]) {
      const server = await serverWith(env);
      const response = await createAgent(server, `closed${Math.random().toString(36).slice(2, 6)}`);
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('SERVICE_UNAVAILABLE');
      expect(response.body).not.toMatch(/sid_|postgres|NOT_CONFIGURED|SHARED_IDENTITY/);
      expect(
        (await server.inject({ url: `${api}/agents/admin/accounts/pending`, headers: adminHeaders() })).statusCode
      ).toBe(503);
      expect((await memberLogin(server)).statusCode).toBe(200);
    }
  });

  it('rehearses activation, identity drift, outage, repair and rollback to dormant', async () => {
    const active = { STAFF_DATABASE_ISOLATION: 'enforce', STAFF_DATABASE_URL: urlFor('staff'), STAFF_DATABASE_ROLE: roles.staff };
    const server = await serverWith(active);
    expect((await createAgent(server, 'act')).statusCode).toBe(201);

    // Drift: the staff role gains CREATEROLE. Refused at once; members unaffected.
    await exec(`ALTER ROLE "${roles.staff}" CREATEROLE`);
    try {
      expect((await createAgent(server, 'drift')).statusCode).toBe(503);
      expect((await memberLogin(server)).statusCode).toBe(200);
    } finally {
      await exec(`ALTER ROLE "${roles.staff}" NOCREATEROLE`);
    }
    expect((await createAgent(server, 'fixed')).statusCode).toBe(201);

    // Outage: the staff login is disabled and its sessions end.
    await exec(`ALTER ROLE "${roles.staff}" NOLOGIN`);
    await exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${roles.staff}'`);
    try {
      expect((await createAgent(server, 'down')).statusCode).toBe(503);
      expect((await memberLogin(server)).statusCode).toBe(200);
      expect(await owner.user.count({ where: { username: agentInput('down').username } })).toBe(0);
    } finally {
      await exec(`ALTER ROLE "${roles.staff}" LOGIN`);
    }
    // Repair without a restart: the pool reconnects on a following request.
    let recovered = 0;
    for (let attempt = 0; attempt < 3 && !recovered; attempt++)
      if ((await createAgent(server, `back${attempt}`)).statusCode === 201) recovered = attempt + 1;
    expect(recovered).toBeGreaterThan(0);

    // Rollback: unset enforcement and the dormant path provisions as before,
    // even with the staff role unusable.
    await exec(`ALTER ROLE "${roles.staff}" NOLOGIN`);
    try {
      const dormant = await serverWith({});
      expect((await createAgent(dormant, 'dormant')).statusCode).toBe(201);
    } finally {
      await exec(`ALTER ROLE "${roles.staff}" LOGIN`);
    }
  });
});
