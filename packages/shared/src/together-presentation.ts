import type {
  TogetherCurrency,
  TogetherGame,
  TogetherRoundView,
  TogetherState,
} from './play-together.js';

export const TOGETHER_REVEAL_LEAD_MS = 3000;
export const TOGETHER_REVEAL_DURATION_MS = 12000;

export interface TogetherRevealTimeline {
  phase: 'awaiting' | 'scheduled' | 'revealing' | 'complete';
  progress: number;
  startsAt: number | null;
  endsAt: number | null;
}

/** Presentation only: every viewer follows the same immutable payment time.
 * This does not delay settlement, create results, or alter accepted terms.
 * Late/reconnecting viewers join the shared progress instead of restarting it.
 */
export function togetherRevealTimeline(
  round: Pick<TogetherRoundView, 'state' | 'paidAt' | 'outcome'>,
  serverNow: number | null | undefined
): TogetherRevealTimeline {
  if (round.state !== 'PAID' && round.state !== 'REFUNDED')
    return { phase: 'awaiting', progress: 0, startsAt: null, endsAt: null };
  if (
    !round.outcome ||
    !Number.isSafeInteger(round.paidAt) ||
    round.paidAt! < 0 ||
    typeof serverNow !== 'number' ||
    !Number.isFinite(serverNow) ||
    serverNow < 0
  )
    return { phase: 'complete', progress: 1, startsAt: null, endsAt: null };
  const startsAt = round.paidAt! + TOGETHER_REVEAL_LEAD_MS;
  const endsAt = startsAt + TOGETHER_REVEAL_DURATION_MS;
  if (!Number.isSafeInteger(endsAt))
    return { phase: 'complete', progress: 1, startsAt: null, endsAt: null };
  return {
    phase: serverNow < startsAt ? 'scheduled' : serverNow < endsAt ? 'revealing' : 'complete',
    progress: Math.max(0, Math.min(1, (serverNow - startsAt) / TOGETHER_REVEAL_DURATION_MS)),
    startsAt,
    endsAt,
  };
}

export interface TogetherActivityRound {
  id: string;
  game: TogetherGame;
  currency: TogetherCurrency;
  entryAmount: number;
  state: TogetherState;
  closesAt: number;
  participants: number;
  groupName: string;
}

/** Lightweight member-only discovery. No selections, wallet data or receipts. */
export interface TogetherGroupActivity {
  serverTime: number;
  activeRound: TogetherActivityRound | null;
  latestResult: TogetherActivityRound | null;
}
