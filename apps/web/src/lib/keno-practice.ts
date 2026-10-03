export const KENO_INTERVAL = 650;
export type KenoRound = { id: number; picks: number[]; numbers: number[]; startedAt: number };
export type KenoState = { version: 1; balance: number; nextId: number; active: KenoRound | null; history: KenoRound[] };
export const newKenoState = (): KenoState => ({ version: 1, balance: 1000, nextId: 1, active: null, history: [] });
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
  return Number.isSafeInteger(round.id) && round.id > 0 && Number.isSafeInteger(round.startedAt) && round.startedAt >= 0 && validNumbers(round.picks, 1, 10) && validNumbers(round.numbers, 20, 20);
}
export function loadKeno(raw: string | null): KenoState {
  try {
    const s = JSON.parse(raw ?? 'null') as KenoState;
    if (s?.version !== 1 || !Number.isSafeInteger(s.balance) || s.balance < 0 || s.balance > 1e9 || !Number.isSafeInteger(s.nextId) || s.nextId < 1 || !Array.isArray(s.history) || s.history.length > 5 || !s.history.every(validRound) || (s.active !== null && !validRound(s.active))) return newKenoState();
    return s;
  } catch { return newKenoState(); }
}
export function startKeno(state: KenoState, picks: number[], now: number, numbers = drawKeno()): KenoState {
  if (state.active || !validNumbers(picks, 1, 10) || !validNumbers(numbers, 20, 20) || picks.length * 5 > state.balance) throw new Error('Choose 1–10 numbers within your practice balance.');
  return { ...state, balance: state.balance - picks.length * 5, nextId: state.nextId + 1, active: { id: state.nextId, picks: [...picks], numbers: [...numbers], startedAt: now } };
}
export function revealedCount(round: KenoRound, now: number): number {
  return Math.max(0, Math.min(20, Math.floor((now - round.startedAt) / KENO_INTERVAL)));
}
export function kenoReturn(round: KenoRound): number { return round.picks.filter(n => round.numbers.includes(n)).length * 18; }
export function advanceKeno(state: KenoState, now: number): KenoState {
  if (!state.active || revealedCount(state.active, now) < 20) return state;
  return { ...state, balance: state.balance + kenoReturn(state.active), active: null, history: [state.active, ...state.history].slice(0, 5) };
}
