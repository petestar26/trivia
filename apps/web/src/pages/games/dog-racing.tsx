import { SceneLoadBoundary } from '@/components/games/scene-load-boundary';
import { GameRoundSummary } from '@/components/games/game-round-summary';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  DOG_RACING_RULES as DERBY_RULES,
  RACING_DOGS as DERBY_HORSES,
  DERBY_MARKETS,
  DERBY_LABELS,
  DERBY_HELP as HORSE_HELP,
  derbyOddsCents,
  derbySelectionCount,
  parseDerbyEntry,
  type DerbyField,
  type DerbyMarket,
  type DerbySnapshot,
  type DerbyRound,
} from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { requestStatus } from '@/lib/request-error';
import { boundedRequest } from '@/lib/bounded-request';
import { useAuth } from '@/providers/auth-provider';
import { GameArena } from '@/components/games/game-arena';
import './thunder-derby.css';
const RaceScene = lazy(() => import('@/components/dog-racing/race-scene'));
const DERBY_HELP = Object.fromEntries(
  Object.entries(HORSE_HELP).map(([key, value]) => [
    key,
    value.replace(/horses/g, 'dogs').replace(/horse/g, 'dog'),
  ])
) as Record<DerbyMarket, string>;
import type { DogCamera } from '@/components/dog-racing/race-scene';
import { useGameQuality } from '@/components/together/use-game-quality';
import type { GameQuality } from '@/components/together/game-art-direction';
import './dog-racing.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

type Entry = {
  roundId: string;
  field: DerbyField;
  market: DerbyMarket;
  picks: number[];
  stake: number;
};
const endpoint = '/games/dog-racing';
function FinishOrder({ round, previous = false }: { round: DerbyRound; previous?: boolean }) {
  const { t: translateUi } = useInterfaceLanguage();

  if (!round.order?.length) return null;
  const winner = DERBY_HORSES[round.order[0] - 1];
  return (
    <section className="derby-results" aria-label={translateUi('Official finishing order')}>
      <div className="derby-winner">
        <span className="derby-winner-medal" aria-hidden="true">
          1
        </span>
        <div>
          <span className="derby-eyebrow">
            {previous ? translateUi('LATEST COMPLETED RACE') : translateUi('OFFICIAL RESULT')}
          </span>
          <h3 role="status">
            {translateUi('Winner · #{value} {name}', { value: round.order[0], name: winner.name })}
          </h3>
          <p>{translateUi('{field} runners · {id}', { field: round.field, id: round.id })}</p>
        </div>
      </div>
      <ol className="derby-finish-order" aria-label={translateUi('First to last')}>
        {round.order.map((number, index) => (
          <li key={number}>
            <span className="derby-place">
              {index < 3
                ? translateUi(['1st', '2nd', '3rd'][index])
                : translateUi('{value}th', { value: index + 1 })}
            </span>
            <b
              style={{
                backgroundColor: DERBY_HORSES[number - 1].color,
                color: DERBY_HORSES[number - 1].ink,
              }}
            >
              #{number}
            </b>
            <span>{DERBY_HORSES[number - 1].name}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
export function DogRacingPage() {
  const { user } = useAuth();
  return user ? <DogRacingConnected key={user.id} userId={user.id} /> : null;
}
function DogRacingConnected({ userId }: { userId: string }) {
  const { t: translateUi } = useInterfaceLanguage();

  const [field, setField] = useState<DerbyField>(6),
    [pending, setPending] = useState<Entry | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const storageKey = `salem.hounds.pending.${userId}`;
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const value = JSON.parse(raw);
        if (typeof value.roundId !== 'string' || value.roundId.length > 64) throw Error();
        setPending({
          roundId: value.roundId,
          ...parseDerbyEntry(value.field, value.market, value.picks, value.stake),
        });
      }
    } catch {
      setError('A saved selection could not be read. Refresh race status before continuing.');
    }
  }, [storageKey]);
  const query = useQuery({
    queryKey: ['dog-racing', userId, field],
    queryFn: async ({ signal }) =>
      unwrapData(
        await boundedRequest(
          (s) => api.get<DerbySnapshot>(`${endpoint}?field=${field}`, undefined, { signal: s }),
          signal
        )
      ),
    refetchInterval: 2000,
    retry: 1,
  });
  async function submit(entry: Entry) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(entry));
      setPending(entry);
      await boundedRequest((signal) =>
        api.post(`${endpoint}/tickets`, entry, undefined, { signal })
      );
      sessionStorage.removeItem(storageKey);
      setPending(null);
      await query.refetch();
    } catch (e) {
      if ([400, 403, 404, 409].includes(requestStatus(e) ?? 0)) {
        sessionStorage.removeItem(storageKey);
        setPending(null);
        setError('Selection was not accepted. Refresh race status and review your choice.');
        await query.refetch();
      } else
        setError(
          'Confirmation is unresolved. Retry this same selection to check its receipt; it cannot be charged twice.'
        );
    } finally {
      setBusy(false);
    }
  }
  if (!query.data)
    return (
      <main className="derby-page hounds-page">
        <Link to="/games">{translateUi('← Games')}</Link>
        <h1>{translateUi('Dog Racing')}</h1>
        <p role="status">
          {query.isError
            ? translateUi('Practice is unavailable. Please try again later.')
            : translateUi('Preparing the racecourse…')}
        </p>
        <button onClick={() => query.refetch()}>{translateUi('Refresh')}</button>
      </main>
    );
  return (
    <DogRacingView
      data={query.data}
      field={field}
      onField={setField}
      onSubmit={submit}
      busy={busy}
      pending={pending}
      error={
        error ||
        (query.isError
          ? 'Connection interrupted. Selections are paused until race status refreshes.'
          : '')
      }
      available={!query.isError}
      updatedAt={query.dataUpdatedAt}
    />
  );
}
export function DogRacingView({
  data,
  field,
  onField,
  onSubmit,
  busy = false,
  pending = null,
  error = '',
  available = true,
  updatedAt = Date.now(),
}: {
  data: DerbySnapshot;
  field: DerbyField;
  onField: (n: DerbyField) => void;
  onSubmit: (e: Entry) => void;
  busy?: boolean;
  pending?: Entry | null;
  error?: string;
  available?: boolean;
  updatedAt?: number;
}) {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const [market, setMarket] = useState<DerbyMarket>('WIN'),
    [picks, setPicks] = useState<number[]>([]),
    [stake, setStake] = useState('25'),
    [confirm, setConfirm] = useState<Entry | null>(null),
    [details, setDetails] = useState<DerbyRound | null>(null),
    [now, setNow] = useState(Date.now()),
    [reduced, setReduced] = useState(false),
    [cameraMode, setCameraMode] = useState<DogCamera>('trackside');
  // Same graphics choice as group play: Automatic adapts to measured frame times.
  const graphics = useGameQuality(reduced);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const round = data.rounds[0];
  useEffect(() => {
    setMarket(round?.ticket?.market ?? 'WIN');
    setPicks([...(round?.ticket?.picks ?? [])]);
    if (round?.ticket) setStake(String(round.ticket.stake));
    setConfirm(null);
  }, [
    field,
    round?.id,
    round?.ticket?.market,
    round?.ticket?.stake,
    JSON.stringify(round?.ticket?.picks),
  ]);
  if (!round)
    return (
      <main className="derby-page hounds-page">
        <h1>{translateUi('Dog Racing')}</h1>
        <p>{translateUi('Waiting for the next race.')}</p>
      </main>
    );
  const serverNow = data.serverTime + Math.max(0, now - updatedAt),
    fresh = now - updatedAt < 6000 && available;
  const open = serverNow >= round.opensAt && serverNow < round.startsAt,
    running = serverNow >= round.startsAt && serverNow < round.finishesAt;
  const latestFinished = data.rounds
    .filter((r) => r.field === field && r.order?.length === field && r.finishesAt <= serverNow)
    .sort((a, b) => b.finishesAt - a.finishesAt)[0];
  const odds = derbyOddsCents(field, market),
    count = derbySelectionCount(market),
    valid =
      Number.isInteger(Number(stake)) &&
      Number(stake) >= 10 &&
      Number(stake) <= 500 &&
      picks.length === count;
  const disabled =
    !fresh || !open || !!round.ticket || busy || !!pending || data.rulesId !== DERBY_RULES.id;
  const seconds = Math.max(
    0,
    Math.ceil(
      ((open ? round.startsAt : running ? round.finishesAt : round.endsAt) - serverNow) / 1000
    )
  );
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  function choose(n: number) {
    setPicks((old) =>
      old.includes(n)
        ? old.filter((p) => p !== n)
        : count === 1
          ? [n]
          : old.length < count
            ? [...old, n]
            : old
    );
  }
  return (
    <main className="derby-page hounds-page" data-field={field}>
      <header className="derby-header">
        <div>
          <Link to="/games">{translateUi('← All games')}</Link>
          <h1>
            <span className="derby-crest" aria-hidden="true">
              ◇
            </span>{' '}
            <em>{translateUi('DOG RACING')}</em>
            <small>{translateUi('SALEM OVAL')}</small>
          </h1>
        </div>
        <div className="derby-credit">
          <span>{translateUi('Racing practice')}</span>
          <strong>
            {data.balance.toLocaleString(interfaceLocale)} <small>{'ETB'}</small>
          </strong>
          <p>{translateUi('No cash stakes · No cash prizes')}</p>
        </div>
      </header>
      <div className="derby-toolbar">
        <div role="group" aria-label={translateUi('Race field')}>
          {([6, 8] as const).map((n) => (
            <button
              key={n}
              aria-pressed={field === n}
              disabled={busy || !!pending}
              onClick={() => onField(n)}
            >
              {n}
              {' ' + translateUi('dogs') + ' '}
              <small>{translateUi('Every {value} min', { value: n / 2 })}</small>
            </button>
          ))}
        </div>
        <Dialog.Root>
          <Dialog.Trigger className="derby-help">{translateUi('How to play ↗')}</Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="derby-overlay" />
            <Dialog.Content className="derby-dialog">
              <Dialog.Title>{translateUi('Welcome to Dog Racing')}</Dialog.Title>
              <Dialog.Description>
                {translateUi(
                  'Original simulated racing with free, non-redeemable practice ETB. Your racing practice balance is shared with Derby; your cash wallet is separate.'
                )}
              </Dialog.Description>
              <ol>
                <li>{translateUi('Choose a six- or eight-dog race, then a selection type.')}</li>
                <li>
                  {translateUi('Pick numbered dogs in the required order. Choose 10–500 ETB.')}
                </li>
                <li>
                  {translateUi(
                    'Review the total return and confirm before the race starts. One selection per race; confirmed choices cannot be changed.'
                  )}
                </li>
                <li>
                  {translateUi(
                    'Watch the 45-second race. Winning returns include your stake and are credited automatically.'
                  )}
                </li>
              </ol>
              {DERBY_MARKETS.map((m) => (
                <p key={m}>
                  <strong>{translateUi(DERBY_LABELS[m])}:</strong> {translateUi(DERBY_HELP[m])}
                </p>
              ))}
              <p>
                {translateUi(
                  'Every finishing order is equally likely. Dog appearance and previous results do not predict the winner. Fixed odds target a 90% average gross return before rounding down to whole ETB. There is no jackpot, bonus round, cash-out or autoplay.'
                )}
              </p>
              <p>
                {translateUi(
                  'Connection lost? Your confirmed selection still settles on the server. Reconnect to retrieve its result. Unconfirmed selections are never carried into a later race.'
                )}
              </p>
              <Dialog.Close>{translateUi('Close rules')}</Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      <GameRoundSummary
        game="Dog Racing"
        label={
          latestFinished
            ? translateUi('Latest winner')
            : running
              ? translateUi('Race running')
              : translateUi('Race status')
        }
        value={
          latestFinished
            ? `#${latestFinished.order![0]} ${DERBY_HORSES[latestFinished.order![0] - 1].name}`
            : open
              ? 'Selections open'
              : 'Awaiting result'
        }
        detail={
          latestFinished
            ? translateUi('Finish: {order}', {
                order: latestFinished.order!.map((n) => `#${n}`).join(' → '),
              })
            : 'Free practice · no cash value'
        }
        clock={`${!fresh ? translateUi('Reconnecting · ') : ''}${translateUi(open ? 'Closes' : running ? 'Finish' : 'Next race')} ${clock}`}
      />
      <section className="derby-history" aria-label={translateUi('Recent results')}>
        <span>{translateUi('RECENT FINISHES')}</span>
        {data.rounds
          .filter((r) => r.order)
          .slice(0, 8)
          .map((r) => (
            <button
              key={r.id}
              onClick={() => setDetails(r)}
              aria-label={translateUi('Open result {id}', { id: r.id })}
            >
              {r.order!.slice(0, 3).map((n, i) => (
                <b key={n} style={{ borderColor: DERBY_HORSES[n - 1].color }}>
                  <small>{i + 1}</small>
                  {n}
                </b>
              ))}
            </button>
          ))}
        {!data.rounds.some((r) => r.order) && (
          <p>{translateUi('Completed races will appear here.')}</p>
        )}
      </section>
      {error && (
        <p role="alert" className="derby-alert">
          {translateUi(error)}
        </p>
      )}
      {pending && (
        <div className="derby-alert">
          {translateUi('Unresolved selection:') + ' '}
          {translateUi(DERBY_LABELS[pending.market])} · {pending.stake}
          {' ' + translateUi('ETB.')}{' '}
          <button disabled={busy} onClick={() => onSubmit(pending)}>
            {translateUi('Check saved confirmation')}
          </button>
        </div>
      )}
      <div className="derby-layout">
        <GameArena title={translateUi('Dog Racing')} className="derby-display">
          <section className="derby-arena" aria-label={translateUi('Racecourse')}>
            <div className="derby-race-heading">
              <div>
                <span className="derby-eyebrow">{translateUi('SALEM OVAL · GREYHOUNDS')}</span>
                <h2>
                  {!fresh
                    ? translateUi('View paused · Reconnecting')
                    : open
                      ? translateUi('At the starting gate')
                      : running
                        ? translateUi('The race is on')
                        : round.order
                          ? translateUi('Official finish')
                          : translateUi('Awaiting official result')}
                </h2>
                <p>{translateUi('{field} runners · {id}', { field: round.field, id: round.id })}</p>
              </div>
              <div className="derby-countdown">
                <span>
                  {open
                    ? translateUi('Selections close')
                    : running
                      ? translateUi('Race finishes')
                      : translateUi('Next race')}
                </span>
                <strong>{clock}</strong>
              </div>
            </div>
            <div className="derby-scene-shell">
              <SceneLoadBoundary
                fallback={
                  <p>
                    {translateUi(
                      'Follow numbered runner progress below and the official finishing order above.'
                    )}
                  </p>
                }
              >
                <Suspense
                  fallback={
                    <div className="derby-scene-fallback">
                      {translateUi('Preparing racecourse…')}
                    </div>
                  }
                >
                  <RaceScene
                    round={round}
                    running={running && fresh}
                    reduced={reduced}
                    cameraMode={cameraMode}
                    quality={graphics.tier}
                    adaptive={graphics.adaptive}
                    onSlow={graphics.degrade}
                  />
                </Suspense>
              </SceneLoadBoundary>
              <div className="derby-broadcast-label">
                <span>{translateUi('SALEM BET / SALEM OVAL')}</span>
                <strong>
                  {!fresh
                    ? translateUi('VIEW PAUSED · RECONNECTING')
                    : round.order
                      ? translateUi('OFFICIAL FINISH')
                      : running
                        ? translateUi('LIVE PUBLISHED POSITIONS')
                        : translateUi('AT THE STARTING GATE')}
                </strong>
              </div>
            </div>
            <div className="hounds-cameras" role="group" aria-label={translateUi('Camera view')}>
              {(['trackside', 'chase', 'aerial'] as const).map((mode) => (
                <button
                  key={mode}
                  aria-pressed={cameraMode === mode}
                  onClick={() => setCameraMode(mode)}
                >
                  {mode === 'trackside'
                    ? translateUi('Trackside')
                    : mode === 'chase'
                      ? translateUi('Follow race')
                      : translateUi('Aerial')}
                </button>
              ))}
            </div>
            <div className="derby-race-footer">
              <span>
                {fresh ? translateUi('● Connected') : translateUi('○ Refreshing race status')}
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={reduced}
                  onChange={(e) => setReduced(e.target.checked)}
                />{' '}
                {translateUi('Reduced motion')}
              </label>
              <label className="hounds-quality">
                {translateUi('Graphics quality')}{' '}
                <select
                  value={graphics.quality}
                  onChange={(e) => graphics.choose(e.target.value as GameQuality)}
                >
                  <option value="auto">{translateUi('Automatic')}</option>
                  <option value="high">{translateUi('High')}</option>
                  <option value="balanced">{translateUi('Balanced')}</option>
                  <option value="low">{translateUi('Low')}</option>
                </select>
              </label>
              <span>{translateUi('Server-set results')}</span>
            </div>
            <div className="derby-progress" aria-label={translateUi('Runner progress')}>
              {DERBY_HORSES.slice(0, field).map((h, i) => (
                <div key={h.name}>
                  <b style={{ background: h.color, color: h.ink }}>{i + 1}</b>
                  <span>{h.name}</span>
                  <meter
                    min={0}
                    max={1}
                    value={round.positions[i] || 0}
                    aria-label={translateUi('{name} race progress', { name: h.name })}
                  />
                </div>
              ))}
            </div>
          </section>
        </GameArena>
        <aside className="derby-slip">
          <span className="derby-eyebrow">{translateUi('YOUR RACE SELECTION')}</span>
          <h2>{translateUi('Pick your finish')}</h2>
          <div className="derby-markets" role="group" aria-label={translateUi('Selection type')}>
            {DERBY_MARKETS.map((m) => (
              <button
                key={m}
                aria-pressed={market === m}
                disabled={disabled}
                onClick={() => {
                  setMarket(m);
                  setPicks([]);
                }}
              >
                {translateUi(DERBY_LABELS[m])}
              </button>
            ))}
          </div>
          <p className="derby-instruction">
            {translateUi(DERBY_HELP[market])}{' '}
            {count > 1 && translateUi('Tap dogs in selection order.')}
          </p>
          {count > 0 ? (
            <div className="derby-runners" role="group" aria-label={translateUi('Choose dogs')}>
              {DERBY_HORSES.slice(0, field).map((h, i) => (
                <button
                  key={h.name}
                  aria-pressed={picks.includes(i + 1)}
                  disabled={disabled}
                  onClick={() => choose(i + 1)}
                >
                  <b style={{ background: h.color, color: h.ink }}>{i + 1}</b>
                  <span>{h.name}</span>
                  {picks.includes(i + 1) && (
                    <small>
                      {market === 'PERFECTA' || market === 'TRIFECTA'
                        ? translateUi(['1st', '2nd', '3rd'][picks.indexOf(i + 1)])
                        : '✓'}
                    </small>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="derby-special">
              {translateUi('Winning numbers: {value}', {
                value: Array.from({ length: field }, (_, i) => i + 1)
                  .filter((n) =>
                    market === 'ODD'
                      ? n % 2
                      : market === 'EVEN'
                        ? n % 2 === 0
                        : market === 'UNDER'
                          ? n <= field / 2
                          : n > field / 2
                  )
                  .join(' · '),
              })}
            </div>
          )}
          <label className="derby-stake">
            {translateUi('Practice ETB')}
            <input
              type="number"
              inputMode="numeric"
              min="10"
              max="500"
              step="1"
              value={stake}
              disabled={disabled}
              onChange={(e) => setStake(e.target.value)}
            />
          </label>
          <dl className="derby-quote">
            <div>
              <dt>{translateUi('Fixed gross odds')}</dt>
              <dd>{(odds / 100).toFixed(2)}×</dd>
            </div>
            <div>
              <dt>{translateUi('Total return if successful')}</dt>
              <dd>
                {translateUi('{value} ETB', {
                  value: valid
                    ? Math.floor((Number(stake) * odds) / 100).toLocaleString(interfaceLocale)
                    : '—',
                })}
              </dd>
            </div>
          </dl>
          <p className="derby-fine">
            {translateUi('Includes your stake. A losing selection returns 0.')}
          </p>
          <button
            className="derby-primary"
            disabled={disabled || !valid || Number(stake) > data.balance}
            onClick={() =>
              setConfirm({
                roundId: round.id,
                ...parseDerbyEntry(field, market, picks, Number(stake)),
              })
            }
          >
            {round.ticket
              ? translateUi('Selection confirmed')
              : !open
                ? translateUi('Selections closed')
                : translateUi('Review selection')}{' '}
            <span>{translateUi('Free practice only')}</span>
          </button>
          {round.ticket && (
            <div className="derby-receipt" role="status">
              <strong>
                {translateUi(DERBY_LABELS[round.ticket.market])}{' '}
                {round.ticket.picks
                  .map((n) => `#${n}`)
                  .join(round.ticket.market === 'QUINELLA' ? ' & ' : ' → ')}
              </strong>
              <p>
                {translateUi('{stake} ETB · {value}×', {
                  stake: round.ticket.stake,
                  value: (round.ticket.oddsCents / 100).toFixed(2),
                })}
              </p>
              <p>
                {round.ticket.payout === null
                  ? translateUi('Awaiting race result')
                  : translateUi('Returned {payout} practice ETB', { payout: round.ticket.payout })}
              </p>
            </div>
          )}
        </aside>
      </div>
      {latestFinished && (
        <FinishOrder round={latestFinished} previous={latestFinished.id !== round.id} />
      )}
      <p className="derby-disclaimer">
        {translateUi(
          'A simulated race with equal-chance runners. Previous results do not predict the next finish. Practice ETB have no monetary value.'
        )}
      </p>
      <Dialog.Root
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v) setConfirm(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="derby-overlay" />
          <Dialog.Content className="derby-dialog">
            <Dialog.Title>{translateUi('Confirm your practice selection')}</Dialog.Title>
            <Dialog.Description>
              {translateUi('This selection cannot be changed after confirmation.')}
            </Dialog.Description>
            {confirm && (
              <>
                <p>
                  {translateUi(DERBY_LABELS[confirm.market])} ·{' '}
                  {confirm.picks
                    .map((n) => `#${n}`)
                    .join(confirm.market === 'QUINELLA' ? ' & ' : ' → ')}
                </p>
                <p>
                  {translateUi('{stake} ETB · total successful return {value} ETB', {
                    stake: confirm.stake,
                    value: Math.floor(
                      (confirm.stake * derbyOddsCents(confirm.field, confirm.market)) / 100
                    ),
                  })}
                </p>
                <button
                  className="derby-primary"
                  disabled={
                    disabled || confirm.roundId !== round.id || confirm.stake > data.balance
                  }
                  onClick={() => {
                    onSubmit(confirm);
                    setConfirm(null);
                  }}
                >
                  {translateUi('Confirm practice selection')}
                </button>
              </>
            )}
            <Dialog.Close>{translateUi('Back')}</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={!!details}
        onOpenChange={(v) => {
          if (!v) setDetails(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="derby-overlay" />
          <Dialog.Content className="derby-dialog">
            <Dialog.Title>{translateUi('Official race result')}</Dialog.Title>
            <Dialog.Description>{details?.id}</Dialog.Description>
            {details && <FinishOrder round={details} />}
            {details?.ticket && (
              <p>
                {translateUi('Your selection returned {value} ETB.', {
                  value: details.ticket.payout ?? translateUi('pending'),
                })}
              </p>
            )}
            <details>
              <summary>{translateUi('Result verification')}</summary>
              <p>{translateUi('Commitment')}</p>
              <code>{details?.commitment}</code>
              <p>{translateUi('Revealed seed')}</p>
              <code>{details?.seed}</code>
              <p>{translateUi('Rules: {id}', { id: DERBY_RULES.id })}</p>
            </details>
            <Dialog.Close>{translateUi('Close result')}</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
