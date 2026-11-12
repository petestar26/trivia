import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '@socialplay/config';
import { passwordSchema } from '@socialplay/shared';
import type { TransactionalDatabase } from '../database/identity.js';
import { hashPassword } from '../utils/auth.js';
import { ApiError } from '../middleware/api-error.js';
import { getSocketServer } from '../realtime/broadcast.js';

const purpose = 'salem-owner-password-reset-v1';
const claimsSchema = z
  .object({
    purpose: z.literal(purpose),
    sub: z.string().uuid(),
    version: z.number().int().nonnegative(),
    role: z.enum(['USER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN']),
    nonce: z.string().uuid(),
    exp: z.number().int().positive(),
  })
  .strict();
type Claims = z.infer<typeof claimsSchema>;
const signature = (body: string) =>
  createHmac('sha256', createHmac('sha256', config.JWT_ACCESS_SECRET).update(purpose).digest())
    .update(body)
    .digest();
const invalid = () =>
  ApiError.unauthorized(
    'This reset link is invalid, expired, or already used. Request a new link.'
  );

export function readResetToken(token: string): Claims {
  try {
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
    const [body, mac] = token.split('.');
    const supplied = Buffer.from(mac, 'base64url');
    const expected = signature(body);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw invalid();
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString()));
    if (claims.exp <= Date.now() || claims.exp > Date.now() + 16 * 60_000) throw invalid();
    return claims;
  } catch {
    throw invalid();
  }
}

/** Only the explicit owner CLI calls this. No public reset-link issuance route. */
export async function issueOwnerReset(db: TransactionalDatabase, userId: string, email: string) {
  if (!db) throw new Error('CREDENTIAL_DATABASE_REQUIRED');
  try {
    return await db.$transaction(async (tx) => {
      const [owner] = await tx.$queryRaw<{ allowed: boolean }[]>`SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid=d.datdba
        WHERE d.datname=current_database() AND r.rolname=current_user) AS allowed`;
      if (!owner?.allowed) throw ApiError.forbidden('Database owner authorization required');
      const [user] = await tx.$queryRaw<
        { id: string; role: Claims['role']; status: string; tokenVersion: number }[]
      >`
        SELECT id,role::text,status::text,"tokenVersion" FROM users
        WHERE id=${userId} AND email=${email} FOR UPDATE`;
      if (!user || user.status !== 'ACTIVE')
        throw ApiError.badRequest('Exact active account required');
      const claims: Claims = {
        purpose,
        sub: user.id,
        role: user.role,
        version: user.tokenVersion + 1,
        nonce: randomUUID(),
        exp: Date.now() + 15 * 60_000,
      };
      await tx.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.auditLog.create({
        data: {
          userId: null,
          action: 'OWNER_PASSWORD_RESET_ISSUED',
          entity: 'User',
          entityId: user.id,
          newData: {
            nonce: claims.nonce,
            expiresAt: new Date(claims.exp).toISOString(),
            authority: 'database-owner',
          },
        },
      });
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return {
        token: `${body}.${signature(body).toString('base64url')}`,
        expiresAt: new Date(claims.exp).toISOString(),
      };
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.internal('Reset link could not be prepared');
  }
}

export async function completePasswordReset(db: TransactionalDatabase, input: unknown) {
  if (!db) throw new Error('CREDENTIAL_DATABASE_REQUIRED');
  const parsed = z
    .object({
      token: z.string().max(2048),
      password: passwordSchema.refine(
        (value) => Buffer.byteLength(value, 'utf8') <= 72,
        'Password must be at most 72 UTF-8 bytes'
      ),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    throw ApiError.badRequest(
      'Use a password with 8 or more characters, uppercase, lowercase, a number and a symbol (maximum 72 UTF-8 bytes).'
    );
  const claims = readResetToken(parsed.data.token);
  const hash = await hashPassword(parsed.data.password);
  try {
    await db.$transaction(async (tx) => {
      const [user] = await tx.$queryRaw<
        { id: string; status: string; role: string; tokenVersion: number }[]
      >`
        SELECT id,status::text,role::text,"tokenVersion" FROM users WHERE id=${claims.sub} FOR UPDATE`;
      if (
        !user ||
        user.status !== 'ACTIVE' ||
        user.role !== claims.role ||
        user.tokenVersion !== claims.version ||
        claims.exp <= Date.now()
      )
        throw invalid();
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: hash, tokenVersion: { increment: 1 } },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: 'OWNER_PASSWORD_RESET_COMPLETED',
          entity: 'User',
          entityId: user.id,
          newData: { nonce: claims.nonce, sessionsRevoked: true },
        },
      });
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.internal(
      'Password change could not be confirmed. Try signing in before requesting another link.'
    );
  }
  try {
    getSocketServer()?.in(`user:${claims.sub}`).disconnectSockets(true);
  } catch {
    /* Token versions also guard every socket packet and private delivery. */
  }
  return { reset: true };
}
