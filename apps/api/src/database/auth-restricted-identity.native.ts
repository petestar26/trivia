import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { prisma as owner, PrismaClient } from '@socialplay/database';
import { config } from '@socialplay/config';
import { authRoutes } from '../routes/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { generateTokens, hashPassword, verifyPassword } from '../utils/auth.js';
import { issueOwnerReset } from '../auth/password-reset.js';

/**
 * Sign-in, refresh, /me and sign-out through an injected, column-restricted
 * login on real PostgreSQL. The login may read only the columns these flows
 * need, so a broad read (a whole User row, a password hash during refresh, a
 * session's IP or user agent) fails with permission denied. Disposable local
 * database and synthetic accounts only.
 */
const base = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(base.hostname) ||
  base.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw new Error('Disposable local database required');

const s = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `ar_auth_${s}`;
const rolePassword = randomUUID();
// Credential login: exactly the boundary in the candidate's auth-flow review.
const credentialRole = `ar_cred_${s}`;
const credentialPassword = randomUUID();
const password = 'Synthetic-Member-1!';
const phone = `+2519${String(Date.now()).slice(-8)}`;
const exec = (sql: string) => owner.$executeRawUnsafe(sql);
let restricted: PrismaClient;
let credential: PrismaClient;
const app = Fastify({ logger: false });
let member: { id: string; email: string | null };

beforeAll(async () => {
  await exec(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`
  );
  for (const sql of [
    `GRANT USAGE ON SCHEMA public TO "${role}"`,
    `GRANT SELECT (id, email, username, role, status, "tokenVersion", "passwordHash", "displayName", "createdAt", "isVerified", bio, "avatarUrl", "lastLoginAt") ON public.users TO "${role}"`,
    `GRANT UPDATE ("lastLoginAt", "updatedAt") ON public.users TO "${role}"`,
    `GRANT SELECT (id, "userId", provider, "providerSubject") ON public.user_auth_identities TO "${role}"`,
    `GRANT SELECT (id, "userId", "refreshToken", "expiresAt") ON public.sessions TO "${role}"`,
    `GRANT INSERT, DELETE ON public.sessions TO "${role}"`,
  ])
    await exec(sql);
  const url = new URL(base);
  url.username = role;
  url.password = rolePassword;
  restricted = new PrismaClient({ datasourceUrl: url.toString(), log: [] });

  await exec(
    `CREATE ROLE "${credentialRole}" LOGIN PASSWORD '${credentialPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`
  );
  for (const sql of [
    `GRANT USAGE ON SCHEMA public TO "${credentialRole}"`,
    `GRANT SELECT (id, status, role, "passwordHash", "tokenVersion") ON public.users TO "${credentialRole}"`,
    `GRANT UPDATE ("passwordHash", "tokenVersion", "updatedAt") ON public.users TO "${credentialRole}"`,
    `GRANT SELECT ("userId"), DELETE ON public.sessions TO "${credentialRole}"`,
    `GRANT SELECT (id), INSERT ON public.audit_logs TO "${credentialRole}"`,
  ])
    await exec(sql);
  const credentialUrl = new URL(base);
  credentialUrl.username = credentialRole;
  credentialUrl.password = credentialPassword;
  credential = new PrismaClient({ datasourceUrl: credentialUrl.toString(), log: [] });

  const created = await owner.user.create({
    data: {
      username: `ar_member_${s}`,
      email: `member_${s}@fixture.invalid`,
      passwordHash: await hashPassword(password),
    },
  });
  await owner.userAuthIdentity.create({
    data: { userId: created.id, provider: 'PHONE', providerSubject: phone },
  });
  member = created;

  await app.register(cookie);
  await app.register(jwt, { secret: config.JWT_ACCESS_SECRET });
  await app.register(rateLimit, { max: 1000 });
  app.setErrorHandler(errorHandler);
  await app.register(authRoutes, { prefix: '/auth', db: restricted, credentialDb: credential });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await restricted?.$disconnect();
  await credential?.$disconnect();
  for (const name of [role, credentialRole]) {
    await exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${name}'`).catch(() => undefined);
    await exec(`DROP OWNED BY "${name}"`).catch(() => undefined);
    await exec(`DROP ROLE IF EXISTS "${name}"`).catch(() => undefined);
  }
  await owner.$disconnect();
});

const columnAllowed = async (table: string, column: string, grantee = role) => {
  const [row] = await owner.$queryRaw<{ allowed: boolean }[]>`
    SELECT pg_catalog.has_column_privilege(${grantee}, ${table}, ${column}, 'SELECT') AS allowed`;
  return row.allowed;
};

it('signs in, refreshes, reads /me and signs out without reading credentials outside sign-in', async () => {
  expect(await columnAllowed('public.sessions', 'ip')).toBe(false);
  expect(await columnAllowed('public.sessions', 'userAgent')).toBe(false);
  expect(await columnAllowed('public.users', 'updatedAt')).toBe(false);

  const byEmail = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: member.email, password } });
  expect(byEmail.statusCode, byEmail.body).toBe(200);
  const byPhone = await app.inject({ method: 'POST', url: '/auth/login', payload: { phone, password } });
  expect(byPhone.statusCode, byPhone.body).toBe(200);
  expect(byPhone.json().data.user).toMatchObject({ id: member.id });
  const { accessToken, refreshToken } = byEmail.json().data;

  // After sign-in the auth login no longer needs the password hash at all.
  await exec(`REVOKE SELECT ("passwordHash") ON public.users FROM "${role}"`);
  try {
    expect(await columnAllowed('public.users', 'passwordHash')).toBe(false);
    const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json().data.refreshToken).not.toBe(refreshToken);
    expect(await owner.session.count({ where: { refreshToken } })).toBe(0);

    const authorization = `Bearer ${accessToken}`;
    const me = await app.inject({ url: '/auth/me', headers: { authorization } });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().data.user).toMatchObject({ id: member.id, status: 'ACTIVE' });

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization } });
    expect(out.statusCode, out.body).toBe(200);
    expect(await owner.session.count({ where: { userId: member.id } })).toBe(0);
  } finally {
    await exec(`GRANT SELECT ("passwordHash") ON public.users TO "${role}"`);
  }
});

it('refuses a correctly signed refresh token for another subject and keeps the session', async () => {
  const owned = await owner.user.create({ data: { username: `ar_owner_${s}`, email: `owner_${s}@fixture.invalid` } });
  const other = await owner.user.create({ data: { username: `ar_other_${s}`, email: `other_${s}@fixture.invalid` } });
  // Signed with the real refresh secret and the owner's tokenVersion, but for another subject.
  const foreign = generateTokens(other.id, other.email, other.username, ['USER'], owned.tokenVersion).refreshToken;
  const session = await owner.session.create({
    data: { userId: owned.id, refreshToken: foreign, expiresAt: new Date(Date.now() + 60_000) },
  });

  const response = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: foreign } });
  expect(response.statusCode, response.body).toBe(401);
  expect(response.json().error).toMatchObject({ code: 'UNAUTHORIZED', details: { code: 'TOKEN_EXPIRED' } });
  expect(await owner.session.findUnique({ where: { id: session.id } })).not.toBeNull();
  expect(await owner.session.count({ where: { userId: owned.id } })).toBe(1);
  expect(await owner.session.count({ where: { userId: other.id } })).toBe(0);
});

it('changes a password and completes an owner-issued reset through a credential login that cannot read emails, tokens or audits', async () => {
  for (const [table, column] of [
    ['public.users', 'email'],
    ['public.sessions', 'refreshToken'],
    ['public.audit_logs', 'newData'],
  ] as const)
    expect(await columnAllowed(table, column, credentialRole), `${table}.${column}`).toBe(false);

  const account = await owner.user.create({
    data: {
      username: `ar_cred_member_${s}`.slice(0, 30),
      email: `cred_${s}@fixture.invalid`,
      passwordHash: await hashPassword(password),
    },
  });
  const signedIn = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: account.email, password } });
  expect(signedIn.statusCode, signedIn.body).toBe(200);
  const changed = 'Synthetic-Member-2!';
  const change = await app.inject({
    method: 'POST',
    url: '/auth/change-password',
    headers: { authorization: `Bearer ${signedIn.json().data.accessToken}` },
    payload: { currentPassword: password, newPassword: changed },
  });
  expect(change.statusCode, change.body).toBe(200);
  const afterChange = await owner.user.findUniqueOrThrow({ where: { id: account.id } });
  expect(afterChange.tokenVersion).toBe(account.tokenVersion + 1);
  expect(await verifyPassword(changed, afterChange.passwordHash!)).toBe(true);
  expect(await owner.session.count({ where: { userId: account.id } })).toBe(0);
  expect(await owner.auditLog.count({ where: { entityId: account.id, action: 'ACCOUNT_PASSWORD_CHANGED' } })).toBe(1);

  // Issuance stays owner-only (the owner CLI path); completion uses the credential login.
  const link = await issueOwnerReset(owner, account.id, account.email!);
  const reset = 'Synthetic-Member-3!';
  const completed = await app.inject({ method: 'POST', url: '/auth/password-reset', payload: { token: link.token, password: reset } });
  expect(completed.statusCode, completed.body).toBe(200);
  const afterReset = await owner.user.findUniqueOrThrow({ where: { id: account.id } });
  expect(afterReset.tokenVersion).toBe(afterChange.tokenVersion + 2);
  expect(await verifyPassword(reset, afterReset.passwordHash!)).toBe(true);
  expect(await owner.auditLog.count({ where: { entityId: account.id, action: 'OWNER_PASSWORD_RESET_COMPLETED' } })).toBe(1);
  const replay = await app.inject({ method: 'POST', url: '/auth/password-reset', payload: { token: link.token, password: 'Synthetic-Member-4!' } });
  expect(replay.statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: account.email, password: reset } })).statusCode).toBe(200);
});
