export type LotClass = 'RESTRICTED' | 'UNCLASSIFIED' | 'WITHDRAWABLE';

export interface FundingLot {
  id: string;
  lotClass: LotClass;
  availableAmount: number;
  expiresAt?: Date | null;
  mintedAt: Date;
}

export interface FundingShare {
  lotId: string;
  lotClass: LotClass;
  amount: number;
  expiresAt?: Date | null;
}

export interface PayoutShare extends FundingShare {}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}

function timestamp(date: Date | null | undefined): number {
  return date?.getTime() ?? Number.POSITIVE_INFINITY;
}

/** Lock acquisition order is id order in SQL; this priority is applied only after every lot is locked. */
export function allocateFunding(lots: FundingLot[], amount: number): FundingShare[] {
  positiveInteger(amount, 'amount');
  const priority: Record<LotClass, number> = { RESTRICTED: 0, UNCLASSIFIED: 1, WITHDRAWABLE: 2 };
  const ordered = lots
    .filter((lot) => {
      if (!Number.isSafeInteger(lot.availableAmount) || lot.availableAmount < 0) throw new RangeError('invalid lot balance');
      return lot.availableAmount > 0;
    })
    .sort((a, b) => priority[a.lotClass] - priority[b.lotClass]
      || (a.lotClass === 'RESTRICTED' ? timestamp(a.expiresAt) - timestamp(b.expiresAt) : 0)
      || a.mintedAt.getTime() - b.mintedAt.getTime()
      || a.id.localeCompare(b.id));
  let remaining = amount;
  const shares: FundingShare[] = [];
  for (const lot of ordered) {
    if (remaining === 0) break;
    const draw = Math.min(remaining, lot.availableAmount);
    shares.push({ lotId: lot.id, lotClass: lot.lotClass, amount: draw, expiresAt: lot.expiresAt });
    remaining -= draw;
  }
  if (remaining > 0) throw new RangeError('insufficient tracked Coins');
  return shares;
}

/** W shares always round down when any non-withdrawable funding exists. */
export function splitPayout(funding: FundingShare[], payout: number): PayoutShare[] {
  if (!Number.isSafeInteger(payout) || payout < 0) throw new RangeError('payout must be a nonnegative safe integer');
  const stake = funding.reduce((sum, share) => {
    positiveInteger(share.amount, 'funding amount');
    return sum + share.amount;
  }, 0);
  positiveInteger(stake, 'stake');
  const result = funding.map((share) => ({ ...share, amount: Number(BigInt(payout) * BigInt(share.amount) / BigInt(stake)) }));
  let remaining = payout - result.reduce((sum, share) => sum + share.amount, 0);
  const restrictedIndices = funding.map((share, i) => share.lotClass === 'WITHDRAWABLE' ? -1 : i).filter((i) => i >= 0);
  const eligible = restrictedIndices.length > 0 ? restrictedIndices : funding.map((_, i) => i);
  if (remaining > 0 && eligible.length === 0) throw new RangeError('no payout destination');
  const remainders = eligible.map((i) => ({
    i,
    remainder: BigInt(payout) * BigInt(funding[i].amount) % BigInt(stake),
    expiry: timestamp(funding[i].expiresAt),
    id: funding[i].lotId,
  }));
  remainders.sort((a, b) => (a.remainder === b.remainder ? a.expiry - b.expiry || a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1));
  let cursor = 0;
  while (remaining > 0) {
    result[remainders[cursor].i].amount++;
    remaining--;
    cursor = (cursor + 1) % remainders.length;
  }
  return result;
}

/** A transfer may never dilute the receiving lot's outstanding playthrough. */
export function splitObligation(outstanding: number, movedAmount: number, availableBefore: number): { moved: number; retained: number } {
  if (!Number.isSafeInteger(outstanding) || outstanding < 0) throw new RangeError('outstanding must be nonnegative');
  positiveInteger(movedAmount, 'movedAmount');
  positiveInteger(availableBefore, 'availableBefore');
  if (movedAmount > availableBefore) throw new RangeError('cannot move more than available');
  const numerator = BigInt(outstanding) * BigInt(movedAmount);
  const moved = Number((numerator + BigInt(availableBefore) - 1n) / BigInt(availableBefore));
  return { moved, retained: outstanding - moved };
}
