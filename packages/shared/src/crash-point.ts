/** Practice-only Crash Point. Never shares a financial wallet. */
export const CRASH_POINT_RULES = Object.freeze({
  id: 'crash-point-practice90-v1',
  cycleMs: 60000,
  bettingMs: 15000,
  growthMs: 10000,
  minStake: 10,
  maxStake: 500,
  maxCashoutCents: 2000,
  initialBalance: 1000,
});
export function crashMultiplier(elapsedMs: number) {
  return Math.min(2000, Math.floor(100 * Math.exp(Math.max(0, elapsedMs) / 10000)));
}
export function crashCrossingMs(cents: number) {
  return Math.ceil(10000 * Math.log(cents / 100));
}
export function parseCrashEntry(stake: unknown, autoCents: unknown) {
  if (typeof stake !== 'number' || !Number.isInteger(stake) || stake < 10 || stake > 500)
    throw Error('Enter a whole amount from 10 to 500 credits');
  if (
    autoCents !== null &&
    (typeof autoCents !== 'number' ||
      !Number.isInteger(autoCents) ||
      autoCents < 101 ||
      autoCents > 2000)
  )
    throw Error('Auto cash-out must be 1.01x–20.00x');
  return { stake, autoCents: autoCents as number | null };
}
export interface CrashPointRound {
  id: string;
  opensAt: number;
  startsAt: number;
  endsAt: number;
  commitment: string;
  crashCents: number | null;
  seed: string | null;
  ticket: {
    stake: number;
    autoCents: number | null;
    payout: number | null;
    paidCents: number | null;
  } | null;
}
export interface CrashPointSnapshot {
  rulesId: string;
  serverTime: number;
  balance: number;
  rounds: CrashPointRound[];
}

/** Public practice activity. No account IDs, auto targets, seeds or future outcomes. */
export interface CrashPointActivity {
  roundId: string;
  totalTickets: number;
  tickets: Array<{
    player: string;
    stake: number;
    payout: number | null;
    paidCents: number | null;
  }>;
}
