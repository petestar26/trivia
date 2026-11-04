/** Salem's published practice rules, independent of any vendor's game or payout table. */
export const LUCKY_SIX_RULES = Object.freeze({
  id: 'lucky-six-300-v1',
  balls: 48,
  drawn: 35,
  roundMs: 300_000,
  entryMs: 210_000,
  revealMs: 2000,
  maxTickets: 10,
  maxStake: 500,
  initialBalance: 1000,
});
export const LS_COLORS = [
  { name: 'Red', hex: '#e75b68' },
  { name: 'Green', hex: '#4fbd88' },
  { name: 'Blue', hex: '#639bed' },
  { name: 'Purple', hex: '#b38de3' },
  { name: 'Gold', hex: '#e6bf60' },
  { name: 'Orange', hex: '#ed9560' },
  { name: 'Teal', hex: '#57c5c5' },
  { name: 'Pink', hex: '#e48ab9' },
] as const;
export const LS_MARKETS = [
  'SIX',
  'ALL_COLORS',
  'PRE_NUMBER',
  'FIRST_COLOR',
  'LAST_COLOR',
  'MOST_COLOR',
  'FIRST_PARITY',
  'FIRST_RANGE',
  'PRE_PARITY',
  'PRE_SUM',
  'DRAW_PARITY',
] as const;
export type LuckySixMarket = (typeof LS_MARKETS)[number];
export const LS_LABELS: Record<LuckySixMarket, string> = {
  SIX: 'Pick six',
  ALL_COLORS: 'All colors',
  PRE_NUMBER: 'First 5 · number',
  FIRST_COLOR: 'First color',
  LAST_COLOR: 'Last color',
  MOST_COLOR: 'Most color',
  FIRST_PARITY: 'First · odd / even',
  FIRST_RANGE: 'First · low / high',
  PRE_PARITY: 'First 5 · odd / even',
  PRE_SUM: 'First 5 · sum',
  DRAW_PARITY: 'Draw · odd / even',
};
export const LS_DESCRIPTIONS: Record<LuckySixMarket, string> = {
  SIX: 'Pick exactly six numbers. Match all six in the 35-ball draw. Earlier completion returns more.',
  ALL_COLORS:
    'Eight six-number lines, one for each color. The amount applies to each line; total cost is eight times the amount.',
  PRE_NUMBER: 'Choose one number to appear among the first five balls.',
  FIRST_COLOR: 'Choose the color of ball 1.',
  LAST_COLOR: 'Choose the color of ball 35.',
  MOST_COLOR:
    'Choose the most frequent color among all 35 balls. If the lead is tied, every bet on this market is refunded.',
  FIRST_PARITY: 'Predict whether ball 1 is odd or even.',
  FIRST_RANGE: 'Predict whether ball 1 is low (1–24) or high (25–48).',
  PRE_PARITY: 'Predict whether at least three of the first five balls are odd or even.',
  PRE_SUM: 'Predict whether the sum of the first five balls is under or over 122.5.',
  DRAW_PARITY: 'Predict whether at least 18 of the 35 balls are odd or even.',
};
/** Gross return in tenths, indexed by the position of the sixth match minus six. */
export const LS_SIX_TENTHS = [
  150000, 75000, 40000, 25000, 16000, 8000, 5000, 3200, 2400, 1600, 1200, 960, 640, 480, 400, 320,
  240, 200, 160, 120, 100, 80, 60, 50, 40, 32, 28, 24, 20, 18,
] as const;
export function lsColor(n: number): number {
  return (n - 1) % 8;
}
export function lsColorNumbers(color: number): number[] {
  return Array.from({ length: 6 }, (_, i) => color + 1 + i * 8);
}
export function lsCompletion(picks: readonly number[], draw: readonly number[]): number | null {
  if (picks.length !== 6) return null;
  const positions = picks.map((n) => draw.indexOf(n));
  return positions.some((p) => p < 0) ? null : Math.max(...positions) + 1;
}
export function lsStake(market: LuckySixMarket, amount: number): number {
  return amount * (market === 'ALL_COLORS' ? 8 : 1);
}
export function lsFixedTenths(market: LuckySixMarket): number | null {
  if (market === 'SIX' || market === 'ALL_COLORS') return null;
  return market === 'PRE_NUMBER' ? 86 : market.endsWith('COLOR') ? 72 : 18;
}
export function lsSelectionLabel(market: LuckySixMarket, picks: number[]): string {
  const n = picks[0];
  if (market === 'ALL_COLORS') return 'All eight color lines';
  if (!n) return 'Choose a selection';
  if (market === 'SIX') return picks.join(' · ');
  if (market === 'PRE_NUMBER') return `Number ${n} in the first five`;
  if (market.endsWith('COLOR')) return LS_COLORS[n - 1]?.name ?? 'Choose a color';
  if (market === 'FIRST_RANGE') return n === 1 ? 'Low · 1–24' : 'High · 25–48';
  if (market === 'PRE_SUM') return n === 1 ? 'Under 122.5' : 'Over 122.5';
  return n === 1 ? 'Odd' : 'Even';
}
export function lsValidate(market: unknown, picks: unknown, amount: unknown) {
  if (!LS_MARKETS.includes(market as LuckySixMarket)) throw Error('Choose a valid market.');
  const m = market as LuckySixMarket;
  const limit =
    m === 'SIX' || m === 'PRE_NUMBER' ? 48 : m.endsWith('COLOR') ? 8 : m === 'ALL_COLORS' ? 1 : 2;
  if (
    !Array.isArray(picks) ||
    picks.length !== (m === 'SIX' ? 6 : 1) ||
    new Set(picks).size !== picks.length ||
    picks.some((n) => !Number.isInteger(n) || n < 1 || n > limit)
  )
    throw Error(
      m === 'SIX'
        ? 'Choose exactly six different numbers from 1–48.'
        : 'Choose one valid option for this market.'
    );
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount < 5 ||
    amount % 5 ||
    lsStake(m, amount) > 500
  )
    throw Error('Use steps of 5, up to 500 practice ETB total. All colors costs eight amounts.');
  return {
    market: m,
    picks: [...picks].sort((a, b) => a - b) as number[],
    amount,
    stake: lsStake(m, amount),
  };
}
export function lsPayout(
  ticket: Pick<LuckySixTicket, 'market' | 'picks' | 'amount'>,
  draw: readonly number[]
): number {
  // Never settle a partial or malformed result, including first-ball markets.
  if (
    draw.length !== 35 ||
    new Set(draw).size !== 35 ||
    draw.some((n) => !Number.isInteger(n) || n < 1 || n > 48)
  )
    throw Error('A complete 35-ball draw is required.');
  const { market, picks, amount } = ticket;
  const sixReturn = (line: number[]) => {
    const position = lsCompletion(line, draw);
    return position === null ? 0 : (amount * LS_SIX_TENTHS[position - 6]) / 10;
  };
  if (market === 'SIX') return sixReturn(picks);
  if (market === 'ALL_COLORS')
    return LS_COLORS.reduce((total, _, i) => total + sixReturn(lsColorNumbers(i)), 0);
  const choice = picks[0],
    first = draw[0],
    pre = draw.slice(0, 5);
  if (market === 'MOST_COLOR') {
    const counts = LS_COLORS.map((_, i) => draw.filter((n) => lsColor(n) === i).length);
    const top = Math.max(...counts);
    if (counts.filter((n) => n === top).length > 1) return amount;
    return counts[choice - 1] === top ? (amount * 72) / 10 : 0;
  }
  const won =
    market === 'PRE_NUMBER'
      ? pre.includes(choice)
      : market === 'FIRST_COLOR'
        ? lsColor(first) + 1 === choice
        : market === 'LAST_COLOR'
          ? lsColor(draw[34]) + 1 === choice
          : market === 'FIRST_PARITY'
            ? (first % 2 === 1) === (choice === 1)
            : market === 'FIRST_RANGE'
              ? first <= 24 === (choice === 1)
              : market === 'PRE_PARITY'
                ? pre.filter((n) => n % 2 === 1).length >= 3 === (choice === 1)
                : market === 'PRE_SUM'
                  ? pre.reduce((a, n) => a + n, 0) < 122.5 === (choice === 1)
                  : draw.filter((n) => n % 2 === 1).length >= 18 === (choice === 1);
  return won ? (amount * lsFixedTenths(market)!) / 10 : 0;
}
export interface LuckySixEntry {
  roundId: string;
  slot: number;
  market: LuckySixMarket;
  picks: number[];
  amount: number;
}
export interface LuckySixTicket extends LuckySixEntry {
  id: string;
  stake: number;
  payout: number | null;
}
export interface LuckySixRound {
  id: string;
  opensAt: number;
  closesAt: number;
  endsAt: number;
  /** Only already released numbers. */
  revealed: number[];
  complete: boolean;
  tickets: LuckySixTicket[];
}
export interface LuckySixSnapshot {
  enabled: boolean;
  rulesId: string;
  serverTime: number;
  balance: number;
  maxTickets: number;
  rounds: LuckySixRound[];
}
