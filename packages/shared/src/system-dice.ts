/** Two independent fair dice. Exactly 21 of 36 outcomes have a sum >= 7. */
export const SYSTEM_DICE_RULES = Object.freeze({
  id: 'dice-sum7-practice90-v1', stakeStep: 35, returnPerStep: 54,
  minStake: 35, maxStake: 490, threshold: 7, initialBalance: 1000,
  roundMs: 60_000, bettingMs: 45_000, revealMs: 10_000,
});
export function parseDiceStake(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < SYSTEM_DICE_RULES.minStake ||
      value > SYSTEM_DICE_RULES.maxStake || value % SYSTEM_DICE_RULES.stakeStep !== 0) {
    throw new RangeError('Use 35–490 practice credits, in steps of 35');
  }
  return value;
}
export function settleDicePractice(stake: number, outcome: readonly number[]): number {
  parseDiceStake(stake);
  if (outcome.length !== 2 || outcome.some(n => !Number.isInteger(n) || n < 1 || n > 6)) {
    throw new RangeError('Two dice from 1 to 6 are required');
  }
  return outcome[0] + outcome[1] >= SYSTEM_DICE_RULES.threshold ? stake / 35 * 54 : 0;
}
export interface SystemDiceRound {
  id: string; opensAt: number; closesAt: number; endsAt: number;
  outcome: [number, number] | null;
  ticket: { stake: number; payout: number | null } | null;
}
export interface SystemDiceSnapshot {
  enabled: boolean; rulesId: string; serverTime: number; balance: number;
  rounds: SystemDiceRound[];
}
