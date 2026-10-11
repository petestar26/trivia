/** Isolated practice scores: never Coins, Game Points, stakes or redeemable rewards. */
export const NUMBER_RULES_ID = 'number-challenge-practice-v1';
export const NUMBER_BANDS = [
  { distance: 0, score: 100, label: 'Exact match' },
  { distance: 1, score: 60, label: '1 away' },
  { distance: 5, score: 40, label: '2–5 away' },
  { distance: 10, score: 20, label: '6–10 away' },
  { distance: 99, score: 0, label: 'More than 10 away' },
] as const;
export function numberScore(guess: number, target: number) {
  if (![guess, target].every((n) => Number.isInteger(n) && n >= 1 && n <= 100))
    throw new Error('Choose a whole number from 1 to 100.');
  const away = Math.abs(guess - target);
  return { away, score: NUMBER_BANDS.find((b) => away <= b.distance)!.score };
}
export interface NumberEntry {
  requestId: string;
  guess: number;
  rulesId: typeof NUMBER_RULES_ID;
}
export function parseNumberEntry(value: unknown): NumberEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid guess.');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'guess,requestId,rulesId' ||
    typeof v.requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{16,64}$/.test(v.requestId) ||
    v.rulesId !== NUMBER_RULES_ID ||
    typeof v.guess !== 'number'
  )
    throw new Error('Invalid guess or rules version.');
  numberScore(v.guess, 1);
  return v as unknown as NumberEntry;
}
export interface NumberRound {
  id: string;
  guess: number;
  target: number;
  away: number;
  score: number;
  createdAt: string;
  rulesId: string;
}
export interface NumberSnapshot {
  rulesId: string;
  rounds: NumberRound[];
}
