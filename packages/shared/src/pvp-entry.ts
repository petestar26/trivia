import { PVP_GAME_POLICY } from './house-game-policy.js';

const MAX_LEDGER_UNITS = 9_223_372_036_854_775_807n;

/**
 * Disclosure quote for the pinned PVP policy, in smallest ledger units.
 * Decimal strings keep JSON and browser transport exact. This is not proof of
 * funding or admission: a server must recompute it before accepting an entry.
 */
export function quotePvpEntry(policyId: string, entryAmount: string) {
  if (policyId !== PVP_GAME_POLICY.id) throw new RangeError('Unsupported PVP entry policy');
  if (typeof entryAmount !== 'string' || entryAmount.trim() !== entryAmount ||
      !/^[1-9][0-9]{0,18}$/.test(entryAmount)) {
    throw new RangeError('Entry must be a positive whole-unit decimal string');
  }
  const amount = BigInt(entryAmount);
  if (amount > MAX_LEDGER_UNITS) throw new RangeError('Entry exceeds the ledger limit');
  if (amount % BigInt(PVP_GAME_POLICY.entryStepUnits) !== 0n) {
    throw new RangeError(`Entry must be a multiple of ${PVP_GAME_POLICY.entryStepUnits} ledger units`);
  }
  const fee = amount * BigInt(PVP_GAME_POLICY.entryFeeBps) / 10_000n;
  return Object.freeze({
    policyId: PVP_GAME_POLICY.id,
    entryAmount,
    platformFee: fee.toString(),
    prizeContribution: (amount - fee).toString(),
    voidRefundAmount: entryAmount,
    feeChargeOn: PVP_GAME_POLICY.chargeOn,
    additionalWinnerFeeBps: PVP_GAME_POLICY.additionalWinnerFeeBps,
  });
}
