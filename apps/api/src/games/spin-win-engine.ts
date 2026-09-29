import { randomInt } from 'node:crypto';
import { SPIN_RULES_ID, parseSpinBets, settleSpinBets } from '@socialplay/shared';

/** Called with the immutable rules row; legacy multiplier tables are rejected. */
export function generateSpinWinResult(stake: number, rawRules: unknown, selections: unknown) {
  if (
    !rawRules ||
    typeof rawRules !== 'object' ||
    (rawRules as Record<string, unknown>).rulesId !== SPIN_RULES_ID
  ) {
    throw new Error('Spin Win has no supported rules');
  }
  const bets = parseSpinBets(selections);
  if (bets.reduce((sum, bet) => sum + bet.amount, 0) !== stake)
    throw new Error('Spin Win stake does not match bets');
  const settled = settleSpinBets(bets, randomInt(37));
  return {
    result: { ...settled, rulesId: SPIN_RULES_ID },
    rewardAmount: settled.payout,
    isWin: settled.payout > 0,
  };
}
