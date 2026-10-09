import {
  VF_TIMING,
  minuteOf,
  type LiveFixture,
  type PublicGoal,
  type Score,
  type VfFixtureView,
  type VfMatchweekView,
} from '@socialplay/shared';

/**
 * A goal is public on the server the moment it happens, but the match plays a short
 * build-up first. Scores, minutes and settlement are shown only once the ball is in the
 * net on screen. This is a pure time rule so it holds with the 3D scene off, paused, in
 * reduced-motion mode, after a reload, or if the renderer failed.
 */
export const GOAL_REVEAL_MS = 2050;

export type MatchStatus = LiveFixture['status'];
/** Match phase from the server-synchronised clock alone, so nothing waits on the next poll. */
export function statusAt(elapsedMs: number): MatchStatus {
  const { firstHalfMs, halftimeMs, matchMs } = VF_TIMING;
  return elapsedMs < 0
    ? 'SCHEDULED'
    : elapsedMs < firstHalfMs
      ? 'FIRST_HALF'
      : elapsedMs < firstHalfMs + halftimeMs
        ? 'HALFTIME'
        : elapsedMs < matchMs
          ? 'SECOND_HALF'
          : 'FULL_TIME';
}

export const goalRevealed = (goal: PublicGoal, elapsedMs: number) =>
  elapsedMs >= goal.atMs + GOAL_REVEAL_MS;

export interface DisplayFixture {
  status: MatchStatus;
  /** Score as the viewer should see it, null before kick-off. */
  score: Score | null;
  halfTime: Score | null;
  /** Only once the final whistle has sounded and every goal has been celebrated. */
  fullTime: Score | null;
  events: PublicGoal[];
  /** Football minute label: "23'", "HT", "FT", or "" before kick-off. */
  minute: string;
  /** A goal is being played out right now. */
  scoring: boolean;
}

export function displayFixture(live: LiveFixture, elapsedMs: number): DisplayFixture {
  const events = live.events.filter((g) => goalRevealed(g, elapsedMs));
  const tally = (list: PublicGoal[]): Score => ({
    home: list.filter((g) => g.side === 'H').length,
    away: list.filter((g) => g.side === 'A').length,
  });
  const allShown = events.length === live.events.length;
  const status = statusAt(elapsedMs);
  const clamped = Math.min(Math.max(elapsedMs, 0), VF_TIMING.matchMs);
  // Full time is final only once the snapshot itself knows it (so the goal list is complete)
  // and every goal has been shown.
  const done = status === 'FULL_TIME' && live.status === 'FULL_TIME' && allShown;
  return {
    status,
    score: status === 'SCHEDULED' ? null : tally(events),
    halfTime:
      live.halfTime &&
      live.events.filter((g) => g.half === 1).every((g) => goalRevealed(g, elapsedMs))
        ? tally(events.filter((g) => g.half === 1))
        : null,
    fullTime: done ? tally(events) : null,
    events,
    minute:
      status === 'SCHEDULED'
        ? ''
        : status === 'HALFTIME'
          ? 'HT'
          : done
            ? 'FT'
            : status === 'FULL_TIME'
              ? '90+'
              : `${minuteOf(clamped)}'`,
    scoring: live.events.some((g) => elapsedMs >= g.atMs && elapsedMs < g.atMs + GOAL_REVEAL_MS),
  };
}

/** Elapsed ms since kick-off of the whole matchweek, from the server clock. */
export const elapsedSince = (kickoffAt: number, serverNow: number) => serverNow - kickoffAt;

/** The instant (server ms) after which every result in the matchweek may be shown. */
export function matchweekRevealAt(
  week: Pick<VfMatchweekView, 'kickoffAt' | 'fullTimeAt' | 'fixtures'>
): number {
  let last = 0;
  for (const fixture of week.fixtures)
    for (const g of fixture.live.events) last = Math.max(last, g.atMs + GOAL_REVEAL_MS);
  return Math.max(week.fullTimeAt, week.kickoffAt + last);
}

/** Goals are only complete for a fixture once full time has been published. */
export const fixtureFinished = (fixture: VfFixtureView) => fixture.live.status === 'FULL_TIME';
