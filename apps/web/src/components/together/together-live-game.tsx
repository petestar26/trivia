import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  togetherGame,
  togetherRevealTimeline,
  type TogetherGameEvent,
  type TogetherRoundView,
} from '@socialplay/shared';
import { useTogetherText } from '@/lib/i18n/together-text';
import { GameArena } from '@/components/games/game-arena';
import { SharedWheel } from './shared-wheel';
import { GAME_ART_DIRECTION, type GameQuality } from './game-art-direction';
import { useGameQuality } from './use-game-quality';
import { DrawStage } from './draw-stage';
import { DiceStage, BlackjackStage, NumberStage } from './table-stages';
import { FlightStage } from './flight-stages';
import { RaceBroadcast2D, PitchBroadcast2D } from './lightweight-sports';
import './together-live-game.css';
import './shared-stages.css';
import './original-scenes.css';

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
  const { t, num, money } = useTogetherText(),
    presentation = round.presentation!,
    game = togetherGame(round.game);
  const [replayAt, setReplayAt] = useState<number | null>(null),
    [frame, setFrame] = useState(performance.now()),
    [match, setMatch] = useState(0);
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );
  const { quality, choose, tier, degrade, adaptive } = useGameQuality(reduced);
  const anchor = useRef({ server: serverNow, at: performance.now() });
  useEffect(() => {
    anchor.current = { server: serverNow, at: performance.now() };
  }, [serverNow]);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media?.matches ?? false);
    media?.addEventListener('change', change);
    return () => media?.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    let id = 0,
      last = 0;
    const draw = (time: number) => {
      if (time - last >= (reduced ? 200 : tier === 'high' ? 16 : 32)) {
        setFrame(time);
        last = time;
      }
      id = requestAnimationFrame(draw);
    };
    id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [reduced, tier]);
  const sharedNow =
    anchor.current.server === null
      ? presentation.observedAt
      : anchor.current.server + Math.max(0, frame - anchor.current.at);
  const duration = presentation.finishesAt - presentation.startsAt;
  const resultAvailable =
    presentation.resultAvailable && presentation.observedAt >= presentation.finishesAt;
  const replay = replayAt !== null && resultAvailable;
  const now = replay ? presentation.startsAt + Math.max(0, frame - replayAt) : sharedNow;
  const timeline = togetherRevealTimeline(round, now),
    elapsed = Math.max(0, Math.min(duration, now - presentation.startsAt));
  const complete = resultAvailable && timeline.phase === 'complete',
    running = timeline.phase === 'revealing';
  const events = presentation.events.filter(
    (e) => e.atMs <= Math.min(elapsed, presentation.observedAt - presentation.startsAt)
  );
  const entries = round.entries.filter(
    (e) => e.state !== 'REFUNDED' || round.settlement?.payouts.some((p) => p.entryId === e.id)
  );
  const ordered = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const mine = entries.find((e) => e.userId === userId);
  const art = GAME_ART_DIRECTION[round.game];
  const race = art.stage === 'race',
    football = art.stage === 'football';
  const raceFrames = events.filter(
    (e): e is Extract<TogetherGameEvent, { kind: 'race' }> => e.kind === 'race'
  );
  const latest = raceFrames.at(-1),
    previous = raceFrames.at(-2) ?? latest;
  // Only interpolate checkpoints already disclosed by the server. Never predict a finish.
  const blend =
    complete || reduced || !latest ? 1 : Math.min(1, Math.max(0, (elapsed - latest.atMs) / 1000));
  const positions =
    latest?.positions.map((v, i) => (previous?.positions[i] ?? v) * (1 - blend) + v * blend) ??
    (Array(8).fill(0) as number[]);
  const dogs = round.game === 'neon_hounds_3d';
  const raceFallback = (
    <RaceBroadcast2D positions={positions} dogs={dogs} elapsed={elapsed} reduced={reduced} />
  );
  const footballFallback = <PitchBroadcast2D elapsed={elapsed} reduced={reduced} />;
  const scores = [0, 1, 2].map((i) =>
    events
      .filter(
        (e): e is Extract<TogetherGameEvent, { kind: 'football' }> =>
          e.kind === 'football' && e.match === i
      )
      .at(-1)
  );
  const balls = events.filter(
    (e): e is Extract<TogetherGameEvent, { kind: 'ball' }> => e.kind === 'ball'
  );
  const winner = complete ? (round.outcome?.numbers[0] ?? null) : null;
  const title =
    timeline.phase === 'scheduled'
      ? t('Starting in {count}', {
          count: num(Math.max(0, Math.ceil((presentation.startsAt - now) / 1000))),
        })
      : complete
        ? t('Official result')
        : timeline.phase === 'complete'
          ? t('Getting the shared result ready')
          : t('Live game');
  return (
    <section
      className="tg-live"
      data-skin={art.skin}
      data-artwork="original"
      data-quality={tier}
      data-reduced-motion={reduced}
      aria-label={t('Shared game screen')}
      data-round-id={round.id}
      data-reveal-phase={timeline.phase}
      data-reveal-mode={replay ? 'personal' : 'shared'}
      data-reveal-progress={timeline.progress}
      data-event-sequence={round.eventSequence}
      data-result-available={resultAvailable}
    >
      <GameArena title={game.name} className="tg-arena-display">
        <header className="tg-live-header">
          <div>
            <span className="tg-broadcast-dot" />
            <h2>{replay ? t('Your replay') : title}</h2>
          </div>
          <span className="tg-live-badge">{mine ? t('Confirmed') : t('Watching')}</span>
        </header>
        <div className="tg-live-stage" data-stage={art.stage}>
          {race && (
            <>
              <SceneBoundary key={tier} fallback={raceFallback}>
                <Suspense fallback={raceFallback}>
                  <RaceScene
                    roundId={round.id + ':' + replayAt}
                    positions={positions}
                    elapsed={elapsed}
                    duration={duration}
                    dogs={dogs}
                    running={running}
                    reduced={reduced}
                    complete={complete}
                    quality={tier}
                    adaptive={adaptive}
                    onSlow={degrade}
                    fallback={raceFallback}
                  />
                </Suspense>
              </SceneBoundary>
              <ol className="tg-race-order" aria-label={t('Race progress')}>
                {positions
                  .map((position, i) => ({ position, i }))
                  .sort((a, b) => b.position - a.position || a.i - b.i)
                  .map(({ position, i }, index) => (
                    <li key={i}>
                      <small>{num(index + 1)}</small>
                      <b
                        style={{
                          background: [
                            '#eee8d6',
                            '#303d4e',
                            '#b53142',
                            '#3979be',
                            '#bd9130',
                            '#328a72',
                            '#9364b1',
                            '#c5779e',
                          ][i],
                          color: i === 0 ? '#1b2530' : 'white',
                        }}
                      >
                        {num(i + 1)}
                      </b>
                      <span>{num(Math.floor(position * 100))}%</span>
                    </li>
                  ))}
              </ol>
            </>
          )}
          {football && (
            <>
              <div className="tg-live-scores">
                {scores.map((score, i) => (
                  <button key={i} onClick={() => setMatch(i)} aria-pressed={match === i}>
                    <span>{t('Match {number}', { number: num(i + 1) })}</span>
                    <strong>
                      {num(score?.home ?? 0)}
                      <i>—</i>
                      {num(score?.away ?? 0)}
                    </strong>
                    <small>{num(Math.min(90, Math.floor((elapsed / duration) * 90)))}′</small>
                  </button>
                ))}
              </div>
              <SceneBoundary key={match + ':' + tier} fallback={footballFallback}>
                <Suspense fallback={footballFallback}>
                  <FootballScene
                    roundId={round.id}
                    match={match}
                    events={events}
                    elapsed={elapsed}
                    duration={duration}
                    complete={complete}
                    quality={tier}
                    reduced={reduced}
                    label={t('Match {number}', { number: num(match + 1) })}
                    fallback={footballFallback}
                  />
                </Suspense>
              </SceneBoundary>
            </>
          )}
          {art.stage === 'draw' && (
            <DrawStage
              game={round.game}
              balls={balls}
              running={running}
              picks={mine?.selection ?? []}
              elapsed={elapsed}
              reduced={reduced}
            />
          )}
          {art.stage === 'wheel' && (
            <div className="tg-wheel-studio">
              <div className="tg-wheel-spotlight" />
              <SharedWheel
                key={round.id + ':' + replayAt}
                entries={ordered}
                winner={winner}
                progress={timeline.progress}
                motion={{ clock: frame, duration, reduced }}
              />
              <div className="tg-wheel-roster">
                <p>{t('Confirmed participants')}</p>
                {ordered.map((e, i) => (
                  <div key={e.id} data-winner={complete && winner === i}>
                    <b>{num(i + 1)}</b>
                    <span>{e.username}</span>
                    {complete && winner === i && <i aria-label={t('Official result')}>✓</i>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {art.stage === 'dice' && (
            <DiceStage
              entries={ordered}
              events={events}
              elapsed={elapsed}
              running={running}
              reduced={reduced}
            />
          )}
          {art.stage === 'cards' && (
            <BlackjackStage events={events} elapsed={elapsed} complete={complete} />
          )}
          {art.stage === 'number' && (
            <NumberStage target={winner} entries={ordered} elapsed={elapsed} reduced={reduced} />
          )}
          {art.stage === 'flight' && (
            <FlightStage
              sky={round.game === 'sky_crash'}
              elapsed={elapsed}
              duration={duration}
              running={running}
              complete={complete}
              result={winner}
              target={mine?.selection?.[0] ?? null}
              reduced={reduced}
              connected={serverNow !== null || replay}
            />
          )}
          {timeline.phase === 'scheduled' && (
            <div className="tg-live-countdown" aria-live="polite">
              <span>{t('Everyone sees the same round')}</span>
              <strong>{num(Math.max(0, Math.ceil((presentation.startsAt - now) / 1000)))}</strong>
              <p>{t('Watching is free')}</p>
            </div>
          )}
        </div>
        <div
          className="tg-live-progress"
          role="progressbar"
          aria-label={t('Shared game progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(timeline.progress * 100)}
        >
          <span style={{ width: timeline.progress * 100 + '%' }} />
        </div>
        <div className="tg-stage-footer">
          <span role="timer">
            {num(Math.floor(elapsed / 1000))} / {num(duration / 1000)} {t('seconds')}
          </span>
          <label>
            {t('Graphics quality')}
            <select value={quality} onChange={(e) => choose(e.target.value as GameQuality)}>
              <option value="auto">{t('Automatic')}</option>
              <option value="high">{t('High')}</option>
              <option value="balanced">{t('Balanced')}</option>
              <option value="low">{t('Low')}</option>
            </select>
          </label>
        </div>
        {serverNow === null && !replay && (
          <p className="tg-live-connection" role="status">
            {t('Reconnecting to the shared game…')}
          </p>
        )}
        {complete && round.state === 'DRAWN' && (
          <p className="tg-live-pending" role="status">
            {t('Game finished—confirming payout')}
          </p>
        )}
      </GameArena>
      <div className="tg-arena-ticket">
        <span>
          <b>{mine ? t('Your confirmed entry') : t('You’re watching')}</b>
          <small>{mine ? money(mine.amount, round.currency) : t('Watching is free')}</small>
        </span>
        <span>
          <small>{t('Funded pool')}</small>
          <b>
            {money(round.settlement?.funded ?? entries.length * round.entryAmount, round.currency)}
          </b>
        </span>
      </div>
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
      {complete && (
        <details className="tg-result-details">
          <summary>{t('Recorded result')}</summary>
          {finalResult}
        </details>
      )}
    </section>
  );
}
