import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ROULETTE_KENO_RULES as R,
  RK_MARKETS,
  RK_LABELS,
  rkColor,
  rkNumbers,
  rkMultiplierTenths,
  rkSelectionLabel,
  rkValidate,
} from '@socialplay/shared';
import type {
  RouletteKenoEntry as Entry,
  RouletteKenoSnapshot,
  RouletteKenoMarket as Market,
  RouletteKenoTicket,
} from '@socialplay/shared';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import { RouletteKenoWheel } from '@/components/roulette-keno/wheel';
import './roulette-keno.css';

const endpoint = '/games/roulette-keno';
const receiptKey = (id: string) => `salem.roulette-keno.pending.v1.${id}`;
export function readRouletteKenoPending(id: string): Entry | null {
  const raw = sessionStorage.getItem(receiptKey(id));
  if (!raw) return null;
  const e = JSON.parse(raw) as Entry;
  if (
    !e ||
    typeof e.roundId !== 'string' ||
    !e.roundId ||
    e.roundId.length > 64 ||
    !Number.isInteger(e.slot) ||
    e.slot < 1 ||
    e.slot > 10
  )
    throw Error('Invalid saved ticket');
  rkValidate(e.market, e.picks, e.amount);
  return e;
}
export function RouletteKenoPage() {
  const { user } = useAuth();
  return user ? <ConnectedRouletteKeno key={user.id} userId={user.id} /> : null;
}
function ConnectedRouletteKeno({ userId }: { userId: string }) {
  const [initial] = useState(() => {
    try {
      return { entry: readRouletteKenoPending(userId), error: '' };
    } catch {
      return {
        entry: null,
        error: 'Browser storage could not be read. Restore storage and reload before entering.',
      };
    }
  });
  const [pending, setPending] = useState<Entry | null>(initial.entry);
  const pendingRef = useRef<Entry | null>(initial.entry);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const [acknowledged, setAcknowledged] = useState<RouletteKenoTicket[]>([]);
  const query = useQuery({
    queryKey: ['roulette-keno', userId],
    queryFn: async ({ signal }) => {
      const sentAt = performance.now();
      const snapshot = unwrapData(
        await boundedRequest(
          (s) => api.get<RouletteKenoSnapshot>(endpoint, undefined, { signal: s }),
          signal
        )
      );
      return { snapshot, sentAt, receivedAt: performance.now() };
    },
    refetchInterval: (q) => ([401, 403, 404].includes(requestStatus(q.state.error)) ? false : 1000),
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const clear = () => {
    pendingRef.current = null;
    setPending(null);
    try {
      sessionStorage.removeItem(receiptKey(userId));
    } catch {
      setError('Could not clear your saved ticket. Restore storage and reload.');
    }
  };
  const mutation = useMutation({
    mutationFn: (e: Entry) =>
      boundedRequest((signal) =>
        api.post<{ accepted: boolean; id: string }>(`${endpoint}/tickets`, e, undefined, { signal })
      ),
    onSuccess: async (response, e) => {
      if (pendingRef.current !== e) return;
      const receipt = unwrapData(response);
      setAcknowledged((a) => [
        ...a.filter((t) => t.roundId !== e.roundId || t.slot !== e.slot),
        { ...e, id: receipt.id, stake: e.amount * e.picks.length, payout: null },
      ]);
      clear();
      setNotice(`Bet ${e.slot} confirmed. You can add another bet to this draw.`);
      await query.refetch();
    },
    onError: async (e, entry) => {
      if (pendingRef.current !== entry) return;
      const status = requestStatus(e);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) clear();
      setNotice(
        status === 409
          ? 'The draw closed or this bet was already saved. Checking your receipt.'
          : 'Confirmation was not received. Checking the server; retry keeps the same bet.'
      );
      await query.refetch();
    },
  });
  useEffect(() => {
    const e = pendingRef.current;
    if (
      e &&
      query.data?.snapshot.rounds
        .find((r) => r.id === e.roundId)
        ?.tickets.some((t) => t.slot === e.slot)
    ) {
      clear();
      setNotice(`Bet ${e.slot} confirmed by the server.`);
    }
    setAcknowledged((a) =>
      a.filter((t) => query.data?.snapshot.rounds.some((r) => r.id === t.roundId))
    );
  }, [query.data]);
  const submit = (e: Entry) => {
    if (mutation.isPending || error || (pendingRef.current && pendingRef.current !== e)) return;
    try {
      sessionStorage.setItem(receiptKey(userId), JSON.stringify(e));
    } catch {
      setError('Could not save your ticket safely. Restore browser storage before entering.');
      return;
    }
    pendingRef.current = e;
    setPending(e);
    mutation.mutate(e);
  };
  const data = query.data?.snapshot;
  const merged = data && {
    ...data,
    rounds: data.rounds.map((r) => ({
      ...r,
      tickets: [
        ...r.tickets,
        ...acknowledged.filter(
          (t) => t.roundId === r.id && !r.tickets.some((x) => x.slot === t.slot)
        ),
      ].sort((a, b) => a.slot - b.slot),
    })),
  };
  return (
    <RouletteKenoView
      data={merged}
      sentAt={query.data?.sentAt}
      receivedAt={query.data?.receivedAt}
      disconnected={query.isError || query.isPaused}
      pending={pending}
      submitting={mutation.isPending}
      error={error}
      notice={notice}
      onSubmit={submit}
      onRetry={() => pending && submit(pending)}
      connectionMessage={
        query.isPending
          ? 'Connecting to the practice table…'
          : requestStatus(query.error) === 401
            ? 'Your session expired. Sign in again to play.'
            : [403, 404].includes(requestStatus(query.error))
              ? 'This table is currently unavailable.'
              : undefined
      }
    />
  );
}

type Draft = { market: Market; picks: number[]; text: string };
const emptyDraft = (): Draft => ({ market: 'NUMBERS', picks: [], text: '5' });
const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
export function RouletteKenoView({
  data,
  sentAt = performance.now(),
  receivedAt = sentAt,
  disconnected = false,
  pending = null,
  submitting = false,
  error = '',
  notice = '',
  connectionMessage,
  onSubmit,
  onRetry,
}: {
  data?: RouletteKenoSnapshot;
  sentAt?: number;
  receivedAt?: number;
  disconnected?: boolean;
  pending?: Entry | null;
  submitting?: boolean;
  error?: string;
  notice?: string;
  connectionMessage?: string;
  onSubmit: (entry: Entry) => void;
  onRetry?: () => void;
}) {
  const [clock, setClock] = useState(performance.now());
  const [slot, setSlot] = useState(1);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({ 1: emptyDraft() });
  const [review, setReview] = useState<Entry | null>(null);
  useEffect(() => {
    const t = setInterval(() => setClock(performance.now()), 100);
    return () => clearInterval(t);
  }, []);
  const age = Math.max(0, Math.max(clock, performance.now()) - sentAt);
  const connected =
    !!data && !disconnected && age < 5000 && receivedAt - sentAt < 1500 && data.rulesId === R.id;
  const now = (data?.serverTime ?? 0) + age;
  const round = data?.rounds.find((r) => r.opensAt <= now && now < r.endsAt);
  const display = round ?? data?.rounds[0];
  const open = !!round && connected && data?.enabled === true && now < round.closesAt;
  const seconds = round
    ? Math.max(0, Math.ceil(((now < round.closesAt ? round.closesAt : round.endsAt) - now) / 1000))
    : 0;
  const tickets = display?.tickets ?? [];
  const ticket = tickets.find((t) => t.slot === slot);
  const waiting =
    pending && pending.roundId === display?.id && pending.slot === slot ? pending : null;
  const draft = drafts[slot] ?? emptyDraft();
  const market = ticket?.market ?? waiting?.market ?? draft.market;
  const picks = ticket?.picks ?? waiting?.picks ?? draft.picks;
  const text = String(ticket?.amount ?? waiting?.amount ?? draft.text);
  const amount = /^\d+$/.test(text) ? Number(text) : 0;
  const cost = amount * picks.length;
  const locked = !open || !!ticket || !!pending || !!error || submitting;
  let valid = false;
  try {
    rkValidate(market, picks, amount);
    valid = true;
  } catch {
    /* Incomplete draft. */
  }
  const covered = market === 'NUMBERS' ? picks : picks.length ? rkNumbers(market, picks[0]) : [];
  const revealed = display?.revealed ?? [];
  const complete = display?.complete === true;
  const drawing = !!round && now >= round.closesAt && !complete;
  const multiplier = rkMultiplierTenths(market) / 10;
  const slots = Array.from(
    new Set([
      1,
      ...Object.keys(drafts).map(Number),
      ...tickets.map((t) => t.slot),
      ...(pending && pending.roundId === round?.id ? [pending.slot] : []),
    ])
  ).sort((a, b) => a - b);
  const maxTickets = Math.min(10, Math.max(1, data?.maxTickets ?? 1));
  const nextSlot = Array.from({ length: maxTickets }, (_, i) => i + 1).find(
    (n) => !slots.includes(n)
  );
  useEffect(() => {
    setSlot(1);
    setDrafts({ 1: emptyDraft() });
    setReview(null);
  }, [round?.id]);
  const update = (change: Partial<Draft>) => {
    if (!locked) setDrafts((ds) => ({ ...ds, [slot]: { ...draft, ...change } }));
  };
  const toggle = (n: number) => {
    if (locked || market !== 'NUMBERS') return;
    update({
      picks: picks.includes(n)
        ? picks.filter((v) => v !== n)
        : picks.length < 10
          ? [...picks, n].sort((a, b) => a - b)
          : picks,
    });
  };
  const add = () => {
    if (!locked || ticket) {
      if (open && !pending && !error && nextSlot) {
        setDrafts((ds) => ({ ...ds, [nextSlot]: emptyDraft() }));
        setSlot(nextSlot);
      }
    }
  };
  const results = data?.rounds.filter((r) => r.complete) ?? [];
  return (
    <div className="rk-page">
      <div className="rk-nav">
        <Link to="/games">← Games</Link>
        <span className={connected ? 'rk-connected' : 'rk-reconnecting'}>
          {connected ? '● Connected' : '○ Connecting'}
        </span>
      </div>
      <header className="rk-heading">
        <div>
          <span className="rk-eyebrow">SALEM ORIGINALS</span>
          <h1>
            Roulette <em>Keno</em>
          </h1>
        </div>
        <div className="rk-balance">
          <span>Practice balance</span>
          <strong>
            {data ? money(data.balance) : '—'} <small>ETB</small>
          </strong>
          <small>No cash value</small>
        </div>
      </header>
      <div className="rk-toolbar">
        <p>
          <b>18 balls.</b> 72 possibilities.
        </p>
        <Rules />
        <Dialog.Root>
          <Dialog.Trigger className="rk-text-button">Recent draws ↗</Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="rk-overlay" />
            <Dialog.Content className="rk-dialog">
              <Dialog.Title>Recent draws</Dialog.Title>
              <Dialog.Description>
                Official completed results and your confirmed practice bets.
              </Dialog.Description>
              {results.length ? (
                results.map((r) => (
                  <article className="rk-history" key={r.id}>
                    <strong>Draw {r.id.replace('rk-', '')}</strong>
                    <div className="rk-history-balls">
                      {r.revealed.map((n) => (
                        <span className={rkColor(n).toLowerCase()} key={n}>
                          {n}
                        </span>
                      ))}
                    </div>
                    {r.tickets.map((t) => (
                      <p key={t.id}>
                        Bet {t.slot} · {rkSelectionLabel(t.market, t.picks)} ·{' '}
                        {t.payout === null ? 'Return pending' : `${money(t.payout)} ETB returned`}
                      </p>
                    ))}
                  </article>
                ))
              ) : (
                <p>No completed draws yet.</p>
              )}
              <Dialog.Close className="rk-primary">Close results</Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      {!connected && (
        <p className="rk-notice" role="alert">
          {connectionMessage ?? 'Reconnecting. Bet entry is paused until a fresh update arrives.'}
        </p>
      )}
      {connected && !round && (
        <p className="rk-notice" role="status">
          Waiting for the next scheduled draw…
        </p>
      )}
      {error && (
        <p className="rk-notice" role="alert">
          {error}
        </p>
      )}
      <div className="rk-table">
        <section className="rk-studio" aria-label="Live practice draw">
          <div className="rk-studio-heading">
            <span className="rk-dot" />
            {open ? 'Place your bets' : complete ? 'Draw complete' : 'Drawing now'}
            <span className="rk-countdown" role="timer">
              {open ? 'Closes' : 'Next draw'} <b>{seconds}s</b>
            </span>
          </div>
          <RouletteKenoWheel latest={revealed.at(-1) ?? null} drawing={drawing && connected} />
          <div className="rk-draw-results">
            <div className="rk-draw-label">
              <strong>
                {revealed.length} <span>/ 18 balls</span>
              </strong>
              <small>Draw {display?.id.replace('rk-', '') ?? '—'}</small>
            </div>
            <ol className="rk-balls" aria-label="Released balls">
              {Array.from({ length: 18 }, (_, i) => {
                const n = revealed[i];
                return (
                  <li
                    key={i}
                    className={`${n ? rkColor(n).toLowerCase() : ''} ${i === 0 ? 'first' : ''} ${n && i === revealed.length - 1 ? 'latest' : ''}`}
                    aria-label={n ? `Ball ${i + 1}: ${n}` : `Ball ${i + 1}: waiting`}
                  >
                    {n ?? <span>·</span>}
                  </li>
                );
              })}
            </ol>
            <div className="rk-first-ball">
              <span>FIRST BALL</span>
              <strong>{revealed[0] ?? '—'}</strong>
              <small>
                {revealed[0]
                  ? `${rkColor(revealed[0]) === 'RED' ? 'Red' : 'Black'} · ${revealed[0] % 2 ? 'Odd' : 'Even'} · ${revealed[0] <= 36 ? 'Low' : 'High'}`
                  : 'Decides the outside markets'}
              </small>
            </div>
          </div>
          <div className="rk-studio-footer">
            <span>New draw every 90 seconds</span>
            <span>Free practice</span>
          </div>
        </section>
        <section className="rk-play" aria-label="Place a practice bet">
          <div className="rk-ticket-tabs" role="group" aria-label="Your bets">
            {slots.map((n) => (
              <button key={n} type="button" aria-pressed={slot === n} onClick={() => setSlot(n)}>
                Bet {n}
                <small>
                  {tickets.some((t) => t.slot === n)
                    ? '✓ Saved'
                    : pending?.slot === n && pending.roundId === round?.id
                      ? 'Checking'
                      : 'Draft'}
                </small>
              </button>
            ))}
            {nextSlot && (
              <button
                className="rk-add-bet"
                disabled={!open || !!pending || !!error || submitting}
                onClick={add}
              >
                + Add bet
              </button>
            )}
          </div>
          <div className="rk-markets" role="group" aria-label="Bet market">
            {RK_MARKETS.map((m) => (
              <button
                key={m}
                aria-pressed={market === m}
                disabled={locked}
                onClick={() => update({ market: m, picks: [] })}
              >
                {RK_LABELS[m]}
              </button>
            ))}
          </div>
          <div className="rk-market-caption">
            <p>
              {market === 'NUMBERS'
                ? 'Pick 1–10 numbers · all 18 balls count'
                : 'Pick one option · first ball only'}
            </p>
            <strong>
              {multiplier.toFixed(1)}× <span>{market === 'NUMBERS' ? 'per match' : 'return'}</span>
            </strong>
          </div>
          {market !== 'NUMBERS' && (
            <div className="rk-options" role="group" aria-label={`${RK_LABELS[market]} options`}>
              {Array.from(
                { length: market === 'ROW' ? 6 : market === 'COLUMN' ? 4 : 2 },
                (_, i) => i + 1
              ).map((n) => (
                <button
                  key={n}
                  className={market === 'COLOR' ? (n === 1 ? 'red' : 'black') : ''}
                  disabled={locked}
                  aria-pressed={picks.includes(n)}
                  onClick={() => update({ picks: [n] })}
                >
                  {rkSelectionLabel(market, [n])}
                  {picks.includes(n) && <span aria-hidden="true"> ✓</span>}
                </button>
              ))}
            </div>
          )}
          <div
            className={`rk-board ${market !== 'NUMBERS' ? 'is-coverage' : ''}`}
            role="group"
            aria-label="72-number board"
          >
            {Array.from({ length: 72 }, (_, i) => i + 1).map((n) => {
              const selected = covered.includes(n),
                drawn = revealed.includes(n),
                hit = selected && (market === 'NUMBERS' ? drawn : revealed[0] === n);
              return (
                <button
                  key={n}
                  type="button"
                  aria-label={`Number ${n}${drawn ? ', drawn' : ''}`}
                  aria-pressed={selected}
                  disabled={locked || market !== 'NUMBERS'}
                  onClick={() => toggle(n)}
                  className={`${rkColor(n).toLowerCase()} ${selected ? 'is-selected' : ''} ${drawn ? 'is-drawn' : ''} ${hit ? 'is-hit' : ''}`}
                >
                  <span>{n}</span>
                  {selected && <i aria-hidden="true">{hit ? '✓' : '●'}</i>}
                </button>
              );
            })}
          </div>
          <div className="rk-board-bottom">
            <span>
              <i />
              Selected <i />
              Drawn <i />
              Match
            </span>
            <div>
              <button
                className="rk-text-button"
                disabled={locked || market !== 'NUMBERS'}
                onClick={() => {
                  const pool = Array.from({ length: 72 }, (_, i) => i + 1),
                    word = new Uint32Array(1);
                  for (let i = 0; i < 5; i++) {
                    const range = 72 - i,
                      limit = Math.floor(2 ** 32 / range) * range;
                    do {
                      crypto.getRandomValues(word);
                    } while (word[0] >= limit);
                    const j = i + (word[0] % range);
                    [pool[i], pool[j]] = [pool[j], pool[i]];
                  }
                  update({ picks: pool.slice(0, 5).sort((a, b) => a - b) });
                }}
              >
                Quick pick 5
              </button>
              <button
                className="rk-text-button"
                disabled={locked || !picks.length}
                onClick={() => update({ picks: [] })}
              >
                Clear
              </button>
            </div>
          </div>
          <div className="rk-slip">
            <div className="rk-slip-selection">
              <span>{ticket ? 'CONFIRMED SELECTION' : `BET ${slot} SELECTION`}</span>
              <strong>
                {picks.length ? rkSelectionLabel(market, picks) : 'Choose your numbers above'}
              </strong>
            </div>
            <div className="rk-stake-row">
              <div>
                <label htmlFor="rk-amount">
                  {market === 'NUMBERS' ? 'ETB per number' : 'Bet amount · ETB'}
                </label>
                <div className="rk-stepper">
                  <button
                    aria-label="Decrease amount"
                    disabled={locked || amount <= 5}
                    onClick={() => update({ text: String(Math.max(5, amount - 5)) })}
                  >
                    −
                  </button>
                  <input
                    id="rk-amount"
                    inputMode="numeric"
                    autoComplete="off"
                    value={text}
                    disabled={locked}
                    onChange={(e) => update({ text: e.target.value })}
                  />
                  <button
                    aria-label="Increase amount"
                    disabled={locked || amount >= 500}
                    onClick={() => update({ text: String(Math.min(500, amount + 5)) })}
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="rk-total">
                <span>Total bet</span>
                <strong>
                  {money(cost || 0)} <small>ETB</small>
                </strong>
              </div>
            </div>
            <p className="rk-return-note">
              {valid
                ? `${money(amount * multiplier)} ETB returned ${market === 'NUMBERS' ? 'per matching number' : 'if your selection wins'}. Includes stake.`
                : 'Steps of 5 ETB · Up to 500 ETB per bet.'}
            </p>
            <button
              className="rk-primary"
              disabled={locked || !valid || cost > (data?.balance ?? 0)}
              onClick={() =>
                round && setReview({ roundId: round.id, slot, market, picks: [...picks], amount })
              }
            >
              {ticket
                ? '✓ Bet confirmed'
                : pending
                  ? 'Checking confirmation…'
                  : !open
                    ? 'Bets are closed'
                    : `Review bet · ${money(cost || 0)} ETB`}
            </button>
            {valid && !ticket && cost > (data?.balance ?? 0) && (
              <p className="rk-warning">Not enough practice ETB for this bet.</p>
            )}
            {ticket && complete && (
              <p className="rk-receipt-result" role="status">
                {ticket.payout === null
                  ? 'Your return is being settled.'
                  : `${money(ticket.payout)} ETB returned · Bet ${ticket.slot}`}
              </p>
            )}
          </div>
        </section>
      </div>
      {notice && (
        <p className="rk-notice" role="status">
          {notice}
        </p>
      )}
      {pending && !submitting && (
        <div className="rk-pending">
          <p>One bet is awaiting confirmation. Retry checks the same receipt.</p>
          <button onClick={onRetry} disabled={!connected || !!error}>
            Retry unconfirmed bet
          </button>
        </div>
      )}
      {!!tickets.length && (
        <section className="rk-saved" aria-label="Saved bets">
          <header>
            <h2>Your bets this draw</h2>
            <span>
              {tickets.length} / {maxTickets} confirmed
            </span>
          </header>
          <div>
            {tickets.map((t) => (
              <button
                key={t.id}
                className={slot === t.slot ? 'active' : ''}
                onClick={() => setSlot(t.slot)}
              >
                <span>
                  <b>Bet {t.slot}</b>
                  <strong>{money(t.stake)} ETB</strong>
                </span>
                <small>
                  {RK_LABELS[t.market]} · {rkSelectionLabel(t.market, t.picks)}
                </small>
                <em>
                  {complete
                    ? t.payout === null
                      ? 'Return pending'
                      : `${money(t.payout)} ETB returned`
                    : 'Confirmed · waiting for results'}
                </em>
              </button>
            ))}
          </div>
        </section>
      )}
      <p className="rk-disclosure">
        Practice ETB only · No deposits or redeemable prizes · 90% theoretical return
      </p>
      <Dialog.Root open={!!review} onOpenChange={(v) => !v && setReview(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="rk-overlay" />
          <Dialog.Content className="rk-dialog">
            <Dialog.Title>Confirm Bet {review?.slot}</Dialog.Title>
            <Dialog.Description>
              Review your practice selection. A confirmed bet cannot be changed.
            </Dialog.Description>
            {review && (
              <>
                <div className="rk-review-choice">
                  <span>{RK_LABELS[review.market]}</span>
                  <strong>{rkSelectionLabel(review.market, review.picks)}</strong>
                  <p>
                    {review.market === 'NUMBERS'
                      ? 'All 18 drawn balls count.'
                      : 'Only the first drawn ball counts.'}
                  </p>
                </div>
                <dl className="rk-review-totals">
                  <dt>Total bet</dt>
                  <dd>{money(review.amount * review.picks.length)} ETB</dd>
                  <dt>{review.market === 'NUMBERS' ? 'Return per match' : 'Return if correct'}</dt>
                  <dd>{money((review.amount * rkMultiplierTenths(review.market)) / 10)} ETB</dd>
                </dl>
                <p>Returns include the stake. Practice ETB has no cash value.</p>
                <button
                  className="rk-primary"
                  disabled={
                    !open ||
                    locked ||
                    review.roundId !== round?.id ||
                    review.amount * review.picks.length > (data?.balance ?? 0)
                  }
                  onClick={() => {
                    onSubmit(review);
                    setReview(null);
                  }}
                >
                  Confirm practice bet
                </button>
              </>
            )}
            <Dialog.Close className="rk-secondary">Keep editing</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
function Rules() {
  return (
    <Dialog.Root>
      <Dialog.Trigger className="rk-text-button">How to play ↗</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="rk-overlay" />
        <Dialog.Content className="rk-dialog">
          <Dialog.Title>How to play Roulette Keno</Dialog.Title>
          <Dialog.Description>
            Salem's original practice game. Pick numbers or a first-ball market before the countdown
            ends.
          </Dialog.Description>
          <ol className="rk-rules-steps">
            <li>Each 90-second round has 60 seconds to place bets.</li>
            <li>The server draws 18 different numbers from 1–72 and releases one each second.</li>
            <li>Keep up to ten independent bets. Choose and confirm each separately.</li>
          </ol>
          <table className="rk-rules-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Decided by</th>
                <th>Return</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Numbers · 1–10 picks</td>
                <td>All 18 balls</td>
                <td>3.6× per match</td>
              </tr>
              <tr>
                <td>Red / black, odd / even, low / high</td>
                <td>First ball</td>
                <td>1.8×</td>
              </tr>
              <tr>
                <td>Rows A–F · 12 numbers each</td>
                <td>First ball</td>
                <td>5.4×</td>
              </tr>
              <tr>
                <td>Columns 1–4 · 18 numbers each</td>
                <td>First ball</td>
                <td>3.6×</td>
              </tr>
            </tbody>
          </table>
          <p>
            Rows: A 1–12, B 13–24, C 25–36, D 37–48, E 49–60, F 61–72. Columns: 1–18, 19–36, 37–54,
            55–72. The board shows each number's red or black color.
          </p>
          <p>
            For number bets the amount applies to each number. Other markets use one amount per
            selection. Amounts are in steps of 5 ETB, with a total limit of 500 ETB per bet.
          </p>
          <p>
            Each account starts with 1,000 separate practice ETB. All returns include the stake and
            settle after the final ball. The mathematical return is 90% over repeated play; an
            individual round can return zero. No jackpots, automatic repeat bets, deposits or
            redeemable prizes.
          </p>
          <Dialog.Close className="rk-primary">Got it</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
