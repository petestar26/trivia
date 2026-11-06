import { useCallback, useRef } from 'react';
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
  fallback,
  quality,
}: {
  roundId: string;
  events: TogetherGameEvent[];
  match: number;
  elapsed: number;
  duration: number;
  complete: boolean;
  label: string;
  fallback: React.ReactNode;
  quality: 'high' | 'balanced';
}) {
  const clock = useRef((elapsed * 60000) / duration);
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
  return (
    <div className="tg-live-football-scene">
      <FootballScene
        match={{
          matchKey: roundId + ':' + match,
          homeClub: match * 2 + 1,
          awayClub: match * 2 + 2,
          goals,
          fullTime: complete ? { home, away } : null,
        }}
        getElapsed={getElapsed}
        reduced={false}
        quality={quality}
        label={label}
        fallback={fallback}
      />
    </div>
  );
}
