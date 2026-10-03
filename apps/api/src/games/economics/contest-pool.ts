import { BPS, CONTEST_FEE_BPS, ECONOMICS_POLICY, PVP_POLICY, PVP_FEE_BPS } from './policy.js';
import { identifier, total, units } from './money.js';

export interface PoolContribution {
  /** Immutable escrow receipt ID, not a client-supplied promise to pay. */
  id: string;
  userId: string;
  kind: 'ENTRY' | 'SPONSOR';
  amount: bigint;
}

export interface ContestPool {
  policy: typeof ECONOMICS_POLICY | typeof PVP_POLICY;
  currency: 'COINS' | 'GAME_POINTS';
  contributions: readonly PoolContribution[];
}

/**
 * Pure settlement plan. The adapter must load committed escrow receipts under
 * the contest lock, then atomically persist this plan, credits and fee journal.
 * This function by itself does NOT prove that money was escrowed.
 * New PVP entries use multiples of 100 smallest ledger units for exact 7% fees.
 * Legacy pinned 15% entries retain their original 20-unit step.
 * SPONSOR contributions are returned or paid in full, with no second fee.
 */
export function planContestSettlement(
  pool: ContestPool,
  result: { status: 'COMPLETED'; winnerIds: readonly string[] } | { status: 'VOID' },
) {
  if (pool.policy !== ECONOMICS_POLICY && pool.policy !== PVP_POLICY) throw new RangeError('Unsupported economic policy');
  const feeBps = pool.policy === PVP_POLICY ? PVP_FEE_BPS : CONTEST_FEE_BPS;
  const entryStep = pool.policy === PVP_POLICY ? 100n : 20n;
  if (pool.currency !== 'COINS' && pool.currency !== 'GAME_POINTS') throw new RangeError('Invalid currency');
  if (!Array.isArray(pool.contributions) || pool.contributions.length > 100_000) {
    throw new RangeError('Invalid contribution list');
  }
  const receiptIds = new Set<string>();
  const entrants = new Set<string>();
  for (const receipt of pool.contributions) {
    identifier(receipt.id, 'Receipt ID');
    identifier(receipt.userId, 'User ID');
    if (receiptIds.has(receipt.id)) throw new RangeError('Duplicate escrow receipt');
    receiptIds.add(receipt.id);
    units(receipt.amount, 'Contribution', true);
    if (receipt.kind === 'ENTRY') {
      if (receipt.amount % entryStep !== 0n) throw new RangeError(`Entry must be a multiple of ${entryStep} ledger units`);
      entrants.add(receipt.userId);
    } else if (receipt.kind !== 'SPONSOR') throw new RangeError('Invalid contribution kind');
  }
  const funded = total(pool.contributions.map((item) => item.amount), 'Pool');
  const entries = total(pool.contributions.filter((item) => item.kind === 'ENTRY').map((item) => item.amount), 'Entries');
  if (result.status === 'VOID') {
    return {
      policy: pool.policy, currency: pool.currency, funded, platformFee: 0n,
      prizes: [] as { userId: string; amount: bigint }[],
      refunds: pool.contributions.map((item) => ({ receiptId: item.id, userId: item.userId, amount: item.amount })),
    };
  }
  if (result.status !== 'COMPLETED') throw new RangeError('Invalid result status');
  if (entrants.size < 2) throw new RangeError('At least two funded entrants required; otherwise void');
  if (!Array.isArray(result.winnerIds) || result.winnerIds.length === 0) {
    throw new RangeError('No winners; event must be voided, not retained by the house');
  }
  const winners = [...new Set(result.winnerIds)].sort();
  if (winners.length !== result.winnerIds.length || winners.some((id) => !entrants.has(id))) {
    throw new RangeError('Winners must be unique funded entrants');
  }
  const platformFee = entries * feeBps / BPS;
  const distributable = funded - platformFee;
  const share = distributable / BigInt(winners.length);
  const remainder = distributable % BigInt(winners.length);
  // Canonical ID ordering determines whole-unit tie remainders, never request order.
  const prizes = winners.map((userId, index) => ({
    userId, amount: share + (BigInt(index) < remainder ? 1n : 0n),
  }));
  if (total(prizes.map((prize) => prize.amount), 'Prizes') + platformFee !== funded) {
    throw new Error('Pool conservation failed');
  }
  return {
    policy: pool.policy, currency: pool.currency, funded, platformFee, prizes,
    refunds: [] as { receiptId: string; userId: string; amount: bigint }[],
  };
}

