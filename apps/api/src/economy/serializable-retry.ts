/**
 * A SERIALIZABLE transaction that loses a race fails with PostgreSQL 40001
 * (or 40P01 for a deadlock), which Prisma reports as P2034, or as P2010 for a
 * raw query. The transaction changed nothing, so it is safe to run it again
 * from the start; the retry then sees the winner's committed state (for an
 * idempotent request, the settled result).
 */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

export function isSerializationFailure(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  if (!e) return false;
  if (e.code === 'P2034') return true;
  if (e.code === 'P2010' && RETRYABLE_SQLSTATES.has(String(e.meta?.code ?? ''))) return true;
  return /Code: `(40001|40P01)`/.test(String(e.message ?? ''));
}

export const MAX_SERIALIZABLE_ATTEMPTS = 5;

/** Runs `transaction` again, a bounded number of times, after a serialization failure. */
export async function withSerializableRetry<T>(transaction: () => Promise<T>,
  attempts = MAX_SERIALIZABLE_ATTEMPTS): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await transaction();
    } catch (error) {
      if (attempt >= attempts || !isSerializationFailure(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 25 * attempt)));
    }
  }
}
