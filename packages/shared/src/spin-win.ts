/** Original single-zero Spin Win rules. Payouts below INCLUDE returned stake. */
export const SPIN_WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
] as const;
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export function spinColour(number: number): 'green' | 'red' | 'black' {
  if (!Number.isInteger(number) || number < 0 || number > 36)
    throw new Error('Invalid wheel number');
  return number === 0 ? 'green' : RED.has(number) ? 'red' : 'black';
}
export interface SpinMarket {
  id: string;
  label: string;
  numbers: readonly number[];
  grossMultiplier: number;
}
const range = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i);
const all = range(1, 36);
export const SPIN_MARKETS: readonly SpinMarket[] = [
  ...range(0, 37).map((n) => ({
    id: `number:${n}`,
    label: `${n}`,
    numbers: [n],
    grossMultiplier: 36,
  })),
  ...range(0, 6).map((i) => ({
    id: `sector:${i}`,
    label: `Sector ${String.fromCharCode(65 + i)} · ${i * 6 + 1}–${i * 6 + 6}`,
    numbers: range(i * 6 + 1, 6),
    grossMultiplier: 6,
  })),
  ...range(0, 3).map((i) => ({
    id: `dozen:${i}`,
    label: `${i * 12 + 1}–${i * 12 + 12}`,
    numbers: range(i * 12 + 1, 12),
    grossMultiplier: 3,
  })),
  { id: 'red', label: 'Red', numbers: all.filter((n) => RED.has(n)), grossMultiplier: 2 },
  { id: 'black', label: 'Black', numbers: all.filter((n) => !RED.has(n)), grossMultiplier: 2 },
  { id: 'odd', label: 'Odd', numbers: all.filter((n) => n % 2 === 1), grossMultiplier: 2 },
  { id: 'even', label: 'Even', numbers: all.filter((n) => n % 2 === 0), grossMultiplier: 2 },
  { id: 'low', label: '1–18', numbers: range(1, 18), grossMultiplier: 2 },
  { id: 'high', label: '19–36', numbers: range(19, 18), grossMultiplier: 2 },
];
export interface SpinBet {
  marketId: string;
  amount: number;
}
export const SPIN_RULES_ID = 'single-zero-standard-v1';
export const SPIN_MAX_TOTAL = 1_000_000;
export function parseSpinBets(value: unknown): SpinBet[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SPIN_MARKETS.length)
    throw new Error('Choose at least one valid bet');
  const ids = new Set<string>();
  let total = 0;
  const bets = value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid bet');
    const { marketId, amount } = raw as Record<string, unknown>;
    if (
      typeof marketId !== 'string' ||
      !SPIN_MARKETS.some((m) => m.id === marketId) ||
      ids.has(marketId)
    )
      throw new Error('Invalid or duplicate market');
    if (
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > SPIN_MAX_TOTAL
    )
      throw new Error('Bet amounts must be positive whole numbers');
    ids.add(marketId);
    total += amount;
    if (total > SPIN_MAX_TOTAL) throw new Error('Total bet exceeds limit');
    return { marketId, amount };
  });
  return bets.sort((a, b) => a.marketId.localeCompare(b.marketId, 'en'));
}
export function settleSpinBets(value: unknown, number: number) {
  const colour = spinColour(number);
  const bets = parseSpinBets(value);
  const lines = bets.map((bet) => {
    const market = SPIN_MARKETS.find((entry) => entry.id === bet.marketId)!;
    return {
      ...bet,
      payout: market.numbers.includes(number) ? bet.amount * market.grossMultiplier : 0,
    };
  });
  const stake = bets.reduce((sum, bet) => sum + bet.amount, 0);
  const payout = lines.reduce((sum, line) => sum + line.payout, 0);
  return { number, colour, lines, stake, payout, net: payout - stake };
}
