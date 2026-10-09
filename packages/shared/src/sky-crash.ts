/** Practice-only Sky Crash. Never shares a financial wallet. */
export const SKY_CRASH_RULES = Object.freeze({
  id: 'sky-crash-practice90-v1',
  cycleMs: 60000,
  bettingMs: 15000,
  growthMs: 10000,
  minStake: 10,
  maxStake: 500,
  maxCashoutCents: 2000,
  initialBalance: 1000,
});
export function skyCrashMultiplier(elapsedMs: number) {
  return Math.min(2000, Math.floor(100 * Math.exp(Math.max(0, elapsedMs) / 10000)));
}
export function skyCrashCrossingMs(cents: number) {
  return Math.ceil(10000 * Math.log(cents / 100));
}
export function parseSkyCrashEntry(stake: unknown, autoCents: unknown) {
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
export interface SkyCrashRound {
  id: string;
  opensAt: number;
  startsAt: number;
  endsAt: number;
  commitment: string;
  crashCents: number | null;
  seed: string | null;
  tickets?: Array<{
    slot: number;
    stake: number;
    autoCents: number | null;
    payout: number | null;
    paidCents: number | null;
  }>;
  ticket: {
    stake: number;
    autoCents: number | null;
    payout: number | null;
    paidCents: number | null;
  } | null;
}
export interface SkyCrashSnapshot {
  rulesId: string;
  maxTickets?: number;
  serverTime: number;
  balance: number;
  rounds: SkyCrashRound[];
}

/** Public practice activity. No account IDs, auto targets, seeds or future outcomes. */
export interface SkyCrashActivity {
  roundId: string;
  totalTickets: number;
  tickets: Array<{
    player: string;
    stake: number;
    payout: number | null;
    paidCents: number | null;
  }>;
}

export interface SkyCrashLeaderboard {
  period: '24h';
  tickets: Array<{
    player: string;
    roundId: string;
    stake: number;
    payout: number;
    paidCents: number;
  }>;
}
