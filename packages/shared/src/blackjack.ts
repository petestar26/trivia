/** Salem's original six-seat prediction table. All balances are nonredeemable practice ETB. */
export const BLACKJACK_RULES = Object.freeze({
  id: 'blackjack-six-seat-160-v1',
  roundMs: 160000,
  stageMs: 40000,
  maxTickets: 10,
  initialBalance: 1000,
  decks: 6,
});
export const BJ_MARKETS = [
  'WIN',
  'DRAW',
  'LOSE',
  'P17',
  'P18',
  'P19',
  'P20',
  'P21',
  'BLACKJACK',
  'BUST',
] as const;
export type BlackjackMarket = (typeof BJ_MARKETS)[number];
export const BJ_LABELS: Record<BlackjackMarket, string> = {
  WIN: 'Win',
  DRAW: 'Draw',
  LOSE: 'Lose',
  P17: '17',
  P18: '18',
  P19: '19',
  P20: '20',
  P21: '21',
  BLACKJACK: 'Blackjack',
  BUST: 'Bust',
};
export const BJ_SUITS = ['♠', '♥', '♣', '♦'] as const;
export const BJ_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export function bjCard(card: number) {
  return {
    rank: BJ_RANKS[card % 13],
    suit: BJ_SUITS[Math.floor(card / 13) % 4],
    red: Math.floor(card / 13) % 2 === 1,
  };
}
export function bjTotal(cards: readonly number[]) {
  let total = 0,
    aces = 0;
  for (const card of cards) {
    const rank = card % 13;
    total += rank === 0 ? 11 : Math.min(rank + 1, 10);
    if (rank === 0) aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0, blackjack: cards.length === 2 && total === 21, bust: total > 21 };
}
export function bjCategory(cards: readonly number[]): BlackjackMarket {
  const v = bjTotal(cards);
  if (v.blackjack) return 'BLACKJACK';
  if (v.bust) return 'BUST';
  if (v.total < 17) throw Error('Hand is not complete');
  return `P${v.total}` as BlackjackMarket;
}
export function bjResult(
  player: readonly number[],
  dealer: readonly number[]
): 'WIN' | 'DRAW' | 'LOSE' {
  const p = bjTotal(player),
    d = bjTotal(dealer);
  if (p.bust) return 'LOSE';
  if (d.bust) return 'WIN';
  if (p.blackjack !== d.blackjack) return p.blackjack ? 'WIN' : 'LOSE';
  return p.total === d.total ? 'DRAW' : p.total > d.total ? 'WIN' : 'LOSE';
}
export function bjKey(seat: number, market: BlackjackMarket) {
  return `${seat}:${market}`;
}
export function bjSelection(seat: number, market: BlackjackMarket) {
  return `${seat === 0 ? 'Dealer' : `Seat ${seat}`} · ${BJ_LABELS[market]}`;
}
export interface BlackjackEntry {
  roundId: string;
  slot: number;
  stage: number;
  seat: number;
  market: BlackjackMarket;
  amount: number;
  odds: number;
}
export function bjValidate(e: BlackjackEntry) {
  if (
    !e ||
    typeof e.roundId !== 'string' ||
    !e.roundId.length ||
    e.roundId.length > 64 ||
    !Number.isInteger(e.slot) ||
    e.slot < 1 ||
    e.slot > 10 ||
    !Number.isInteger(e.stage) ||
    e.stage < 0 ||
    e.stage > 2 ||
    !Number.isInteger(e.seat) ||
    e.seat < 0 ||
    e.seat > 6 ||
    !BJ_MARKETS.includes(e.market) ||
    (e.seat === 0 && ['WIN', 'DRAW', 'LOSE'].includes(e.market))
  )
    throw Error('Choose a valid table, bet and selection.');
  if (!Number.isInteger(e.amount) || e.amount < 5 || e.amount > 500 || e.amount % 5)
    throw Error('Choose 5–500 practice ETB, in steps of 5.');
  if (!Number.isInteger(e.odds) || e.odds < 101 || e.odds > 20000)
    throw Error('Choose an available price.');
  return e;
}
export function bjWon(seat: number, market: BlackjackMarket, hands: readonly number[][]) {
  return ['WIN', 'DRAW', 'LOSE'].includes(market)
    ? bjResult(hands[seat], hands[0]) === market
    : bjCategory(hands[seat]) === market;
}
export interface BlackjackTicket extends BlackjackEntry {
  id: string;
  payout: number | null;
}
export interface BlackjackRound {
  id: string;
  opensAt: number;
  endsAt: number;
  stage: number;
  hands: number[][];
  quotes: Record<string, number>;
  tickets: BlackjackTicket[];
}
export interface BlackjackSnapshot {
  enabled: boolean;
  rulesId: string;
  serverTime: number;
  balance: number;
  maxTickets: number;
  rounds: BlackjackRound[];
}
