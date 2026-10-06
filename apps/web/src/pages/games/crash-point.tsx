import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, ShieldCheck, Wifi, WifiOff, TrendingUp } from 'lucide-react';
import {
  CRASH_POINT_RULES as rules,
  crashMultiplier,
  crashCrossingMs,
  parseCrashEntry,
} from '@socialplay/shared';
import type {
  CrashPointSnapshot,
  CrashPointRound,
  CrashPointActivity,
  CrashPointLeaderboard,
} from '@socialplay/shared';
import { useAuth } from '@/providers/auth-provider';
import { useCasino } from '@/components/casino/CasinoProvider';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import './crash-point.css';
type Entry = { roundId: string; stake: number; autoCents: number | null; slot?: number };
const endpoint = '/games/crash-point';
const receiptKey = (id: string, slot = 1) =>
  `playqube.crash-point.pending.${id}${slot === 2 ? '.2' : ''}`;
export function readCrashReceipt(id: string, slot = 1): Entry | null {
  const raw = sessionStorage.getItem(receiptKey(id, slot));
  if (!raw) return null;
  const entry = JSON.parse(raw) as Entry;
  if (typeof entry.roundId !== 'string' || !entry.roundId || entry.roundId.length > 64)
    throw Error('Invalid saved ticket');
  if ((entry.slot ?? 1) !== slot) throw Error('Invalid saved slot');
  return {
    roundId: entry.roundId,
    ...parseCrashEntry(entry.stake, entry.autoCents),
    ...(slot === 2 ? { slot } : {}),
  };
}
export function CrashPointPage() {
  const { user } = useAuth();
  return user ? <CrashPoint key={user.id} userId={user.id} /> : null;
}
function CrashPoint({
  userId,
  slot = 1,
  controlsOnly = false,
}: {
  userId: string;
  slot?: number;
  controlsOnly?: boolean;
}) {
  const { coinsBalance, walletLoading, walletError } = useCasino();
  const [initial] = useState(() => {
    try {
      return { entry: readCrashReceipt(userId, slot), error: '' };
    } catch {
      return {
        entry: null,
        error: 'Browser storage could not be read. Restore storage and reload before entering.',
      };
    }
  });
  const [pending, setPending] = useState<Entry | null>(initial.entry),
    pendingRef = useRef(initial.entry);
  const [storageError, setStorageError] = useState(initial.error),
    [notice, setNotice] = useState(
      initial.entry
        ? 'Checking your saved ticket…'
        : 'Choose your amount. Confirm during the entry countdown.'
    );
  const [stakeText, setStakeText] = useState('25'),
    [auto, setAuto] = useState(true),
    [autoText, setAutoText] = useState('2.00');
  const [activityView, setActivityView] = useState<'current' | 'mine' | 'top'>('current');
  const [autoplay, setAutoplay] = useState<{
    remaining: number;
    stake: number;
    autoCents: number;
  } | null>(null);
  const autoplayRound = useRef('');
  const [clock, setClock] = useState(performance.now()),
    mounted = useRef(true);
  const query = useQuery({
    queryKey: ['crash-point', userId],
    queryFn: async ({ signal }) => {
      const sent = performance.now();
      const snapshot = unwrapData(
        await boundedRequest(
          (s) => api.get<CrashPointSnapshot>(endpoint, undefined, { signal: s }),
          signal
        )
      );
      return { snapshot, sent, received: performance.now() };
    },
    refetchInterval: 750,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    retry: false,
  });
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setClock(performance.now()), 50);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  const raw = query.data?.snapshot;
  const s = raw
      ? {
          ...raw,
          rounds: raw.rounds.map((r) => ({
            ...r,
            ticket: r.tickets
              ? (r.tickets.find((t) => t.slot === slot) ?? null)
              : slot === 1
                ? r.ticket
                : null,
          })),
        }
      : undefined,
    age = query.data ? Math.max(clock, performance.now()) - query.data.received : Infinity;
  const connected =
    !!s &&
    !query.isError &&
    !query.isPaused &&
    age < 3000 &&
    query.data!.received - query.data!.sent < 1200 &&
    s.rulesId === rules.id;
  const now = s ? s.serverTime + (connected ? age : Math.min(age, 3000)) : 0,
    round = s?.rounds.find((r) => r.opensAt <= now && now < r.endsAt),
    shown = round ?? s?.rounds[0];
  const open = connected && !!round && now < round.startsAt;
  const flying = !!round && now >= round.startsAt && round.crashCents === null;
  const cents = shown?.crashCents ?? (flying ? crashMultiplier(now - round!.startsAt) : 100);
  const remainingMs = round
    ? Math.max(0, (now < round.startsAt ? round.startsAt : round.endsAt) - now)
    : 0;
  const seconds = round
    ? Math.max(0, Math.ceil(((now < round.startsAt ? round.startsAt : round.endsAt) - now) / 1000))
    : 0;
  const ticket = round?.ticket;
  let input: { stake: number; autoCents: number | null } | null = null;
  try {
    if (/^\d+$/.test(stakeText) && (!auto || /^\d{1,2}(\.\d{1,2})?$/.test(autoText)))
      input = parseCrashEntry(Number(stakeText), auto ? Math.round(Number(autoText) * 100) : null);
  } catch {
    /* field feedback below */
  }
  function clearReceipt(entry: Entry) {
    if (!mounted.current || pendingRef.current !== entry) return;
    try {
      sessionStorage.removeItem(receiptKey(userId, slot));
      pendingRef.current = null;
      setPending(null);
      setStorageError('');
    } catch {
      setStorageError('Your ticket is on the server. Reload after restoring browser storage.');
    }
  }
  const entryMutation = useMutation({
    mutationFn: (entry: Entry) =>
      boundedRequest((signal) => api.post(`${endpoint}/tickets`, entry, undefined, { signal })),
    onSuccess: async (_data, entry) => {
      if (!mounted.current) return;
      clearReceipt(entry);
      setNotice('Ticket confirmed. Your amount and auto cash-out are locked.');
      await query.refetch();
    },
    onError: async (error, entry) => {
      if (!mounted.current) return;
      setAutoplay(null);
      const status = requestStatus(error);
      if ([400, 404, 409].includes(status ?? 0)) clearReceipt(entry);
      setNotice(
        status === 409
          ? 'Entry closed or a ticket already exists. Checking the server.'
          : status === 400
            ? 'Check your amount and practice balance.'
            : 'Confirmation interrupted. Retry the saved ticket; your amount will not be charged twice.'
      );
      await query.refetch();
    },
  });
  const cashout = useMutation({
    mutationFn: (roundId: string) =>
      boundedRequest((signal) =>
        api.post<{ payout: number; paidCents: number }>(
          `${endpoint}/cashout`,
          { roundId, ...(slot === 2 ? { slot } : {}) },
          undefined,
          { signal }
        )
      ),
    onSuccess: async (result) => {
      if (!mounted.current) return;
      const data = unwrapData(result);
      setNotice(
        data.payout > 0
          ? `Cash-out confirmed at ${(data.paidCents / 100).toFixed(2)}x · ${data.payout} credits returned.`
          : 'The round crashed before cash-out was accepted. No return for this ticket.'
      );
      await query.refetch();
    },
    onError: async () => {
      if (!mounted.current) return;
      setNotice(
        'Cash-out confirmation interrupted. Checking the saved server result. You may retry while the round is running.'
      );
      await query.refetch();
    },
  });
  useEffect(() => {
    const entry = pendingRef.current;
    if (!entry || !connected) return;
    const accepted = s?.rounds.find((r) => r.id === entry.roundId)?.ticket;
    if (accepted) {
      clearReceipt(entry);
      setNotice('Your saved ticket is confirmed by the server.');
    }
  }, [query.data, connected]);
  function submit(entry: Entry) {
    if (entryMutation.isPending || (pendingRef.current && pendingRef.current !== entry)) return;
    if (slot === 2) entry = { ...entry, slot };
    try {
      sessionStorage.setItem(receiptKey(userId, slot), JSON.stringify(entry));
      setStorageError('');
    } catch {
      setAutoplay(null);
      setStorageError('Enable browser storage before confirming. No ticket was sent.');
      return;
    }
    pendingRef.current = entry;
    setPending(entry);
    entryMutation.mutate(entry);
  }
  useEffect(() => {
    if (!autoplay) return;
    if (!connected || storageError || document.visibilityState === 'hidden') {
      setAutoplay(null);
      setNotice('Autoplay stopped. Confirmed tickets keep their server auto cash-out.');
      return;
    }
    if (
      !open ||
      !round ||
      ticket ||
      pending ||
      entryMutation.isPending ||
      autoplayRound.current === round.id
    )
      return;
    if (autoplay.stake > (s?.balance ?? 0)) {
      setAutoplay(null);
      setNotice('Autoplay stopped: not enough practice credits.');
      return;
    }
    autoplayRound.current = round.id;
    submit({ roundId: round.id, stake: autoplay.stake, autoCents: autoplay.autoCents });
    setAutoplay((plan) =>
      plan && plan.remaining > 1 ? { ...plan, remaining: plan.remaining - 1 } : null
    );
  }, [
    autoplay,
    connected,
    open,
    round?.id,
    ticket,
    pending,
    entryMutation.isPending,
    storageError,
    s?.balance,
  ]);
  useEffect(() => {
    const stop = () => {
      if (document.visibilityState === 'hidden') setAutoplay(null);
    };
    document.addEventListener('visibilitychange', stop);
    return () => document.removeEventListener('visibilitychange', stop);
  }, []);
  const locked = !open || !!ticket || !!pending || !!storageError || !!autoplay;
  const elapsed = shown
    ? shown.crashCents !== null
      ? crashCrossingMs(shown.crashCents)
      : flying
        ? Math.min(crashCrossingMs(2001), Math.max(0, now - shown.startsAt))
        : 0
    : 0;
  const timeRange = Math.max(10000, elapsed * 1.2);
  const valueRange =
    [2, 5, 10, 20, 25].find((value) => value >= Math.exp(elapsed / 10000) * 1.15) ?? 25;
  const progress = Math.min(1, elapsed / timeRange);
  const points = Array.from({ length: 61 }, (_, i) => {
    const t = (elapsed * i) / 60;
    return `${72 + (t / timeRange) * 650},${330 - ((Math.exp(t / 10000) - 1) / (valueRange - 1)) * 260}`;
  }).join(' ');
  const x = 72 + progress * 650,
    y = 330 - ((Math.exp(elapsed / 10000) - 1) / (valueRange - 1)) * 260;
  const result = shown?.ticket;
  const controls = (
    <aside className="crash-controls" aria-label={`Bet ${slot} controls`}>
      <div className="crash-practice">
        <div>
          <span>PRACTICE BALANCE</span>
          <strong>
            {s?.balance.toLocaleString() ?? '—'} <small>credits</small>
          </strong>
        </div>
        <ShieldCheck size={24} />
      </div>
      <p className="crash-credit-note">Free credits · no cash value</p>
      <h2>Bet {slot}</h2>
      <div className="crash-bet-fields">
        <div className="crash-stake-field">
          <label htmlFor={`crash-stake-${slot}`}>Bet amount</label>
          <div className="crash-input">
            <input
              id={`crash-stake-${slot}`}
              inputMode="numeric"
              value={ticket ? String(ticket.stake) : pending ? String(pending.stake) : stakeText}
              onChange={(e) => setStakeText(e.target.value)}
              disabled={locked}
            />
            <span>credits</span>
          </div>
          <div className="crash-presets">
            {[10, 25, 50, 100].map((v) => (
              <button key={v} disabled={locked} onClick={() => setStakeText(String(v))}>
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="crash-auto-field">
          <label className="crash-auto">
            <span>Auto cash-out</span>
            <input
              type="checkbox"
              checked={
                ticket ? ticket.autoCents !== null : pending ? pending.autoCents !== null : auto
              }
              disabled={locked}
              onChange={(e) => setAuto(e.target.checked)}
            />
          </label>
          <div className="crash-input">
            <input
              aria-label="Auto cash-out multiplier"
              inputMode="decimal"
              disabled={locked || !auto}
              value={
                ticket
                  ? ticket.autoCents === null
                    ? ''
                    : (ticket.autoCents / 100).toFixed(2)
                  : pending
                    ? pending.autoCents === null
                      ? ''
                      : (pending.autoCents / 100).toFixed(2)
                    : autoText
              }
              onChange={(e) => setAutoText(e.target.value)}
            />
            <span>×</span>
          </div>
          <p className="crash-field-help">10–500 credits · auto cash-out 1.01×–20.00×</p>
        </div>
        <div className="crash-submit-field">
          {ticket && ticket.payout === null && flying ? (
            <button
              className="crash-action cashout"
              disabled={!connected || cashout.isPending}
              onClick={() => cashout.mutate(round!.id)}
            >
              {cashout.isPending ? (
                'Confirming cash-out…'
              ) : (
                <>
                  Cash out <ArrowUpRight size={20} />
                </>
              )}
              <small>Server confirms your final multiplier</small>
            </button>
          ) : (
            <button
              className="crash-action"
              disabled={
                locked || !input || input.stake > (s?.balance ?? 0) || entryMutation.isPending
              }
              onClick={() => round && input && submit({ roundId: round.id, ...input })}
            >
              {ticket
                ? ticket.payout === null
                  ? 'Ticket confirmed'
                  : ticket.payout > 0
                    ? 'Cashed out'
                    : 'Round finished'
                : pending
                  ? 'Checking saved ticket…'
                  : open
                    ? 'Confirm ticket'
                    : 'Wait for next round'}
              <small>
                {ticket
                  ? ticket.payout === null
                    ? `${ticket.stake} credits locked`
                    : `${ticket.payout} credits returned`
                  : open
                    ? `${input?.stake ?? '—'} practice credits`
                    : `Next entry in ${seconds}s`}
              </small>
            </button>
          )}
        </div>
      </div>
      {pending && !entryMutation.isPending && (
        <button className="crash-retry" disabled={!connected} onClick={() => submit(pending)}>
          Retry saved ticket
        </button>
      )}
      {!input && !ticket && !pending && (
        <p role="alert" className="crash-error">
          Enter a whole stake and a valid auto cash-out target.
        </p>
      )}
      {input && input.stake > (s?.balance ?? Infinity) && !ticket && (
        <p role="alert" className="crash-error">
          Not enough practice credits.
        </p>
      )}
      {storageError && (
        <p role="alert" className="crash-error">
          {storageError}
        </p>
      )}
      <p className="crash-notice" aria-live="polite">
        {query.isError
          ? requestStatus(query.error) === 403
            ? 'Crash Point practice is unavailable.'
            : 'Connection interrupted. Entry and manual cash-out are paused until the server reconnects.'
          : notice}
      </p>
      {raw?.maxTickets === 2 && (
        <div className="crash-autoplay-controls">
          {autoplay ? (
            <button
              onClick={() => {
                setAutoplay(null);
                setNotice('Autoplay stopped. Already confirmed tickets remain active.');
              }}
            >
              Stop autoplay · {autoplay.remaining} entries left
            </button>
          ) : (
            <button
              disabled={
                !connected ||
                !!pending ||
                !!storageError ||
                !input?.autoCents ||
                (input?.stake ?? Infinity) > (s?.balance ?? 0)
              }
              onClick={() => {
                if (input?.autoCents) {
                  autoplayRound.current = '';
                  setAutoplay({ remaining: 10, stake: input.stake, autoCents: input.autoCents });
                }
              }}
            >
              Start autoplay · 10 rounds
            </button>
          )}
          <p>
            Uses this amount and auto target for up to 10 new entries. Stops on error,
            disconnection, hidden tab, or refresh. Stop does not cancel a confirmed ticket.
          </p>
        </div>
      )}
      <div className="crash-summary">
        <span>New round</span>
        <b>Every minute</b>
        <span>Entry window</span>
        <b>15 seconds</b>
        <span>Maximum cash-out</span>
        <b>20.00×</b>
      </div>
    </aside>
  );
  if (controlsOnly) return controls;
  return (
    <div className="crash-page">
      <nav className="crash-nav">
        <Link to="/casino">
          <ArrowLeft size={16} />
          Casino
        </Link>
        <span>PLAYQUBE ORIGINALS / CRASH POINT</span>
        <span className={connected ? 'online' : 'offline'}>
          {connected ? <Wifi size={15} /> : <WifiOff size={15} />}{' '}
          {connected ? 'Connected' : 'Connecting'}
        </span>
      </nav>
      <header className="crash-heading">
        <div>
          <p className="crash-kicker">THE RUBY GRAND COLLECTION</p>
          <h1>
            Crash <em>Point</em>
            <span>LIVE PRACTICE</span>
          </h1>
          <p>Follow the curve. Choose your moment.</p>
        </div>
        <div className="crash-wallet">
          <span>ACCOUNT BALANCE</span>
          <strong>
            {walletLoading
              ? 'Loading…'
              : walletError
                ? 'Unavailable'
                : `${coinsBalance.toLocaleString()} Coins`}
          </strong>
          <small>Free practice uses a separate balance</small>
        </div>
      </header>
      <div className="crash-layout">
        <div className="crash-table">
          <section className="crash-history">
            <div>
              <h2>Recent crash points</h2>
              <p>Previous rounds do not predict the next result.</p>
            </div>
            <div className="crash-history-row">
              {s?.rounds
                .filter((r) => r.crashCents !== null)
                .map((r) => (
                  <span key={r.id} className={r.crashCents! >= 200 ? 'high' : ''} title={r.id}>
                    {(r.crashCents! / 100).toFixed(2)}×
                  </span>
                ))}
              {!s?.rounds.some((r) => r.crashCents !== null) && (
                <p>Completed rounds will appear here.</p>
              )}
            </div>
          </section>

          <section
            className={`crash-arena ${shown?.crashCents !== null && shown?.crashCents !== undefined ? 'crashed' : ''}`}
            aria-label="Live multiplier graph"
          >
            <div className="crash-arena-top">
              <span>
                <i />
                {!connected
                  ? 'SYNCHRONIZING'
                  : open
                    ? 'ENTRY OPEN'
                    : flying
                      ? 'ROUND RUNNING'
                      : shown?.crashCents
                        ? 'ROUND COMPLETE'
                        : 'WAITING FOR ROUND'}
              </span>
              <span role="timer">
                {open ? 'Entry closes' : 'Next round'} <b>{String(seconds).padStart(2, '0')}s</b>
              </span>
            </div>
            <div className="crash-multiplier">
              <span>
                {shown?.crashCents
                  ? 'CRASH POINT'
                  : open
                    ? 'READY FOR THE RISE'
                    : 'LIVE MULTIPLIER'}
              </span>
              <strong>
                {open ? (remainingMs / 1000).toFixed(1) : (cents / 100).toFixed(2)}
                <em>{open ? 's' : '×'}</em>
              </strong>
              <p>
                {!connected
                  ? 'Waiting for a fresh server update'
                  : open
                    ? 'Confirm your ticket before the round starts'
                    : shown?.crashCents
                      ? 'The server has revealed this round’s result'
                      : 'Cash out before the curve stops'}
              </p>
            </div>
            {open && (
              <div className="crash-countdown-track" aria-hidden="true">
                <div
                  style={{ width: `${Math.min(100, (remainingMs / rules.bettingMs) * 100)}%` }}
                />
              </div>
            )}
            <div className="crash-graph-shell" aria-hidden="true">
              <div className="crash-floor" />
              <svg className="crash-graph" viewBox="0 0 800 390">
                <defs>
                  <linearGradient id="crash-line">
                    <stop stopColor="#b73e65" />
                    <stop offset="1" stopColor="#f3d2b0" />
                  </linearGradient>
                  <linearGradient id="crash-area" x1="0" y1="0" x2="0" y2="1">
                    <stop stopColor="#cf5475" stopOpacity=".28" />
                    <stop offset="1" stopColor="#cf5475" stopOpacity="0" />
                  </linearGradient>
                  <filter id="crash-glow">
                    <feGaussianBlur stdDeviation="6" />
                  </filter>
                </defs>
                {[4, 3, 2, 1, 0].map((index) => {
                  const value = 1 + ((valueRange - 1) * index) / 4;
                  const v = 330 - (index / 4) * 260;
                  return (
                    <g key={v}>
                      <path d={`M72 ${v}H745`} className="grid" />
                      <text x="15" y={v + 5}>
                        {Number(value.toFixed(2))}×
                      </text>
                    </g>
                  );
                })}
                {[72, 235, 397, 560, 722].map((v, i) => (
                  <g key={v}>
                    <path d={`M${v} 60V330`} className="grid" />
                    <text x={v - 8} y="365">
                      {Math.round((i * timeRange) / 4000)}s
                    </text>
                  </g>
                ))}
                <polygon points={`72,330 ${points} ${x},330`} fill="url(#crash-area)" />
                <polyline points={points} className="curve depth" transform="translate(0 9)" />
                <polyline points={points} className="curve glow" filter="url(#crash-glow)" />
                <polyline points={points} className="curve" />
                <circle cx={x} cy={y} r="12" fill="#733147" />
                <circle
                  cx={x}
                  cy={y}
                  r="6"
                  fill="#ffe0c3"
                  className={flying && connected ? 'crash-beacon' : ''}
                />
              </svg>
            </div>
            <div className="crash-result" role="status">
              {result?.payout !== null && result?.payout !== undefined ? (
                <>
                  <ShieldCheck size={18} />
                  {result.payout > 0
                    ? `Confirmed return · ${result.payout} credits at ${(result.paidCents! / 100).toFixed(2)}x`
                    : 'Round finished · no return for this ticket'}
                </>
              ) : (
                <>
                  <TrendingUp size={18} />
                  {ticket
                    ? ticket.autoCents !== null
                      ? 'Your ticket is live · auto cash-out stays active when you disconnect'
                      : 'Your ticket is live · manual cash-out requires a connection'
                    : 'One shared round · one server-controlled result'}
                </>
              )}
            </div>
          </section>
          <div className="crash-dual-controls">
            {controls}
            {raw?.maxTickets === 2 && <CrashPoint userId={userId} slot={2} controlsOnly />}
          </div>
        </div>
        <aside className="crash-activity" aria-label="Your round activity">
          <div className="crash-activity-tabs" role="group" aria-label="Activity view">
            {(
              [
                ['current', 'Current round'],
                ['mine', 'My bets'],
                ['top', 'Top · 24h'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                aria-pressed={activityView === key}
                onClick={() => setActivityView(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="crash-activity-caption">Your practice activity · latest 12 rounds</p>
          {activityView === 'current' ? (
            <>
              <PublicActivity
                current={shown}
                previous={s?.rounds.find((r) => shown && r.opensAt < shown.opensAt)}
                userId={userId}
              />
              <h2>Your current round</h2>
              <dl className="crash-round-info">
                <dt>Round</dt>
                <dd>{shown?.id ?? 'Connecting…'}</dd>
                <dt>Status</dt>
                <dd>
                  {!connected
                    ? 'Reconnecting'
                    : open
                      ? 'Entry open'
                      : flying
                        ? 'Running'
                        : 'Complete'}
                </dd>
                <dt>Your stake</dt>
                <dd>{ticket ? `${ticket.stake} credits` : 'No ticket'}</dd>
                <dt>Auto cash-out</dt>
                <dd>{ticket?.autoCents ? `${(ticket.autoCents / 100).toFixed(2)}×` : 'Not set'}</dd>
              </dl>
              {shown && (
                <div className="crash-commitment">
                  <h3>Round commitment</h3>
                  <code>{shown.commitment}</code>
                  <p>
                    {shown.seed
                      ? 'Result revealed. Verify it in the round details below.'
                      : 'Published before entry closes. The seed stays hidden until the crash.'}
                  </p>
                </div>
              )}
              <p className="crash-activity-empty">
                Up to two independent tickets per round. Each bet has its own cash-out and autoplay
                controls.
              </p>
            </>
          ) : activityView === 'top' ? (
            <PublicLeaderboard userId={userId} />
          ) : (
            <>
              <h2>{'My recent tickets'}</h2>
              <div className="crash-ticket-table">
                <table>
                  <caption className="sr-only">
                    Your tickets from the latest 12 rounds, amounts in practice credits
                  </caption>
                  <thead>
                    <tr>
                      <th>Round</th>
                      <th>Stake</th>
                      <th>Cash-out</th>
                      <th>Return</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      raw?.rounds.flatMap((r) =>
                        (r.tickets ?? (r.ticket ? [{ ...r.ticket, slot: 1 }] : [])).map((t) => ({
                          ...r,
                          id: `${r.id}:${t.slot}`,
                          ticket: t,
                        }))
                      ) ?? []
                    )
                      .filter((r) => r.ticket)
                      .sort((a, b) => b.opensAt - a.opensAt)
                      .map((r) => (
                        <tr key={r.id}>
                          <td title={r.id}>
                            {new Date(r.opensAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                          <td>{r.ticket!.stake}</td>
                          <td>
                            {r.ticket!.payout === null
                              ? 'Pending'
                              : r.ticket!.paidCents
                                ? `${(r.ticket!.paidCents / 100).toFixed(2)}×`
                                : '—'}
                          </td>
                          <td>{r.ticket!.payout === null ? 'Pending' : r.ticket!.payout}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {!(
                raw?.rounds.flatMap((r) =>
                  (r.tickets ?? (r.ticket ? [{ ...r.ticket, slot: 1 }] : [])).map((t) => ({
                    ...r,
                    id: `${r.id}:${t.slot}`,
                    ticket: t,
                  }))
                ) ?? []
              ).some((r) => r.ticket && true) && (
                <p className="crash-activity-empty">{'No tickets in the latest 12 rounds.'}</p>
              )}
            </>
          )}
          <div className="crash-activity-foot">
            <ShieldCheck size={17} /> Server-confirmed data · practice credits only
          </div>
        </aside>
      </div>
      <section className="crash-guide">
        <article>
          <span>01</span>
          <h3>Make your entry</h3>
          <p>Confirm once during the countdown. Your ticket stays saved after refresh.</p>
        </article>
        <article>
          <span>02</span>
          <h3>Choose your moment</h3>
          <p>Cash out during the rise, or set an automatic target before the round starts.</p>
        </article>
        <article>
          <span>03</span>
          <h3>Get a confirmed result</h3>
          <p>Returns include your stake. The server credits the result once.</p>
        </article>
      </section>
      <details className="crash-rules">
        <summary>Rules, timing and round verification</summary>
        <p>
          Practice starts with 1,000 nonredeemable credits, separate from Coins and Game Points. No
          purchases, gifts, transfers or withdrawals. Confirm up to two immutable tickets per round.
          Auto cash-out is handled by the server and survives disconnects.
        </p>
        <p>
          Manual cash-out is accepted at server processing time, after locks are acquired. At or
          after the crash cutoff it loses. Displayed multipliers are estimates between updates; only
          a server-confirmed receipt is a return. A round can crash immediately at 1.00×. Cash-out
          is capped at 20.00×, with a terminal crash at 20.01×.
        </p>
        <p>
          The target gross return for a fixed auto cash-out is approximately 90%, before
          whole-credit rounding. It is a long-run mathematical expectation, not a promise for a
          session. Manual timing and rounding affect returns. There is no additional practice fee or
          PVP mode.
        </p>
        <p>
          Each round publishes a SHA-256 commitment before entry and reveals its seed after the
          crash. This checks that the revealed seed matches the earlier commitment; it is not an
          independent RNG certification.
        </p>
        {s?.rounds
          .filter((r) => r.seed)
          .slice(0, 3)
          .map((r) => (
            <RoundProof key={r.id} round={r} />
          ))}
      </details>
    </div>
  );
}
function RoundProof({ round }: { round: CrashPointRound }) {
  const [status, setStatus] = useState('');
  async function verify() {
    try {
      const hex = (bytes: ArrayBuffer) =>
        Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${round.id}:${round.seed}`)
      );
      let draw = 0;
      for (let counter = 0; !draw; counter++) {
        const hash = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(`${round.seed}:${counter}`)
        );
        const n = new DataView(hash).getUint32(0);
        if (n < 4000000000) draw = (n % 1000000000) + 1;
      }
      setStatus(
        hex(digest) === round.commitment &&
          Math.min(2001, Math.max(100, Math.ceil(90000000000 / draw))) === round.crashCents
          ? 'Commitment and crash point verified'
          : 'Verification failed'
      );
    } catch {
      setStatus('Verification unavailable in this browser');
    }
  }
  return (
    <div className="crash-proof">
      <strong>{round.id}</strong>
      <span>Commitment: {round.commitment}</span>
      <span>Revealed seed: {round.seed}</span>
      <button onClick={verify}>Verify round</button>
      <p role="status">{status}</p>
    </div>
  );
}

function PublicActivity({
  current,
  previous,
  userId,
}: {
  current?: CrashPointRound;
  previous?: CrashPointRound;
  userId: string;
}) {
  const [previousSelected, setPreviousSelected] = useState(false);
  const selected = previousSelected ? previous : current;
  const feed = useQuery({
    queryKey: ['crash-point-activity', userId, selected?.id],
    enabled: !!selected,
    queryFn: async ({ signal }) =>
      unwrapData(
        await boundedRequest(
          (s) =>
            api.get<CrashPointActivity>(
              `${endpoint}/activity`,
              { roundId: selected!.id },
              { signal: s }
            ),
          signal
        )
      ),
    refetchInterval: 3000,
    retry: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  return (
    <section className="crash-public-activity" aria-label="Public practice tickets">
      <div className="crash-feed-heading">
        <strong>{previousSelected ? 'Previous round' : 'Current round'} tickets</strong>
        <button
          aria-pressed={previousSelected}
          disabled={!previous}
          onClick={() => setPreviousSelected((v) => !v)}
        >
          {previousSelected ? 'Back to current' : 'Previous round'}
        </button>
      </div>
      <p className="crash-activity-caption">
        {selected?.id ?? 'Waiting for round'} · anonymous practice players
      </p>
      {feed.isError ? (
        <p role="status">Activity unavailable. Reconnecting…</p>
      ) : feed.isPending ? (
        <p role="status">Loading activity…</p>
      ) : (
        <>
          <p>
            Total tickets: <strong>{feed.data.totalTickets}</strong>
          </p>
          {feed.data.tickets.length ? (
            <div className="crash-ticket-table">
              <table>
                <caption className="sr-only">
                  Public practice tickets for {feed.data.roundId}
                </caption>
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Stake</th>
                    <th>Cash-out</th>
                    <th>Return</th>
                  </tr>
                </thead>
                <tbody>
                  {feed.data.tickets.map((t) => (
                    <tr key={t.player}>
                      <td>{t.player}</td>
                      <td>{t.stake}</td>
                      <td>
                        {t.payout === null
                          ? 'Pending'
                          : t.paidCents
                            ? `${(t.paidCents / 100).toFixed(2)}×`
                            : '—'}
                      </td>
                      <td>{t.payout === null ? 'Pending' : t.payout}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="crash-activity-empty">No tickets in this round.</p>
          )}
          {feed.data.totalTickets > feed.data.tickets.length && (
            <p>
              Showing {feed.data.tickets.length} of {feed.data.totalTickets} tickets.
            </p>
          )}
        </>
      )}
      <p className="crash-activity-caption">
        Returns appear only after server settlement. Amounts are practice credits.
      </p>
    </section>
  );
}

function PublicLeaderboard({ userId }: { userId: string }) {
  const feed = useQuery({
    queryKey: ['crash-point-leaderboard', userId],
    queryFn: async ({ signal }) =>
      unwrapData(
        await boundedRequest(
          (s) =>
            api.get<CrashPointLeaderboard>(`${endpoint}/leaderboard`, undefined, { signal: s }),
          signal
        )
      ),
    refetchInterval: 10000,
    retry: false,
  });
  return (
    <section aria-label="Public top returns">
      <h2>Top returns · last 24 hours</h2>
      <p className="crash-activity-caption">
        Highest confirmed ticket returns · practice credits · includes stake
      </p>
      {feed.isError ? (
        <p role="status">Leaderboard unavailable. Reconnecting…</p>
      ) : feed.isPending ? (
        <p role="status">Loading leaderboard…</p>
      ) : feed.data.tickets.length ? (
        <div className="crash-ticket-table">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Stake</th>
                <th>Cash-out</th>
                <th>Return</th>
              </tr>
            </thead>
            <tbody>
              {feed.data.tickets.map((t) => (
                <tr key={`${t.roundId}:${t.player}`}>
                  <td>{t.player}</td>
                  <td>{t.stake}</td>
                  <td>{(t.paidCents / 100).toFixed(2)}×</td>
                  <td>{t.payout}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="crash-activity-empty">No confirmed returns in the last 24 hours.</p>
      )}
    </section>
  );
}
