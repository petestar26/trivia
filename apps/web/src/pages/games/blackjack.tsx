import { BlackjackTable } from '@/components/blackjack/table';
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
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

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
  const { t: translateUi } = useInterfaceLanguage();

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
        <Link to="/games">{translateUi('← Games')}</Link>
        <span className={connected ? 'bj-online' : ''}>
          <i />
          {connected ? translateUi('Connected') : translateUi('Connecting')}
        </span>
      </div>
      <header className="bj-header">
        <div>
          <span className="bj-eyebrow">{translateUi('SALEM TABLE GAMES')}</span>
          <h1>
            {translateUi('Black')}
            <span>{translateUi('jack')}</span>
          </h1>
          <p>{translateUi('Six seats. One dealer. Your call.')}</p>
        </div>
        <div className="bj-balance">
          <small>{translateUi('Practice balance')}</small>
          <strong>
            {money(data?.balance ?? 0)} <em>{'ETB'}</em>
          </strong>
          <span>{translateUi('Virtual ETB · no cash value')}</span>
        </div>
      </header>
      {(connectionMessage || error || !connected) && (
        <p className="bj-notice" role="status">
          {error ||
            connectionMessage ||
            translateUi('Connection interrupted. Betting pauses until the table is up to date.')}
        </p>
      )}
      <div className="bj-layout">
        <section className="bj-arena" aria-label={translateUi('Blackjack table')}>
          <div className="bj-stagebar">
            <div>
              <span className="bj-live-dot" />
              <b>
                {history
                  ? translateUi('Past round')
                  : complete
                    ? translateUi('Round complete')
                    : open
                      ? translateUi('Bets open')
                      : translateUi('Dealing cards')}
              </b>
              <small>#{table?.id.replace('bj-', '') ?? '—'}</small>
            </div>
            <div className="bj-timer">
              <span>
                {history
                  ? translateUi('Final result')
                  : phase === 3
                    ? translateUi('Next round')
                    : translateUi('Next deal')}
              </span>
              <strong>
                {history ? '✓' : translateUi('{countdown}s', { countdown: countdown })}
              </strong>
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
                <b>{translateUi(name)}</b>
              </div>
            ))}
          </div>
          <BlackjackTable
            hands={table?.hands ?? []}
            complete={complete}
            selectedSeat={seat}
            onSelect={(s) => update({ seat: s, market: null })}
            disabled={!!ticket || !!pending || !!history}
          />
          <div className="bj-table-footer">
            <span>
              {translateUi('6-deck shoe') + ' '}
              <i>·</i>
              {' ' + translateUi('2m 40s rounds')}
            </span>
            <Rules />
          </div>
        </section>
        <section className="bj-slip" aria-label={translateUi('Your bet')}>
          <div className="bj-slip-heading">
            <div>
              <span className="bj-eyebrow">{translateUi('YOUR SELECTION')}</span>
              <h2>
                {history
                  ? translateUi('Round receipts')
                  : translateUi('Bet {slot}', { slot: slot })}
              </h2>
            </div>
            <span className="bj-ticket-count">
              {translateUi('{length}/10 confirmed', { length: tickets.length })}
            </span>
          </div>
          <div className="bj-ticket-tabs" aria-label={translateUi('Bet tabs')}>
            {Array.from(used)
              .sort((a, b) => a - b)
              .map((i) => (
                <button
                  key={i}
                  aria-pressed={slot === i}
                  className={slot === i ? 'active' : ''}
                  onClick={() => setSlot(i)}
                >
                  {translateUi('Bet') + ' '}
                  {i}
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
              aria-label={translateUi('Add bet')}
            >
              ＋
            </button>
          </div>
          <div className="bj-slip-content">
            <div className="bj-market-heading">
              <h3>
                {seat === 0 ? translateUi('Dealer') : translateUi('Seat {seat}', { seat: seat })}
              </h3>
              <span>
                {ticket
                  ? translateUi('Price locked')
                  : history
                    ? translateUi('Finished')
                    : translateUi('Stage {value} prices', { value: (current?.stage ?? 0) + 1 })}
              </span>
            </div>
            <p className="bj-small">
              {seat === 0
                ? translateUi('Predict the dealer’s final total.')
                : translateUi('Predict this seat’s result against the dealer.')}
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
              {translateUi('Final points') + ' '}
              <span>{translateUi('or a special finish')}</span>
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
              <span>
                {market ? '✓ ' + bjSelection(seat, market) : translateUi('Choose a result above')}
              </span>
              <strong>{odds ? `${(odds / 100).toFixed(2)}×` : '—'}</strong>
            </div>
            <label className="bj-amount-label" htmlFor="bj-amount">
              {translateUi('Bet amount') + ' '}
              <span>{'ETB'}</span>
            </label>
            <div className="bj-amount">
              <button
                aria-label={translateUi('Decrease amount')}
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
                aria-label={translateUi('Increase amount')}
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
              <span>
                {ticket && complete ? translateUi('Returned') : translateUi('Return if correct')}
              </span>
              <b>
                {ticket && complete
                  ? ticket.payout === null
                    ? translateUi('Settling…')
                    : translateUi('{value} ETB', { value: money(ticket.payout) })
                  : valid
                    ? translateUi('{value} ETB', { value: money((amount * odds!) / 100) })
                    : '—'}
              </b>
            </div>
            <p className="bj-small">
              {translateUi('Returns include your stake. 5–500 ETB per bet.')}
            </p>
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
                ? translateUi('✓ Bet confirmed')
                : pending
                  ? translateUi('Checking confirmation…')
                  : history
                    ? translateUi('Viewing past round')
                    : !open
                      ? translateUi('Bets are closed')
                      : translateUi('Review bet · {value} ETB', {
                          value: money(Number.isFinite(amount) ? amount : 0),
                        })}
            </button>
            {open && !ticket && amount > (data?.balance ?? 0) && (
              <p className="bj-warning">{translateUi('Not enough practice ETB for this bet.')}</p>
            )}
          </div>
        </section>
      </div>
      {notice && (
        <p className="bj-notice" role="status">
          {translateUi(notice)}
        </p>
      )}
      {pending && !submitting && (
        <div className="bj-notice">
          <span>
            {translateUi('A bet is awaiting confirmation. Retry checks the same receipt.')}
          </span>
          <button onClick={onRetry} disabled={!connected || !!error}>
            {translateUi('Retry unconfirmed bet')}
          </button>
        </div>
      )}
      {!!tickets.length && (
        <section className="bj-receipts" aria-label={translateUi('Confirmed bets')}>
          <header>
            <h2>{translateUi('Your bets this round')}</h2>
            <span>
              {translateUi('{value} ETB total', {
                value: money(tickets.reduce((s, t) => s + t.amount, 0)),
              })}
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
                  <b>{translateUi('Bet {slot}', { slot: t.slot })}</b>
                  <strong>{translateUi('{value} ETB', { value: money(t.amount) })}</strong>
                </span>
                <p>{bjSelection(t.seat, t.market)}</p>
                <small>
                  {translateUi('{value}× locked · Stage {value2}', {
                    value: (t.odds / 100).toFixed(2),
                    value2: t.stage + 1,
                  })}
                </small>
                <em className={t.payout && t.payout > 0 ? 'won' : ''}>
                  {complete
                    ? t.payout === null
                      ? translateUi('Return pending')
                      : translateUi('{value} ETB returned', { value: money(t.payout) })
                    : translateUi('Confirmed · waiting for showdown')}
                </em>
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="bj-history" aria-label={translateUi('Recent rounds')}>
        <header>
          <h2>{translateUi('Recent rounds')}</h2>
          <span>{translateUi('Last 15 results')}</span>
        </header>
        <div>
          {history && (
            <button className="bj-back-live" onClick={() => setHistory(null)}>
              {translateUi('← Back to live table')}
            </button>
          )}
          {data?.rounds
            .filter((r) => r.stage === 3)
            .slice(0, 15)
            .map((r) => (
              <button
                key={r.id}
                className={history === r.id ? 'active' : ''}
                aria-label={translateUi('View round {id}', { id: r.id })}
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
                        ? translateUi('W')
                        : bjResult(h, r.hands[0]) === 'DRAW'
                          ? translateUi('D')
                          : translateUi('L')}
                    </i>
                  ))}
                </strong>
              </button>
            ))}
          {!data?.rounds.some((r) => r.stage === 3) && (
            <p>{translateUi('Completed rounds will appear here.')}</p>
          )}
        </div>
      </section>
      <p className="bj-disclosure">
        {translateUi('Free practice · No cash value · Salem’s original table rules')}
      </p>
      <Dialog.Root open={!!review} onOpenChange={(v) => !v && setReview(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="bj-overlay" />
          <Dialog.Content className="bj-dialog">
            <Dialog.Title>
              {translateUi('Confirm Bet {slot}', { slot: review?.slot ?? '' })}
            </Dialog.Title>
            <Dialog.Description>
              {translateUi('Review your selection and price. Confirmed bets cannot be changed.')}
            </Dialog.Description>
            {review && (
              <>
                <div className="bj-confirm-choice">
                  <span>
                    {translateUi('Stage {value} · {value2}', {
                      value: review.stage + 1,
                      value2: bjSelection(review.seat, review.market),
                    })}
                  </span>
                  <strong>{(review.odds / 100).toFixed(2)}×</strong>
                </div>
                <dl>
                  <dt>{translateUi('Practice stake')}</dt>
                  <dd>{translateUi('{value} ETB', { value: money(review.amount) })}</dd>
                  <dt>{translateUi('Return if correct')}</dt>
                  <dd>
                    {translateUi('{value} ETB', {
                      value: money((review.amount * review.odds) / 100),
                    })}
                  </dd>
                </dl>
                <p>
                  {translateUi(
                    'Includes your stake. Settles at showdown. Virtual ETB has no cash value.'
                  )}
                </p>
                {!reviewValid && (
                  <p className="bj-warning">
                    {translateUi(
                      'The stage or price changed. Close this review and select a current price.'
                    )}
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
                  {translateUi('Confirm practice bet')}
                </button>
              </>
            )}
            <Dialog.Close className="bj-secondary">{translateUi('Keep editing')}</Dialog.Close>
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
  const { t: translateUi } = useInterfaceLanguage();

  return (
    <button
      className={`bj-market ${selected ? 'selected' : ''}`}
      aria-label={
        price
          ? translateUi('{market} at {price} times', {
              market: translateUi(BJ_LABELS[market]),
              price: (price / 100).toFixed(2),
            })
          : translateUi('{market}, closed', { market: translateUi(BJ_LABELS[market]) })
      }
      aria-pressed={selected}
      disabled={locked || !price}
      onClick={onClick}
    >
      <span>
        {selected ? '✓ ' : ''}
        {translateUi(BJ_LABELS[market])}
      </span>
      <b>{price ? (price / 100).toFixed(2) : translateUi('Closed')}</b>
    </button>
  );
}
function Rules() {
  const { t: translateUi } = useInterfaceLanguage();

  return (
    <Dialog.Root>
      <Dialog.Trigger className="bj-rules-link">{translateUi('How to play ↗')}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="bj-overlay" />
        <Dialog.Content className="bj-dialog">
          <Dialog.Title>{translateUi('How to play Blackjack')}</Dialog.Title>
          <Dialog.Description>
            {translateUi(
              'Predict six automated seats playing against one dealer. You choose bets; the table deals and plays each hand.'
            )}
          </Dialog.Description>
          <ol>
            <li>
              {translateUi(
                'Each round lasts 2 minutes 40 seconds. A first card is visible immediately. The second card arrives at 40 seconds; a third arrives at 80 seconds for hands below 17. Betting closes at 120 seconds, when the remaining cards and results appear.'
              )}
            </li>
            <li>
              {translateUi(
                'Choose a seat to win, draw or lose against the dealer, or predict final points: 17–21, a natural Blackjack, or a Bust. Dealer bets are final-points bets only.'
              )}
            </li>
            <li>
              {translateUi(
                'All hands stand on 17, including soft 17. Aces count as 1 or 11; picture cards count as 10. Blackjack is an Ace and any ten-value card on the first two cards and beats a multi-card 21. A busted seat loses even when the dealer busts. Equal surviving hands draw.'
              )}
            </li>
            <li>
              {translateUi(
                'Prices refresh after each deal and lock when you confirm. Closed outcomes cannot be bet on. A winning prediction returns stake × locked price; an incorrect prediction returns zero. Draw bets pay only when you select Draw.'
              )}
            </li>
            <li>
              {translateUi(
                'Place up to ten independent tickets per round, with 5–500 practice ETB each. You start with a separate 1,000 ETB practice balance.'
              )}
            </li>
          </ol>
          <p>
            {translateUi(
              'A fresh six-deck shoe is used each round, without replacement. Prices are estimates from simulations of the visible cards, rounded down and capped at 200×. The 21 market excludes a two-card natural Blackjack.'
            )}
          </p>
          <p>
            {translateUi(
              'This is Salem’s original practice game. No deposits, cash prizes, insurance, splits, double-downs, or automatic repeat bets.'
            )}
          </p>
          <Dialog.Close className="bj-primary">{translateUi('Got it')}</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
