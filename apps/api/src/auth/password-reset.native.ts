import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
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
  await app.register(authRoutes, { prefix: '/auth', db: prisma, credentialDb });
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
  const link = await issueOwnerReset(credentialDb, user.id, user.email!);
  expect(
    (await app.inject({ url: '/private', headers: { authorization: oldAuth } })).statusCode
  ).toBe(401);
  const during = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const duringAuth = authorization(during);
  const attempts = await Promise.allSettled(
    [1, 2, 3].map(() => completePasswordReset(credentialDb, { token: link.token, password: newPassword }))
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
  const old = await issueOwnerReset(credentialDb, user.id, user.email!);
  expect(() => readResetToken(`x${old.token}`)).toThrow('invalid');
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(old.expiresAt) + 1);
  expect(() => readResetToken(old.token)).toThrow('expired');
  now.mockRestore();
  const current = await issueOwnerReset(credentialDb, user.id, user.email!);
  await expect(completePasswordReset(credentialDb, { token: old.token, password: newPassword })).rejects.toThrow(
    'invalid'
  );
  await completePasswordReset(credentialDb, { token: current.token, password: newPassword });
  await expect(
    completePasswordReset(credentialDb, { token: current.token, password: newPassword })
  ).rejects.toThrow('already used');
});

it('does not bypass suspension, role changes, account matching, or password strength', async () => {
  const user = await account();
  await expect(issueOwnerReset(credentialDb, user.id, 'wrong@example.test')).rejects.toThrow(
    'Exact active account'
  );
  const link = await issueOwnerReset(credentialDb, user.id, user.email!);
  await expect(completePasswordReset(credentialDb, { token: link.token, password: 'weak' })).rejects.toThrow(
    '8 or more'
  );
  await expect(
    completePasswordReset(credentialDb, { token: link.token, password: 'Aa1!' + '🎁'.repeat(20) })
  ).rejects.toThrow('72 UTF-8');
  await prisma.user.update({ where: { id: user.id }, data: { role: 'USER' } });
  await expect(completePasswordReset(credentialDb, { token: link.token, password: newPassword })).rejects.toThrow(
    'invalid'
  );
  await prisma.user.update({
    where: { id: user.id },
    data: { role: 'ADMIN', status: 'SUSPENDED' },
  });
  await expect(completePasswordReset(credentialDb, { token: link.token, password: newPassword })).rejects.toThrow(
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
  const link = await issueOwnerReset(credentialDb, user.id, user.email!);
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
