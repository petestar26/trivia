import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUpRight,
  History,
  Minus,
  Plus,
  ShieldCheck,
  Wifi,
  WifiOff,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  SKY_CRASH_RULES as rules,
  skyCrashMultiplier,
  skyCrashCrossingMs,
  parseSkyCrashEntry,
} from '@socialplay/shared';
import type {
  SkyCrashSnapshot,
  SkyCrashRound,
  SkyCrashActivity,
  SkyCrashLeaderboard,
} from '@socialplay/shared';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import './sky-crash.css';
type Entry = { roundId: string; stake: number; autoCents: number | null; slot?: number };
const endpoint = '/games/sky-crash';
const receiptKey = (id: string, slot = 1) =>
  `playqube.sky-crash.pending.${id}${slot === 2 ? '.2' : ''}`;
export function readSkyCrashReceipt(id: string, slot = 1): Entry | null {
  const raw = sessionStorage.getItem(receiptKey(id, slot));
  if (!raw) return null;
  const entry = JSON.parse(raw) as Entry;
  if (typeof entry.roundId !== 'string' || !entry.roundId || entry.roundId.length > 64)
    throw Error('Invalid saved ticket');
  if ((entry.slot ?? 1) !== slot) throw Error('Invalid saved slot');
  return {
    roundId: entry.roundId,
    ...parseSkyCrashEntry(entry.stake, entry.autoCents),
    ...(slot === 2 ? { slot } : {}),
  };
}
export function SkyCrashPage() {
  const { user } = useAuth();
  return user ? <SkyCrash key={user.id} userId={user.id} /> : null;
}
function SkyCrash({
  userId,
  slot = 1,
  controlsOnly = false,
}: {
  userId: string;
  slot?: number;
  controlsOnly?: boolean;
}) {
  const betHeading = useRef<HTMLHeadingElement>(null);
  const [initial] = useState(() => {
    try {
      return { entry: readSkyCrashReceipt(userId, slot), error: '' };
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
    queryKey: ['sky-crash', userId],
    queryFn: async ({ signal }) => {
      const sent = performance.now();
      const snapshot = unwrapData(
        await boundedRequest(
          (s) => api.get<SkyCrashSnapshot>(endpoint, undefined, { signal: s }),
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
  const cents = shown?.crashCents ?? (flying ? skyCrashMultiplier(now - round!.startsAt) : 100);
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
      input = parseSkyCrashEntry(
        Number(stakeText),
        auto ? Math.round(Number(autoText) * 100) : null
      );
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
  // Draft choices remain available between rounds; admission still requires an open window.
  const locked = !connected || !!ticket || !!pending || !!storageError || !!autoplay;
  const elapsed = shown
    ? shown.crashCents !== null
      ? skyCrashCrossingMs(shown.crashCents)
      : flying
        ? Math.min(skyCrashCrossingMs(2001), Math.max(0, now - shown.startsAt))
        : 0
    : 0;
  const timeRange = Math.max(10000, elapsed * 1.2);
  const valueRange =
    [2, 5, 10, 20, 25].find((value) => value >= Math.exp(elapsed / 10000) * 1.15) ?? 25;
  const progress = Math.min(1, elapsed / timeRange);
  const points = Array.from({ length: 61 }, (_, i) => {
    const t = (elapsed * i) / 60;
    return `${72 + (t / timeRange) * 560},${330 - ((Math.exp(t / 10000) - 1) / (valueRange - 1)) * 260}`;
  }).join(' ');
  const x = 72 + progress * 560,
    y = 330 - ((Math.exp(elapsed / 10000) - 1) / (valueRange - 1)) * 260;
  const arrowAngle =
    (-Math.atan2(
      (Math.exp(elapsed / rules.growthMs) * 260) / (rules.growthMs * (valueRange - 1)),
      560 / timeRange
    ) *
      180) /
    Math.PI;
  const draftStake =
    /^\d+$/.test(stakeText) &&
    Number.isSafeInteger(Number(stakeText)) &&
    Number(stakeText) >= rules.minStake &&
    Number(stakeText) <= rules.maxStake
      ? Number(stakeText)
      : null;
  const draftStakeLimit = Math.min(rules.maxStake, s?.balance ?? 0);
  const result = shown?.ticket;
  // Only the server's revealed result ends the flight, never the local clock.
  const crashed = shown?.crashCents != null;
  const shownTickets = shown?.tickets ?? (shown?.ticket ? [{ ...shown.ticket, slot: 1 }] : []);
  const controls = (
    <aside className="sky-controls" aria-label={`Bet ${slot} controls`}>
      <div className="sky-ticket-header">
        <div>
          <span>YOUR TICKET</span>
          <h2>Bet {slot}</h2>
        </div>
        <span className="sky-ticket-state">
          {ticket
            ? ticket.payout === null
              ? 'Confirmed'
              : 'Complete'
            : pending
              ? 'Checking ticket'
              : open
                ? 'Entry open'
                : 'Next round'}
        </span>
      </div>
      <div className="sky-bet-fields">
        <div className="sky-auto-field">
          <label className="sky-auto">
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
          <div className="sky-input">
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
          <details className="sky-target-options">
            <summary>Quick targets</summary>
            <div
              className="sky-presets sky-targets"
              role="group"
              aria-label="Auto cash-out targets"
            >
              {[1.5, 2, 3, 5].map((target) => (
                <button
                  key={target}
                  disabled={locked}
                  aria-pressed={
                    (ticket
                      ? ticket.autoCents
                      : pending
                        ? pending.autoCents
                        : auto
                          ? Math.round(Number(autoText) * 100)
                          : null) ===
                    target * 100
                  }
                  onClick={() => {
                    setAuto(true);
                    setAutoText(target.toFixed(2));
                  }}
                >
                  {target.toFixed(2)}×
                </button>
              ))}
            </div>
          </details>
          <p className="sky-field-help">Set your automatic cash-out target. 1.01×–20.00×.</p>
        </div>
        <div className="sky-stake-field">
          <label htmlFor={`sky-stake-${slot}`}>Bet amount</label>
          <div className="sky-input sky-stake-adjustment">
            <button
              type="button"
              className="sky-amount-adjust"
              aria-label="Decrease bet amount"
              disabled={locked || draftStake === null || draftStake <= rules.minStake}
              onClick={() => {
                if (!locked && draftStake !== null)
                  setStakeText(String(Math.max(rules.minStake, draftStake - 5)));
              }}
            >
              <Minus size={18} />
            </button>
            <input
              id={`sky-stake-${slot}`}
              inputMode="numeric"
              value={ticket ? String(ticket.stake) : pending ? String(pending.stake) : stakeText}
              onChange={(e) => setStakeText(e.target.value)}
              disabled={locked}
            />
            <span>credits</span>
            <button
              type="button"
              className="sky-amount-adjust"
              aria-label="Increase bet amount"
              disabled={locked || draftStake === null || draftStake >= draftStakeLimit}
              onClick={() => {
                if (!locked && draftStake !== null)
                  setStakeText(String(Math.min(draftStakeLimit, draftStake + 5)));
              }}
            >
              <Plus size={18} />
            </button>
          </div>
        </div>
        <div className="sky-submit-field">
          {ticket && ticket.payout === null && flying ? (
            <button
              className="sky-action cashout"
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
              className="sky-action"
              disabled={
                !open ||
                locked ||
                !input ||
                input.stake > (s?.balance ?? 0) ||
                entryMutation.isPending
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
        <div
          className="sky-presets sky-amount-presets"
          role="group"
          aria-label="Bet amount presets"
        >
          {[10, 25, 50, 100].map((v) => (
            <button
              key={v}
              disabled={locked}
              aria-pressed={
                Number(ticket ? ticket.stake : pending ? pending.stake : stakeText) === v
              }
              onClick={() => setStakeText(String(v))}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      {pending && !entryMutation.isPending && (
        <button className="sky-retry" disabled={!connected} onClick={() => submit(pending)}>
          Retry saved ticket
        </button>
      )}
      {!input && !ticket && !pending && (
        <p role="alert" className="sky-error">
          Enter a whole stake and a valid auto cash-out target.
        </p>
      )}
      {input && input.stake > (s?.balance ?? Infinity) && !ticket && (
        <p role="alert" className="sky-error">
          Not enough practice credits.
        </p>
      )}
      {storageError && (
        <p role="alert" className="sky-error">
          {storageError}
        </p>
      )}
      <p className="sky-notice" aria-live="polite">
        {query.isError
          ? requestStatus(query.error) === 403
            ? 'Sky Crash practice is unavailable.'
            : 'Connection interrupted. Entry and manual cash-out are paused until the server reconnects.'
          : notice}
      </p>
      {raw?.maxTickets === 2 && (
        <div className="sky-autoplay-controls">
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
                !!ticket ||
                !!pending ||
                !!storageError ||
                !input?.autoCents ||
                (input?.stake ?? Infinity) > (s?.balance ?? 0)
              }
              onClick={() => {
                if (!ticket && input?.autoCents) {
                  autoplayRound.current = '';
                  setAutoplay({ remaining: 10, stake: input.stake, autoCents: input.autoCents });
                }
              }}
            >
              Start autoplay · 10 rounds
            </button>
          )}
          <details className="sky-autoplay-info">
            <summary>Rules</summary>
            <p>
              Up to 10 entries using this amount and target. Start before confirming a ticket. Stops
              on error, disconnection, hidden tab or refresh. Confirmed tickets stay active.
            </p>
          </details>
        </div>
      )}
    </aside>
  );
  if (controlsOnly) return controls;
  return (
    <div className="sky-page sky-reference">
      <nav className="sky-nav">
        <Link to="/casino">
          <ArrowLeft size={16} />
          Casino
        </Link>
        <span>PLAYQUBE ORIGINALS / SKY CRASH</span>
        <span className={connected ? 'online' : 'offline'}>
          {connected ? <Wifi size={15} /> : <WifiOff size={15} />}{' '}
          {connected ? 'Connected' : 'Connecting'}
        </span>
      </nav>
      <header className="sky-heading">
        <div>
          <p className="sky-kicker">THE FLIGHT COLLECTION</p>
          <h1>
            Sky <em>Crash</em>
            <span>LIVE PRACTICE</span>
          </h1>
          <p>Above the clouds. Choose your moment.</p>
        </div>
        <div className="sky-heading-actions">
          <div className="sky-wallet">
            <span>PRACTICE BALANCE</span>
            <strong>{s ? `${s.balance.toLocaleString()} credits` : 'Connecting…'}</strong>
            <small>Free credits · no cash value</small>
          </div>
          <div className="sky-bet-navigation">
            <a
              href="#sky-betting"
              onClick={(event) => {
                event.preventDefault();
                betHeading.current?.scrollIntoView({ block: 'start' });
                betHeading.current?.focus({ preventScroll: true });
              }}
            >
              Choose your bet <ArrowDown size={16} />
            </a>
          </div>
        </div>
      </header>
      <div className="sky-layout">
        <div className="sky-table">
          <RoundHistory rounds={raw?.rounds ?? []} />
          <section
            className={`sky-arena ${crashed ? 'crashed' : ''}`}
            aria-label="Live flight arena"
          >
            <div className="sky-arena-top">
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
            <div className="sky-multiplier">
              <span>
                {shown?.crashCents ? 'CRASHED' : open ? 'READY FOR THE RISE' : 'LIVE MULTIPLIER'}
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
              <div className="sky-countdown-track" aria-hidden="true">
                <div
                  style={{ width: `${Math.min(100, (remainingMs / rules.bettingMs) * 100)}%` }}
                />
              </div>
            )}
            <div className="sky-graph-shell" aria-hidden="true">
              <svg className="sky-graph" viewBox="0 0 800 390">
                <defs>
                  <linearGradient id="sky-line">
                    <stop stopColor="#c77b38" />
                    <stop offset="0.55" stopColor="#e8b26b" />
                    <stop offset="1" stopColor="#ffe4b1" />
                  </linearGradient>
                  <linearGradient id="sky-area" x1="0" y1="0" x2="0" y2="1">
                    <stop stopColor="#f4bd77" stopOpacity=".28" />
                    <stop offset="1" stopColor="#f4bd77" stopOpacity="0" />
                  </linearGradient>
                  <filter id="sky-glow">
                    <feGaussianBlur stdDeviation="6" />
                  </filter>
                </defs>
                {[4, 3, 2, 1, 0].map((index) => {
                  const value = 1 + ((valueRange - 1) * index) / 4;
                  const v = 330 - (index / 4) * 260;
                  return (
                    <g key={v}>
                      <path d={`M72 ${v}H745`} className="grid" />
                      <text x="790" y={v + 5} textAnchor="end">
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
                <polygon points={`72,330 ${points} ${x},330`} fill="url(#sky-area)" />
                <polyline points={points} className="curve depth" transform="translate(0 9)" />
                <polyline points={points} className="curve glow" filter="url(#sky-glow)" />
                <polyline points={points} className="curve" />
                <g key={shown?.id ?? 'waiting'} transform={`translate(${x} ${y})`}>
                  <g className={crashed ? 'sky-impact-plane' : undefined}>
                    <g transform={`rotate(${Math.max(-18, arrowAngle)})`}>
                      <image
                        className={flying && connected ? 'sky-aircraft flying' : 'sky-aircraft'}
                        href="/images/sky-crash/aircraft.webp"
                        x="-63"
                        y="-47"
                        width="126"
                        height="84"
                      />
                    </g>
                  </g>
                  {crashed && (
                    <g className="sky-impact" data-testid="sky-crash-impact">
                      <g className="sky-impact-smoke" fill="#526071">
                        <circle cx="-8" cy="-26" r="17" />
                        <circle cx="12" cy="-40" r="22" />
                        <circle cx="-9" cy="-59" r="18" />
                      </g>
                      <ellipse className="sky-impact-halo" cy="4" rx="47" ry="30" fill="#fb8129" />
                      <g className="sky-impact-flames">
                        <path
                          fill="#ee6028"
                          d="M-27 18C-45-1-19-13-25-35C-10-28-13-11-4-16C4-26-6-43 8-56C5-26 33-24 25-8C41-15 32 13 22 21C8 30-12 30-27 18Z"
                        />
                        <path
                          fill="#ffb64d"
                          d="M-18 18C-28 5-8-3-13-18C0-12-2-4 5-10C13-19 5-28 13-34C12-14 27 1 19 15C12 26-8 28-18 18Z"
                        />
                        <path
                          fill="#fff0b2"
                          d="M-9 18C-15 7 2 4 0-9C14 1 17 16 8 22C2 25-5 24-9 18Z"
                        />
                      </g>
                      <g className="sky-impact-embers" fill="#ffc270">
                        <circle cx="-35" cy="-20" r="2" />
                        <circle cx="30" cy="-32" r="2.5" />
                        <circle cx="-20" cy="-51" r="2" />
                        <circle cx="24" cy="-65" r="1.5" />
                      </g>
                    </g>
                  )}
                </g>
              </svg>
            </div>
            <div className="sky-result" role="status">
              <div className="sky-result-heading">
                <ShieldCheck size={18} />
                <span>
                  {shown?.crashCents != null ? 'ROUND RESULT' : 'YOUR FLIGHT'}
                  <small>Practice credits · no cash value</small>
                </span>
              </div>
              <div className="sky-result-content">
                {raw?.maxTickets === 2 && shownTickets.length > 0 ? (
                  <div className="sky-slot-results">
                    {shownTickets.map((t) => (
                      <span
                        className={`sky-result-card ${t.payout === null ? 'pending' : t.payout > 0 ? 'returned' : 'finished'}`}
                        key={t.slot}
                        role="group"
                        aria-label={`Bet ${t.slot} result`}
                      >
                        <span>
                          BET {t.slot} ·{' '}
                          {t.payout === null
                            ? 'CONFIRMED'
                            : t.payout > 0
                              ? 'CASHED OUT'
                              : 'FINISHED'}
                        </span>
                        <strong>
                          {t.payout === null
                            ? `${t.stake} credits in play`
                            : `${t.payout} credits returned`}
                        </strong>
                        <small>
                          {t.payout === null
                            ? t.autoCents === null
                              ? 'Manual cash-out requires a connection'
                              : `Auto cash-out at ${(t.autoCents / 100).toFixed(2)}× remains active`
                            : t.payout > 0
                              ? `Confirmed at ${((t.paidCents ?? 0) / 100).toFixed(2)}× · includes stake`
                              : 'No return for this ticket'}
                        </small>
                      </span>
                    ))}
                  </div>
                ) : result?.payout !== null && result?.payout !== undefined ? (
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
            </div>
          </section>
          <section id="sky-betting" className="sky-betting" aria-labelledby="sky-betting-title">
            <div className="sky-betting-heading">
              <div>
                <h2 id="sky-betting-title" tabIndex={-1} ref={betHeading}>
                  Choose your bet
                </h2>
                <p>
                  {raw?.maxTickets === 2 ? 'Up to two tickets' : 'One ticket'} per round · Confirm
                  during the 15-second entry window.
                </p>
              </div>
              <span>Practice credits</span>
            </div>
            <div className="sky-dual-controls">
              {controls}
              {raw?.maxTickets === 2 && <SkyCrash userId={userId} slot={2} controlsOnly />}
            </div>
          </section>
        </div>
        <aside className="sky-activity" aria-label="Your round activity">
          <div className="sky-activity-tabs" role="group" aria-label="Activity view">
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
          <p className="sky-activity-caption">
            {activityView === 'top'
              ? 'Public practice returns · last 24 hours'
              : 'Your practice activity · latest 12 rounds'}
          </p>
          {activityView === 'current' ? (
            <>
              <PublicActivity
                current={shown}
                previous={s?.rounds.find((r) => shown && r.opensAt < shown.opensAt)}
                userId={userId}
              />
              <h2>Your current round</h2>
              <dl className="sky-round-info">
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
                <dt>Total stake</dt>
                <dd>
                  {shownTickets.length
                    ? `${shownTickets.reduce((total, t) => total + t.stake, 0)} credits`
                    : 'No tickets'}
                </dd>
              </dl>
              {shownTickets.map((t) => (
                <section
                  className="sky-ticket-summary"
                  key={t.slot}
                  aria-label={`Bet ${t.slot} receipt`}
                >
                  <h3>Bet {t.slot}</h3>
                  <dl className="sky-round-info">
                    <dt>Stake</dt>
                    <dd>{t.stake} credits</dd>
                    <dt>Auto cash-out</dt>
                    <dd>{t.autoCents ? `${(t.autoCents / 100).toFixed(2)}×` : 'Manual only'}</dd>
                    <dt>Return</dt>
                    <dd>{t.payout === null ? 'Pending' : `${t.payout} credits`}</dd>
                  </dl>
                </section>
              ))}

              {shown && (
                <div className="sky-commitment">
                  <h3>Round commitment</h3>
                  <code>{shown.commitment}</code>
                  <p>
                    {shown.seed
                      ? 'Result revealed. Verify it using the round history above.'
                      : 'Published before entry closes. The seed stays hidden until the crash.'}
                  </p>
                </div>
              )}
              <p className="sky-activity-empty">
                Up to two independent tickets per round. Each bet has its own cash-out and autoplay
                controls.
              </p>
            </>
          ) : activityView === 'top' ? (
            <PublicLeaderboard userId={userId} />
          ) : (
            <>
              <h2>{'My recent tickets'}</h2>
              <div className="sky-ticket-table">
                <table>
                  <caption className="sr-only">
                    Your tickets from the latest 12 rounds, amounts in practice credits
                  </caption>
                  <thead>
                    <tr>
                      <th>Round</th>
                      <th>Bet</th>
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
                          <td>{r.ticket!.slot}</td>
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
                <p className="sky-activity-empty">{'No tickets in the latest 12 rounds.'}</p>
              )}
            </>
          )}
          <div className="sky-activity-foot">
            <ShieldCheck size={17} /> Server-confirmed data · practice credits only
          </div>
        </aside>
      </div>
      <section className="sky-guide">
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
      <details className="sky-rules">
        <summary>Rules, timing and round verification</summary>
        <p>
          Practice starts with 1,000 nonredeemable credits, separate from Coins and Game Points. No
          purchases, refills, gifts, transfers or withdrawals. Sky Crash credits are separate from
          Crash Point credits. Confirm up to two immutable tickets per round. Auto cash-out is
          handled by the server and survives disconnects. A target equal to the crash loses.
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
function RoundHistory({ rounds }: { rounds: SkyCrashRound[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const completed = rounds
    .filter((r) => r.crashCents !== null)
    .sort((a, b) => b.opensAt - a.opensAt);
  const selected = completed.find((r) => r.id === selectedId);
  const tickets = selected?.tickets ?? (selected?.ticket ? [{ ...selected.ticket, slot: 1 }] : []);
  return (
    <section className="sky-history" aria-labelledby="sky-history-title">
      <div className="sky-history-heading">
        <History size={18} />
        <div>
          <h2 id="sky-history-title" tabIndex={-1} ref={historyHeading}>
            Round history
          </h2>
          <p>
            Completed results · Tap a round for details. Previous rounds do not predict the next
            result.
          </p>
        </div>
      </div>
      <div className="sky-history-grid">
        {completed.map((r) => (
          <button
            key={r.id}
            type="button"
            className={r.crashCents! >= 1000 ? 'peak' : r.crashCents! >= 200 ? 'high' : ''}
            aria-label={`View completed round ${r.id}: ${(r.crashCents! / 100).toFixed(2)}×`}
            title={`${new Date(r.startsAt).toLocaleString()} · View round details`}
            aria-haspopup="dialog"
            onClick={(event) => {
              opener.current = event.currentTarget;
              setSelectedId(r.id);
            }}
          >
            <strong>{(r.crashCents! / 100).toFixed(2)}×</strong>
            <time dateTime={new Date(r.startsAt).toISOString()}>
              {new Date(r.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          </button>
        ))}
      </div>
      {!completed.length && <p>Completed rounds will appear here.</p>}
      <Dialog.Root
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="sky-history-overlay" />
          <Dialog.Content
            className="sky-history-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (opener.current?.isConnected) opener.current.focus();
              else historyHeading.current?.focus();
            }}
          >
            <p className="sky-history-eyebrow">COMPLETED ROUND</p>
            <Dialog.Title>Round details</Dialog.Title>
            <Dialog.Description>
              Viewing a past result keeps your current ticket and cash-out target unchanged.
            </Dialog.Description>
            <Dialog.Close asChild>
              <button className="sky-history-close" aria-label="Close round details">
                <X size={20} />
              </button>
            </Dialog.Close>
            {selected ? (
              <>
                <div className="sky-past-result">
                  <span>Crash point</span>
                  <strong>{(selected.crashCents! / 100).toFixed(2)}×</strong>
                  <time dateTime={new Date(selected.startsAt).toISOString()}>
                    {new Date(selected.startsAt).toLocaleString()}
                  </time>
                </div>
                <h3>Your tickets in this round</h3>
                {tickets.length ? (
                  tickets.map((ticket) => (
                    <dl
                      key={ticket.slot}
                      className="sky-past-ticket"
                      aria-label={`Past bet ${ticket.slot} receipt`}
                    >
                      <dt>Bet {ticket.slot}</dt>
                      <dd>{ticket.stake} credits staked</dd>
                      <dt>Cash-out</dt>
                      <dd>{ticket.paidCents ? `${(ticket.paidCents / 100).toFixed(2)}×` : '—'}</dd>
                      <dt>Return</dt>
                      <dd>
                        {ticket.payout === null ? 'Pending settlement' : `${ticket.payout} credits`}
                      </dd>
                    </dl>
                  ))
                ) : (
                  <p className="sky-history-empty">You did not enter this round.</p>
                )}
                {selected.seed && (
                  <details className="sky-history-verification">
                    <summary>Round verification</summary>
                    <RoundProof key={selected.id} round={selected} />
                  </details>
                )}
              </>
            ) : (
              <p className="sky-history-empty">
                This round has left recent history. Close this view and select another result.
              </p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
function RoundProof({ round }: { round: SkyCrashRound }) {
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
    <div className="sky-proof">
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
  current?: SkyCrashRound;
  previous?: SkyCrashRound;
  userId: string;
}) {
  const [previousSelected, setPreviousSelected] = useState(false);
  const selected = previousSelected ? previous : current;
  const feed = useQuery({
    queryKey: ['sky-crash-activity', userId, selected?.id],
    enabled: !!selected,
    queryFn: async ({ signal }) =>
      unwrapData(
        await boundedRequest(
          (s) =>
            api.get<SkyCrashActivity>(
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
    <section className="sky-public-activity" aria-label="Public practice tickets">
      <div className="sky-feed-heading">
        <strong>{previousSelected ? 'Previous round' : 'Current round'} tickets</strong>
        <button
          aria-pressed={previousSelected}
          disabled={!previous}
          onClick={() => setPreviousSelected((v) => !v)}
        >
          {previousSelected ? 'Back to current' : 'Previous round'}
        </button>
      </div>
      <p className="sky-activity-caption">
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
            <div className="sky-ticket-table">
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
            <p className="sky-activity-empty">No tickets in this round.</p>
          )}
          {feed.data.totalTickets > feed.data.tickets.length && (
            <p>
              Showing {feed.data.tickets.length} of {feed.data.totalTickets} tickets.
            </p>
          )}
        </>
      )}
      <p className="sky-activity-caption">
        Returns appear only after server settlement. Amounts are practice credits.
      </p>
    </section>
  );
}

function PublicLeaderboard({ userId }: { userId: string }) {
  const feed = useQuery({
    queryKey: ['sky-crash-leaderboard', userId],
    queryFn: async ({ signal }) =>
      unwrapData(
        await boundedRequest(
          (s) => api.get<SkyCrashLeaderboard>(`${endpoint}/leaderboard`, undefined, { signal: s }),
          signal
        )
      ),
    refetchInterval: 10000,
    retry: false,
  });
  return (
    <section aria-label="Public top returns">
      <h2>Top returns · last 24 hours</h2>
      <p className="sky-activity-caption">
        Highest confirmed ticket returns · practice credits · includes stake
      </p>
      {feed.isError ? (
        <p role="status">Leaderboard unavailable. Reconnecting…</p>
      ) : feed.isPending ? (
        <p role="status">Loading leaderboard…</p>
      ) : feed.data.tickets.length ? (
        <div className="sky-ticket-table">
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
        <p className="sky-activity-empty">No confirmed returns in the last 24 hours.</p>
      )}
    </section>
  );
}
