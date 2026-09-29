import { randomInt } from 'node:crypto';
import {
  SPIN_RULES_ID,
  SPIN90_RULES_ID,
  parseSpinBets,
  settleSpinBets,
  parseSpin90Bets,
  settleSpin90Bets,
} from '@socialplay/shared';

/** Called with the immutable rules row; legacy multiplier tables are rejected. */
export function generateSpinWinResult(stake: number, rawRules: unknown, selections: unknown) {
  if (
    !rawRules ||
    typeof rawRules !== 'object' ||
    ![SPIN_RULES_ID, SPIN90_RULES_ID].includes(
      (rawRules as Record<string, unknown>).rulesId as string
    )
  ) {
    throw new Error('Spin Win has no supported rules');
  }
  const rulesId = (rawRules as Record<string, unknown>).rulesId;
  const bets =
    rulesId === SPIN90_RULES_ID ? parseSpin90Bets(selections) : parseSpinBets(selections);
  if (bets.reduce((sum, bet) => sum + bet.amount, 0) !== stake)
    throw new Error('Spin Win stake does not match bets');
  const settled = (rulesId === SPIN90_RULES_ID ? settleSpin90Bets : settleSpinBets)(
    bets,
    randomInt(37)
  );
  return {
    result: { ...settled, rulesId },
    rewardAmount: settled.payout,
    isWin: settled.payout > 0,
  };
}
