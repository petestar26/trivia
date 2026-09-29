import { prisma } from '@socialplay/database';
import { expireBonusLot, lockUserEconomicScope } from './coin-ledger-service.js';

/** Bounded sweep. Concurrent workers may discover the same lot, but the L0
 * lot scope and locked lot state make expiry exactly once. */
export async function sweepExpiredCoinLots(limit = 100): Promise<{ examined: number; expired: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid expiry batch limit');
  const candidates = await prisma.coinProvenance.findMany({
    where: { lotClass: 'RESTRICTED', state: 'OPEN', reservedAmount: 0,
      availableAmount: { gt: 0 }, expiresAt: { lte: new Date() } },
    select: { id: true, userId: true }, orderBy: { expiresAt: 'asc' }, take: limit,
  });
  let expired = 0;
  for (const candidate of candidates) {
    const changed = await prisma.$transaction(async (tx) => {
      await lockUserEconomicScope(tx, `bonus_expiry:${candidate.id}`); // L0
      const rows = (await tx.$queryRaw`
        SELECT id FROM users WHERE id = ${candidate.userId} FOR SHARE
      `) as { id: string }[]; // L1, expiry applies even to suspended users
      if (!rows[0]) return false;
      return expireBonusLot(tx, candidate.userId, candidate.id); // L5, L6, L7
    });
    if (changed) expired++;
  }
  return { examined: candidates.length, expired };
}
