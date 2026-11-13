import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { prisma as owner, PrismaClient } from '@socialplay/database';
import { config } from '@socialplay/config';
import { credentialDb } from '../agents/credential-database.js';
import { completePasswordReset, issueOwnerReset, resetIssuanceMode } from './password-reset.js';
import { hashPassword, verifyPassword } from '../utils/auth.js';
import { authRoutes } from '../routes/auth.js';
import { errorHandler } from '../middleware/error-handler.js';

/**
 * Owner issuance records for password resets (dormant;
 * docs/deployment/owner-password-reset-issuance.sql). Disposable local
 * database, synthetic roles and accounts only; all removed afterwards.
 */
const base = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(base.hostname) ||
  base.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw new Error('Disposable local database required');

const INSTALL = readFileSync(
  new URL('../../../../docs/deployment/owner-password-reset-issuance.sql', import.meta.url),
  'utf8'
);
const CONSUME = 'public.owner_password_reset_consume(text,text,integer)';
const PURGE = [
  `DROP FUNCTION IF EXISTS ${CONSUME}`,
  'DROP SCHEMA IF EXISTS owner_password_reset, owner_password_reset_moved CASCADE',
];
const s = randomUUID().replaceAll('-', '').slice(0, 10);
const roles = { runtime: `opr_runtime_${s}`, credential: `opr_cred_${s}` };
const passwords = { runtime: randomUUID(), credential: randomUUID() };
const oldPassword = 'Test-Old-Issuance-43!';
const newPassword = 'Test-New-Issuance-72!';
const exec = (sql: string) => owner.$executeRawUnsafe(sql);
const clients: PrismaClient[] = [];
const apps: { close(): Promise<unknown> }[] = [];

function clientFor(key: keyof typeof roles) {
  const url = new URL(base);
  url.username = roles[key];
  url.password = passwords[key];
  const client = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
  clients.push(client);
  return client;
}

/** Every privilege held by anyone but the users owner, in public and the private schema. */
async function nonOwnerPrivileges(): Promise<string[]> {
  const rows = await owner.$queryRaw<{ entry: string }[]>`
    WITH ns AS (
      SELECT n.oid, n.nspname, n.nspacl, n.nspowner FROM pg_catalog.pg_namespace n
      WHERE n.nspname IN ('public', 'owner_password_reset')),
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
const canExecute = async (grantee: string, signature = CONSUME) => {
  const [row] = await owner.$queryRaw<{ allowed: boolean }[]>`
    SELECT pg_catalog.has_function_privilege(${grantee}, ${signature}, 'EXECUTE') AS allowed`;
  return row.allowed;
};

async function account(role: 'USER' | 'ADMIN' = 'ADMIN') {
  const tag = randomUUID().slice(0, 8);
  return owner.user.create({
    data: {
      username: `opr_${tag}_${s}`.slice(0, 30),
      email: `opr_${tag}_${s}@fixture.invalid`,
      role,
      passwordHash: await hashPassword(oldPassword),
    },
  });
}
const current = (id: string) => owner.user.findUniqueOrThrow({ where: { id } });
const record = async (nonce: string) =>
  (
    await owner.$queryRaw<{ user_id: string; version: number; consumed_at: Date | null; consumed_by: string | null }[]>`
      SELECT user_id, version, consumed_at, consumed_by FROM owner_password_reset.issuances WHERE nonce = ${nonce}::uuid`
  )[0];
const nonceOf = (token: string) =>
  (JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()) as { nonce: string }).nonce;

/**
 * A link signed with nothing but JWT_ACCESS_SECRET and public facts: the
 * account's ID, role and current tokenVersion. No owner authority.
 */
function forged(user: { id: string; role: string; tokenVersion: number }, overrides: Record<string, unknown> = {}) {
  const purpose = 'salem-owner-password-reset-v1';
  const claims = {
    purpose,
    sub: user.id,
    version: user.tokenVersion,
    role: user.role,
    nonce: randomUUID(),
    exp: Date.now() + 10 * 60_000,
    ...overrides,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const key = createHmac('sha256', config.JWT_ACCESS_SECRET).update(purpose).digest();
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
/** Owner issuance, exactly as the owner CLI does it. */
const issue = async (user: { id: string; email: string | null }) =>
  (await issueOwnerReset(credentialDb, user.id, user.email!)).token;

let runtime: PrismaClient;
let credential: PrismaClient;
let before: string[];

beforeAll(async () => {
  for (const sql of PURGE) await exec(sql);
  for (const key of ['runtime', 'credential'] as const)
    await exec(`CREATE ROLE "${roles[key]}" LOGIN PASSWORD '${passwords[key]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await exec('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${roles.runtime})`;
  // The narrow credential login of auth-restricted-identity.native.ts.
  for (const sql of [
    `GRANT USAGE ON SCHEMA public TO "${roles.credential}"`,
    `GRANT SELECT (id, status, role, "passwordHash", "tokenVersion") ON public.users TO "${roles.credential}"`,
    `GRANT UPDATE ("passwordHash", "tokenVersion", "updatedAt") ON public.users TO "${roles.credential}"`,
    `GRANT SELECT ("userId"), DELETE ON public.sessions TO "${roles.credential}"`,
    `GRANT SELECT (id), INSERT ON public.audit_logs TO "${roles.credential}"`,
  ])
    await exec(sql);
  runtime = clientFor('runtime');
  credential = clientFor('credential');
  before = await nonOwnerPrivileges();
});

afterAll(async () => {
  for (const app of apps) await app.close().catch(() => undefined);
  for (const client of clients) await client.$disconnect().catch(() => undefined);
  for (const sql of PURGE) await exec(sql).catch(() => undefined);
  for (const name of Object.values(roles)) {
    await exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${name}'`).catch(() => undefined);
    await exec(`DROP OWNED BY "${name}"`).catch(() => undefined);
    await exec(`DROP ROLE IF EXISTS "${name}"`).catch(() => undefined);
  }
  await credentialDb.$disconnect();
  await owner.$disconnect();
});

describe('mode', () => {
  it('is dormant when unset or empty, enforced only for "enforce", and fails closed for anything else', () => {
    expect(resetIssuanceMode({})).toBe('dormant');
    expect(resetIssuanceMode({ PASSWORD_RESET_ISSUANCE: '' })).toBe('dormant');
    expect(resetIssuanceMode({ PASSWORD_RESET_ISSUANCE: 'enforce' })).toBe('enforce');
    for (const typo of ['Enforce', 'enforced', 'true', '1', 'off'])
      expect(resetIssuanceMode({ PASSWORD_RESET_ISSUANCE: typo }), typo).toBe('unavailable');
  });
});

describe('dormant: unchanged before installation and enforcement', () => {
  it('completes a reset without consulting any record, and the CLI still issues without the records', async () => {
    const user = await account();
    // Today's behaviour, kept while dormant: the signature and current version
    // are all completion checks. This is what enforcement closes.
    await expect(completePasswordReset(credential, { token: forged(user), password: newPassword })).resolves.toEqual({ reset: true });
    const other = await account();
    const token = await issue(other);
    await expect(completePasswordReset(credential, { token, password: newPassword })).resolves.toEqual({ reset: true });
  });

  it('refuses every reset, before reading the link, when the mode is not recognised', async () => {
    const user = await account();
    const token = await issue(user);
    await expect(completePasswordReset(credential, { token, password: newPassword }, 'unavailable')).rejects.toMatchObject({ statusCode: 503 });
    expect(await verifyPassword(oldPassword, (await current(user.id)).passwordHash!)).toBe(true);
  });
});

describe('installation', () => {
  it('refuses installation by anyone but the owner of public.users, leaving nothing behind', async () => {
    await expect(runtime.$executeRawUnsafe(INSTALL)).rejects.toThrow(/must be installed by the owner of public\.users/);
    const [row] = await owner.$queryRaw<{ present: boolean }[]>`
      SELECT pg_catalog.to_regprocedure(${CONSUME}) IS NOT NULL AS present`;
    expect(row.present).toBe(false);
  });

  it('installs atomically, grants nothing, and keeps the records from every other login after runtime grants are re-applied', async () => {
    await exec(INSTALL);
    const [fn] = await owner.$queryRaw<{ definer: boolean; config: string[]; owner: string; usersOwner: string }[]>`
      SELECT p.prosecdef AS definer, p.proconfig AS config, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
             pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.users'::regclass)) AS "usersOwner"
      FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(${CONSUME})`;
    expect(fn).toMatchObject({ definer: true, config: ['search_path=pg_catalog, pg_temp'] });
    expect(fn.owner).toBe(fn.usersOwner);
    expect(await nonOwnerPrivileges()).toEqual(before);
    for (let round = 0; round < 2; round++) {
      await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${roles.runtime})`;
      expect(await nonOwnerPrivileges()).toEqual(before);
    }
    for (const grantee of ['public', roles.runtime, roles.credential]) {
      expect(await canExecute(grantee)).toBe(false);
      expect(await canExecute(grantee, 'owner_password_reset.record_issuance(uuid,text,integer,timestamptz)')).toBe(false);
      const [row] = await owner.$queryRaw<{ usage: boolean }[]>`
        SELECT pg_catalog.has_schema_privilege(${grantee}, 'owner_password_reset', 'USAGE') AS usage`;
      expect(row.usage, grantee).toBe(false);
    }
    await exec(INSTALL);
    expect(await nonOwnerPrivileges()).toEqual(before);
  });

  it('refuses a planted privilege, object or schema, atomically', async () => {
    const intruder = `opr_intruder_${s}`;
    await exec(`CREATE ROLE "${intruder}" NOLOGIN`);
    try {
      for (const [plant, undo, found] of [
        [`GRANT USAGE ON SCHEMA owner_password_reset TO "${intruder}"`, `REVOKE USAGE ON SCHEMA owner_password_reset FROM "${intruder}"`, /schema owner_password_reset/],
        [`GRANT SELECT ON owner_password_reset.issuances TO "${intruder}"`, `REVOKE SELECT ON owner_password_reset.issuances FROM "${intruder}"`, /relation owner_password_reset\.issuances/],
        [`GRANT UPDATE (consumed_at) ON owner_password_reset.issuances TO "${intruder}"`, `REVOKE UPDATE (consumed_at) ON owner_password_reset.issuances FROM "${intruder}"`, /column owner_password_reset\.issuances\.consumed_at/],
        [`CREATE TABLE owner_password_reset.planted (x int); ALTER TABLE owner_password_reset.planted OWNER TO "${intruder}"`, 'DROP TABLE owner_password_reset.planted', /relation owner_password_reset\.planted/],
      ] as const) {
        for (const statement of plant.split('; ')) await exec(statement);
        await expect(exec(INSTALL), plant).rejects.toThrow(found);
        await exec(undo);
      }
      await exec('ALTER SCHEMA owner_password_reset RENAME TO owner_password_reset_moved');
      try {
        await exec(`CREATE SCHEMA owner_password_reset AUTHORIZATION "${intruder}"`);
        await expect(exec(INSTALL)).rejects.toThrow(/not owned by the owner of public\.users/);
      } finally {
        await exec('DROP SCHEMA IF EXISTS owner_password_reset CASCADE');
        await exec('ALTER SCHEMA owner_password_reset_moved RENAME TO owner_password_reset');
      }
    } finally {
      await exec(`DROP OWNED BY "${intruder}"`).catch(() => undefined);
      await exec(`DROP ROLE IF EXISTS "${intruder}"`);
    }
    await exec(INSTALL);
    expect(await nonOwnerPrivileges()).toEqual(before);
  });
});

describe('enforced', () => {
  beforeAll(async () => {
    // Activation, rehearsed in the throwaway database only.
    await exec(`GRANT EXECUTE ON FUNCTION ${CONSUME} TO "${roles.credential}"`);
  });

  it('records each owner issuance and accepts that link exactly once through the narrow credential login', async () => {
    const user = await account();
    const token = await issue(user);
    const nonce = nonceOf(token);
    const issued = await current(user.id);
    expect(await record(nonce)).toMatchObject({ user_id: user.id, version: issued.tokenVersion, consumed_at: null });
    await expect(completePasswordReset(credential, { token, password: newPassword }, 'enforce')).resolves.toEqual({ reset: true });
    const after = await current(user.id);
    expect(await verifyPassword(newPassword, after.passwordHash!)).toBe(true);
    expect(after.role).toBe('ADMIN');
    expect(await record(nonce)).toMatchObject({ consumed_by: roles.credential });
    expect((await record(nonce)).consumed_at).not.toBeNull();
    await expect(completePasswordReset(credential, { token, password: oldPassword }, 'enforce')).rejects.toMatchObject({ statusCode: 401 });
    expect(await verifyPassword(newPassword, (await current(user.id)).passwordHash!)).toBe(true);
  });

  it('refuses a correctly signed link the owner never issued, and changes nothing', async () => {
    const user = await account();
    await owner.session.create({ data: { userId: user.id, refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    const audits = () => owner.auditLog.count({ where: { entityId: user.id } });
    const auditsBefore = await audits();
    await expect(completePasswordReset(credential, { token: forged(user), password: newPassword }, 'enforce')).rejects.toMatchObject({ statusCode: 401 });
    const after = await current(user.id);
    expect(await verifyPassword(oldPassword, after.passwordHash!)).toBe(true);
    expect(after.tokenVersion).toBe(user.tokenVersion);
    expect(await owner.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await audits()).toBe(auditsBefore);
  });

  it('refuses a record for another account, another version, or one that has expired', async () => {
    const a = await account();
    const b = await account();
    const nonce = nonceOf(await issue(a));
    // Another account presenting a real nonce, with its version aligned to the
    // record so that only the account comparison can refuse it.
    const issuedVersion = (await record(nonce)).version;
    await owner.$executeRaw`UPDATE users SET "tokenVersion" = ${issuedVersion} WHERE id = ${b.id}`;
    const bNow = await current(b.id);
    expect(bNow.tokenVersion).toBe(issuedVersion);
    await expect(
      completePasswordReset(credential, { token: forged(bNow, { nonce }), password: newPassword }, 'enforce')
    ).rejects.toMatchObject({ statusCode: 401 });
    // A record naming another version than the link and account.
    const aNow = await current(a.id);
    const otherVersion = randomUUID();
    await owner.$executeRaw`SELECT owner_password_reset.record_issuance(
      ${otherVersion}::uuid, ${a.id}, ${aNow.tokenVersion + 7}::integer, ${new Date(Date.now() + 60_000)}::timestamptz)`;
    await expect(
      completePasswordReset(credential, { token: forged(aNow, { nonce: otherVersion }), password: newPassword }, 'enforce')
    ).rejects.toMatchObject({ statusCode: 401 });
    // An expired record (written directly by the owner; the record function refuses past expiries).
    const expired = randomUUID();
    await owner.$executeRaw`INSERT INTO owner_password_reset.issuances (nonce, user_id, version, expires_at)
      VALUES (${expired}::uuid, ${a.id}, ${aNow.tokenVersion}::integer, now() - interval '1 second')`;
    await expect(
      completePasswordReset(credential, { token: forged(aNow, { nonce: expired }), password: newPassword }, 'enforce')
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(await verifyPassword(oldPassword, (await current(a.id)).passwordHash!)).toBe(true);
    expect(await verifyPassword(oldPassword, (await current(b.id)).passwordHash!)).toBe(true);
  });

  it('consumes a record only once, even when the version check alone would not stop a second use', async () => {
    const user = await account();
    const nonce = randomUUID();
    await owner.$executeRaw`SELECT owner_password_reset.record_issuance(
      ${nonce}::uuid, ${user.id}, ${user.tokenVersion}::integer, ${new Date(Date.now() + 60_000)}::timestamptz)`;
    const consume = () =>
      credential.$queryRaw<{ outcome: string }[]>`
        SELECT public.owner_password_reset_consume(${nonce}, ${user.id}, ${user.tokenVersion}::integer) AS outcome`;
    expect((await consume())[0].outcome).toBe('OK');
    expect((await consume())[0].outcome).toBe('NOT_ISSUED');
    expect(await record(nonce)).toMatchObject({ consumed_by: roles.credential });
  });

  it('lets exactly one of three concurrent completions win', async () => {
    const user = await account();
    const token = await issue(user);
    const attempts = await Promise.allSettled(
      [1, 2, 3].map(() => completePasswordReset(credential, { token, password: newPassword }, 'enforce'))
    );
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.statusCode)).toEqual([401, 401]);
  });

  it('keeps the records out of the credential and runtime logins, and never lets anyone delete or un-consume them', async () => {
    for (const client of [credential, runtime]) {
      await expect(client.$queryRawUnsafe('SELECT nonce FROM owner_password_reset.issuances LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(
        client.$queryRawUnsafe(`SELECT owner_password_reset.record_issuance(gen_random_uuid(), 'x', 0, now() + interval '1 minute')`)
      ).rejects.toThrow(/permission denied/);
    }
    await expect(runtime.$queryRawUnsafe(`SELECT ${CONSUME.replace('(text,text,integer)', "('x', 'y', 0)")}`)).rejects.toThrow(/permission denied/);
    const user = await account();
    const nonce = nonceOf(await issue(user));
    await expect(exec(`UPDATE owner_password_reset.issuances SET version = version + 1 WHERE nonce = '${nonce}'`)).rejects.toThrow(/only ever consumed/);
    await expect(exec(`DELETE FROM owner_password_reset.issuances WHERE nonce = '${nonce}'`)).rejects.toThrow(/only ever consumed/);
    await expect(exec('TRUNCATE owner_password_reset.issuances')).rejects.toThrow(/only ever consumed/);
    await exec(`UPDATE owner_password_reset.issuances SET consumed_at = now(), consumed_by = 'owner-test' WHERE nonce = '${nonce}'`);
    await expect(exec(`UPDATE owner_password_reset.issuances SET consumed_at = NULL WHERE nonce = '${nonce}'`)).rejects.toThrow(/only ever consumed/);
  });

  it('enforces through the HTTP route when configured, and stays dormant by default', async () => {
    const app = async (enforce: boolean) => {
      const server = Fastify({ logger: false });
      await server.register(cookie);
      await server.register(jwt, { secret: config.JWT_ACCESS_SECRET });
      server.setErrorHandler(errorHandler);
      await server.register(authRoutes, {
        prefix: '/auth',
        db: owner,
        credentialDb: credential,
        ...(enforce ? { resetIssuance: 'enforce' as const } : {}),
      });
      await server.ready();
      apps.push(server);
      return server;
    };
    const enforced = await app(true);
    const dormant = await app(false);
    const post = (server: Awaited<ReturnType<typeof app>>, token: string) =>
      server.inject({ method: 'POST', url: '/auth/password-reset', payload: { token, password: newPassword } });
    const user = await account();
    expect((await post(enforced, forged(user))).statusCode).toBe(401);
    expect((await post(enforced, await issue(user))).statusCode).toBe(200);
    const other = await account();
    expect((await post(dormant, forged(other))).statusCode).toBe(200);
  });

  it('fails closed without the grant or the function, changes nothing, and recovers', async () => {
    const user = await account();
    const token = await issue(user);
    const nonce = nonceOf(token);
    await exec(`REVOKE EXECUTE ON FUNCTION ${CONSUME} FROM "${roles.credential}"`);
    await expect(completePasswordReset(credential, { token, password: newPassword }, 'enforce')).rejects.toMatchObject({ statusCode: 503 });
    await exec(`GRANT EXECUTE ON FUNCTION ${CONSUME} TO "${roles.credential}"`);
    await exec(`DROP FUNCTION ${CONSUME}`);
    await expect(completePasswordReset(credential, { token, password: newPassword }, 'enforce')).rejects.toMatchObject({ statusCode: 503 });
    expect(await verifyPassword(oldPassword, (await current(user.id)).passwordHash!)).toBe(true);
    expect((await record(nonce)).consumed_at).toBeNull();
    // Reinstall keeps the records; dropping the function dropped its grant.
    await exec(INSTALL);
    expect(await canExecute(roles.credential)).toBe(false);
    await exec(`GRANT EXECUTE ON FUNCTION ${CONSUME} TO "${roles.credential}"`);
    await expect(completePasswordReset(credential, { token, password: newPassword }, 'enforce')).resolves.toEqual({ reset: true });
  });
});
