import { SPIN_MARKETS, parseSpinBets, spinColour } from './spin-win.js';

/** Versioned, uniform 37-pocket rules. Returns include stake; no payout rounding. */
export const SPIN90_RULES_ID = 'single-zero-rtp90-v2';
export const SPIN90_BET_STEP = 40;
export const SPIN90_MARKETS = SPIN_MARKETS.map((market) => ({
  ...market,
  // A 40-Coin line pays 1332 / coveredNumbers on a win.
  payoutPerUnit: 1332 / market.numbers.length,
  grossMultiplier: 1332 / market.numbers.length / SPIN90_BET_STEP,
}));
export function parseSpin90Bets(value: unknown) {
  const bets = parseSpinBets(value);
  if (bets.some((bet) => bet.amount % SPIN90_BET_STEP !== 0))
    throw new Error('Each Spin Win bet must be a multiple of 40');
  return bets;
}
export function settleSpin90Bets(value: unknown, number: number) {
  const colour = spinColour(number);
  const bets = parseSpin90Bets(value);
  const lines = bets.map((bet) => {
    const market = SPIN90_MARKETS.find((entry) => entry.id === bet.marketId)!;
    return {
      ...bet,
      payout: market.numbers.includes(number)
        ? (bet.amount / SPIN90_BET_STEP) * market.payoutPerUnit
        : 0,
    };
  });
  const stake = bets.reduce((sum, bet) => sum + bet.amount, 0);
  const payout = lines.reduce((sum, line) => sum + line.payout, 0);
  return { number, colour, lines, stake, payout, net: payout - stake };
}
