import { KENO_90_RULES } from '@socialplay/shared';

export const KENO_MAX_PRACTICE_STAKE = 480;
export function parseKenoStake(value: string): number {
  if (!/^\d+$/.test(value)) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= KENO_90_RULES.stakeStep && n <= KENO_MAX_PRACTICE_STAKE && n % KENO_90_RULES.stakeStep === 0 ? n : 0;
}
export const KENO_INTERVAL = 650;
export type KenoRound = { id: number; picks: number[]; numbers: number[]; startedAt: number; stakePerNumber: number };
export type KenoState = { version: 2; balance: number; nextId: number; active: KenoRound | null; history: KenoRound[] };
export const newKenoState = (): KenoState => ({ version: 2, balance: 1000, nextId: 1, active: null, history: [] });
export function drawKeno(): number[] {
  const pool = Array.from({ length: 80 }, (_, i) => i + 1);
  const word = new Uint32Array(1);
  for (let i = 0; i < 20; i++) {
    const range = 80 - i;
    const limit = Math.floor(2 ** 32 / range) * range;
    do { crypto.getRandomValues(word); } while (word[0] >= limit);
    const j = i + word[0] % range;
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 20);
}
function validNumbers(values: unknown, min: number, max: number): values is number[] {
  return Array.isArray(values) && values.length >= min && values.length <= max && new Set(values).size === values.length && values.every(n => Number.isInteger(n) && n >= 1 && n <= 80);
}
function validRound(r: unknown): r is KenoRound {
  if (!r || typeof r !== 'object') return false;
  const round = r as KenoRound;
  return !!parseKenoStake(String(round.stakePerNumber)) && round.picks?.length * round.stakePerNumber <= KENO_MAX_PRACTICE_STAKE && Number.isSafeInteger(round.id) && round.id > 0 && Number.isSafeInteger(round.startedAt) && round.startedAt >= 0 && validNumbers(round.picks, 1, 10) && validNumbers(round.numbers, 20, 20);
}
export function loadKeno(raw: string | null): KenoState {
  try {
    const s = JSON.parse(raw ?? 'null');
    // Existing v1 tickets always cost five credits per number. Preserve them.
    if (s?.version === 1 && Array.isArray(s.history)) {
      s.version = 2;
      s.history = s.history.map((r: object) => ({ ...r, stakePerNumber: 5 }));
      if (s.active) s.active = { ...s.active, stakePerNumber: 5 };
    }
    if (s?.version !== 2 || !Number.isSafeInteger(s.balance) || s.balance < 0 || s.balance > 1e9 || !Number.isSafeInteger(s.nextId) || s.nextId < 1 || !Array.isArray(s.history) || s.history.length > 5 || !s.history.every(validRound) || (s.active !== null && !validRound(s.active))) return newKenoState();
    return s;
  } catch { return newKenoState(); }
}
export function startKeno(state: KenoState, picks: number[], now: number, numbers = drawKeno(), stakePerNumber: number = KENO_90_RULES.stakeStep): KenoState {
  if (state.active || !validNumbers(picks, 1, 10) || !validNumbers(numbers, 20, 20) || !parseKenoStake(String(stakePerNumber)) || picks.length * stakePerNumber > Math.min(state.balance, KENO_MAX_PRACTICE_STAKE) || !Number.isSafeInteger(now) || now < 0) throw new Error('Choose 1–10 numbers with a valid amount, within your balance and the 480-credit ticket limit.');
  return { ...state, balance: state.balance - picks.length * stakePerNumber, nextId: state.nextId + 1, active: { id: state.nextId, picks: [...picks], numbers: [...numbers], startedAt: now, stakePerNumber } };
}
export function revealedCount(round: KenoRound, now: number): number {
  return Math.max(0, Math.min(20, Math.floor((now - round.startedAt) / KENO_INTERVAL)));
}
export function kenoReturn(round: KenoRound): number { return round.picks.filter(n => round.numbers.includes(n)).length * (round.stakePerNumber / KENO_90_RULES.stakeStep) * KENO_90_RULES.returnPerStep; }
export function advanceKeno(state: KenoState, now: number): KenoState {
  if (!state.active || revealedCount(state.active, now) < 20) return state;
  return { ...state, balance: state.balance + kenoReturn(state.active), active: null, history: [state.active, ...state.history].slice(0, 5) };
}
