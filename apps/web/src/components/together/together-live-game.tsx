import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  bjCard,
  togetherRevealTimeline,
  type TogetherGameEvent,
  type TogetherRoundView,
} from '@socialplay/shared';
import { useTogetherText } from '@/lib/i18n/together-text';
import { SharedWheel } from './shared-wheel';
import './together-live-game.css';

const RaceScene = lazy(() => import('./shared-race-scene'));
const FootballScene = lazy(() => import('./shared-football-scene'));
class SceneBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function TogetherLiveGame({
  round,
  userId,
  serverNow,
  finalResult,
}: {
  round: TogetherRoundView;
  userId: string;
  serverNow: number | null;
  finalResult: ReactNode;
}) {
  const { t, num } = useTogetherText();
  const presentation = round.presentation!;
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [frame, setFrame] = useState(performance.now());
  const [match, setMatch] = useState(0);
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );
  const [simple, setSimple] = useState(() => {
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    return navigator.hardwareConcurrency <= 4 || (memory !== undefined && memory <= 4);
  });
  const anchor = useRef({ server: serverNow, at: performance.now() });
  useEffect(() => {
    anchor.current = { server: serverNow, at: performance.now() };
  }, [serverNow]);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media?.matches ?? false);
    media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    let request = 0,
      last = 0;
    const animate = (now: number) => {
      if (now - last >= (reduced ? 200 : 32)) {
        setFrame(now);
        last = now;
      }
      request = requestAnimationFrame(animate);
    };
    request = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(request);
  }, [reduced]);
  const sharedNow =
    anchor.current.server === null
      ? presentation.observedAt
      : anchor.current.server + Math.max(0, frame - anchor.current.at);
  const duration = presentation.finishesAt - presentation.startsAt;
  const resultAvailable =
    presentation.resultAvailable && presentation.observedAt >= presentation.finishesAt;
  const replay = replayAt !== null && resultAvailable;
  const now = replay ? presentation.startsAt + Math.max(0, frame - replayAt) : sharedNow;
  const timeline = togetherRevealTimeline(round, now);
  const elapsed = Math.max(0, Math.min(duration, now - presentation.startsAt));
  const complete = resultAvailable && timeline.phase === 'complete';
  const running = timeline.phase === 'revealing';
  const events = presentation.events.filter(
    (e) => e.atMs <= Math.min(elapsed, presentation.observedAt - presentation.startsAt)
  );
  const entries = round.entries.filter(
    (e) => e.state !== 'REFUNDED' || round.settlement?.payouts.some((p) => p.entryId === e.id)
  );
  const ordered = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const race = round.game === 'thunder_derby_3d' || round.game === 'neon_hounds_3d';
  const football = round.game === 'virtual_football_3d';
  const balls = events.filter(
    (e): e is Extract<TogetherGameEvent, { kind: 'ball' }> => e.kind === 'ball'
  );
  const raceFrames = events.filter(
    (e): e is Extract<TogetherGameEvent, { kind: 'race' }> => e.kind === 'race'
  );
  const latestRace = raceFrames.at(-1);
  const previousRace = raceFrames.at(-2) ?? latestRace;
  // Interpolate only between two already released checkpoints. The shared
  // clock makes this identical for late viewers; no future path is predicted.
  const raceBlend =
    complete || reduced || !latestRace
      ? 1
      : Math.min(1, Math.max(0, (elapsed - latestRace.atMs) / 1000));
  const positions =
    latestRace?.positions.map(
      (value, i) => (previousRace?.positions[i] ?? value) * (1 - raceBlend) + value * raceBlend
    ) ?? (Array(8).fill(0) as number[]);
  const scores = [0, 1, 2].map((i) =>
    events
      .filter(
        (e): e is Extract<TogetherGameEvent, { kind: 'football' }> =>
          e.kind === 'football' && e.match === i
      )
      .at(-1)
  );
  const raceFallback = (
    <ol className="tg-live-lanes" aria-label={t('Race progress')}>
      {positions.map((position, i) => (
        <li key={i}>
          <b>{num(i + 1)}</b>
          <span>
            <i style={{ width: `${Math.min(100, position * 100)}%` }} />
          </span>
          <small>{num(Math.floor(position * 100))}%</small>
        </li>
      ))}
    </ol>
  );
  const footballFallback = (
    <div className="tg-live-pitch" aria-hidden="true">
      <span
        style={{
          left: `${30 + (reduced ? 0 : Math.sin(elapsed / 2400) * 24)}%`,
          top: `${45 + (reduced ? 0 : Math.sin(elapsed / 1600) * 20)}%`,
        }}
      >
        ⚽
      </span>
    </div>
  );
  const lightweight = reduced || simple;
  return (
    <section
      className="tg-live"
      aria-label={t('Shared game screen')}
      data-round-id={round.id}
      data-reveal-phase={timeline.phase}
      data-reveal-mode={replay ? 'personal' : 'shared'}
      data-reveal-progress={timeline.progress}
      data-event-sequence={round.eventSequence}
      data-result-available={resultAvailable}
    >
      <header className="tg-live-header">
        <div>
          <p>{replay ? t('Your replay') : t('Everyone sees the same round')}</p>
          <h2>
            {timeline.phase === 'scheduled'
              ? t('Starting in {count}', {
                  count: num(Math.max(0, Math.ceil((presentation.startsAt - now) / 1000))),
                })
              : complete
                ? t('Official result')
                : timeline.phase === 'complete'
                  ? t('Getting the shared result ready')
                  : t('Live game')}
          </h2>
        </div>
        <span className="tg-live-badge">
          {entries.some((e) => e.userId === userId) ? t('Confirmed') : t('Watching')}
        </span>
      </header>
      <div
        role="progressbar"
        aria-label={t('Shared game progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(timeline.progress * 100)}
        className="tg-live-progress"
      >
        <span style={{ width: timeline.progress * 100 + '%' }} />
      </div>
      <p className="tg-live-clock" role="timer">
        {num(Math.floor(elapsed / 1000))} / {num(duration / 1000)} {t('seconds')}
      </p>
      {serverNow === null && !replay && (
        <p role="status">{t('Reconnecting to the shared game…')}</p>
      )}
      {timeline.phase === 'scheduled' ? (
        <div className="tg-live-countdown" aria-live="polite">
          <strong>{num(Math.max(0, Math.ceil((presentation.startsAt - now) / 1000)))}</strong>
          <p>{t('Watching is free. Only confirmed entries participate financially.')}</p>
        </div>
      ) : (
        <>
          {race && (
            <>
              <SceneBoundary fallback={raceFallback}>
                <Suspense fallback={raceFallback}>
                  {lightweight ? (
                    raceFallback
                  ) : (
                    <RaceScene
                      positions={positions}
                      elapsed={elapsed}
                      dogs={round.game === 'neon_hounds_3d'}
                      running={running}
                      fallback={raceFallback}
                    />
                  )}
                </Suspense>
              </SceneBoundary>
              {!lightweight && (
                <details>
                  <summary>{t('Race progress')}</summary>
                  {raceFallback}
                </details>
              )}
            </>
          )}
          {football && (
            <>
              <div className="tg-live-scores">
                {scores.map((score, i) => (
                  <button key={i} onClick={() => setMatch(i)} aria-pressed={match === i}>
                    <span>{t('Match {number}', { number: num(i + 1) })}</span>
                    <strong>
                      {num(score?.home ?? 0)} – {num(score?.away ?? 0)}
                    </strong>
                    <small>{num(Math.min(90, Math.floor((elapsed / duration) * 90)))}′</small>
                  </button>
                ))}
              </div>
              <SceneBoundary key={match} fallback={footballFallback}>
                <Suspense fallback={footballFallback}>
                  {lightweight ? (
                    footballFallback
                  ) : (
                    <FootballScene
                      roundId={round.id}
                      match={match}
                      events={events}
                      elapsed={elapsed}
                      duration={duration}
                      complete={complete}
                      label={t('Football Predictions')}
                      fallback={footballFallback}
                    />
                  )}
                </Suspense>
              </SceneBoundary>
            </>
          )}
          {['turbo_keno', 'roulette_keno', 'lucky_six'].includes(round.game) && (
            <div className="tg-live-draw">
              <div className="tg-live-ball" aria-live="polite">
                {balls.length ? num(balls[balls.length - 1].value) : '…'}
              </div>
              <ol aria-label={t('Drawn balls')}>
                {balls.map((ball, i) => (
                  <li key={i}>{num(ball.value)}</li>
                ))}
              </ol>
            </div>
          )}
          {round.game === 'spin_win' && (
            <div className="tg-live-wheel">
              <SharedWheel
                entries={ordered}
                winner={complete ? (round.outcome?.numbers[0] ?? null) : null}
                progress={complete ? 1 : reduced ? 0 : timeline.progress}
              />
              <p>{complete ? t('Official result') : t('The shared wheel is spinning…')}</p>
            </div>
          )}
          {round.game === 'dice' && (
            <div className="tg-live-dice">
              {ordered.map((entry) => {
                const roll = events.find(
                  (e): e is Extract<TogetherGameEvent, { kind: 'dice' }> =>
                    e.kind === 'dice' && e.entryId === entry.id
                );
                return (
                  <article key={entry.id}>
                    <strong>{entry.username}</strong>
                    <div>
                      {[0, 1].map((i) => (
                        <span
                          key={i}
                          className={!roll && running && !reduced ? 'tg-live-tumbling' : ''}
                        >
                          {roll ? ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][roll.values[i] - 1] : '·'}
                        </span>
                      ))}
                    </div>
                    <small>
                      {roll ? num(roll.values[0] + roll.values[1]) : t('Revealing dice…')}
                    </small>
                  </article>
                );
              })}
            </div>
          )}
          {round.game === 'blackjack' && (
            <div className="tg-live-hands">
              {[0, 1, 2, 3, 4, 5, 6].map((hand) => {
                const cards =
                  events
                    .filter(
                      (e): e is Extract<TogetherGameEvent, { kind: 'hand' }> =>
                        e.kind === 'hand' && e.hand === hand
                    )
                    .at(-1)?.cards ?? [];
                return (
                  <article key={hand}>
                    <strong>
                      {hand === 0 ? t('Dealer') : t('Hand {number}', { number: num(hand) })}
                    </strong>
                    <div>
                      {cards.length ? (
                        cards.map((card, i) => {
                          const value = bjCard(card);
                          return (
                            <span className={value.red ? 'red' : ''} key={i}>
                              {value.rank}
                              <small>{value.suit}</small>
                            </span>
                          );
                        })
                      ) : (
                        <span className="tg-live-card-back">◆</span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {round.game === 'number_challenge' && (
            <div className="tg-live-number">
              <div style={{ transform: reduced ? undefined : `rotateY(${elapsed / 35}deg)` }}>
                ?
              </div>
              <p>
                {complete ? num(round.outcome?.numbers[0] ?? 0) : t('Revealing the shared target…')}
              </p>
            </div>
          )}
          {(round.game === 'sky_crash' || round.game === 'crash_point') && (
            <div className="tg-live-flight">
              <svg viewBox="0 0 700 260" aria-hidden="true">
                <path
                  d="M30 230 Q350 220 660 30"
                  fill="none"
                  stroke="#d6be7d"
                  strokeWidth="4"
                  strokeDasharray="800"
                  strokeDashoffset={800 * (1 - timeline.progress)}
                />
                <text
                  x={30 + timeline.progress * 590}
                  y={225 - timeline.progress ** 2 * 180}
                  fontSize="40"
                >
                  ✈
                </text>
              </svg>
              <strong>
                {complete
                  ? `${num((round.outcome?.numbers[0] ?? 100) / 100)}×`
                  : t('Flight in progress · targets are locked')}
              </strong>
              <p>
                {t(
                  'The automatic target result is revealed at the finish. There is no live cash-out.'
                )}
              </p>
            </div>
          )}
        </>
      )}
      {(race || football) && !reduced && (
        <button className="tg-live-toggle" onClick={() => setSimple(!simple)}>
          {simple ? t('3D view') : t('Simple view')}
        </button>
      )}
      {complete && round.state === 'DRAWN' && (
        <p className="tg-live-pending" role="status">
          {t('Game finished—confirming payout')}
        </p>
      )}
      {resultAvailable && (
        <div className="tg-live-controls">
          <button onClick={() => setReplayAt(replay ? null : performance.now())}>
            {replay ? t('Show final result') : t('Replay for me')}
          </button>
          <small>
            {t('Your personal replay. The group’s result and everyone’s wallet are unchanged.')}
          </small>
        </div>
      )}
      {complete && finalResult}
    </section>
  );
}
