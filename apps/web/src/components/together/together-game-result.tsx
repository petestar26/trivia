import { useEffect, useId, useState } from 'react';
import { Flag, RotateCcw, SkipForward, Trophy } from 'lucide-react';
import {
  bjCard,
  bjResult,
  bjTotal,
  togetherRevealTimeline,
  TOGETHER_REVEAL_DURATION_MS,
  type TogetherEntryView,
  type TogetherRoundView,
} from '@socialplay/shared';
import './together-game-result.css';

const supported = new Set([
  'spin_win',
  'turbo_keno',
  'dice',
  'number_challenge',
  'roulette_keno',
  'lucky_six',
  'thunder_derby_3d',
  'neon_hounds_3d',
  'virtual_football_3d',
  'blackjack',
  'sky_crash',
  'crash_point',
]);
const predictions = ['Home win', 'Draw', 'Away win'];
const handResults = ['Win', 'Draw', 'Lose'];
const integer = (n: number, min: number, max: number) =>
  Number.isInteger(n) && n >= min && n <= max;
const target = (n: number) => (n / 100).toFixed(2) + '×';

// Rendering guards do not replace the independent round-proof verifier. A damaged
// response must not become a plausible looking race, scorecard or hand.
function displayable(round: TogetherRoundView) {
  const outcome = round.outcome;
  if (!outcome || !Array.isArray(outcome.numbers)) return false;
  const n = outcome.numbers;
  switch (round.game) {
    case 'spin_win':
      return n.length === 1 && integer(n[0], 0, currentEntries(round).length - 1);
    case 'dice':
      return (
        n.length === currentEntries(round).length * 2 &&
        n.length >= 4 &&
        n.every((v) => integer(v, 1, 6))
      );
    case 'number_challenge':
      return n.length === 1 && integer(n[0], 1, 100);
    case 'turbo_keno':
    case 'roulette_keno':
    case 'lucky_six': {
      const lucky = round.game === 'lucky_six';
      return (
        n.length === (lucky ? 35 : round.game === 'turbo_keno' ? 20 : 18) &&
        new Set(n).size === n.length &&
        n.every((v) => integer(v, 1, lucky ? 48 : round.game === 'turbo_keno' ? 80 : 72))
      );
    }
    case 'thunder_derby_3d':
    case 'neon_hounds_3d':
      return n.length === 8 && new Set(n).size === 8 && n.every((v) => integer(v, 1, 8));
    case 'virtual_football_3d':
      return (
        n.length === 3 &&
        Array.isArray(outcome.football) &&
        outcome.football.length === 3 &&
        outcome.football.every(
          (s, i) =>
            s &&
            integer(s.home, 0, 100) &&
            integer(s.away, 0, 100) &&
            n[i] === (s.home > s.away ? 0 : s.home === s.away ? 1 : 2)
        )
      );
    case 'blackjack': {
      const hands = outcome.hands;
      if (
        n.length !== 6 ||
        !Array.isArray(hands) ||
        hands.length !== 7 ||
        !hands.every(
          (h) =>
            Array.isArray(h) &&
            h.length >= 2 &&
            h.length <= 22 &&
            h.every((v) => integer(v, 0, 311)) &&
            bjTotal(h).total >= 17
        )
      )
        return false;
      return (
        new Set(hands.flat()).size === hands.flat().length &&
        hands
          .slice(1)
          .every((h, i) => n[i] === ['WIN', 'DRAW', 'LOSE'].indexOf(bjResult(h, hands[0])))
      );
    }
    case 'sky_crash':
    case 'crash_point':
      return n.length === 1 && integer(n[0], 100, 2001);
    default:
      return false;
  }
}

function currentEntries(round: TogetherRoundView) {
  if (round.settlement) {
    const included = new Set(round.settlement.payouts.map((p) => p.entryId));
    return round.entries.filter((e) => included.has(e.id));
  }
  return round.entries.filter((e) => e.state !== 'REFUNDED');
}

/** Uses only the recorded server result. Viewing and replay never change wallets. */
export function TogetherGameResult({
  round,
  userId,
  serverNow,
}: {
  round: TogetherRoundView;
  userId: string;
  serverNow: number | null;
}) {
  if (!supported.has(round.game) || round.state === 'OPEN' || round.state === 'LOCKED') return null;
  return (
    <RecordedResult
      key={round.id + ':' + round.termsHash}
      round={round}
      userId={userId}
      serverNow={serverNow}
    />
  );
}

function RecordedResult({
  round,
  userId,
  serverNow,
}: {
  round: TogetherRoundView;
  userId: string;
  serverNow: number | null;
}) {
  const headingId = useId();
  const [showFinal, setShowFinal] = useState(false);
  const [personalStart, setPersonalStart] = useState<number | null>(null);
  const [personalNow, setPersonalNow] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => {
      setReducedMotion(media.matches);
      if (media.matches) setPersonalStart(null);
    };
    media.addEventListener?.('change', change);
    return () => media.removeEventListener?.('change', change);
  }, []);
  const timeline = togetherRevealTimeline(round, serverNow);
  const hasClock = typeof serverNow === 'number' && Number.isFinite(serverNow) && serverNow > 0;
  const activeShared = timeline.phase === 'scheduled' || timeline.phase === 'revealing';
  const canReplay =
    hasClock && timeline.phase === 'complete' && round.paidAt !== null && !reducedMotion;
  const personal = personalStart !== null && canReplay;
  useEffect(() => {
    if (personalStart === null) return;
    if (!canReplay) {
      setPersonalStart(null);
      return;
    }
    const timer = window.setInterval(() => {
      const now = performance.now();
      setPersonalNow(now);
      if (now - personalStart >= TOGETHER_REVEAL_DURATION_MS) setPersonalStart(null);
    }, 100);
    return () => window.clearInterval(timer);
  }, [personalStart, canReplay]);
  const shared = activeShared && !showFinal && !reducedMotion;
  const progress = personal
    ? Math.max(0, Math.min(1, (personalNow - personalStart!) / TOGETHER_REVEAL_DURATION_MS))
    : shared
      ? timeline.progress
      : 1;
  const mode = personal ? 'personal' : shared ? 'shared' : 'final';
  const race = round.game === 'thunder_derby_3d' || round.game === 'neon_hounds_3d';
  const keno = ['roulette_keno', 'lucky_six', 'turbo_keno'].includes(round.game);
  const entries = currentEntries(round);
  const mine = entries.find((e) => e.userId === userId);
  const total = keno
    ? (round.outcome?.numbers.length ?? 0)
    : race
      ? 8
      : round.game === 'blackjack'
        ? 7
        : round.game === 'virtual_football_3d'
          ? 3
          : round.game === 'dice'
            ? entries.length
            : 1;
  const visible = Math.floor(total * progress);
  const valid = displayable(round);
  if (!round.outcome && round.state === 'REFUNDED')
    return (
      <section
        className="tg-result tg-result-refund"
        aria-labelledby={headingId}
        data-reveal-phase="complete"
        data-reveal-mode="final"
        data-reveal-progress="1"
      >
        <h2 id={headingId}>Entries returned</h2>
        <p>
          This round ended without a draw. Every confirmed entry was returned in full, with no fee.
        </p>
      </section>
    );
  if (!valid)
    return (
      <section className="tg-result" aria-labelledby={headingId}>
        <h2 id={headingId}>Result display unavailable</h2>
        <p>
          The saved result could not be displayed. Refresh this round or use the round receipt and
          result verification below.
        </p>
      </section>
    );
  return (
    <section
      className={'tg-result' + (progress < 1 ? ' tg-result-revealing' : '')}
      aria-labelledby={headingId}
      data-reveal-phase={timeline.phase}
      data-reveal-mode={mode}
      data-reveal-progress={progress}
    >
      <div className="tg-result-header">
        <div>
          <p className="tg-result-kicker">
            <Flag size={15} />
            {shared ? 'Shared reveal' : personal ? 'Your replay' : 'Recorded result'}
          </p>
          <h2 id={headingId}>
            {race
              ? 'The finishing order'
              : keno
                ? 'The shared draw'
                : round.game === 'blackjack'
                  ? 'The table revealed'
                  : round.game === 'virtual_football_3d'
                    ? 'Full-time results'
                    : round.game === 'spin_win'
                      ? 'The winning segment'
                      : round.game === 'dice'
                        ? 'The dice results'
                        : round.game === 'number_challenge'
                          ? 'The shared target'
                          : 'The crash result'}
          </h2>
        </div>
        <div className="tg-result-controls">
          {shared || personal ? (
            <button
              type="button"
              onClick={() => {
                setShowFinal(true);
                setPersonalStart(null);
              }}
            >
              <SkipForward size={16} />
              Show final result
            </button>
          ) : activeShared && !reducedMotion ? (
            <button type="button" onClick={() => setShowFinal(false)}>
              Rejoin shared reveal
            </button>
          ) : canReplay ? (
            <button
              type="button"
              onClick={() => {
                const now = performance.now();
                setPersonalNow(now);
                setPersonalStart(now);
                setShowFinal(false);
              }}
            >
              <RotateCcw size={16} />
              Replay for me
            </button>
          ) : null}
        </div>
      </div>
      {shared && (
        <div className="tg-result-shared-status">
          <p role="status">
            {timeline.phase === 'scheduled'
              ? 'The group reveal starts in ' +
                Math.max(0, Math.ceil((timeline.startsAt! - serverNow!) / 1000)) +
                ' seconds.'
              : 'Watching together. The group follows one shared reveal.'}
          </p>
          <div
            role="progressbar"
            aria-label="Shared reveal progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(timeline.progress * 100)}
          >
            <span style={{ width: timeline.progress * 100 + '%' }} />
          </div>
          <small>You can view the final result at any time. Your payout is shown below.</small>
        </div>
      )}
      {personal && (
        <p className="tg-result-replay-note" role="status">
          Your personal replay. The group’s result and everyone’s wallet are unchanged.
        </p>
      )}
      {!hasClock && (
        <p className="tg-result-replay-note" role="status">
          Showing the saved final result while the shared clock reconnects.
        </p>
      )}
      {hasClock && reducedMotion && activeShared && (
        <p className="tg-result-replay-note">
          Showing the final result with reduced motion. The group’s reveal continues.
        </p>
      )}
      {hasClock && !reducedMotion && showFinal && activeShared && (
        <p className="tg-result-replay-note">
          You’re viewing the final result. The group’s reveal continues.
        </p>
      )}
      {timeline.phase === 'awaiting' && hasClock && (
        <p className="tg-result-replay-note">
          Result recorded. The group reveal will start when settlement completes.
        </p>
      )}
      {round.settlement?.refunds && (
        <p className="tg-result-refund-note">
          {round.settlement.reason === 'ALL_TIED'
            ? 'Everyone tied.'
            : round.settlement.reason === 'NO_WINNERS'
              ? 'No qualifying winner.'
              : 'Round refunded.'}{' '}
          All entries returned in full. No fee.
        </p>
      )}
      {keno && <KenoResult round={round} mine={mine} visible={visible} />}
      {race && <RaceResult round={round} mine={mine} visible={visible} />}
      {round.game === 'virtual_football_3d' && (
        <FootballResult round={round} mine={mine} visible={visible} />
      )}
      {round.game === 'blackjack' && (
        <BlackjackResult round={round} mine={mine} visible={visible} />
      )}
      {(round.game === 'sky_crash' || round.game === 'crash_point') && (
        <CrashResult round={round} entries={entries} mine={mine} progress={progress} />
      )}
      {(round.game === 'spin_win' ||
        round.game === 'dice' ||
        round.game === 'number_challenge') && (
        <OriginalResult
          round={round}
          entries={entries}
          mine={mine}
          visible={visible}
          progress={progress}
        />
      )}
    </section>
  );
}

function OriginalResult({
  round,
  entries,
  mine,
  visible,
  progress,
}: {
  round: TogetherRoundView;
  entries: TogetherEntryView[];
  mine?: TogetherEntryView;
  visible: number;
  progress: number;
}) {
  const numbers = round.outcome!.numbers;
  const ordered = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (round.game === 'spin_win')
    return (
      <div className="tg-result-simple">
        <SharedWheel entries={ordered} winner={numbers[0]} progress={progress} />
        <p data-revealed={visible > 0}>
          {visible > 0 ? (
            <>
              Winning segment <strong>{numbers[0] + 1}</strong>
            </>
          ) : (
            'The shared wheel is spinning…'
          )}
        </p>
        {visible > 0 && (
          <h3>
            {ordered[numbers[0]]?.username}
            {ordered[numbers[0]]?.id === mine?.id ? ' (you)' : ''}
          </h3>
        )}
        <p className="tg-result-footnote">
          Every confirmed entry has one equal segment on the shared wheel.
        </p>
      </div>
    );
  if (round.game === 'number_challenge')
    return (
      <>
        <div className="tg-result-simple">
          <p>Shared target</p>
          <strong data-revealed={visible > 0}>{visible > 0 ? numbers[0] : '…'}</strong>
          {visible === 0 && <p>Revealing the shared target…</p>}
        </div>
        <ul className="tg-result-exits" aria-label="Guesses and distance from the target">
          {ordered.map((entry) => (
            <li
              key={entry.id}
              data-revealed={visible > 0}
              className={entry.id === mine?.id ? 'is-mine' : ''}
            >
              <span>
                {entry.username}
                {entry.id === mine?.id ? ' (you)' : ''}
              </span>
              <strong>{entry.selection?.[0] ?? 'Unavailable'}</strong>
              <span>
                {visible === 0
                  ? 'Awaiting target'
                  : entry.selection?.[0] === undefined
                    ? 'Selection unavailable'
                    : 'Distance ' + Math.abs(entry.selection[0] - numbers[0])}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  return (
    <ul className="tg-result-exits" aria-label="Recorded dice rolls">
      {ordered.map((entry, i) => (
        <li
          key={entry.id}
          data-revealed={i < visible}
          className={entry.id === mine?.id ? 'is-mine' : ''}
        >
          <span>
            {entry.username}
            {entry.id === mine?.id ? ' (you)' : ''}
          </span>
          <strong>{i < visible ? numbers[i * 2] + ' + ' + numbers[i * 2 + 1] : '— + —'}</strong>
          <span>
            {i < visible ? 'Total ' + (numbers[i * 2] + numbers[i * 2 + 1]) : 'Revealing dice…'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SharedWheel({
  entries,
  winner,
  progress,
}: {
  entries: TogetherEntryView[];
  winner: number;
  progress: number;
}) {
  const segment = 360 / entries.length;
  const rotation = (1440 - (winner + 0.5) * segment) * (1 - (1 - progress) ** 3);
  const point = (angle: number, radius: number) => [
    120 + radius * Math.sin((angle * Math.PI) / 180),
    120 - radius * Math.cos((angle * Math.PI) / 180),
  ];
  return (
    <svg
      className="tg-result-wheel"
      viewBox="0 0 240 240"
      role="img"
      aria-label={
        progress === 1 ? 'Shared wheel, winning segment ' + (winner + 1) : 'Shared wheel reveal'
      }
    >
      <g transform={'rotate(' + rotation + ' 120 120)'}>
        {entries.map((entry, i) => {
          const from = point(i * segment, 100),
            to = point((i + 1) * segment, 100),
            label = point((i + 0.5) * segment, 76);
          return (
            <g key={entry.id}>
              <path
                d={`M120 120 L${from.join(' ')} A100 100 0 ${segment > 180 ? 1 : 0} 1 ${to.join(' ')} Z`}
                fill={i % 2 ? 'var(--tg-soft)' : 'var(--tg-bg)'}
                stroke="var(--tg-line)"
              />
              <text
                x={label[0]}
                y={label[1]}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="var(--tg-ink)"
                fontSize="13"
                fontWeight="700"
              >
                {i + 1}
              </text>
            </g>
          );
        })}
      </g>
      <circle cx="120" cy="120" r="24" fill="var(--tg-panel)" stroke="var(--tg-line)" />
      <path d="M110 9 L130 9 L120 30 Z" fill="var(--tg-accent)" />
    </svg>
  );
}

function KenoResult({
  round,
  mine,
  visible,
}: {
  round: TogetherRoundView;
  mine?: TogetherEntryView;
  visible: number;
}) {
  const drawn = round.outcome!.numbers;
  const picks = mine?.selection ?? [];
  const hits = picks.filter((n) => drawn.slice(0, visible).includes(n));
  const completion = hits.length === 6 ? Math.max(...picks.map((n) => drawn.indexOf(n))) + 1 : null;
  return (
    <>
      <div className="tg-result-summary">
        <strong>
          {visible < drawn.length
            ? visible + ' of ' + drawn.length + ' balls revealed'
            : drawn.length + ' balls drawn'}
        </strong>
        {picks.length > 0 && (
          <span>
            Your ticket: <b>{hits.length} matches</b>
            {round.game === 'lucky_six' && completion
              ? ' · six completed on ball ' + completion
              : ''}
          </span>
        )}
      </div>
      <ol className="tg-result-balls" aria-label="Balls in draw order">
        {drawn.map((n, i) => (
          <li
            key={n}
            data-revealed={i < visible}
            className={
              (i < visible && picks.includes(n) ? 'is-match ' : '') +
              (i >= visible ? 'is-concealed' : '')
            }
            aria-label={
              i >= visible
                ? 'Ball ' + (i + 1) + ': awaiting reveal'
                : 'Ball ' + (i + 1) + ': ' + n + (picks.includes(n) ? ', matched your ticket' : '')
            }
          >
            <span aria-hidden="true">{i < visible ? n : '·'}</span>
            <small aria-hidden="true">{i + 1}</small>
          </li>
        ))}
      </ol>
      {picks.length > 0 && (
        <div className="tg-result-ticket">
          <span>Your numbers</span>
          <div>
            {picks.map((n) => (
              <b key={n} className={hits.includes(n) ? 'is-match' : ''}>
                {n}
                {hits.includes(n) && <span className="sr-only"> matched</span>}
              </b>
            ))}
          </div>
        </div>
      )}
      <p className="tg-result-footnote">
        {round.game === 'lucky_six'
          ? 'First to complete all six wins. If no ticket completes, most matches wins.'
          : 'Most matches wins.'}{' '}
        Tied leaders share the prize; if everyone ties or nobody matches, all entries are returned.
      </p>
    </>
  );
}

function RaceResult({
  round,
  mine,
  visible,
}: {
  round: TogetherRoundView;
  mine?: TogetherEntryView;
  visible: number;
}) {
  const order = round.outcome!.numbers;
  const label = round.game === 'neon_hounds_3d' ? 'Dog' : 'Runner';
  const selected = mine?.selection?.[0];
  const selectedRunners = new Set(currentEntries(round).flatMap((e) => e.selection ?? []));
  const leadingPick = order.find((n) => selectedRunners.has(n));
  const contestLabel = round.state === 'PAID' ? 'Group-winning pick' : 'Best selected finisher';
  return (
    <>
      <p className="tg-result-footnote">
        The best finishing {label.toLowerCase()} selected by your group wins. Members who chose the
        same leading pick share the prize.
      </p>
      {leadingPick !== undefined && order.indexOf(leadingPick) < visible && (
        <p className="tg-result-group-winner">
          <strong>
            {contestLabel}: {label} {leadingPick}
          </strong>{' '}
          · finished #{order.indexOf(leadingPick) + 1} overall
        </p>
      )}
      {selected !== undefined && (
        <div className="tg-result-summary">
          <strong>
            Your pick: {label} {selected}
          </strong>
          <span>
            {order.indexOf(selected) < visible ? (
              <>
                Finished <b>#{order.indexOf(selected) + 1}</b>
              </>
            ) : (
              'Awaiting finish'
            )}
          </span>
        </div>
      )}
      <ol className="tg-result-race" aria-label="Recorded finishing order">
        {order.map((n, i) => (
          <li
            key={n}
            data-revealed={i < visible}
            className={
              (i < visible && selected === n ? 'is-mine ' : '') +
              (i >= visible ? 'is-concealed' : '')
            }
          >
            <span className="tg-result-place">
              {i === 0 ? <Trophy size={18} aria-label="First place" /> : i + 1}
            </span>
            <div className="tg-result-lane">
              <span className="tg-result-runner">
                {i < visible ? (
                  <>
                    <b>{n}</b>
                    <span>
                      {label} {n}
                    </span>
                  </>
                ) : (
                  <span>Revealing finish…</span>
                )}
              </span>
            </div>
            {i < visible && selected === n && <span className="tg-result-you">Your pick</span>}
          </li>
        ))}
      </ol>
    </>
  );
}

function FootballResult({
  round,
  mine,
  visible,
}: {
  round: TogetherRoundView;
  mine?: TogetherEntryView;
  visible: number;
}) {
  return (
    <>
      <p className="tg-result-footnote">
        Three simulated matches. Each correct prediction earns one point.
      </p>
      <div className="tg-result-matches">
        {round.outcome!.football!.map((score, i) => {
          const pick = mine?.selection?.[i];
          return (
            <article
              key={i}
              data-revealed={i < visible}
              className={'tg-result-match' + (i >= visible ? ' is-concealed' : '')}
              aria-label={'Simulated match ' + (i + 1)}
            >
              <h3>Match {i + 1}</h3>
              <div className="tg-result-score">
                <span>Home</span>
                <strong>{i < visible ? score.home + ' – ' + score.away : '– : –'}</strong>
                <span>Away</span>
              </div>
              <p>{i < visible ? predictions[round.outcome!.numbers[i]] : 'Revealing score…'}</p>
              {pick !== undefined && (
                <div
                  className={
                    'tg-result-prediction' +
                    (i < visible && pick === round.outcome!.numbers[i] ? ' is-match' : '')
                  }
                >
                  Your prediction: {predictions[pick] ?? 'Unavailable'}
                  {i < visible
                    ? pick === round.outcome!.numbers[i]
                      ? ' · Correct'
                      : ' · Missed'
                    : ''}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

function CardHand({ cards }: { cards: number[] }) {
  const total = bjTotal(cards);
  const names = ['spades', 'hearts', 'clubs', 'diamonds'];
  return (
    <>
      <div className="tg-result-cards">
        {cards.map((id) => {
          const card = bjCard(id);
          return (
            <span
              key={id}
              className={'tg-result-card' + (card.red ? ' is-red' : '')}
              aria-label={card.rank + ' of ' + names[Math.floor(id / 13) % 4]}
            >
              <b aria-hidden="true">{card.rank}</b>
              <span aria-hidden="true">{card.suit}</span>
            </span>
          );
        })}
      </div>
      <p className="tg-result-hand-total">
        {total.blackjack
          ? 'Blackjack · 21'
          : total.bust
            ? 'Bust · ' + total.total
            : (total.soft ? 'Soft ' : 'Total ') + total.total}
      </p>
    </>
  );
}

function BlackjackResult({
  round,
  mine,
  visible,
}: {
  round: TogetherRoundView;
  mine?: TogetherEntryView;
  visible: number;
}) {
  return (
    <>
      <p className="tg-result-footnote">
        Six automated hands against one dealer. Hands draw below 17 and stand on 17 or higher,
        including soft 17. Each correct win, draw or loss prediction earns one point.
      </p>
      <div className="tg-result-table">
        {round.outcome!.hands!.map((hand, i) => {
          const pick = mine?.selection?.[i - 1];
          return (
            <article
              key={i}
              data-revealed={i < visible}
              className={'tg-result-hand' + (i === 0 ? ' tg-result-dealer' : '')}
              aria-label={i === 0 ? 'Dealer hand' : 'Hand ' + i}
            >
              <h3>
                {i === 0 ? 'Dealer' : 'Hand ' + i}
                {i > 0 && i < visible && <span>{handResults[round.outcome!.numbers[i - 1]]}</span>}
              </h3>
              {i < visible ? (
                <CardHand cards={hand} />
              ) : (
                <p className="tg-result-card-wait">Revealing hand…</p>
              )}
              {i > 0 && pick !== undefined && (
                <div
                  className={
                    'tg-result-prediction' +
                    (i < visible && pick === round.outcome!.numbers[i - 1] ? ' is-match' : '')
                  }
                >
                  Your prediction: {handResults[pick] ?? 'Unavailable'}
                  {i < visible
                    ? pick === round.outcome!.numbers[i - 1]
                      ? ' · Correct'
                      : ' · Missed'
                    : ''}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

function CrashResult({
  round,
  entries,
  mine,
  progress,
}: {
  round: TogetherRoundView;
  entries: TogetherEntryView[];
  mine?: TogetherEntryView;
  progress: number;
}) {
  const crash = round.outcome!.numbers[0];
  const pick = mine?.selection?.[0];
  const finished = progress >= 1;
  const position = (n: number) =>
    Math.max(0, Math.min(100, (Math.log(n / 100) / Math.log(20.01)) * 100));
  return (
    <>
      <div className="tg-result-crash-hero">
        <span>{finished ? 'Shared crash' : 'Shared reveal'}</span>
        <strong data-revealed={finished}>{finished ? target(crash) : '…'}</strong>
        <p>
          {finished
            ? 'Targets must be strictly below this point to qualify.'
            : 'Revealing the saved crash point together…'}
        </p>
      </div>
      <div
        className="tg-result-crash-scale"
        aria-label={
          (finished ? 'Crash point ' + target(crash) : 'Crash point reveal in progress') +
          (pick ? ', your target ' + target(pick) : '')
        }
      >
        <div className="tg-result-crash-track">
          <div style={{ width: position(crash) * progress + '%' }} />
          {finished && (
            <span className="tg-result-crash-marker" style={{ left: position(crash) + '%' }} />
          )}
          {pick !== undefined && (
            <span className="tg-result-target-marker" style={{ left: position(pick) + '%' }} />
          )}
        </div>
        <div className="tg-result-crash-labels">
          <span>1.00×</span>
          <span>5.00×</span>
          <span>20.01×</span>
        </div>
      </div>
      <div className="tg-result-legend">
        <span>
          <i className="tg-result-crash-dot" /> Crash
        </span>
        {pick !== undefined && (
          <span>
            <i className="tg-result-target-dot" /> Your target
          </span>
        )}
      </div>
      <p className="tg-result-footnote">
        Targets are contest scores, not payout multipliers. The highest qualifying target wins; ties
        share. Reaching the crash point exactly does not qualify.
      </p>
      <ul className="tg-result-exits" aria-label="Recorded exit targets">
        {[...entries]
          .sort((a, b) => (b.selection?.[0] ?? 0) - (a.selection?.[0] ?? 0))
          .map((entry) => {
            const choice = entry.selection?.[0];
            return (
              <li
                key={entry.id}
                data-revealed={finished}
                className={entry.id === mine?.id ? 'is-mine' : ''}
              >
                <span>
                  {entry.username}
                  {entry.id === mine?.id ? ' (you)' : ''}
                </span>
                <strong>{choice === undefined ? 'Unavailable' : target(choice)}</strong>
                <span>
                  {!finished
                    ? 'Awaiting crash point'
                    : choice === undefined
                      ? 'Selection unavailable'
                      : choice < crash
                        ? 'Qualified'
                        : 'Crashed'}
                </span>
              </li>
            );
          })}
      </ul>
    </>
  );
}
