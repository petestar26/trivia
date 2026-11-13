import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { PrismaClient, type Prisma } from '@prisma/client';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { credentialDb } from '../agents/credential-database.js';
import { issueOwnerReset, completePasswordReset, readResetToken } from './password-reset.js';
import { hashPassword, verifyPassword, generateTokens } from '../utils/auth.js';
import { authRoutes } from '../routes/auth.js';
import { authenticate } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Disposable local database required');
const oldPassword = 'Test-Old-Recovery-43!',
  newPassword = 'Test-New-Recovery-72!';
const app = Fastify({ logger: false });
const account = async () =>
  prisma.user.create({
    data: {
      username: `reset_${randomUUID()}`,
      email: `${randomUUID()}@example.test`,
      role: 'ADMIN',
      passwordHash: await hashPassword(oldPassword),
    },
  });
const authorization = (u: {
  id: string;
  email: string | null;
  username: string;
  tokenVersion: number;
}) => `Bearer ${generateTokens(u.id, u.email, u.username, ['ADMIN'], u.tokenVersion).accessToken}`;
beforeAll(async () => {
  await app.register(cookie);
  await app.register(jwt, { secret: config.JWT_ACCESS_SECRET });
  app.setErrorHandler(errorHandler);
  await app.register(authRoutes, { prefix: '/auth' });
  app.get('/private', { preHandler: authenticate }, async () => ({ ok: true }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await credentialDb.$disconnect();
});

it('allows one reset winner, keeps the administrator role, and revokes old sessions and access tokens', async () => {
  const user = await account();
  const oldAuth = authorization(user);
  await prisma.session.create({
    data: { userId: user.id, refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
  });
  expect(
    (await app.inject({ url: '/private', headers: { authorization: oldAuth } })).statusCode
  ).toBe(200);
  const link = await issueOwnerReset(user.id, user.email!);
  expect(
    (await app.inject({ url: '/private', headers: { authorization: oldAuth } })).statusCode
  ).toBe(401);
  const during = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const duringAuth = authorization(during);
  const attempts = await Promise.allSettled(
    [1, 2, 3].map(() => completePasswordReset({ token: link.token, password: newPassword }))
  );
  expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(updated.role).toBe('ADMIN');
  expect(await verifyPassword(newPassword, updated.passwordHash!)).toBe(true);
  expect(await verifyPassword(oldPassword, updated.passwordHash!)).toBe(false);
  expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  expect(
    (await app.inject({ url: '/private', headers: { authorization: duringAuth } })).statusCode
  ).toBe(401);
  expect(
    (await app.inject({ url: '/private', headers: { authorization: authorization(updated) } }))
      .statusCode
  ).toBe(200);
  const audit = await prisma.auditLog.findMany({
    where: { entityId: user.id, action: 'OWNER_PASSWORD_RESET_COMPLETED' },
  });
  expect(audit).toHaveLength(1);
  expect(JSON.stringify(audit)).not.toContain(newPassword);
  expect(JSON.stringify(audit)).not.toContain(link.token);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: user.email, password: newPassword },
      })
    ).statusCode
  ).toBe(200);
});

it('rejects forged, expired, reused and superseded links', async () => {
  const user = await account();
  const old = await issueOwnerReset(user.id, user.email!);
  expect(() => readResetToken(`x${old.token}`)).toThrow('invalid');
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(old.expiresAt) + 1);
  expect(() => readResetToken(old.token)).toThrow('expired');
  now.mockRestore();
  const current = await issueOwnerReset(user.id, user.email!);
  await expect(completePasswordReset({ token: old.token, password: newPassword })).rejects.toThrow(
    'invalid'
  );
  await completePasswordReset({ token: current.token, password: newPassword });
  await expect(
    completePasswordReset({ token: current.token, password: newPassword })
  ).rejects.toThrow('already used');
});

it('does not bypass suspension, role changes, account matching, or password strength', async () => {
  const user = await account();
  await expect(issueOwnerReset(user.id, 'wrong@example.test')).rejects.toThrow(
    'Exact active account'
  );
  const link = await issueOwnerReset(user.id, user.email!);
  await expect(completePasswordReset({ token: link.token, password: 'weak' })).rejects.toThrow(
    '8 or more'
  );
  await expect(
    completePasswordReset({ token: link.token, password: 'Aa1!' + '🎁'.repeat(20) })
  ).rejects.toThrow('72 UTF-8');
  await prisma.user.update({ where: { id: user.id }, data: { role: 'USER' } });
  await expect(completePasswordReset({ token: link.token, password: newPassword })).rejects.toThrow(
    'invalid'
  );
  await prisma.user.update({
    where: { id: user.id },
    data: { role: 'ADMIN', status: 'SUSPENDED' },
  });
  await expect(completePasswordReset({ token: link.token, password: newPassword })).rejects.toThrow(
    'invalid'
  );
  expect(
    await verifyPassword(
      oldPassword,
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash!
    )
  ).toBe(true);
});

it('protects browser origins and returns a private result without leaking credentials', async () => {
  const user = await account();
  const link = await issueOwnerReset(user.id, user.email!);
  const payload = { token: link.token, password: newPassword };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/auth/password-reset',
        headers: { origin: 'https://untrusted.example' },
        payload,
      })
    ).statusCode
  ).toBe(403);
  const result = await app.inject({
    method: 'POST',
    url: '/auth/password-reset',
    headers: { origin: new URL(config.FRONTEND_URL).origin },
    payload,
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toContain('no-store');
  expect(result.body).not.toContain(newPassword);
  expect(result.body).not.toContain(link.token);
  expect(result.json().data).toEqual({ reset: true });
});

it('rejects tokens signed with the access key and reset-key tokens without an owner issuance', async () => {
  const user = await account();
  const claims = {
    purpose: 'salem-owner-password-reset-v2',
    sub: user.id,
    role: user.role,
    version: user.tokenVersion,
    nonce: randomUUID(),
    exp: Date.now() + 600_000,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  for (const key of [config.JWT_ACCESS_SECRET, config.PASSWORD_RESET_SECRET!]) {
    const token = `${body}.${createHmac('sha256', key).update(claims.purpose).update('\0').update(body).digest('base64url')}`;
    await expect(completePasswordReset({ token, password: newPassword })).rejects.toThrow(
      'invalid'
    );
  }
  const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(updated.tokenVersion).toBe(user.tokenVersion);
  expect(await verifyPassword(oldPassword, updated.passwordHash!)).toBe(true);
});

it('fails closed without an independent reset key and rolls back failed issuance', async () => {
  const user = await account();
  const key = config.PASSWORD_RESET_SECRET;
  try {
    for (const value of [undefined, config.JWT_ACCESS_SECRET, config.JWT_REFRESH_SECRET]) {
      config.PASSWORD_RESET_SECRET = value;
      await expect(issueOwnerReset(user.id, user.email!)).rejects.toThrow('not configured');
    }
  } finally {
    config.PASSWORD_RESET_SECRET = key;
  }
  expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).tokenVersion).toBe(0);
  const rows = await prisma.$queryRaw<
    { count: bigint }[]
  >`SELECT count(*) FROM password_reset_private.issuances WHERE user_id=${user.id}`;
  expect(Number(rows[0].count)).toBe(0);
});

it('binds every issuance field and restores consumption when a later write rolls back', async () => {
  const user = await account();
  const link = await issueOwnerReset(user.id, user.email!);
  const claims = readResetToken(link.token);
  for (const change of [{ nonce: randomUUID() }, { exp: claims.exp - 1 }]) {
    const changed = { ...claims, ...change };
    const body = Buffer.from(JSON.stringify(changed)).toString('base64url');
    const token = `${body}.${createHmac('sha256', config.PASSWORD_RESET_SECRET!).update(claims.purpose).update('\0').update(body).digest('base64url')}`;
    await expect(completePasswordReset({ token, password: newPassword })).rejects.toThrow(
      'invalid'
    );
  }
  for (const mismatch of [
    { sub: randomUUID(), role: claims.role, version: claims.version },
    { sub: claims.sub, role: 'USER', version: claims.version },
    { sub: claims.sub, role: claims.role, version: claims.version + 1 },
  ]) {
    const [r] = await prisma.$queryRaw<
      { consumed: boolean }[]
    >`SELECT public.consume_owner_password_reset(
      ${claims.nonce}::uuid, ${mismatch.sub}::text, ${mismatch.role}::text,
      ${mismatch.version}::integer, ${new Date(claims.exp)}::timestamptz) AS consumed`;
    expect(r.consumed).toBe(false);
  }
  await expect(
    prisma.$transaction(async (tx) => {
      const [r] = await tx.$queryRaw<
        { consumed: boolean }[]
      >`SELECT public.consume_owner_password_reset(
      ${claims.nonce}::uuid, ${claims.sub}::text, ${claims.role}::text,
      ${claims.version}::integer, ${new Date(claims.exp)}::timestamptz) AS consumed`;
      expect(r.consumed).toBe(true);
      throw new Error('synthetic downstream failure');
    })
  ).rejects.toThrow('synthetic downstream failure');
  await completePasswordReset({ token: link.token, password: newPassword });
});

it('does not expose the ledger or consume function through inherited default grants', async () => {
  // Runner creates this hostile-default-grant role before installing migrations.
  const [role] = await prisma.$queryRaw<
    { exists: boolean }[]
  >`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='reset_untrusted') AS exists`;
  if (!role.exists) await prisma.$executeRawUnsafe('CREATE ROLE reset_untrusted NOLOGIN');
  const [acl] = await prisma.$queryRaw<{ schema: boolean; table: boolean; func: boolean }[]>`
    SELECT has_schema_privilege('reset_untrusted','password_reset_private','USAGE') AS schema,
      has_table_privilege('reset_untrusted','password_reset_private.issuances','INSERT') AS table,
      has_function_privilege('reset_untrusted','public.consume_owner_password_reset(uuid,text,text,integer,timestamptz)','EXECUTE') AS func`;
  expect(acl).toEqual({ schema: false, table: false, func: false });
  await expect(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE reset_untrusted');
      await tx.$executeRawUnsafe('INSERT INTO password_reset_private.issuances DEFAULT VALUES');
    })
  ).rejects.toThrow();
});

it('rejects legacy v1 links even for an otherwise matching current user', async () => {
  const user = await account();
  const purpose = 'salem-owner-password-reset-v1';
  const body = Buffer.from(
    JSON.stringify({
      purpose,
      sub: user.id,
      role: user.role,
      version: user.tokenVersion,
      nonce: randomUUID(),
      exp: Date.now() + 600_000,
    })
  ).toString('base64url');
  const token = `${body}.${createHmac('sha256', createHmac('sha256', config.JWT_ACCESS_SECRET).update(purpose).digest()).update(body).digest('base64url')}`;
  await expect(completePasswordReset({ token, password: newPassword })).rejects.toThrow('invalid');
});

it('rejects non-owner issuance before it can write an authorization', async () => {
  const user = await account();
  const transact = credentialDb.$transaction.bind(credentialDb);
  const spy = vi.spyOn(credentialDb, '$transaction').mockImplementation(((
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>
  ) =>
    transact(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE reset_untrusted');
      return callback(tx);
    })) as typeof credentialDb.$transaction);
  try {
    await expect(issueOwnerReset(user.id, user.email!)).rejects.toThrow(
      'Database owner authorization required'
    );
  } finally {
    spy.mockRestore();
  }
});

it('redeems using a real restricted non-owner login with EXECUTE but no ledger access', async () => {
  const user = await account();
  const link = await issueOwnerReset(user.id, user.email!);
  await prisma.$executeRawUnsafe(
    "CREATE ROLE reset_login LOGIN PASSWORD 'synthetic-reset-login-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT"
  );
  await prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO reset_login');
  await prisma.$executeRawUnsafe(
    'GRANT SELECT (id,role,status,"tokenVersion"), UPDATE ("passwordHash","tokenVersion","updatedAt") ON public.users TO reset_login'
  );
  await prisma.$executeRawUnsafe(
    'GRANT SELECT ("userId"), DELETE ON public.sessions TO reset_login'
  );
  await prisma.$executeRawUnsafe('GRANT INSERT, SELECT (id) ON public.audit_logs TO reset_login');
  await prisma.$executeRawUnsafe(
    'GRANT EXECUTE ON FUNCTION public.consume_owner_password_reset(uuid,text,text,integer,timestamptz) TO reset_login'
  );
  const restrictedUrl = new URL(process.env.DATABASE_URL!);
  restrictedUrl.username = 'reset_login';
  restrictedUrl.password = 'synthetic-reset-login-only';
  const restricted = new PrismaClient({
    datasources: { db: { url: restrictedUrl.toString() } },
    log: [],
  });
  const [identity] = await restricted.$queryRaw<
    { name: string; owner: boolean; superuser: boolean }[]
  >`
    SELECT current_user::text AS name, r.rolsuper AS superuser,
      (r.oid=d.datdba) AS owner FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user`;
  expect(identity).toEqual({ name: 'reset_login', owner: false, superuser: false });
  await expect(
    restricted.$queryRawUnsafe('SELECT * FROM password_reset_private.issuances')
  ).rejects.toThrow();
  const spy = vi
    .spyOn(credentialDb, '$transaction')
    .mockImplementation(restricted.$transaction.bind(restricted));
  try {
    await expect(issueOwnerReset(user.id, user.email!)).rejects.toThrow(
      'Database owner authorization required'
    );
    await completePasswordReset({ token: link.token, password: newPassword });
    await expect(
      completePasswordReset({ token: link.token, password: newPassword })
    ).rejects.toThrow('invalid');
  } finally {
    spy.mockRestore();
    await restricted.$disconnect();
    await prisma.$executeRawUnsafe('DROP OWNED BY reset_login');
    await prisma.$executeRawUnsafe('DROP ROLE reset_login');
  }
  expect(
    await verifyPassword(
      newPassword,
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash!
    )
  ).toBe(true);
});

it('rolls back actual application password, session and nonce writes when the completion audit fails', async () => {
  const user = await account();
  const link = await issueOwnerReset(user.id, user.email!);
  const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  await prisma.session.create({
    data: { userId: user.id, refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
  });
  await prisma.$executeRawUnsafe(`CREATE FUNCTION public.synthetic_reset_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action = 'OWNER_PASSWORD_RESET_COMPLETED' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
    RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(
    'CREATE TRIGGER synthetic_reset_audit_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.synthetic_reset_audit_failure()'
  );
  try {
    await expect(
      completePasswordReset({ token: link.token, password: newPassword })
    ).rejects.toThrow('Password change could not be confirmed');
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER synthetic_reset_audit_failure ON public.audit_logs'
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION public.synthetic_reset_audit_failure()');
  }
  const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(after.passwordHash).toBe(before.passwordHash);
  expect(after.tokenVersion).toBe(before.tokenVersion);
  expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  expect(
    await prisma.auditLog.count({
      where: { entityId: user.id, action: 'OWNER_PASSWORD_RESET_COMPLETED' },
    })
  ).toBe(0);
  const [record] = await prisma.$queryRaw<
    { consumed_at: Date | null }[]
  >`SELECT consumed_at FROM password_reset_private.issuances WHERE nonce=${readResetToken(link.token).nonce}::uuid`;
  expect(record.consumed_at).toBeNull();
  await completePasswordReset({ token: link.token, password: newPassword });
  expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
});

it('keeps ordinary login available while a missing reset key disables only reset flows', async () => {
  const user = await account();
  const link = await issueOwnerReset(user.id, user.email!);
  const nonce = readResetToken(link.token).nonce;
  const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const key = config.PASSWORD_RESET_SECRET;
  try {
    config.PASSWORD_RESET_SECRET = undefined;
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: user.email, password: oldPassword },
    });
    expect(login.statusCode).toBe(200);
    await expect(issueOwnerReset(user.id, user.email!)).rejects.toThrow('not configured');
    await expect(
      completePasswordReset({ token: link.token, password: newPassword })
    ).rejects.toThrow('invalid');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(before.tokenVersion);
    const [record] = await prisma.$queryRaw<
      { consumed_at: Date | null }[]
    >`SELECT consumed_at FROM password_reset_private.issuances WHERE nonce=${nonce}::uuid`;
    expect(record.consumed_at).toBeNull();
  } finally {
    config.PASSWORD_RESET_SECRET = key;
  }
  await completePasswordReset({ token: link.token, password: newPassword });
});

it('fails closed during unavailable ledger and recovers without consuming the issued link', async () => {
  const user = await account();
  const link = await issueOwnerReset(user.id, user.email!);
  const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  await prisma.$executeRawUnsafe(
    'ALTER TABLE password_reset_private.issuances RENAME TO synthetic_unavailable_issuances'
  );
  try {
    await expect(issueOwnerReset(user.id, user.email!)).rejects.toThrow(
      'Reset link could not be prepared'
    );
    await expect(
      completePasswordReset({ token: link.token, password: newPassword })
    ).rejects.toThrow('Password change could not be confirmed');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(before.tokenVersion);
  } finally {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE password_reset_private.synthetic_unavailable_issuances RENAME TO issuances'
    );
  }
  await completePasswordReset({ token: link.token, password: newPassword });
});
