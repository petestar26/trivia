import { useCallback, useRef } from 'react';
import { Scoreboard, MatchCentre } from '@/components/football/match-centre';
import { statusAt } from '@/lib/football/reveal';
import type { DisplayFixture } from '@/lib/football/reveal';
import '@/pages/games/virtual-football.css';
import FootballScene from '@/components/football/football-scene';
import type { MatchInput } from '@/components/football/engine/engine';
import type { TogetherGameEvent } from '@socialplay/shared';

/** Reuses the released-facts-only football scene, scaled to this contest's
 * published duration. Switching a match is a personal camera choice. */
export default function SharedFootballScene({
  roundId,
  events,
  match,
  elapsed,
  duration,
  complete,
  label,
  quality,
  reduced,
}: {
  roundId: string;
  events: TogetherGameEvent[];
  match: number;
  elapsed: number;
  duration: number;
  complete: boolean;
  label: string;
  fallback: React.ReactNode;
  quality: 'high' | 'balanced' | 'low';
  reduced: boolean;
}) {
  const clock = useRef((elapsed * 60000) / duration);
  const releasedMatch = useRef<MatchInput | null>(null);
  clock.current = (elapsed * 60000) / duration;
  const getElapsed = useCallback(() => clock.current, []);
  const scores = events.filter(
    (e): e is Extract<TogetherGameEvent, { kind: 'football' }> =>
      e.kind === 'football' && e.match === match
  );
  let home = 0,
    away = 0;
  const goals: MatchInput['goals'] = [];
  for (const score of scores) {
    for (let i = home; i < score.home; i++)
      goals.push({
        n: goals.length + 1,
        side: 'H',
        atMs: Math.max(0, (score.atMs * 60000) / duration - 2050),
      });
    for (let i = away; i < score.away; i++)
      goals.push({
        n: goals.length + 1,
        side: 'A',
        atMs: Math.max(0, (score.atMs * 60000) / duration - 2050),
      });
    home = score.home;
    away = score.away;
  }
  const nextMatch: MatchInput = {
    matchKey: roundId + ':' + match,
    homeClub: match * 2 + 1,
    awayClub: match * 2 + 2,
    goals,
    fullTime: complete ? { home, away } : null,
  };
  // Clock-only HUD updates must not force another reduced-motion scene render.
  // The engine receives a new object only when an already released fact changes.
  if (JSON.stringify(releasedMatch.current) !== JSON.stringify(nextMatch))
    releasedMatch.current = nextMatch;
  const fixture = { homeClub: match * 2 + 1, awayClub: match * 2 + 2 };
  const display: DisplayFixture = {
    status: complete ? 'FULL_TIME' : statusAt(clock.current),
    score: { home, away },
    halfTime: null,
    fullTime: complete ? { home, away } : null,
    minute: complete ? 'FT' : `${Math.min(90, Math.floor((elapsed / duration) * 90))}′`,
    scoring: false,
    events: goals.map((g) => ({
      ...g,
      minute: Math.max(1, Math.round((g.atMs / 60000) * 90)),
      half: g.atMs < 30000 ? 1 : 2,
    })),
  };
  return (
    <div className="vf-page original-football" data-original-scene="football">
      <div className="vf-stage-frame">
        <FootballScene
          match={releasedMatch.current}
          getElapsed={getElapsed}
          reduced={reduced}
          quality={quality}
          label={label}
          fallback={<MatchCentre fixture={fixture} display={display} week={label} />}
        />
        <div className="vf-board-overlay">
          <Scoreboard fixture={fixture} display={display} week={label} />
        </div>
      </div>
    </div>
  );
}
