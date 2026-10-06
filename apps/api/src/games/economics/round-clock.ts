import { identifier } from './money.js';

export interface RoundTiming {
  anchorMs: number;
  bettingMs: number;
  revealMs: number;
  resultMs: number;
}

export const SPIN_ROUND_TIMING = Object.freeze({ bettingMs: 45_000, revealMs: 10_000, resultMs: 5_000 });

function milliseconds(value: number, name: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new RangeError(`Invalid ${name}`);
}

/** Pure UTC clock. Server/database time is required; never trust a browser timestamp. */
export function scheduledRound(nowMs: number, timing: RoundTiming) {
  milliseconds(nowMs, 'server time');
  milliseconds(timing.anchorMs, 'anchor');
  milliseconds(timing.bettingMs, 'betting interval', true);
  milliseconds(timing.revealMs, 'reveal interval', true);
  milliseconds(timing.resultMs, 'result interval', true);
  const duration = timing.bettingMs + timing.revealMs + timing.resultMs;
  milliseconds(duration, 'duration', true);
  if (nowMs < timing.anchorMs) throw new RangeError('Schedule has not started');
  const sequence = Math.floor((nowMs - timing.anchorMs) / duration);
  const opensAt = timing.anchorMs + sequence * duration;
  const closesAt = opensAt + timing.bettingMs;
  const revealEndsAt = closesAt + timing.revealMs;
  const endsAt = opensAt + duration;
  milliseconds(endsAt, 'round end');
  const phase = nowMs < closesAt ? 'OPEN' : nowMs < revealEndsAt ? 'REVEAL' : 'RESULT';
  return { sequence, opensAt, closesAt, revealEndsAt, endsAt, phase } as const;
}

/** Called again inside ticket admission's DB transaction, after obtaining locks. */
export function assertRoundOpen(round: {
  id: string; status: string; opensAt: number; closesAt: number;
}, requestedRoundId: string, nowMs: number): void {
  identifier(requestedRoundId, 'Round ID');
  milliseconds(nowMs, 'server time');
  milliseconds(round.opensAt, 'open time');
  milliseconds(round.closesAt, 'close time');
  if (round.closesAt <= round.opensAt || round.id !== requestedRoundId || round.status !== 'OPEN' ||
      nowMs < round.opensAt || nowMs >= round.closesAt) {
    throw new RangeError('Round is not accepting bets');
  }
}
