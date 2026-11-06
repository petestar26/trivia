import type {
  TogetherCurrency,
  TogetherGame,
  TogetherRoundView,
  TogetherState,
} from './play-together.js';

export const TOGETHER_REVEAL_LEAD_MS = 3000;
export const TOGETHER_REVEAL_DURATION_MS = 12000;

export const TOGETHER_PRESENTATION_VERSION = 2;
export const TOGETHER_COUNTDOWN_MS = 5000;
/** Fixed, published durations. Changing these requires a new presentation version. */
export const TOGETHER_GAME_DURATION_MS: Readonly<Record<TogetherGame, number>> = Object.freeze({
  spin_win: 20000,
  turbo_keno: 44000,
  dice: 40000,
  number_challenge: 18000,
  roulette_keno: 40000,
  lucky_six: 72000,
  thunder_derby_3d: 45000,
  neon_hounds_3d: 32000,
  virtual_football_3d: 90000,
  blackjack: 54000,
  sky_crash: 42000,
  crash_point: 42000,
});

export type TogetherGameEvent = { atMs: number } & (
  | { kind: 'ball'; value: number }
  | { kind: 'dice'; entryId: string; values: number[] }
  | { kind: 'hand'; hand: number; cards: number[] }
  | { kind: 'football'; match: number; minute: number; home: number; away: number }
  | { kind: 'race'; positions: number[] }
);

/** Only elapsed events are included during live play. The full sequence is
 * released at finish for personal replay; it never drives payment. */
export interface TogetherPresentationView {
  version: 2;
  startsAt: number;
  finishesAt: number;
  observedAt: number;
  events: TogetherGameEvent[];
  resultAvailable: boolean;
}

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
  round: Pick<TogetherRoundView, 'state' | 'paidAt' | 'outcome' | 'presentation'>,
  serverNow: number | null | undefined
): TogetherRevealTimeline {
  if (round.presentation?.version === 2) {
    const { startsAt, finishesAt, observedAt } = round.presentation;
    // Losing the clock never exposes a future result or jumps to the ending.
    const now =
      typeof serverNow === 'number' && Number.isFinite(serverNow) ? serverNow : observedAt;
    return {
      phase: now < startsAt ? 'scheduled' : now < finishesAt ? 'revealing' : 'complete',
      progress: Math.max(0, Math.min(1, (now - startsAt) / (finishesAt - startsAt))),
      startsAt,
      endsAt: finishesAt,
    };
  }
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
