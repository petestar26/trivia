import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  BLACKJACK_RULES as R,
  BJ_MARKETS,
  BJ_LABELS,
  bjCard,
  bjTotal,
  bjResult,
  bjKey,
  bjSelection,
  bjValidate,
} from '@socialplay/shared';
import type {
  BlackjackEntry as Entry,
  BlackjackSnapshot,
  BlackjackMarket as Market,
  BlackjackTicket,
} from '@socialplay/shared';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import './blackjack.css';

const endpoint = '/games/blackjack';
const receiptKey = (id: string) => `salem.blackjack.pending.v1.${id}`;
export function readBlackjackPending(id: string): Entry | null {
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
  bjValidate(e);
  return e;
}
export function BlackjackPage() {
  const { user } = useAuth();
  return user ? <ConnectedBlackjack key={user.id} userId={user.id} /> : null;
}
function ConnectedBlackjack({ userId }: { userId: string }) {
  const [initial] = useState(() => {
    try {
      return { entry: readBlackjackPending(userId), error: '' };
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
  const [acknowledged, setAcknowledged] = useState<BlackjackTicket[]>([]);
  const query = useQuery({
    queryKey: ['blackjack', userId],
    queryFn: async ({ signal }) => {
      const sentAt = performance.now();
      const snapshot = unwrapData(
        await boundedRequest(
          (s) => api.get<BlackjackSnapshot>(endpoint, undefined, { signal: s }),
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
        { ...e, id: receipt.id, payout: null },
      ]);
      clear();
      setNotice(`Bet ${e.slot} confirmed. You can add another bet to this round.`);
      await query.refetch();
    },
    onError: async (e, entry) => {
      if (pendingRef.current !== entry) return;
      const status = requestStatus(e);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) clear();
      setNotice(
        status === 409
          ? 'The betting stage closed or this bet was already saved. Checking your receipt.'
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
    <BlackjackView
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
          ? 'Connecting to the Blackjack table…'
          : requestStatus(query.error) === 401
            ? 'Your session expired. Sign in again to play.'
            : [403, 404].includes(requestStatus(query.error))
              ? 'This table is currently unavailable.'
              : undefined
      }
    />
  );
}

type Draft = { seat: number; market: Market | null; text: string };
const emptyDraft = (): Draft => ({ seat: 1, market: null, text: '10' });
const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const phases = ['First card', 'Second card', 'Third card', 'Showdown'];
function Card({ value, index }: { value?: number; index: number }) {
  const c = value === undefined ? null : bjCard(value);
  return (
    <span
      className={`bj-card ${c?.red ? 'bj-red' : ''} ${!c ? 'bj-card-back' : ''}`}
      style={{ '--card-index': index } as CSSProperties}
      aria-label={c ? `${c.rank} ${c.suit}` : 'Waiting for card'}
    >
      {c ? (
        <>
          <span className="bj-card-corner">
            {c.rank}
            <i>{c.suit}</i>
          </span>
          <span className="bj-card-pip">{c.suit}</span>
          <span className="bj-card-corner bj-card-bottom">
            {c.rank}
            <i>{c.suit}</i>
          </span>
        </>
      ) : (
        <span>♠</span>
      )}
    </span>
  );
}
export function BlackjackView({
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
  data?: BlackjackSnapshot;
  sentAt?: number;
  receivedAt?: number;
  disconnected?: boolean;
  pending?: Entry | null;
  submitting?: boolean;
  error?: string;
  notice?: string;
  connectionMessage?: string;
  onSubmit: (e: Entry) => void;
  onRetry?: () => void;
}) {
  const [clock, setClock] = useState(performance.now());
  const [slot, setSlot] = useState(1),
    [drafts, setDrafts] = useState<Record<number, Draft>>({ 1: emptyDraft() });
  const [review, setReview] = useState<Entry | null>(null),
    [history, setHistory] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setClock(performance.now()), 100);
    return () => clearInterval(id);
  }, []);
  const age = Math.max(0, Math.max(clock, performance.now()) - sentAt),
    now = (data?.serverTime ?? 0) + age;
  const connected =
    !!data &&
    data.enabled &&
    data.rulesId === R.id &&
    !disconnected &&
    age < 5000 &&
    receivedAt - sentAt < 1500;
  const current = data?.rounds.find((r) => r.opensAt <= now && now < r.endsAt);
  const table = (history ? data?.rounds.find((r) => r.id === history) : current) ?? data?.rounds[0];
  const phase = current ? Math.min(3, Math.floor((now - current.opensAt) / R.stageMs)) : 3;
  const open = connected && !!current && !history && current.stage === phase && phase < 3;
  useEffect(() => {
    setSlot(1);
    setDrafts({ 1: emptyDraft() });
    setReview(null);
  }, [current?.id]);
  const tickets = table?.tickets ?? [],
    ticket = tickets.find((t) => t.slot === slot),
    draft = drafts[slot] ?? emptyDraft();
  const seat = ticket?.seat ?? draft.seat,
    market = ticket?.market ?? draft.market,
    amount = ticket?.amount ?? Number(draft.text);
  const odds = ticket?.odds ?? (market ? current?.quotes[bjKey(seat, market)] : undefined);
  const locked = !!ticket || !!pending || submitting || !!error || !!history;
  const valid =
    Number.isInteger(amount) &&
    amount >= 5 &&
    amount <= 500 &&
    amount % 5 === 0 &&
    !!market &&
    !!odds;
  const canReview = open && !locked && valid && amount <= (data?.balance ?? 0);
  const update = (patch: Partial<Draft>) => {
    if (!locked) setDrafts((d) => ({ ...d, [slot]: { ...(d[slot] ?? emptyDraft()), ...patch } }));
  };
  const used = new Set([...Object.keys(drafts).map(Number), ...tickets.map((t) => t.slot)]),
    next = Array.from({ length: 10 }, (_, i) => i + 1).find((i) => !used.has(i));
  const end = current ? current.opensAt + (phase + 1) * R.stageMs : (table?.endsAt ?? now);
  const countdown = Math.max(0, Math.ceil((end - now) / 1000));
  const complete = table?.stage === 3;
  const reviewValid =
    !!review &&
    canReview &&
    review.roundId === current?.id &&
    review.stage === current?.stage &&
    current?.quotes[bjKey(review.seat, review.market)] === review.odds;
  return (
    <div className="bj-page">
      <div className="bj-topline">
        <Link to="/games">← Games</Link>
        <span className={connected ? 'bj-online' : ''}>
          <i />
          {connected ? 'Connected' : 'Connecting'}
        </span>
      </div>
      <header className="bj-header">
        <div>
          <span className="bj-eyebrow">SALEM TABLE GAMES</span>
          <h1>
            Black<span>jack</span>
          </h1>
          <p>Six seats. One dealer. Your call.</p>
        </div>
        <div className="bj-balance">
          <small>Practice balance</small>
          <strong>
            {money(data?.balance ?? 0)} <em>ETB</em>
          </strong>
          <span>Virtual ETB · no cash value</span>
        </div>
      </header>
      {(connectionMessage || error || !connected) && (
        <p className="bj-notice" role="status">
          {error ||
            connectionMessage ||
            'Connection interrupted. Betting pauses until the table is up to date.'}
        </p>
      )}
      <div className="bj-layout">
        <section className="bj-arena" aria-label="Blackjack table">
          <div className="bj-stagebar">
            <div>
              <span className="bj-live-dot" />
              <b>
                {history
                  ? 'Past round'
                  : complete
                    ? 'Round complete'
                    : open
                      ? 'Bets open'
                      : 'Dealing cards'}
              </b>
              <small>#{table?.id.replace('bj-', '') ?? '—'}</small>
            </div>
            <div className="bj-timer">
              <span>{history ? 'Final result' : phase === 3 ? 'Next round' : 'Next deal'}</span>
              <strong>{history ? '✓' : `${countdown}s`}</strong>
            </div>
          </div>
          <div className="bj-stages">
            {phases.map((name, i) => (
              <div
                key={name}
                className={
                  (table?.stage ?? -1) === i ? 'active' : (table?.stage ?? -1) > i ? 'done' : ''
                }
              >
                <span>{i < 3 ? `0${i + 1}` : '♠'}</span>
                <b>{name}</b>
              </div>
            ))}
          </div>
          <div className="bj-felt">
            <div className="bj-table-inscription" aria-hidden="true">
              <span>SALEM</span>
              <strong>BLACKJACK</strong>
              <small>ALL HANDS STAND ON 17</small>
              <div>♦ ───── ♠ ───── ♥</div>
            </div>
            <div className="bj-hands">
              {[0, 1, 2, 3, 4, 5, 6].map((s) => {
                const cards = table?.hands[s] ?? [],
                  v = bjTotal(cards),
                  result = s && complete ? bjResult(cards, table!.hands[0]) : null;
                return (
                  <button
                    key={s}
                    type="button"
                    className={`bj-hand bj-hand-${s} ${s === seat ? 'selected' : ''} ${result ? `bj-result-${result.toLowerCase()}` : ''}`}
                    aria-label={`${s === 0 ? 'Dealer' : `Seat ${s}`}, ${cards.length ? v.total + ' points' : 'waiting'}`}
                    aria-pressed={s === seat}
                    onClick={() => update({ seat: s, market: null })}
                    disabled={!!ticket || !!pending || !!history}
                  >
                    <span className="bj-seat-name">
                      {s === 0 ? 'Dealer' : `Seat ${s}`}
                      <b>{cards.length ? (v.blackjack ? 'BJ' : v.bust ? 'BUST' : v.total) : '—'}</b>
                    </span>
                    <span
                      className="bj-card-row"
                      style={
                        {
                          '--cards': Math.max(2, cards.length),
                          width: cards.length === 1 ? 'var(--cw)' : undefined,
                        } as CSSProperties
                      }
                    >
                      {(cards.length ? cards : [undefined, undefined]).map((c, i) => (
                        <Card key={`${s}-${i}-${c}`} value={c} index={i} />
                      ))}
                    </span>
                    <span className={`bj-hand-status ${result ? 'settled' : ''}`}>
                      {result
                        ? result === 'WIN'
                          ? 'Wins'
                          : result === 'DRAW'
                            ? 'Draw'
                            : 'Loses'
                        : s === 0
                          ? 'Stand on all 17s'
                          : v.blackjack
                            ? 'Natural blackjack'
                            : v.bust
                              ? 'Bust'
                              : v.total >= 17
                                ? 'Standing'
                                : cards.length
                                  ? 'In play'
                                  : 'Waiting'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="bj-table-footer">
            <span>
              6-deck shoe <i>·</i> 2m 40s rounds
            </span>
            <Rules />
          </div>
        </section>
        <section className="bj-slip" aria-label="Your bet">
          <div className="bj-slip-heading">
            <div>
              <span className="bj-eyebrow">YOUR SELECTION</span>
              <h2>{history ? 'Round receipts' : `Bet ${slot}`}</h2>
            </div>
            <span className="bj-ticket-count">{tickets.length}/10 confirmed</span>
          </div>
          <div className="bj-ticket-tabs" aria-label="Bet tabs">
            {Array.from(used)
              .sort((a, b) => a - b)
              .map((i) => (
                <button
                  key={i}
                  aria-pressed={slot === i}
                  className={slot === i ? 'active' : ''}
                  onClick={() => setSlot(i)}
                >
                  Bet {i}
                  {tickets.some((t) => t.slot === i) && <span> ✓</span>}
                </button>
              ))}
            <button
              className="bj-add"
              disabled={!next || !!pending || submitting || !!history}
              onClick={() => {
                if (next) {
                  setDrafts((d) => ({ ...d, [next]: emptyDraft() }));
                  setSlot(next);
                }
              }}
              aria-label="Add bet"
            >
              ＋
            </button>
          </div>
          <div className="bj-slip-content">
            <div className="bj-market-heading">
              <h3>{seat === 0 ? 'Dealer' : `Seat ${seat}`}</h3>
              <span>
                {ticket
                  ? 'Price locked'
                  : history
                    ? 'Finished'
                    : `Stage ${(current?.stage ?? 0) + 1} prices`}
              </span>
            </div>
            <p className="bj-small">
              {seat === 0
                ? 'Predict the dealer’s final total.'
                : 'Predict this seat’s result against the dealer.'}
            </p>
            {seat !== 0 && (
              <div className="bj-outcomes">
                {(['WIN', 'DRAW', 'LOSE'] as const).map((m) => (
                  <MarketButton
                    key={m}
                    market={m}
                    price={ticket?.market === m ? ticket.odds : table?.quotes[bjKey(seat, m)]}
                    selected={market === m}
                    locked={locked}
                    onClick={() => update({ market: m })}
                  />
                ))}
              </div>
            )}
            <div className="bj-market-label">
              Final points <span>or a special finish</span>
            </div>
            <div className="bj-point-markets">
              {BJ_MARKETS.slice(3).map((m) => (
                <MarketButton
                  key={m}
                  market={m}
                  price={ticket?.market === m ? ticket.odds : table?.quotes[bjKey(seat, m)]}
                  selected={market === m}
                  locked={locked}
                  onClick={() => update({ market: m })}
                />
              ))}
            </div>
            <div className="bj-selected" aria-live="polite">
              <span>{market ? '✓ ' + bjSelection(seat, market) : 'Choose a result above'}</span>
              <strong>{odds ? `${(odds / 100).toFixed(2)}×` : '—'}</strong>
            </div>
            <label className="bj-amount-label" htmlFor="bj-amount">
              Bet amount <span>ETB</span>
            </label>
            <div className="bj-amount">
              <button
                aria-label="Decrease amount"
                disabled={locked || amount <= 5}
                onClick={() => update({ text: String(Math.max(5, (amount || 5) - 5)) })}
              >
                −
              </button>
              <input
                id="bj-amount"
                inputMode="numeric"
                autoComplete="off"
                value={ticket ? String(ticket.amount) : draft.text}
                disabled={locked}
                onChange={(e) => update({ text: e.target.value })}
              />
              <button
                aria-label="Increase amount"
                disabled={locked || amount >= 500}
                onClick={() => update({ text: String(Math.min(500, (amount || 0) + 5)) })}
              >
                ＋
              </button>
            </div>
            <div className="bj-quick">
              {[10, 25, 50, 100].map((n) => (
                <button
                  key={n}
                  disabled={locked}
                  aria-pressed={amount === n}
                  onClick={() => update({ text: String(n) })}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="bj-return">
              <span>{ticket && complete ? 'Returned' : 'Return if correct'}</span>
              <b>
                {ticket && complete
                  ? ticket.payout === null
                    ? 'Settling…'
                    : `${money(ticket.payout)} ETB`
                  : valid
                    ? `${money((amount * odds!) / 100)} ETB`
                    : '—'}
              </b>
            </div>
            <p className="bj-small">Returns include your stake. 5–500 ETB per bet.</p>
            <button
              className="bj-primary"
              disabled={!canReview}
              onClick={() =>
                current &&
                market &&
                odds &&
                setReview({
                  roundId: current.id,
                  stage: current.stage,
                  slot,
                  seat,
                  market,
                  amount,
                  odds,
                })
              }
            >
              {ticket
                ? '✓ Bet confirmed'
                : pending
                  ? 'Checking confirmation…'
                  : history
                    ? 'Viewing past round'
                    : !open
                      ? 'Bets are closed'
                      : `Review bet · ${money(Number.isFinite(amount) ? amount : 0)} ETB`}
            </button>
            {open && !ticket && amount > (data?.balance ?? 0) && (
              <p className="bj-warning">Not enough practice ETB for this bet.</p>
            )}
          </div>
        </section>
      </div>
      {notice && (
        <p className="bj-notice" role="status">
          {notice}
        </p>
      )}
      {pending && !submitting && (
        <div className="bj-notice">
          <span>A bet is awaiting confirmation. Retry checks the same receipt.</span>
          <button onClick={onRetry} disabled={!connected || !!error}>
            Retry unconfirmed bet
          </button>
        </div>
      )}
      {!!tickets.length && (
        <section className="bj-receipts" aria-label="Confirmed bets">
          <header>
            <h2>Your bets this round</h2>
            <span>{money(tickets.reduce((s, t) => s + t.amount, 0))} ETB total</span>
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
                  <strong>{money(t.amount)} ETB</strong>
                </span>
                <p>{bjSelection(t.seat, t.market)}</p>
                <small>
                  {(t.odds / 100).toFixed(2)}× locked · Stage {t.stage + 1}
                </small>
                <em className={t.payout && t.payout > 0 ? 'won' : ''}>
                  {complete
                    ? t.payout === null
                      ? 'Return pending'
                      : `${money(t.payout)} ETB returned`
                    : 'Confirmed · waiting for showdown'}
                </em>
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="bj-history" aria-label="Recent rounds">
        <header>
          <h2>Recent rounds</h2>
          <span>Last 15 results</span>
        </header>
        <div>
          {history && (
            <button className="bj-back-live" onClick={() => setHistory(null)}>
              ← Back to live table
            </button>
          )}
          {data?.rounds
            .filter((r) => r.stage === 3)
            .slice(0, 15)
            .map((r) => (
              <button
                key={r.id}
                className={history === r.id ? 'active' : ''}
                aria-label={`View round ${r.id}`}
                onClick={() => {
                  setHistory(r.id);
                  setSlot(r.tickets[0]?.slot ?? 1);
                  setReview(null);
                }}
              >
                <span>#{r.id.replace('bj-', '')}</span>
                <strong>
                  {r.hands.slice(1).map((h, i) => (
                    <i key={i} className={`result-${bjResult(h, r.hands[0]).toLowerCase()}`}>
                      {bjResult(h, r.hands[0]) === 'WIN'
                        ? 'W'
                        : bjResult(h, r.hands[0]) === 'DRAW'
                          ? 'D'
                          : 'L'}
                    </i>
                  ))}
                </strong>
              </button>
            ))}
          {!data?.rounds.some((r) => r.stage === 3) && <p>Completed rounds will appear here.</p>}
        </div>
      </section>
      <p className="bj-disclosure">Free practice · No cash value · Salem’s original table rules</p>
      <Dialog.Root open={!!review} onOpenChange={(v) => !v && setReview(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="bj-overlay" />
          <Dialog.Content className="bj-dialog">
            <Dialog.Title>Confirm Bet {review?.slot}</Dialog.Title>
            <Dialog.Description>
              Review your selection and price. Confirmed bets cannot be changed.
            </Dialog.Description>
            {review && (
              <>
                <div className="bj-confirm-choice">
                  <span>
                    Stage {review.stage + 1} · {bjSelection(review.seat, review.market)}
                  </span>
                  <strong>{(review.odds / 100).toFixed(2)}×</strong>
                </div>
                <dl>
                  <dt>Practice stake</dt>
                  <dd>{money(review.amount)} ETB</dd>
                  <dt>Return if correct</dt>
                  <dd>{money((review.amount * review.odds) / 100)} ETB</dd>
                </dl>
                <p>Includes your stake. Settles at showdown. Virtual ETB has no cash value.</p>
                {!reviewValid && (
                  <p className="bj-warning">
                    The stage or price changed. Close this review and select a current price.
                  </p>
                )}
                <button
                  className="bj-primary"
                  disabled={!reviewValid}
                  onClick={() => {
                    if (reviewValid) {
                      onSubmit(review);
                      setReview(null);
                    }
                  }}
                >
                  Confirm practice bet
                </button>
              </>
            )}
            <Dialog.Close className="bj-secondary">Keep editing</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
function MarketButton({
  market,
  price,
  selected,
  locked,
  onClick,
}: {
  market: Market;
  price?: number;
  selected: boolean;
  locked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`bj-market ${selected ? 'selected' : ''}`}
      aria-label={`${BJ_LABELS[market]}${price ? ` at ${(price / 100).toFixed(2)} times` : ', closed'}`}
      aria-pressed={selected}
      disabled={locked || !price}
      onClick={onClick}
    >
      <span>
        {selected ? '✓ ' : ''}
        {BJ_LABELS[market]}
      </span>
      <b>{price ? (price / 100).toFixed(2) : 'Closed'}</b>
    </button>
  );
}
function Rules() {
  return (
    <Dialog.Root>
      <Dialog.Trigger className="bj-rules-link">How to play ↗</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="bj-overlay" />
        <Dialog.Content className="bj-dialog">
          <Dialog.Title>How to play Blackjack</Dialog.Title>
          <Dialog.Description>
            Predict six automated seats playing against one dealer. You choose bets; the table deals
            and plays each hand.
          </Dialog.Description>
          <ol>
            <li>
              Each round lasts 2 minutes 40 seconds. A first card is visible immediately. The second
              card arrives at 40 seconds; a third arrives at 80 seconds for hands below 17. Betting
              closes at 120 seconds, when the remaining cards and results appear.
            </li>
            <li>
              Choose a seat to win, draw or lose against the dealer, or predict final points: 17–21,
              a natural Blackjack, or a Bust. Dealer bets are final-points bets only.
            </li>
            <li>
              All hands stand on 17, including soft 17. Aces count as 1 or 11; picture cards count
              as 10. Blackjack is an Ace and any ten-value card on the first two cards and beats a
              multi-card 21. A busted seat loses even when the dealer busts. Equal surviving hands
              draw.
            </li>
            <li>
              Prices refresh after each deal and lock when you confirm. Closed outcomes cannot be
              bet on. A winning prediction returns stake × locked price; an incorrect prediction
              returns zero. Draw bets pay only when you select Draw.
            </li>
            <li>
              Place up to ten independent tickets per round, with 5–500 practice ETB each. You start
              with a separate 1,000 ETB practice balance.
            </li>
          </ol>
          <p>
            A fresh six-deck shoe is used each round, without replacement. Prices are estimates from
            simulations of the visible cards, rounded down and capped at 200×. The 21 market
            excludes a two-card natural Blackjack.
          </p>
          <p>
            This is Salem’s original practice game. No deposits, cash prizes, insurance, splits,
            double-downs, or automatic repeat bets.
          </p>
          <Dialog.Close className="bj-primary">Got it</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
