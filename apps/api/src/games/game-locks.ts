import { ApiError } from '../middleware';

// ─── User Eligibility Lock ─────────────────────────────────────
// Prisma has no `FOR SHARE` support, so the row lock is done with raw
// SQL against the mapped table name ("users"). The guard is strict:
// an account that is anything other than ACTIVE may not play.

export interface LockedUser {
  id: string;
  status: string;
}

export async function lockUserForPlay(tx: any, userId: string): Promise<LockedUser> {
  const rows = (await tx.$queryRaw`SELECT "id", "status" FROM "users" WHERE "id" = ${userId} FOR SHARE`) as LockedUser[];
  const user = rows[0];
  if (!user || user.status !== 'ACTIVE') {
    throw ApiError.forbidden('Your account is not eligible to play');
  }
  return user;
}