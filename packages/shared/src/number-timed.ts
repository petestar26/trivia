import { numberScore } from './number-challenge.js';

export const NUMBER_TIMED_RULES_ID = 'number-challenge-timed-v2';
export const NUMBER_ROUND_MS = 60_000;
export const NUMBER_ENTRY_MS = 30_000;
export interface NumberTimedEntry {
  requestId: string;
  roundId: string;
  guess: number;
  rulesId: typeof NUMBER_TIMED_RULES_ID;
}
export interface NumberTimedRound {
  id: string;
  opensAt: string;
  closesAt: string;
  endsAt: string;
  target: number | null;
}
export interface NumberTimedReceipt {
  id: string;
  roundId: string;
  guess: number;
  createdAt: string;
  target: number | null;
  away: number | null;
  score: number | null;
}
export interface NumberTimedSnapshot {
  rulesId: typeof NUMBER_TIMED_RULES_ID;
  serverNow: string;
  round: NumberTimedRound | null;
  receipt: NumberTimedReceipt | null;
  history: NumberTimedReceipt[];
}
export function parseNumberTimedEntry(value: unknown): NumberTimedEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid guess.');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'guess,requestId,roundId,rulesId' ||
    typeof v.requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{16,64}$/.test(v.requestId) ||
    typeof v.roundId !== 'string' ||
    !/^number-v2:[0-9]{1,12}$/.test(v.roundId) ||
    v.rulesId !== NUMBER_TIMED_RULES_ID ||
    typeof v.guess !== 'number'
  )
    throw Error('Invalid guess or rules version.');
  numberScore(v.guess, 1);
  return v as unknown as NumberTimedEntry;
}
