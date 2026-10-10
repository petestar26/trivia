import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  DERBY_RULES,
  DERBY_HORSES,
  DERBY_MARKETS,
  DERBY_LABELS,
  DERBY_HELP,
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
const RaceScene = lazy(() => import('@/components/derby/race-scene'));
type Entry = {
  roundId: string;
  field: DerbyField;
  market: DerbyMarket;
  picks: number[];
  stake: number;
};
const endpoint = '/games/thunder-derby';
function FinishOrder({ round, previous = false }: { round: DerbyRound; previous?: boolean }) {
  if (!round.order?.length) return null;
  const winner = DERBY_HORSES[round.order[0] - 1];
  return (
    <section className="derby-results" aria-label="Official finishing order">
      <div className="derby-winner">
        <span className="derby-winner-medal" aria-hidden="true">
          1
        </span>
        <div>
          <span className="derby-eyebrow">
            {previous ? 'LATEST COMPLETED RACE' : 'OFFICIAL RESULT'}
          </span>
          <h3 role="status">
            Winner · #{round.order[0]} {winner.name}
          </h3>
          <p>
            {round.field} runners · {round.id}
          </p>
        </div>
      </div>
      <ol className="derby-finish-order" aria-label="First to last">
        {round.order.map((number, index) => (
          <li key={number}>
            <span className="derby-place">
              {index < 3 ? ['1st', '2nd', '3rd'][index] : `${index + 1}th`}
            </span>
            <b style={{ backgroundColor: DERBY_HORSES[number - 1].color }}>#{number}</b>
            <span>{DERBY_HORSES[number - 1].name}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
export function ThunderDerbyPage() {
  const { user } = useAuth();
  return user ? <DerbyConnected key={user.id} userId={user.id} /> : null;
}
function DerbyConnected({ userId }: { userId: string }) {
  const [field, setField] = useState<DerbyField>(6),
    [pending, setPending] = useState<Entry | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const storageKey = `playqube.derby.pending.${userId}`;
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
    queryKey: ['derby', userId, field],
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
      <main className="derby-page">
        <Link to="/games">← Games</Link>
        <h1>Thunder Derby 3D</h1>
        <p role="status">
          {query.isError
            ? 'Practice is unavailable. Please try again later.'
            : 'Preparing the racecourse…'}
        </p>
        <button onClick={() => query.refetch()}>Refresh</button>
      </main>
    );
  return (
    <DerbyView
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
export function DerbyView({
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
  const [market, setMarket] = useState<DerbyMarket>('WIN'),
    [picks, setPicks] = useState<number[]>([]),
    [stake, setStake] = useState('25'),
    [confirm, setConfirm] = useState<Entry | null>(null),
    [details, setDetails] = useState<DerbyRound | null>(null),
    [now, setNow] = useState(Date.now()),
    [reduced, setReduced] = useState(false);
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
    setPicks([]);
    setConfirm(null);
  }, [field, round?.id]);
  if (!round)
    return (
      <main className="derby-page">
        <h1>Thunder Derby 3D</h1>
        <p>Waiting for the next race.</p>
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
    <main className="derby-page">
      <header className="derby-header">
        <div>
          <Link to="/games">← All games</Link>
          <h1>
            <span className="derby-crest" aria-hidden="true">
              ♞
            </span>{' '}
            THUNDER <em>DERBY</em>
            <small>3D RACING CLUB</small>
          </h1>
        </div>
        <div className="derby-credit">
          <span>Free practice</span>
          <strong>
            {data.balance.toLocaleString()} <small>credits</small>
          </strong>
          <p>No Coins · No cash prizes</p>
        </div>
      </header>
      <div className="derby-toolbar">
        <div role="group" aria-label="Race field">
          {([6, 8] as const).map((n) => (
            <button
              key={n}
              aria-pressed={field === n}
              disabled={busy || !!pending}
              onClick={() => onField(n)}
            >
              {n} horses <small>Every {n / 2} min</small>
            </button>
          ))}
        </div>
        <Dialog.Root>
          <Dialog.Trigger className="derby-help">How to play ↗</Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="derby-overlay" />
            <Dialog.Content className="derby-dialog">
              <Dialog.Title>Welcome to Thunder Derby</Dialog.Title>
              <Dialog.Description>
                Original simulated racing with free, non-redeemable practice credits.
              </Dialog.Description>
              <ol>
                <li>Choose a six- or eight-horse race, then a selection type.</li>
                <li>Pick numbered horses in the required order. Choose 10–500 credits.</li>
                <li>
                  Review the total return and confirm before the race starts. One selection per
                  race; confirmed choices cannot be changed.
                </li>
                <li>
                  Watch the 45-second race. Winning returns include your stake and are credited
                  automatically.
                </li>
              </ol>
              {DERBY_MARKETS.map((m) => (
                <p key={m}>
                  <strong>{DERBY_LABELS[m]}:</strong> {DERBY_HELP[m]}
                </p>
              ))}
              <p>
                Every finishing order is equally likely. Horse appearance and previous results do
                not predict the winner. Fixed odds target a 90% average gross return before rounding
                down to whole credits. There is no jackpot, bonus round, cash-out or autoplay.
              </p>
              <p>
                Connection lost? Your confirmed selection still settles on the server. Reconnect to
                retrieve its result. Unconfirmed selections are never carried into a later race.
              </p>
              <Dialog.Close>Close rules</Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      <section className="derby-history" aria-label="Recent results">
        <span>RECENT FINISHES</span>
        {data.rounds
          .filter((r) => r.order)
          .slice(0, 8)
          .map((r) => (
            <button key={r.id} onClick={() => setDetails(r)} aria-label={`Open result ${r.id}`}>
              {r.order!.slice(0, 3).map((n, i) => (
                <b key={n} style={{ borderColor: DERBY_HORSES[n - 1].color }}>
                  <small>{i + 1}</small>
                  {n}
                </b>
              ))}
            </button>
          ))}
        {!data.rounds.some((r) => r.order) && <p>Completed races will appear here.</p>}
      </section>
      {error && (
        <p role="alert" className="derby-alert">
          {error}
        </p>
      )}
      {pending && (
        <div className="derby-alert">
          Unresolved selection: {DERBY_LABELS[pending.market]} · {pending.stake} credits.{' '}
          <button disabled={busy} onClick={() => onSubmit(pending)}>
            Check saved confirmation
          </button>
        </div>
      )}
      <div className="derby-layout">
        <GameArena title="Thunder Derby" className="derby-display">
          <section className="derby-arena" aria-label="Racecourse">
            <div className="derby-race-heading">
              <div>
                <span className="derby-eyebrow">THE EMERALD COURSE</span>
                <h2>
                  {open
                    ? 'At the starting gate'
                    : running
                      ? 'Down the home straight'
                      : round.order
                        ? 'Official finish'
                        : 'Awaiting official result'}
                </h2>
                <p>
                  {round.field} runners · {round.id}
                </p>
              </div>
              <div className="derby-countdown">
                <span>{open ? 'Selections close' : running ? 'Race finishes' : 'Next race'}</span>
                <strong>{clock}</strong>
              </div>
            </div>
            {latestFinished && (
              <FinishOrder round={latestFinished} previous={latestFinished.id !== round.id} />
            )}
            <Suspense
              fallback={<div className="derby-scene-fallback">Preparing 3D racecourse…</div>}
            >
              <RaceScene round={round} running={running && fresh} reduced={reduced} />
            </Suspense>
            <div className="derby-race-footer">
              <span>{fresh ? '● Connected' : '○ Refreshing race status'}</span>
              <label>
                <input
                  type="checkbox"
                  checked={reduced}
                  onChange={(e) => setReduced(e.target.checked)}
                />{' '}
                Reduced motion
              </label>
              <span>Server-set results</span>
            </div>
            <div className="derby-progress" aria-label="Runner progress">
              {DERBY_HORSES.slice(0, field).map((h, i) => (
                <div key={h.name}>
                  <b style={{ background: h.color }}>{i + 1}</b>
                  <span>{h.name}</span>
                  <meter
                    min={0}
                    max={1}
                    value={round.positions[i] || 0}
                    aria-label={`${h.name} race progress`}
                  />
                </div>
              ))}
            </div>
          </section>
        </GameArena>
        <aside className="derby-slip">
          <span className="derby-eyebrow">YOUR RACE SELECTION</span>
          <h2>Pick your finish</h2>
          <div className="derby-markets" role="group" aria-label="Selection type">
            {DERBY_MARKETS.map((m) => (
              <button
                key={m}
                aria-pressed={market === m}
                disabled={busy || !!pending}
                onClick={() => {
                  setMarket(m);
                  setPicks([]);
                }}
              >
                {DERBY_LABELS[m]}
              </button>
            ))}
          </div>
          <p className="derby-instruction">
            {DERBY_HELP[market]} {count > 1 && 'Tap horses in selection order.'}
          </p>
          {count > 0 ? (
            <div className="derby-runners" role="group" aria-label="Choose horses">
              {DERBY_HORSES.slice(0, field).map((h, i) => (
                <button
                  key={h.name}
                  aria-pressed={picks.includes(i + 1)}
                  disabled={busy || !!pending}
                  onClick={() => choose(i + 1)}
                >
                  <b style={{ background: h.color }}>{i + 1}</b>
                  <span>{h.name}</span>
                  {picks.includes(i + 1) && (
                    <small>
                      {market === 'PERFECTA' || market === 'TRIFECTA'
                        ? `${picks.indexOf(i + 1) + 1}${['st', 'nd', 'rd'][picks.indexOf(i + 1)]}`
                        : '✓'}
                    </small>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="derby-special">
              Winning numbers:{' '}
              {Array.from({ length: field }, (_, i) => i + 1)
                .filter((n) =>
                  market === 'ODD'
                    ? n % 2
                    : market === 'EVEN'
                      ? n % 2 === 0
                      : market === 'UNDER'
                        ? n <= field / 2
                        : n > field / 2
                )
                .join(' · ')}
            </div>
          )}
          <label className="derby-stake">
            Practice credits
            <input
              type="number"
              inputMode="numeric"
              min="10"
              max="500"
              step="1"
              value={stake}
              disabled={busy || !!pending}
              onChange={(e) => setStake(e.target.value)}
            />
          </label>
          <div className="derby-amounts">
            {[10, 25, 50, 100].map((n) => (
              <button
                key={n}
                disabled={busy || !!pending}
                aria-pressed={stake === String(n)}
                onClick={() => setStake(String(n))}
              >
                {n}
              </button>
            ))}
          </div>
          <dl className="derby-quote">
            <div>
              <dt>Fixed gross odds</dt>
              <dd>{(odds / 100).toFixed(2)}×</dd>
            </div>
            <div>
              <dt>Total return if successful</dt>
              <dd>
                {valid ? Math.floor((Number(stake) * odds) / 100).toLocaleString() : '—'} credits
              </dd>
            </div>
          </dl>
          <p className="derby-fine">Includes your stake. A losing selection returns 0.</p>
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
              ? 'Selection confirmed'
              : !open
                ? 'Selections closed'
                : 'Review selection'}{' '}
            <span>Free practice only</span>
          </button>
          {round.ticket && (
            <div className="derby-receipt" role="status">
              <strong>
                {DERBY_LABELS[round.ticket.market]}{' '}
                {round.ticket.picks
                  .map((n) => `#${n}`)
                  .join(round.ticket.market === 'QUINELLA' ? ' & ' : ' → ')}
              </strong>
              <p>
                {round.ticket.stake} credits · {(round.ticket.oddsCents / 100).toFixed(2)}×
              </p>
              <p>
                {round.ticket.payout === null
                  ? 'Awaiting race result'
                  : `Returned ${round.ticket.payout} practice credits`}
              </p>
            </div>
          )}
        </aside>
      </div>
      <p className="derby-disclaimer">
        A simulated race with equal-chance runners. Previous results do not predict the next finish.
        Practice credits have no monetary value.
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
            <Dialog.Title>Confirm your practice selection</Dialog.Title>
            <Dialog.Description>
              This selection cannot be changed after confirmation.
            </Dialog.Description>
            {confirm && (
              <>
                <p>
                  {DERBY_LABELS[confirm.market]} ·{' '}
                  {confirm.picks
                    .map((n) => `#${n}`)
                    .join(confirm.market === 'QUINELLA' ? ' & ' : ' → ')}
                </p>
                <p>
                  {confirm.stake} credits · total successful return{' '}
                  {Math.floor(
                    (confirm.stake * derbyOddsCents(confirm.field, confirm.market)) / 100
                  )}{' '}
                  credits
                </p>
                <button
                  className="derby-primary"
                  disabled={disabled || confirm.roundId !== round.id}
                  onClick={() => {
                    onSubmit(confirm);
                    setConfirm(null);
                  }}
                >
                  Confirm practice selection
                </button>
              </>
            )}
            <Dialog.Close>Back</Dialog.Close>
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
            <Dialog.Title>Official race result</Dialog.Title>
            <Dialog.Description>{details?.id}</Dialog.Description>
            {details && <FinishOrder round={details} />}
            {details?.ticket && (
              <p>Your selection returned {details.ticket.payout ?? 'pending'} credits.</p>
            )}
            <details>
              <summary>Result verification</summary>
              <p>Commitment</p>
              <code>{details?.commitment}</code>
              <p>Revealed seed</p>
              <code>{details?.seed}</code>
              <p>Rules: {DERBY_RULES.id}</p>
            </details>
            <Dialog.Close>Close result</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
