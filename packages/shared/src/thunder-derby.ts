/** Original practice rules; no Coins, cash prizes, jackpots or paid entry. */
export const DERBY_RULES = Object.freeze({
  id: 'thunder-derby-uniform90-v1',
  initialBalance: 1000,
  minStake: 10,
  maxStake: 500,
  raceMs: 45000,
  resultMs: 15000,
});
export const DERBY_MARKETS = [
  'WIN',
  'PERFECTA',
  'QUINELLA',
  'TRIFECTA',
  'TOP3',
  'UNDER',
  'OVER',
  'ODD',
  'EVEN',
] as const;
export type DerbyMarket = (typeof DERBY_MARKETS)[number];
export type DerbyField = 6 | 8;
export const DERBY_LABELS: Record<DerbyMarket, string> = {
  WIN: 'Winner',
  PERFECTA: 'Perfecta',
  QUINELLA: 'Quinella',
  TRIFECTA: 'Trifecta',
  TOP3: 'In first 3',
  UNDER: 'Lower half',
  OVER: 'Upper half',
  ODD: 'Odd',
  EVEN: 'Even',
};
export const DERBY_HELP: Record<DerbyMarket, string> = {
  WIN: 'Choose the winning horse.',
  PERFECTA: 'Choose first and second in the exact order.',
  QUINELLA: 'Choose the first two horses in either order.',
  TRIFECTA: 'Choose first, second and third in the exact order.',
  TOP3: 'Choose one horse to finish in the first three.',
  UNDER: 'The winner is in the lower half of runner numbers.',
  OVER: 'The winner is in the upper half of runner numbers.',
  ODD: 'The winner has an odd runner number.',
  EVEN: 'The winner has an even runner number.',
};
export const DERBY_HORSES = [
  { name: 'Royal Ember', color: '#e95c59' },
  { name: 'Midnight Blue', color: '#4d8dff' },
  { name: 'Silver Comet', color: '#e8edf2' },
  { name: 'Onyx Storm', color: '#8c85a7' },
  { name: 'Golden Hour', color: '#f6c55e' },
  { name: 'Emerald Run', color: '#4dd5a1' },
  { name: 'Desert Rose', color: '#ec8dc2' },
  { name: 'Violet Crown', color: '#af8aff' },
] as const;
export function derbySelectionCount(market: DerbyMarket) {
  return market === 'TRIFECTA'
    ? 3
    : market === 'PERFECTA' || market === 'QUINELLA'
      ? 2
      : market === 'WIN' || market === 'TOP3'
        ? 1
        : 0;
}
export function derbyOddsCents(field: DerbyField, market: DerbyMarket) {
  switch (market) {
    case 'WIN':
      return field * 90;
    case 'TOP3':
      return field * 30;
    case 'PERFECTA':
      return field * (field - 1) * 90;
    case 'QUINELLA':
      return field * (field - 1) * 45;
    case 'TRIFECTA':
      return field * (field - 1) * (field - 2) * 90;
    default:
      return 180;
  }
}
export function parseDerbyEntry(field: unknown, market: unknown, picks: unknown, stake: unknown) {
  if (field !== 6 && field !== 8) throw Error('Choose a six- or eight-horse race');
  if (!DERBY_MARKETS.includes(market as DerbyMarket)) throw Error('Choose a valid selection type');
  const type = market as DerbyMarket;
  if (
    !Array.isArray(picks) ||
    picks.length !== derbySelectionCount(type) ||
    picks.some((p) => !Number.isInteger(p) || p < 1 || p > field) ||
    new Set(picks).size !== picks.length
  )
    throw Error('Choose distinct horses for every position');
  if (typeof stake !== 'number' || !Number.isInteger(stake) || stake < 10 || stake > 500)
    throw Error('Enter 10–500 whole practice credits');
  return {
    field: field as DerbyField,
    market: type,
    picks:
      type === 'QUINELLA'
        ? ([...picks].sort((a, b) => a - b) as number[])
        : ([...picks] as number[]),
    stake,
  };
}
export function derbyWins(market: DerbyMarket, picks: number[], order: number[]) {
  switch (market) {
    case 'WIN':
      return order[0] === picks[0];
    case 'TOP3':
      return order.slice(0, 3).includes(picks[0]);
    case 'PERFECTA':
    case 'TRIFECTA':
      return picks.every((p, i) => order[i] === p);
    case 'QUINELLA':
      return picks.every((p) => order.slice(0, 2).includes(p));
    case 'UNDER':
      return order[0] <= order.length / 2;
    case 'OVER':
      return order[0] > order.length / 2;
    case 'ODD':
      return order[0] % 2 === 1;
    case 'EVEN':
      return order[0] % 2 === 0;
  }
}
export interface DerbyTicket {
  market: DerbyMarket;
  picks: number[];
  stake: number;
  oddsCents: number;
  payout: number | null;
}
export interface DerbyRound {
  id: string;
  field: DerbyField;
  opensAt: number;
  startsAt: number;
  finishesAt: number;
  endsAt: number;
  commitment: string;
  order: number[] | null;
  seed: string | null;
  positions: number[];
  ticket: DerbyTicket | null;
}
export interface DerbySnapshot {
  rulesId: string;
  serverTime: number;
  balance: number;
  rounds: DerbyRound[];
}
