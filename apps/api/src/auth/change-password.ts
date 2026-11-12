import { z } from 'zod';
import { passwordSchema } from '@socialplay/shared';
import type { Prisma } from '@socialplay/database';
import type { TransactionalDatabase } from '../database/identity.js';
import { ApiError } from '../middleware/api-error.js';
import { hashPassword, verifyPassword } from '../utils/auth.js';
import { getSocketServer } from '../realtime/broadcast.js';

/** Logger-free credential client; supplied by the caller, never imported here. */
export type CredentialDatabase = TransactionalDatabase & Pick<Prisma.TransactionClient, 'user'>;

export async function changeOwnPassword(
  credentialDb: CredentialDatabase,
  userId: string,
  input: unknown
) {
  if (!credentialDb) throw new Error('CREDENTIAL_DATABASE_REQUIRED');
  const parsed = z
    .object({
      currentPassword: z.string().min(1).max(512),
      newPassword: passwordSchema.refine((value) => Buffer.byteLength(value, 'utf8') <= 72),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    throw ApiError.badRequest(
      'Enter your current password and a new password with 8 or more characters, uppercase, lowercase, a number and a symbol (maximum 72 UTF-8 bytes).'
    );
  const { currentPassword, newPassword } = parsed.data;
  try {
    const account = await credentialDb.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, status: true, tokenVersion: true },
    });
    if (!account || account.status !== 'ACTIVE')
      throw ApiError.forbidden('Active account required.');
    if (!account.passwordHash)
      throw ApiError.badRequest(
        'This account uses a connected sign-in provider. Use account recovery to set a password.'
      );
    if (!(await verifyPassword(currentPassword, account.passwordHash)))
      throw ApiError.unauthorized('Your current password is incorrect.');
    if (await verifyPassword(newPassword, account.passwordHash))
      throw ApiError.badRequest('Choose a new password different from your current password.');
    const passwordHash = await hashPassword(newPassword);
    await credentialDb.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true, status: true, tokenVersion: true },
      });
      if (
        !current ||
        current.status !== 'ACTIVE' ||
        current.passwordHash !== account.passwordHash ||
        current.tokenVersion !== account.tokenVersion
      )
        throw ApiError.conflict(
          'Your account changed. Sign in again before changing your password.'
        );
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });
      await tx.session.deleteMany({ where: { userId } });
      await tx.auditLog.create({
        data: {
          userId,
          action: 'ACCOUNT_PASSWORD_CHANGED',
          entity: 'User',
          entityId: userId,
          newData: { sessionsRevoked: true },
        },
      });
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.internal(
      'Password change could not be confirmed. Try signing in with your new password before retrying.'
    );
  }
  try {
    getSocketServer()?.in(`user:${userId}`).disconnectSockets(true);
  } catch {
    /* Version checks also revoke private socket access. */
  }
  return { changed: true };
}
