/** Salem's original practice rules; not the vendor's proprietary payout table. */
export const ROULETTE_KENO_RULES = Object.freeze({
  id: 'roulette-keno-90-v1',
  balls: 72,
  drawn: 18,
  roundMs: 90_000,
  entryMs: 60_000,
  revealMs: 1000,
  maxTickets: 10,
  maxStake: 500,
  initialBalance: 1000,
});
export const RK_MARKETS = ['NUMBERS', 'COLOR', 'PARITY', 'RANGE', 'ROW', 'COLUMN'] as const;
export type RouletteKenoMarket = (typeof RK_MARKETS)[number];
const red36 = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export function rkColor(n: number): 'RED' | 'BLACK' {
  return red36.has(((n - 1) % 36) + 1) ? 'RED' : 'BLACK';
}
export function rkNumbers(market: RouletteKenoMarket, selection: number): number[] {
  return Array.from({ length: 72 }, (_, i) => i + 1).filter((n) =>
    market === 'NUMBERS'
      ? n === selection
      : market === 'COLOR'
        ? rkColor(n) === (selection === 1 ? 'RED' : 'BLACK')
        : market === 'PARITY'
          ? n % 2 === (selection === 1 ? 1 : 0)
          : market === 'RANGE'
            ? (n <= 36 ? 1 : 2) === selection
            : market === 'ROW'
              ? Math.ceil(n / 12) === selection
              : Math.ceil(n / 18) === selection
  );
}
export const RK_LABELS: Record<RouletteKenoMarket, string> = {
  NUMBERS: 'Numbers',
  COLOR: 'Color',
  PARITY: 'Odd / even',
  RANGE: 'Low / high',
  ROW: 'Rows',
  COLUMN: 'Columns',
};
export function rkSelectionLabel(market: RouletteKenoMarket, picks: number[]): string {
  const n = picks[0];
  if (market === 'NUMBERS') return picks.join(' · ');
  if (!n) return 'Choose a selection';
  if (market === 'COLOR') return n === 1 ? 'Red' : 'Black';
  if (market === 'PARITY') return n === 1 ? 'Odd' : 'Even';
  if (market === 'RANGE') return n === 1 ? 'Low · 1–36' : 'High · 37–72';
  if (market === 'ROW') return `Row ${'ABCDEF'[n - 1]} · ${(n - 1) * 12 + 1}–${n * 12}`;
  return `Column ${n} · ${(n - 1) * 18 + 1}–${n * 18}`;
}
/** Tenths, so valid stakes in steps of five always settle to whole practice ETB. */
export function rkMultiplierTenths(market: RouletteKenoMarket): number {
  return market === 'ROW' ? 54 : market === 'NUMBERS' || market === 'COLUMN' ? 36 : 18;
}
export function rkValidate(
  market: unknown,
  picks: unknown,
  amount: unknown
): { market: RouletteKenoMarket; picks: number[]; amount: number; stake: number } {
  if (!RK_MARKETS.includes(market as RouletteKenoMarket)) throw Error('Choose a valid market.');
  const m = market as RouletteKenoMarket;
  const max = m === 'NUMBERS' ? 72 : m === 'ROW' ? 6 : m === 'COLUMN' ? 4 : 2;
  if (
    !Array.isArray(picks) ||
    !picks.length ||
    picks.length > (m === 'NUMBERS' ? 10 : 1) ||
    new Set(picks).size !== picks.length ||
    picks.some((n) => !Number.isInteger(n) || n < 1 || n > max)
  )
    throw Error(
      m === 'NUMBERS'
        ? 'Choose 1–10 different numbers from 1–72.'
        : 'Choose one option for this market.'
    );
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount < 5 ||
    amount % 5 ||
    amount * picks.length > 500
  )
    throw Error('Use amounts in steps of 5, up to 500 practice ETB per bet.');
  return {
    market: m,
    picks: [...picks].sort((a, b) => a - b),
    amount,
    stake: amount * picks.length,
  };
}
export function rkPayout(
  ticket: Pick<RouletteKenoTicket, 'market' | 'picks' | 'amount'>,
  draw: number[]
): number {
  const hits =
    ticket.market === 'NUMBERS'
      ? ticket.picks.filter((n) => draw.includes(n)).length
      : Number(!!draw.length && rkNumbers(ticket.market, ticket.picks[0]).includes(draw[0]));
  return (hits * ticket.amount * rkMultiplierTenths(ticket.market)) / 10;
}
export interface RouletteKenoEntry {
  roundId: string;
  slot: number;
  market: RouletteKenoMarket;
  picks: number[];
  amount: number;
}
export interface RouletteKenoTicket extends RouletteKenoEntry {
  id: string;
  stake: number;
  payout: number | null;
}
export interface RouletteKenoRound {
  id: string;
  opensAt: number;
  closesAt: number;
  endsAt: number;
  /** Only already-released numbers, never the hidden remaining outcome. */
  revealed: number[];
  complete: boolean;
  tickets: RouletteKenoTicket[];
}
export interface RouletteKenoSnapshot {
  enabled: boolean;
  rulesId: string;
  serverTime: number;
  balance: number;
  maxTickets: number;
  rounds: RouletteKenoRound[];
}
