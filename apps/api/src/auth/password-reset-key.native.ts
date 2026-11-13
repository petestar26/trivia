import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { prisma as owner } from '@socialplay/database';
import { config } from '@socialplay/config';
import { credentialDb } from '../agents/credential-database.js';
import { completePasswordReset, issueOwnerReset, readResetToken, resetSigningKey } from './password-reset.js';
import { hashPassword, verifyPassword } from '../utils/auth.js';
import { authRoutes } from '../routes/auth.js';
import { errorHandler } from '../middleware/error-handler.js';

/**
 * Dedicated password-reset signing key (dormant until PASSWORD_RESET_SIGNING_KEY
 * is set). Disposable local database and synthetic accounts only.
 */
const base = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(base.hostname) ||
  base.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw new Error('Disposable local database required');

const purpose = 'salem-owner-password-reset-v1';
const oldPassword = 'Test-Old-Reset-Key-43!';
const newPassword = 'Test-New-Reset-Key-72!';
const app = Fastify({ logger: false });

async function account() {
  const tag = randomUUID().slice(0, 8);
  return owner.user.create({
    data: {
      username: `prk_${tag}`,
      email: `prk_${tag}@fixture.invalid`,
      role: 'ADMIN',
      passwordHash: await hashPassword(oldPassword),
    },
  });
}
const current = (id: string) => owner.user.findUniqueOrThrow({ where: { id } });
/** A link signed under a given root key, outside the API and the owner CLI. */
function signedWith(root: Buffer, user: { id: string; role: string; tokenVersion: number }) {
  const claims = { purpose, sub: user.id, version: user.tokenVersion, role: user.role, nonce: randomUUID(), exp: Date.now() + 10 * 60_000 };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const key = createHmac('sha256', root).update(purpose).digest();
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
const accessSecretRoot = () => Buffer.from(config.JWT_ACCESS_SECRET, 'utf8');
const setKey = (value: string | undefined) => {
  if (value === undefined) delete process.env.PASSWORD_RESET_SIGNING_KEY;
  else process.env.PASSWORD_RESET_SIGNING_KEY = value;
};

beforeAll(async () => {
  await app.register(cookie);
  await app.register(jwt, { secret: config.JWT_ACCESS_SECRET });
  app.setErrorHandler(errorHandler);
  await app.register(authRoutes, { prefix: '/auth', db: owner, credentialDb });
  await app.ready();
});
afterEach(() => setKey(undefined));
afterAll(async () => {
  await app.close();
  await credentialDb.$disconnect();
  await owner.$disconnect();
});

describe('unset: unchanged', () => {
  it('derives the key from JWT_ACCESS_SECRET exactly as before, for issuance and completion', async () => {
    setKey(undefined);
    expect(resetSigningKey()).toEqual(createHmac('sha256', config.JWT_ACCESS_SECRET).update(purpose).digest());
    setKey('');
    expect(resetSigningKey()).toEqual(createHmac('sha256', config.JWT_ACCESS_SECRET).update(purpose).digest());
    const user = await account();
    const { token } = await issueOwnerReset(credentialDb, user.id, user.email!);
    await expect(completePasswordReset(credentialDb, { token, password: newPassword })).resolves.toEqual({ reset: true });
    // Today's behaviour, kept while unset: the access secret alone signs a valid link.
    const other = await account();
    expect(readResetToken(signedWith(accessSecretRoot(), other)).sub).toBe(other.id);
  });
});

describe('set: a dedicated key', () => {
  it('signs and verifies with the dedicated key only; a link signed from JWT_ACCESS_SECRET is refused and changes nothing', async () => {
    const dedicated = randomBytes(32);
    setKey(dedicated.toString('hex'));
    const user = await account();
    await owner.session.create({ data: { userId: user.id, refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    await expect(
      completePasswordReset(credentialDb, { token: signedWith(accessSecretRoot(), user), password: newPassword })
    ).rejects.toMatchObject({ statusCode: 401 });
    const untouched = await current(user.id);
    expect(await verifyPassword(oldPassword, untouched.passwordHash!)).toBe(true);
    expect(untouched.tokenVersion).toBe(user.tokenVersion);
    expect(await owner.session.count({ where: { userId: user.id } })).toBe(1);

    // The owner CLI path, with the same key in its environment.
    const { token } = await issueOwnerReset(credentialDb, user.id, user.email!);
    expect(readResetToken(token).sub).toBe(user.id);
    await expect(completePasswordReset(credentialDb, { token, password: newPassword })).resolves.toEqual({ reset: true });
    expect(await verifyPassword(newPassword, (await current(user.id)).passwordHash!)).toBe(true);
    // Accepts 32 to 64 bytes, upper or lower case.
    for (const hex of [randomBytes(64).toString('hex'), randomBytes(48).toString('hex').toUpperCase()]) {
      setKey(hex);
      expect(resetSigningKey()).not.toBeNull();
    }
  });

  it('stops accepting links signed with a key once it is rotated away', async () => {
    setKey(randomBytes(32).toString('hex'));
    const user = await account();
    const { token } = await issueOwnerReset(credentialDb, user.id, user.email!);
    setKey(randomBytes(32).toString('hex'));
    await expect(completePasswordReset(credentialDb, { token, password: newPassword })).rejects.toMatchObject({ statusCode: 401 });
    expect(await verifyPassword(oldPassword, (await current(user.id)).passwordHash!)).toBe(true);
  });
});

describe('malformed: fails closed', () => {
  it('refuses issuance before revoking anything, and refuses completion, for every malformed key', async () => {
    const user = await account();
    await owner.session.create({ data: { userId: user.id, refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    const valid = signedWith(accessSecretRoot(), user);
    for (const bad of ['not-hex', randomBytes(31).toString('hex'), randomBytes(65).toString('hex'), `${randomBytes(32).toString('hex')}a`, ' '.repeat(64)]) {
      setKey(bad);
      expect(resetSigningKey(), bad).toBeNull();
      await expect(issueOwnerReset(credentialDb, user.id, user.email!), bad).rejects.toMatchObject({ statusCode: 503 });
      // Never falls back to the shared secret, even for a link it would accept.
      await expect(completePasswordReset(credentialDb, { token: valid, password: newPassword }), bad).rejects.toMatchObject({ statusCode: 503 });
    }
    const after = await current(user.id);
    expect(after.tokenVersion).toBe(user.tokenVersion);
    expect(await verifyPassword(oldPassword, after.passwordHash!)).toBe(true);
    expect(await owner.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await owner.auditLog.count({ where: { entityId: user.id, action: 'OWNER_PASSWORD_RESET_ISSUED' } })).toBe(0);
  });

  it('answers 503 through the HTTP route and leaves the account untouched', async () => {
    const user = await account();
    setKey('zz'.repeat(32));
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password-reset',
      payload: { token: signedWith(accessSecretRoot(), user), password: newPassword },
    });
    expect(res.statusCode).toBe(503);
    expect(await verifyPassword(oldPassword, (await current(user.id)).passwordHash!)).toBe(true);
  });
});
