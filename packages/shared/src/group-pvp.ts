import { PVP_GAME_POLICY } from './house-game-policy.js';

export const GROUP_PVP_RULES = Object.freeze({
  id: 'group-pvp-points-v1', policyId: PVP_GAME_POLICY.id,
  countdownMs: 30_000, lobbyMs: 15 * 60_000, maxPlayers: 20,
  minEntry: 100, maxEntry: 10_000, entryStep: 100,
});
export type GroupPvpGame = 'spin_win' | 'turbo_keno' | 'dice';
export const GROUP_PVP_GAMES = [
  { key: 'spin_win', name: 'Spin PVP', description: 'Pick one number. Exact matches share the prize.' },
  { key: 'turbo_keno', name: 'Keno PVP', description: 'Pick five numbers. The most matches win.' },
  { key: 'dice', name: 'Dice PVP', description: 'Pick a total from 2 to 12. Exact matches share the prize.' },
] as const;
export const groupPvpRulesId = (game: GroupPvpGame) => game === 'dice' ? 'group-pvp-dice-v1' : GROUP_PVP_RULES.id;
export type GroupPvpState = 'OPEN' | 'COUNTDOWN' | 'DRAWN' | 'SETTLED' | 'VOID';
export interface GroupPvpEntry {
  userId: string; username: string; ready: boolean; selection: number[] | null;
}
export interface GroupPvpRound {
  id: string; creationRequestId: string; game: GroupPvpGame; entryAmount: number; policyId: string;
  rulesId: string; state: GroupPvpState; expiresAt: number; startsAt: number | null;
  outcome: number[] | null; entries: GroupPvpEntry[];
  settlement: null | { platformFee: number; prizes: { userId: string; username: string; amount: number }[];
    refunds: { userId: string; amount: number }[]; reason: string | null };
}
export interface GroupPvpSnapshot {
  enabled: boolean; currency: 'GAME_POINTS'; serverTime: number; groupName: string;
  ownerId: string; balance: number; round: GroupPvpRound | null;
}

export function validatePvpSelection(game: GroupPvpGame, selection: unknown): number[] {
  const count = game === 'spin_win' || game === 'dice' ? 1 : game === 'turbo_keno' ? 5 : 0;
  const min = game === 'spin_win' ? 0 : game === 'dice' ? 2 : 1;
  const max = game === 'spin_win' ? 36 : game === 'dice' ? 12 : 80;
  if (!count || !Array.isArray(selection) || selection.length !== count ||
      new Set(selection).size !== count || selection.some(n => !Number.isInteger(n) || n < min || n > max)) {
    throw new RangeError(game === 'spin_win' ? 'Choose one number from 0 to 36' : game === 'dice' ? 'Choose one total from 2 to 12' : 'Choose five different numbers from 1 to 80');
  }
  return [...selection].sort((a, b) => a - b);
}

export function pvpWinnerIds(game: GroupPvpGame, entries: { userId: string; selection: number[] }[], outcome: number[]) {
  if (game === 'dice') {
    if (outcome.length !== 2 || outcome.some(n => !Number.isInteger(n) || n < 1 || n > 6)) throw new RangeError('Invalid Dice outcome');
    return entries.filter(e => validatePvpSelection(game, e.selection)[0] === outcome[0] + outcome[1]).map(e => e.userId).sort();
  }
  const drawCount = game === 'spin_win' ? 1 : game === 'turbo_keno' ? 20 : 0;
  const min = game === 'spin_win' ? 0 : 1;
  const max = game === 'spin_win' ? 36 : 80;
  if (!drawCount || outcome.length !== drawCount || new Set(outcome).size !== drawCount ||
      outcome.some(n => !Number.isInteger(n) || n < min || n > max)) throw new RangeError('Invalid PVP outcome');
  const scores = entries.map(entry => ({ userId: entry.userId,
    hits: validatePvpSelection(game, entry.selection).filter(n => outcome.includes(n)).length }));
  const best = Math.max(0, ...scores.map(score => score.hits));
  return best === 0 ? [] : scores.filter(score => score.hits === best).map(score => score.userId).sort();
}
