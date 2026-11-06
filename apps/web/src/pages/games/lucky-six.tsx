import { luckySixSelectionLabel } from '@/lib/i18n/game-labels';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  LUCKY_SIX_RULES as R,
  LS_MARKETS,
  LS_LABELS,
  lsColor,
  lsColorNumbers,
  LS_COLORS,
  LS_DESCRIPTIONS,
  LS_SIX_TENTHS,
  lsCompletion,
  lsStake,
  lsFixedTenths,
  lsValidate,
} from '@socialplay/shared';
import type {
  LuckySixEntry as Entry,
  LuckySixSnapshot,
  LuckySixMarket as Market,
  LuckySixTicket,
} from '@socialplay/shared';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import { LuckySixMachine } from '@/components/lucky-six/draw-machine';
import './lucky-six.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

const endpoint = '/games/lucky-six';
const receiptKey = (id: string) => `salem.lucky-six.pending.v1.${id}`;
export function readLuckySixPending(id: string): Entry | null {
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
  lsValidate(e.market, e.picks, e.amount);
  return e;
}
export function LuckySixPage() {
  const { user } = useAuth();
  return user ? <ConnectedLuckySix key={user.id} userId={user.id} /> : null;
}
function ConnectedLuckySix({ userId }: { userId: string }) {
  const [initial] = useState(() => {
    try {
      return { entry: readLuckySixPending(userId), error: '' };
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
  const [acknowledged, setAcknowledged] = useState<LuckySixTicket[]>([]);
  const query = useQuery({
    queryKey: ['lucky-six', userId],
    queryFn: async ({ signal }) => {
      const sentAt = performance.now();
      const snapshot = unwrapData(
        await boundedRequest(
          (s) => api.get<LuckySixSnapshot>(endpoint, undefined, { signal: s }),
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
        { ...e, id: receipt.id, stake: lsStake(e.market, e.amount), payout: null },
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
    <LuckySixView
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
const emptyDraft = (): Draft => ({ market: 'SIX', picks: [], text: '5' });
const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const groups: Record<string, Market[]> = {
  Numbers: ['SIX', 'PRE_NUMBER'],
  Colors: ['FIRST_COLOR', 'LAST_COLOR', 'MOST_COLOR', 'ALL_COLORS'],
  Extras: ['FIRST_PARITY', 'FIRST_RANGE', 'PRE_PARITY', 'PRE_SUM', 'DRAW_PARITY'],
};
const colored = (n: number): CSSProperties =>
  ({ '--ball': LS_COLORS[lsColor(n)].hex }) as CSSProperties;
function scopeReturn(m: Market, amount: number) {
  const fixed = lsFixedTenths(m);
  return fixed === null
    ? 'See the six-match payout table'
    : `${money((amount * fixed) / 10)} ETB if correct${m === 'MOST_COLOR' ? '; a tied lead refunds your bet' : ''}`;
}
export function LuckySixView({
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
  data?: LuckySixSnapshot;
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
  const { t: translateUi } = useInterfaceLanguage();

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
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const tickets = display?.tickets ?? [];
  const ticket = tickets.find((t) => t.slot === slot);
  const waiting =
    pending && pending.roundId === display?.id && pending.slot === slot ? pending : null;
  const draft = drafts[slot] ?? emptyDraft();
  const market = ticket?.market ?? waiting?.market ?? draft.market;
  const picks = ticket?.picks ?? waiting?.picks ?? draft.picks;
  const text = String(ticket?.amount ?? waiting?.amount ?? draft.text);
  const amount = /^\d+$/.test(text) ? Number(text) : 0;
  const cost = lsStake(market, amount);
  const locked = !open || !!ticket || !!pending || !!error || submitting;
  let valid = false;
  try {
    lsValidate(market, picks, amount);
    valid = true;
  } catch {
    /* Incomplete draft. */
  }
  const numberMarket = market === 'SIX' || market === 'PRE_NUMBER';
  const covered = numberMarket
    ? picks
    : market === 'ALL_COLORS'
      ? Array.from({ length: 48 }, (_, i) => i + 1)
      : market.endsWith('COLOR') && picks.length
        ? lsColorNumbers(picks[0] - 1)
        : [];
  const revealed = display?.revealed ?? [];
  const complete = display?.complete === true;
  const drawing = !!round && now >= round.closesAt && !complete;
  const group = Object.keys(groups).find((g) => groups[g].includes(market))!;
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
  const changeMarket = (m: Market) => update({ market: m, picks: m === 'ALL_COLORS' ? [1] : [] });
  const toggle = (n: number) => {
    if (locked || !numberMarket) return;
    update({
      picks:
        market === 'PRE_NUMBER'
          ? picks.includes(n)
            ? []
            : [n]
          : picks.includes(n)
            ? picks.filter((v) => v !== n)
            : picks.length < 6
              ? [...picks, n].sort((a, b) => a - b)
              : picks,
    });
  };
  const quickPick = () => {
    const pool = Array.from({ length: 48 }, (_, i) => i + 1),
      word = new Uint32Array(1),
      count = market === 'SIX' ? 6 : 1;
    for (let i = 0; i < count; i++) {
      const range = 48 - i,
        limit = Math.floor(2 ** 32 / range) * range;
      do {
        crypto.getRandomValues(word);
      } while (word[0] >= limit);
      const j = i + (word[0] % range);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    update({ picks: pool.slice(0, count).sort((a, b) => a - b) });
  };
  const results = data?.rounds.filter((r) => r.complete) ?? [];
  const completion = market === 'SIX' ? lsCompletion(picks, revealed) : null;
  const fixed = lsFixedTenths(market);
  return (
    <div className="ls-page">
      <div className="ls-nav">
        <Link to="/games">{translateUi('← Games')}</Link>
        <span className={connected ? 'ls-connected' : ''}>
          {connected ? translateUi('● Connected') : translateUi('○ Connecting')}
        </span>
      </div>
      <header className="ls-heading">
        <div>
          <span className="ls-eyebrow">{translateUi('SALEM ORIGINALS')}</span>
          <h1>
            {translateUi('Lucky') + ' '}
            <em>{translateUi('Six')}</em>
            <span className="ls-title-dot" aria-hidden="true">
              ●
            </span>
          </h1>
        </div>
        <div className="ls-balance">
          <span>{translateUi('Practice balance')}</span>
          <strong>
            {data ? money(data.balance) : '—'} <small>{'ETB'}</small>
          </strong>
          <small>{translateUi('No cash value')}</small>
        </div>
      </header>
      <div className="ls-toolbar">
        <p>
          <b>{translateUi('Pick six.')}</b>
          {' ' + translateUi('Follow every ball.')}
        </p>
        <Rules />
        <Dialog.Root>
          <Dialog.Trigger className="ls-text-button">
            {translateUi('Recent draws ↗')}
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="ls-overlay" />
            <Dialog.Content className="ls-dialog">
              <Dialog.Title>{translateUi('Recent Lucky Six draws')}</Dialog.Title>
              <Dialog.Description>
                {translateUi('Completed results and your confirmed practice bets.')}
              </Dialog.Description>
              {results.length ? (
                results.map((r) => (
                  <article className="ls-history" key={r.id}>
                    <strong>
                      {translateUi('Draw {value}', { value: r.id.replace('ls-', '') })}
                    </strong>
                    <div className="ls-history-balls">
                      {r.revealed.map((n, i) => (
                        <span
                          key={n}
                          style={colored(n)}
                          title={translateUi('Ball {value}', { value: i + 1 })}
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                    {r.tickets.map((t) => (
                      <p key={t.id}>
                        {translateUi('Bet {slot} · {value} · {value2}', {
                          slot: t.slot,
                          value: luckySixSelectionLabel(t.market, t.picks, translateUi),
                          value2:
                            t.payout === null
                              ? translateUi('Return pending')
                              : translateUi('{value} ETB returned', { value: money(t.payout) }),
                        })}
                      </p>
                    ))}
                  </article>
                ))
              ) : (
                <p>{translateUi('No completed draws yet.')}</p>
              )}
              <Dialog.Close className="ls-primary">{translateUi('Close results')}</Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      {!connected && (
        <p className="ls-notice" role="alert">
          {connectionMessage ??
            translateUi('Reconnecting. Bet entry pauses until a fresh update arrives.')}
        </p>
      )}
      {connected && !round && (
        <p className="ls-notice" role="status">
          {translateUi('Waiting for the next scheduled draw…')}
        </p>
      )}
      {error && (
        <p className="ls-notice" role="alert">
          {translateUi(error)}
        </p>
      )}
      <div className="ls-table">
        <section className="ls-studio" aria-label={translateUi('Live practice draw')}>
          <div className="ls-studio-heading">
            <span className="ls-dot" />
            {!connected
              ? translateUi('Connecting')
              : !round
                ? translateUi('Next draw pending')
                : open
                  ? translateUi('Place your bets')
                  : complete
                    ? translateUi('Draw complete')
                    : translateUi('Drawing now')}
            <span className="ls-countdown" role="timer">
              {open ? translateUi('Closes in') : translateUi('Next draw')} <b>{countdown}</b>
            </span>
          </div>
          <LuckySixMachine latest={revealed.at(-1) ?? null} drawing={drawing && connected} />
          <div className="ls-draw-results">
            <div className="ls-draw-label">
              <strong>
                {revealed.length}
                <span>{' ' + translateUi('/ 35 balls')}</span>
              </strong>
              <small>
                {translateUi('Draw {value}', { value: display?.id.replace('ls-', '') ?? '—' })}
              </small>
            </div>
            <ol className="ls-balls" aria-label={translateUi('Released balls')}>
              {Array.from({ length: 35 }, (_, i) => {
                const n = revealed[i];
                return (
                  <li
                    key={i}
                    style={n ? colored(n) : undefined}
                    className={`${i < 5 ? 'preball' : ''} ${n ? 'released' : ''} ${n && numberMarket && picks.includes(n) && (market === 'SIX' || i < 5) ? 'match' : ''}`}
                    aria-label={
                      n
                        ? translateUi('Ball {value}: {n}', { value: i + 1, n: n })
                        : translateUi('Ball {value}: waiting', { value: i + 1 })
                    }
                  >
                    {n ?? <span>·</span>}
                  </li>
                );
              })}
            </ol>
            <p className="ls-result-note" aria-live="polite">
              {completion
                ? translateUi('Six matched at ball {completion} · {value}× return', {
                    completion: completion,
                    value: LS_SIX_TENTHS[completion - 6] / 10,
                  })
                : revealed.length
                  ? translateUi('Ball {length}: {value} · {name}', {
                      length: revealed.length,
                      value: revealed.at(-1) ?? '',
                      name: translateUi(LS_COLORS[lsColor(revealed.at(-1)!)].name),
                    })
                  : translateUi('The first five slots are the pre-balls.')}
            </p>
          </div>
          <div className="ls-studio-footer">
            <span>{translateUi('Every five minutes')}</span>
            <span>{translateUi('35 of 48 · Free practice')}</span>
          </div>
        </section>
        <section className="ls-play" aria-label={translateUi('Place a practice bet')}>
          <div className="ls-ticket-tabs" role="group" aria-label={translateUi('Your bets')}>
            {slots.map((n) => (
              <button key={n} type="button" aria-pressed={slot === n} onClick={() => setSlot(n)}>
                {translateUi('Bet') + ' '}
                {n}
                <small>
                  {tickets.some((t) => t.slot === n)
                    ? translateUi('✓ Saved')
                    : pending?.slot === n && pending.roundId === round?.id
                      ? translateUi('Checking')
                      : translateUi('Draft')}
                </small>
              </button>
            ))}
            {nextSlot && (
              <button
                className="ls-add-bet"
                disabled={!open || !!pending || !!error || submitting}
                onClick={() => {
                  setDrafts((ds) => ({ ...ds, [nextSlot]: emptyDraft() }));
                  setSlot(nextSlot);
                }}
              >
                {translateUi('+ Add bet')}
              </button>
            )}
          </div>
          <div
            className="ls-market-groups"
            role="group"
            aria-label={translateUi('Market category')}
          >
            {Object.keys(groups).map((g) => (
              <button
                key={g}
                aria-pressed={group === g}
                disabled={locked}
                onClick={() => changeMarket(groups[g][0])}
              >
                {g}
              </button>
            ))}
          </div>
          <div className="ls-market-select">
            <label htmlFor="ls-market">{translateUi('Bet type')}</label>
            <select
              id="ls-market"
              value={market}
              disabled={locked}
              onChange={(e) => changeMarket(e.target.value as Market)}
            >
              {groups[group].map((m) => (
                <option key={m} value={m}>
                  {translateUi(LS_LABELS[m])}
                </option>
              ))}
            </select>
            <strong>{fixed === null ? '6 / 48' : `${fixed / 10}×`}</strong>
          </div>
          <p className="ls-market-caption">{translateUi(LS_DESCRIPTIONS[market])}</p>
          {market === 'SIX' && (
            <div
              className="ls-six-slots"
              aria-label={translateUi('{length} of 6 numbers selected', { length: picks.length })}
            >
              {Array.from({ length: 6 }, (_, i) => (
                <span
                  key={i}
                  style={picks[i] ? colored(picks[i]) : undefined}
                  className={picks[i] ? 'filled' : ''}
                >
                  {picks[i] ?? '+'}
                </span>
              ))}
            </div>
          )}
          {!numberMarket && market !== 'ALL_COLORS' && (
            <div
              className={`ls-options ${market.endsWith('COLOR') ? 'color-options' : ''}`}
              role="group"
              aria-label={translateUi('{value} options', { value: translateUi(LS_LABELS[market]) })}
            >
              {Array.from({ length: market.endsWith('COLOR') ? 8 : 2 }, (_, i) => i + 1).map(
                (n) => (
                  <button
                    key={n}
                    disabled={locked}
                    aria-pressed={picks.includes(n)}
                    style={market.endsWith('COLOR') ? colored(n) : undefined}
                    onClick={() => update({ picks: [n] })}
                  >
                    {market.endsWith('COLOR') && <i />}
                    {luckySixSelectionLabel(market, [n], translateUi)}
                    {picks.includes(n) && <span aria-hidden="true"> ✓</span>}
                  </button>
                )
              )}
            </div>
          )}
          <div
            className={`ls-board ${!numberMarket ? 'is-coverage' : ''}`}
            role="group"
            aria-label={translateUi('48-number board')}
          >
            {Array.from({ length: 48 }, (_, i) => i + 1).map((n) => {
              const selected = covered.includes(n),
                drawn = revealed.includes(n),
                hit =
                  numberMarket &&
                  selected &&
                  (market === 'SIX' ? drawn : revealed.slice(0, 5).includes(n));
              return (
                <button
                  key={n}
                  type="button"
                  style={colored(n)}
                  aria-label={translateUi('Number {n}{value}', {
                    n: n,
                    value: drawn ? translateUi(', drawn') : '',
                  })}
                  aria-pressed={selected}
                  disabled={locked || !numberMarket}
                  onClick={() => toggle(n)}
                  className={`${selected ? 'is-selected' : ''} ${drawn ? 'is-drawn' : ''} ${hit ? 'is-hit' : ''}`}
                >
                  <span>{n}</span>
                  {selected && <i aria-hidden="true">{hit ? '✓' : '●'}</i>}
                </button>
              );
            })}
          </div>
          <div className="ls-board-bottom">
            <span>
              {market === 'SIX'
                ? translateUi('{length} / 6 selected', { length: picks.length })
                : numberMarket
                  ? translateUi('{length} / 1 selected', { length: picks.length })
                  : translateUi('Eight colors · six balls each')}
            </span>
            <div>
              <button
                className="ls-text-button"
                disabled={locked || !numberMarket}
                onClick={quickPick}
              >
                {translateUi('Quick pick {value}', { value: market === 'SIX' ? '6' : '1' })}
              </button>
              <button
                className="ls-text-button"
                disabled={locked || !picks.length || market === 'ALL_COLORS'}
                onClick={() => update({ picks: [] })}
              >
                {translateUi('Clear')}
              </button>
            </div>
          </div>
          <div className="ls-slip">
            <div className="ls-slip-selection">
              <span>
                {ticket
                  ? translateUi('CONFIRMED SELECTION')
                  : translateUi('BET {slot} SELECTION', { slot: slot })}
              </span>
              <strong>
                {picks.length
                  ? luckySixSelectionLabel(market, picks, translateUi)
                  : translateUi('Choose your selection above')}
              </strong>
            </div>
            <div className="ls-stake-row">
              <div>
                <label htmlFor="ls-amount">
                  {market === 'ALL_COLORS'
                    ? translateUi('ETB per color line')
                    : translateUi('Bet amount · ETB')}
                </label>
                <div className="ls-stepper">
                  <button
                    aria-label={translateUi('Decrease amount')}
                    disabled={locked || amount <= 5}
                    onClick={() => update({ text: String(Math.max(5, amount - 5)) })}
                  >
                    −
                  </button>
                  <input
                    id="ls-amount"
                    inputMode="numeric"
                    autoComplete="off"
                    value={text}
                    disabled={locked}
                    onChange={(e) => update({ text: e.target.value })}
                  />
                  <button
                    aria-label={translateUi('Increase amount')}
                    disabled={locked || amount >= (market === 'ALL_COLORS' ? 60 : 500)}
                    onClick={() =>
                      update({
                        text: String(Math.min(market === 'ALL_COLORS' ? 60 : 500, amount + 5)),
                      })
                    }
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="ls-total">
                <span>{translateUi('Total bet')}</span>
                <strong>
                  {money(cost || 0)} <small>{'ETB'}</small>
                </strong>
              </div>
            </div>
            <p className="ls-return-note">
              {valid
                ? translateUi('{value}. Returns include stake.', {
                    value: scopeReturn(market, amount),
                  })
                : translateUi('Steps of 5 ETB · Up to 500 ETB per bet.')}
            </p>
            <button
              className="ls-primary"
              disabled={locked || !valid || cost > (data?.balance ?? 0)}
              onClick={() =>
                round && setReview({ roundId: round.id, slot, market, picks: [...picks], amount })
              }
            >
              {ticket
                ? translateUi('✓ Bet confirmed')
                : pending
                  ? translateUi('Checking confirmation…')
                  : !open
                    ? translateUi('Bets are closed')
                    : translateUi('Review bet · {value} ETB', { value: money(cost || 0) })}
            </button>
            {valid && !ticket && cost > (data?.balance ?? 0) && (
              <p className="ls-warning">{translateUi('Not enough practice ETB for this bet.')}</p>
            )}
            {ticket && complete && (
              <p className="ls-receipt-result" role="status">
                {ticket.payout === null
                  ? translateUi('Your return is being settled.')
                  : translateUi('{value} ETB returned · Bet {slot}', {
                      value: money(ticket.payout),
                      slot: ticket.slot,
                    })}
              </p>
            )}
          </div>
        </section>
      </div>
      {notice && (
        <p className="ls-notice" role="status">
          {translateUi(notice)}
        </p>
      )}
      {pending && !submitting && (
        <div className="ls-pending">
          <p>{translateUi('One bet is awaiting confirmation. Retry checks the same receipt.')}</p>
          <button onClick={onRetry} disabled={!connected || !!error}>
            {translateUi('Retry unconfirmed bet')}
          </button>
        </div>
      )}
      {!!tickets.length && (
        <section className="ls-saved" aria-label={translateUi('Saved bets')}>
          <header>
            <h2>{translateUi('Your bets this draw')}</h2>
            <span>
              {translateUi('{length} / {maxTickets} confirmed', {
                length: tickets.length,
                maxTickets: maxTickets,
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
                  <strong>{translateUi('{value} ETB', { value: money(t.stake) })}</strong>
                </span>
                <small>
                  {translateUi(LS_LABELS[t.market])} ·{' '}
                  {luckySixSelectionLabel(t.market, t.picks, translateUi)}
                </small>
                <em>
                  {complete
                    ? t.payout === null
                      ? translateUi('Return pending')
                      : translateUi('{value} ETB returned', { value: money(t.payout) })
                    : translateUi('Confirmed · waiting for results')}
                </em>
              </button>
            ))}
          </div>
        </section>
      )}
      <p className="ls-disclosure">
        {translateUi(
          "Practice ETB only · No deposits or redeemable prizes · Salem's original rules"
        )}
      </p>
      <Dialog.Root open={!!review} onOpenChange={(v) => !v && setReview(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="ls-overlay" />
          <Dialog.Content className="ls-dialog">
            <Dialog.Title>
              {translateUi('Confirm Bet {slot}', { slot: review?.slot ?? '' })}
            </Dialog.Title>
            <Dialog.Description>
              {translateUi('Review your practice selection. A confirmed bet cannot be changed.')}
            </Dialog.Description>
            {review && (
              <>
                <div className="ls-review-choice">
                  <span>{translateUi(LS_LABELS[review.market])}</span>
                  <strong>
                    {luckySixSelectionLabel(review.market, review.picks, translateUi)}
                  </strong>
                  <p>{translateUi(LS_DESCRIPTIONS[review.market])}</p>
                </div>
                <dl className="ls-review-totals">
                  <dt>{translateUi('Total bet')}</dt>
                  <dd>
                    {translateUi('{value} ETB', {
                      value: money(lsStake(review.market, review.amount)),
                    })}
                  </dd>
                  <dt>{translateUi('Return')}</dt>
                  <dd>{scopeReturn(review.market, review.amount)}</dd>
                </dl>
                <p>
                  {translateUi(
                    'Returns include the stake and settle after ball 35. Practice ETB has no cash value.'
                  )}
                </p>
                <button
                  className="ls-primary"
                  disabled={
                    !open ||
                    locked ||
                    review.roundId !== round?.id ||
                    lsStake(review.market, review.amount) > (data?.balance ?? 0)
                  }
                  onClick={() => {
                    onSubmit(review);
                    setReview(null);
                  }}
                >
                  {translateUi('Confirm practice bet')}
                </button>
              </>
            )}
            <Dialog.Close className="ls-secondary">{translateUi('Keep editing')}</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
function Rules() {
  const { t: translateUi } = useInterfaceLanguage();

  return (
    <Dialog.Root>
      <Dialog.Trigger className="ls-text-button">{translateUi('How to play ↗')}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="ls-overlay" />
        <Dialog.Content className="ls-dialog">
          <Dialog.Title>{translateUi('How to play Lucky Six')}</Dialog.Title>
          <Dialog.Description>
            {translateUi(
              "Salem's original practice rules. Choose your bets before the countdown closes."
            )}
          </Dialog.Description>
          <ol className="ls-rules-steps">
            <li>
              {translateUi(
                'New rounds begin every five minutes. You have 3 minutes 30 seconds to place bets.'
              )}
            </li>
            <li>
              {translateUi(
                'The server draws 35 different balls from 1–48, revealing one every two seconds. The first five are the pre-balls.'
              )}
            </li>
            <li>
              {translateUi(
                'Pick exactly six numbers for one amount. All six must appear; the position of your sixth match sets the return.'
              )}
            </li>
            <li>
              {translateUi(
                'Keep up to ten independent confirmed bets per draw. Each bet has its own selection and amount.'
              )}
            </li>
          </ol>
          <h3>{translateUi('Six-match returns')}</h3>
          <p>
            {translateUi(
              'Gross multiples of the amount, including the stake. Fewer than six matches returns zero.'
            )}
          </p>
          <div className="ls-payout-grid">
            {LS_SIX_TENTHS.map((mult, i) => (
              <div key={i} className={i === 29 ? 'last' : ''}>
                <span>{translateUi('Ball {value}', { value: i + 6 })}</span>
                <b>{(mult / 10).toLocaleString('en-US')}×</b>
              </div>
            ))}
          </div>
          <h3>{translateUi('Other bet types')}</h3>
          <table className="ls-rules-table">
            <thead>
              <tr>
                <th>{translateUi('Market')}</th>
                <th>{translateUi('Rule')}</th>
                <th>{translateUi('Gross return')}</th>
              </tr>
            </thead>
            <tbody>
              {LS_MARKETS.filter((m) => m !== 'SIX').map((m) => (
                <tr key={m}>
                  <td>{translateUi(LS_LABELS[m])}</td>
                  <td>{translateUi(LS_DESCRIPTIONS[m])}</td>
                  <td>
                    {lsFixedTenths(m) === null
                      ? translateUi('Six-match table per line')
                      : `${lsFixedTenths(m)! / 10}×`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {translateUi(
              'Colors repeat every eight numbers: Red 1, 9, 17, 25, 33, 41; Green 2, 10, 18, 26, 34, 42; and so on through Pink 8, 16, 24, 32, 40, 48. All colors buys all eight six-number lines in one ticket.'
            )}
          </p>
          <p>
            {translateUi(
              'Amount steps are 5 ETB, up to 500 ETB total per bet. All colors uses 5–60 ETB per line, costing 40–480 ETB total. Every return settles after the final ball.'
            )}
          </p>
          <p>
            {translateUi(
              'You start with 1,000 separate practice ETB. Six-number lines have a theoretical gross return of about 92.18%; other markets have different returns. A round may return zero. Most color refunds every bet on that market when two or more colors tie for the lead.'
            )}
          </p>
          <p>{translateUi('No jackpots, automatic repeat bets, deposits or redeemable prizes.')}</p>
          <Dialog.Close className="ls-primary">{translateUi('Got it')}</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
