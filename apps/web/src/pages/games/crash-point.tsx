import { CrashPointFlight } from '@/components/crash-point/flight-scene';
import { GameArena } from '@/components/games/game-arena';
import { GameRoundSummary } from '@/components/games/game-round-summary';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUpRight,
  Check,
  History,
  Minus,
  Plus,
  ShieldCheck,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
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
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import './crash-point.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

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
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const betHeading = useRef<HTMLHeadingElement>(null);
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
    [notice, setNotice] = useState(initial.entry ? 'Checking your saved ticket…' : '');
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
          ? `Cash-out confirmed at ${(data.paidCents / 100).toFixed(2)}x · ${data.payout} ETB returned.`
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
      setNotice('Autoplay stopped: not enough practice ETB.');
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
      ? crashCrossingMs(shown.crashCents)
      : flying
        ? Math.min(crashCrossingMs(2001), Math.max(0, now - shown.startsAt))
        : 0
    : 0;
  const draftStake =
    /^\d+$/.test(stakeText) &&
    Number.isSafeInteger(Number(stakeText)) &&
    Number(stakeText) >= rules.minStake &&
    Number(stakeText) <= rules.maxStake
      ? Number(stakeText)
      : null;
  const draftStakeLimit = Math.min(rules.maxStake, s?.balance ?? 0);
  const result = shown?.ticket;
  const shownTickets = shown?.tickets ?? (shown?.ticket ? [{ ...shown.ticket, slot: 1 }] : []);
  const controls = (
    <aside
      className="crash-controls"
      aria-label={translateUi('Bet {slot} controls', { slot: slot })}
    >
      <div className="crash-ticket-header">
        <div>
          <span>{translateUi('YOUR TICKET')}</span>
          <h2>{translateUi('Bet {slot}', { slot: slot })}</h2>
        </div>
        <span className="crash-ticket-state">
          {ticket
            ? ticket.payout === null
              ? translateUi('Confirmed')
              : translateUi('Complete')
            : pending
              ? translateUi('Checking ticket')
              : open
                ? translateUi('Entry open')
                : translateUi('Next round')}
        </span>
      </div>
      {result && (
        <div
          className="crash-ticket-result"
          role="group"
          aria-label={translateUi('Bet {slot} result', { slot: slot })}
        >
          <strong>
            {result.payout === null
              ? translateUi('{stake} ETB in play', { stake: result.stake })
              : translateUi('{payout} ETB returned', { payout: result.payout })}
          </strong>
          <span>
            {result.payout === null
              ? result.autoCents === null
                ? translateUi('Your ticket is live · manual cash-out requires a connection')
                : translateUi(
                    'Your ticket is live · auto cash-out stays active when you disconnect'
                  )
              : result.payout > 0
                ? translateUi('Confirmed at {value}× · includes stake', {
                    value: ((result.paidCents ?? 0) / 100).toFixed(2),
                  })
                : translateUi('Round finished · no return for this ticket')}
          </span>
        </div>
      )}
      <div className="crash-bet-fields">
        <div className="crash-auto-field">
          <label className="crash-auto">
            <span>{translateUi('Auto cash-out')}</span>
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
              aria-label={translateUi('Auto cash-out multiplier')}
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
        </div>
        <div className="crash-stake-field">
          <label htmlFor={`crash-stake-${slot}`}>{translateUi('Bet amount')}</label>
          <div className="crash-input crash-stake-adjustment">
            <button
              type="button"
              className="crash-amount-adjust"
              aria-label={translateUi('Decrease bet amount')}
              disabled={locked || draftStake === null || draftStake <= rules.minStake}
              onClick={() => {
                if (!locked && draftStake !== null)
                  setStakeText(String(Math.max(rules.minStake, draftStake - 5)));
              }}
            >
              <Minus size={18} />
            </button>
            <input
              id={`crash-stake-${slot}`}
              inputMode="numeric"
              value={ticket ? String(ticket.stake) : pending ? String(pending.stake) : stakeText}
              onChange={(e) => setStakeText(e.target.value)}
              disabled={locked}
            />
            <span>{'ETB'}</span>
            <button
              type="button"
              className="crash-amount-adjust"
              aria-label={translateUi('Increase bet amount')}
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
        <div className="crash-submit-field">
          {ticket && ticket.payout === null && flying ? (
            <button
              className="crash-action cashout"
              disabled={!connected || cashout.isPending}
              onClick={() => cashout.mutate(round!.id)}
            >
              {cashout.isPending ? (
                translateUi('Confirming cash-out…')
              ) : (
                <>
                  {translateUi('Cash out')} <ArrowUpRight size={20} />
                </>
              )}
              <small>{translateUi('Server confirms your final multiplier')}</small>
            </button>
          ) : (
            <button
              className="crash-action"
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
                  ? translateUi('Ticket confirmed')
                  : ticket.payout > 0
                    ? translateUi('Cashed out')
                    : translateUi('Round finished')
                : pending
                  ? translateUi('Checking saved ticket…')
                  : open
                    ? translateUi('Confirm ticket')
                    : translateUi('Wait for next round')}
              <small>
                {ticket
                  ? ticket.payout === null
                    ? translateUi('{stake} ETB locked', { stake: ticket.stake })
                    : translateUi('{payout} ETB returned', { payout: ticket.payout })
                  : open
                    ? translateUi('{value} practice ETB', { value: input?.stake ?? '—' })
                    : translateUi('Next entry in {seconds}s', { seconds: seconds })}
              </small>
            </button>
          )}
        </div>
      </div>
      {pending && !entryMutation.isPending && (
        <button className="crash-retry" disabled={!connected} onClick={() => submit(pending)}>
          {translateUi('Retry saved ticket')}
        </button>
      )}
      {!input && !ticket && !pending && (
        <p role="alert" className="crash-error">
          {translateUi('Enter a whole stake and a valid auto cash-out target.')}
        </p>
      )}
      {input && input.stake > (s?.balance ?? Infinity) && !ticket && (
        <p role="alert" className="crash-error">
          {translateUi('Not enough practice ETB.')}
        </p>
      )}
      {storageError && (
        <p role="alert" className="crash-error">
          {translateUi(storageError)}
        </p>
      )}
      {(query.isError || notice) && (
        <p className="crash-notice" aria-live="polite">
          {query.isError
            ? requestStatus(query.error) === 403
              ? translateUi('Crash Point practice is unavailable.')
              : translateUi(
                  'Connection interrupted. Entry and manual cash-out are paused until the server reconnects.'
                )
            : notice}
        </p>
      )}
      <details className="crash-more-options">
        <summary>{translateUi('More options')}</summary>
        <details className="crash-target-options">
          <summary>{translateUi('Quick targets')}</summary>
          <div
            className="crash-presets crash-targets"
            role="group"
            aria-label={translateUi('Auto cash-out targets')}
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
        {raw?.maxTickets === 2 && !autoplay && (
          <div className="crash-autoplay-controls">
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
              {translateUi('Start autoplay · 10 rounds')}
            </button>{' '}
            <details className="crash-autoplay-info">
              <summary>{translateUi('Rules')}</summary>
              <p>
                {translateUi(
                  'Up to 10 entries using this amount and target. Start before confirming a ticket. Stops on error, disconnection, hidden tab or refresh. Confirmed tickets stay active.'
                )}
              </p>
            </details>
          </div>
        )}
      </details>
      {autoplay && (
        <div className="crash-autoplay-controls">
          <button
            onClick={() => {
              setAutoplay(null);
              setNotice('Autoplay stopped. Already confirmed tickets remain active.');
            }}
          >
            {translateUi('Stop autoplay · {remaining} entries left', {
              remaining: autoplay.remaining,
            })}
          </button>
        </div>
      )}
    </aside>
  );
  if (controlsOnly) return controls;
  return (
    <div className="crash-page crash-reference">
      <nav className="crash-nav">
        <Link to="/games">
          <ArrowLeft size={16} />
          {translateUi('Games')}
        </Link>
        <span>{translateUi('SALEM BET ORIGINALS / CRASH POINT')}</span>
        <span className={connected ? 'online' : 'offline'}>
          {connected ? <Wifi size={15} /> : <WifiOff size={15} />}{' '}
          {connected ? translateUi('Connected') : translateUi('Connecting')}
        </span>
      </nav>
      <header className="crash-heading">
        <div>
          <p className="crash-kicker">{translateUi('THE RUBY GRAND COLLECTION')}</p>
          <h1>
            {translateUi('Crash') + ' '}
            <em>{translateUi('Point')}</em>
            <span>{translateUi('LIVE PRACTICE')}</span>
          </h1>
          <p>{translateUi('Follow the curve. Choose your moment.')}</p>
        </div>
        <div className="crash-heading-actions">
          <div className="crash-wallet">
            <span>{translateUi('PRACTICE BALANCE')}</span>
            <strong>
              {s
                ? translateUi('{value} ETB', { value: s.balance.toLocaleString(interfaceLocale) })
                : translateUi('Connecting…')}
            </strong>
            <small>{translateUi('Virtual ETB · no cash value')}</small>
          </div>
          <div className="crash-bet-navigation">
            <a
              href="#crash-betting"
              onClick={(event) => {
                event.preventDefault();
                betHeading.current?.scrollIntoView({ block: 'start' });
                betHeading.current?.focus({ preventScroll: true });
              }}
            >
              {translateUi('Choose your bet') + ' '}
              <ArrowDown size={16} />
            </a>
          </div>
        </div>
      </header>
      <GameRoundSummary
        game="Crash Point"
        label={
          !connected
            ? translateUi('Reconnecting')
            : shown?.crashCents != null
              ? translateUi('Round result')
              : open
                ? translateUi('Entry open')
                : translateUi('Live multiplier')
        }
        value={connected ? (open ? 'Place your ticket' : `${(cents / 100).toFixed(2)}×`) : '—'}
        detail="Free practice · no cash value"
        clock={`${open ? 'Closes' : 'Next round'} ${seconds}s`}
      />
      <div className="crash-layout">
        <div className="crash-table">
          <div className="crash-stage-masthead">
            <div className="crash-stage-brand">
              <CrashPointMark />
              <CrashRulesDialog />
            </div>
            <RoundHistory rounds={raw?.rounds ?? []} />
          </div>
          <GameArena
            title={translateUi('Crash Point')}
            className="crash-display"
            onReturnToControls={() => {
              betHeading.current?.scrollIntoView({ block: 'start' });
              betHeading.current?.focus({ preventScroll: true });
            }}
          >
            <section
              className={`crash-arena ${shown?.crashCents !== null && shown?.crashCents !== undefined ? 'crashed' : ''}`}
              aria-label={translateUi('Live multiplier graph')}
            >
              <div className="crash-arena-top">
                <span>
                  <i />
                  {!connected
                    ? translateUi('SYNCHRONIZING')
                    : open
                      ? translateUi('ENTRY OPEN')
                      : flying
                        ? translateUi('ROUND RUNNING')
                        : shown?.crashCents
                          ? translateUi('ROUND COMPLETE')
                          : translateUi('WAITING FOR ROUND')}
                </span>
                <span role="timer">
                  {open ? translateUi('Entry closes') : translateUi('Next round')}{' '}
                  <b>{translateUi('{value}s', { value: String(seconds).padStart(2, '0') })}</b>
                </span>
              </div>
              <div className="crash-multiplier">
                <span>
                  {shown?.crashCents
                    ? translateUi('CRASHED')
                    : open
                      ? translateUi('READY FOR THE RISE')
                      : translateUi('LIVE MULTIPLIER')}
                </span>
                <strong>
                  {open ? (remainingMs / 1000).toFixed(1) : (cents / 100).toFixed(2)}
                  <em>{open ? translateUi('sec') : '×'}</em>
                </strong>
                <p>
                  {!connected
                    ? translateUi('Waiting for a fresh server update')
                    : open
                      ? translateUi('Confirm your ticket before the round starts')
                      : shown?.crashCents
                        ? translateUi('The server has revealed this round’s result')
                        : translateUi('Cash out before the curve stops')}
                </p>
              </div>
              {open && (
                <div className="crash-countdown-track" aria-hidden="true">
                  <div
                    style={{ width: `${Math.min(100, (remainingMs / rules.bettingMs) * 100)}%` }}
                  />
                </div>
              )}
              <CrashPointFlight
                elapsed={elapsed}
                flying={flying}
                connected={connected}
                growthMs={rules.growthMs}
              />
            </section>
          </GameArena>
          <section
            id="crash-betting"
            className="crash-betting"
            aria-labelledby="crash-betting-title"
          >
            <div className="crash-betting-heading">
              <div>
                <h2 id="crash-betting-title" tabIndex={-1} ref={betHeading}>
                  {translateUi('Choose your bet')}
                </h2>
                <p>
                  {translateUi('{value} per round · Confirm during the 15-second entry window.', {
                    value:
                      raw?.maxTickets === 2
                        ? translateUi('Up to two tickets')
                        : translateUi('One ticket'),
                  })}
                </p>
              </div>
              <span>{translateUi('Practice ETB')}</span>
            </div>
            <div className="crash-dual-controls">
              {controls}
              {raw?.maxTickets === 2 && <CrashPoint userId={userId} slot={2} controlsOnly />}
            </div>
          </section>
        </div>
        <aside className="crash-activity" aria-label={translateUi('Your round activity')}>
          <div
            className="crash-activity-tabs"
            role="group"
            aria-label={translateUi('Activity view')}
          >
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
          <p className="crash-activity-caption">
            {activityView === 'top'
              ? translateUi('Public practice returns · last 24 hours')
              : translateUi('Your practice activity · latest 12 rounds')}
          </p>
          {activityView === 'current' ? (
            <>
              <PublicActivity
                current={shown}
                previous={s?.rounds.find((r) => shown && r.opensAt < shown.opensAt)}
                userId={userId}
              />
              <h2>{translateUi('Your current round')}</h2>
              <dl className="crash-round-info">
                <dt>{translateUi('Round')}</dt>
                <dd>{shown?.id ?? translateUi('Connecting…')}</dd>
                <dt>{translateUi('Status')}</dt>
                <dd>
                  {!connected
                    ? translateUi('Reconnecting')
                    : open
                      ? translateUi('Entry open')
                      : flying
                        ? translateUi('Running')
                        : translateUi('Complete')}
                </dd>
                <dt>{translateUi('Total stake')}</dt>
                <dd>
                  {shownTickets.length
                    ? translateUi('{value} ETB', {
                        value: shownTickets.reduce((total, t) => total + t.stake, 0),
                      })
                    : translateUi('No tickets')}
                </dd>
              </dl>
              {shownTickets.map((t) => (
                <section
                  className="crash-ticket-summary"
                  key={t.slot}
                  aria-label={translateUi('Bet {slot} receipt', { slot: t.slot })}
                >
                  <h3>{translateUi('Bet {slot}', { slot: t.slot })}</h3>
                  <dl className="crash-round-info">
                    <dt>{translateUi('Stake')}</dt>
                    <dd>{translateUi('{stake} ETB', { stake: t.stake })}</dd>
                    <dt>{translateUi('Auto cash-out')}</dt>
                    <dd>
                      {t.autoCents
                        ? `${(t.autoCents / 100).toFixed(2)}×`
                        : translateUi('Manual only')}
                    </dd>
                    <dt>{translateUi('Return')}</dt>
                    <dd>
                      {t.payout === null
                        ? translateUi('Pending')
                        : translateUi('{payout} ETB', { payout: t.payout })}
                    </dd>
                  </dl>
                </section>
              ))}

              {shown && (
                <div className="crash-commitment">
                  <h3>{translateUi('Round commitment')}</h3>
                  <code>{shown.commitment}</code>
                  <p>
                    {shown.seed
                      ? translateUi(
                          'Result revealed. Tap a result in the round history above to verify it.'
                        )
                      : translateUi(
                          'Published before entry closes. The seed stays hidden until the crash.'
                        )}
                  </p>
                </div>
              )}
              <p className="crash-activity-empty">
                {translateUi(
                  'Up to two independent tickets per round. Each bet has its own cash-out and autoplay controls.'
                )}
              </p>
            </>
          ) : activityView === 'top' ? (
            <PublicLeaderboard userId={userId} />
          ) : (
            <>
              <h2>{translateUi('My recent tickets')}</h2>
              <div className="crash-ticket-table">
                <table>
                  <caption className="sr-only">
                    {translateUi('Your tickets from the latest 12 rounds, amounts in practice ETB')}
                  </caption>
                  <thead>
                    <tr>
                      <th>{translateUi('Round')}</th>
                      <th>{translateUi('Bet')}</th>
                      <th>{translateUi('Stake')}</th>
                      <th>{translateUi('Cash-out')}</th>
                      <th>{translateUi('Return')}</th>
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
                              ? translateUi('Pending')
                              : r.ticket!.paidCents
                                ? `${(r.ticket!.paidCents / 100).toFixed(2)}×`
                                : '—'}
                          </td>
                          <td>
                            {r.ticket!.payout === null ? translateUi('Pending') : r.ticket!.payout}
                          </td>
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
                <p className="crash-activity-empty">
                  {translateUi('No tickets in the latest 12 rounds.')}
                </p>
              )}
            </>
          )}
          <div className="crash-activity-foot">
            <ShieldCheck size={17} />
            {' ' + translateUi('Server-confirmed data · practice ETB only')}
          </div>
        </aside>
      </div>
      <section className="crash-guide">
        <article>
          <span>01</span>
          <h3>{translateUi('Make your entry')}</h3>
          <p>
            {translateUi(
              'Confirm once during the countdown. Your ticket stays saved after refresh.'
            )}
          </p>
        </article>
        <article>
          <span>02</span>
          <h3>{translateUi('Choose your moment')}</h3>
          <p>
            {translateUi(
              'Cash out during the rise, or set an automatic target before the round starts.'
            )}
          </p>
        </article>
        <article>
          <span>03</span>
          <h3>{translateUi('Get a confirmed result')}</h3>
          <p>{translateUi('Returns include your stake. The server credits the result once.')}</p>
        </article>
      </section>
      <details className="crash-rules">
        <summary>{translateUi('Rules, timing and round verification')}</summary>
        <CrashRulesContent />
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
function CrashPointMark() {
  const { t: translateUi } = useInterfaceLanguage();

  return (
    <svg
      className="crash-brand-mark"
      viewBox="0 0 280 106"
      role="img"
      aria-label={translateUi('Salem Bet Crash Point')}
    >
      <defs>
        <linearGradient id="cp-brand-face" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#f2fdff" />
          <stop offset="0.5" stopColor="#bce9ff" />
          <stop offset="1" stopColor="#6e9be9" />
        </linearGradient>
        <linearGradient id="cp-brand-arrow" x1="0" y1="1" x2="1" y2="0">
          <stop stopColor="#5279ef" />
          <stop offset="1" stopColor="#86ffec" />
        </linearGradient>
      </defs>
      <path d="M12 72L12 41L38 18L65 33L65 64L38 89Z" fill="#111e3e" stroke="#638ab7" />
      <path
        d="M19 67L39 44L30 40L58 30L53 59L47 50L27 75Z"
        fill="#1b518e"
        transform="translate(0 5)"
      />
      <path d="M19 67L39 44L30 40L58 30L53 59L47 50L27 75Z" fill="url(#cp-brand-arrow)" />
      <path d="M19 67L27 75L47 50L53 59L58 30L45 45Z" fill="#58b8d5" opacity=".6" />
      <g
        fontFamily="system-ui, sans-serif"
        fontWeight="900"
        fontStyle="italic"
        fontSize="38"
        letterSpacing="1"
      >
        <g fill="#203764" stroke="#203764" strokeWidth="2" transform="translate(0 5)">
          <text x="80" y="46">
            {translateUi('CRASH')}
          </text>
          <text x="80" y="84">
            {translateUi('POINT')}
          </text>
        </g>
        <g fill="url(#cp-brand-face)">
          <text x="80" y="46">
            {translateUi('CRASH')}
          </text>
          <text x="80" y="84">
            {translateUi('POINT')}
          </text>
        </g>
      </g>
      <text
        x="82"
        y="101"
        fill="#aabedb"
        fontSize="9"
        letterSpacing="3"
        fontFamily="system-ui, sans-serif"
      >
        {translateUi('SALEM BET ORIGINAL')}
      </text>
    </svg>
  );
}
function CrashRulesContent() {
  const { t: translateUi } = useInterfaceLanguage();

  return (
    <>
      <div className="crash-rule-limits" role="group" aria-label={translateUi('Practice limits')}>
        <span>
          <strong>
            {rules.minStake}–{rules.maxStake}
          </strong>{' '}
          {translateUi('ETB per ticket')}
        </span>
        <span>
          <strong>{translateUi('{value} seconds', { value: rules.bettingMs / 1000 })}</strong>
          {' ' + translateUi('to confirm your entry')}
        </span>
        <span>
          <strong>{(rules.maxCashoutCents / 100).toFixed(2)}×</strong>
          {' ' + translateUi('maximum cash-out')}
        </span>
      </div>
      <ol className="crash-rule-steps">
        <li>
          <strong>{translateUi('Choose your ticket.')}</strong>
          {' ' +
            translateUi(
              'Set an amount and optional auto cash-out target. Each panel is independent and shares the practice balance.'
            )}
        </li>
        <li>
          <strong>{translateUi('Confirm during entry.')}</strong>
          {' ' +
            translateUi(
              'An accepted ticket locks its amount and target. Changing a draft or tapping a past result never places a ticket.'
            )}
        </li>
        <li>
          <strong>{translateUi('Cash out before the crash.')}</strong>
          {' ' +
            translateUi(
              'A return includes the stake. If the crash happens first, that ticket returns zero. Matching the crash multiplier also loses.'
            )}
        </li>
      </ol>
      <p>
        {translateUi(
          'Practice starts with 1,000 nonredeemable practice ETB, separate from your cash wallet and Game Points. No purchases, gifts, transfers or withdrawals. Confirm up to two immutable tickets per round. Auto cash-out is handled by the server and survives disconnects.'
        )}
      </p>
      <p>
        {translateUi(
          'Manual cash-out is accepted at server processing time, after locks are acquired. At or after the crash cutoff it loses. Displayed multipliers are estimates between updates; only a server-confirmed receipt is a return. A round can crash immediately at 1.00×. Cash-out is capped at 20.00×, with a terminal crash at 20.01×.'
        )}
      </p>
      <p>
        {translateUi(
          'The target gross return for a fixed auto cash-out is approximately 90%, before whole-credit rounding. It is a long-run mathematical expectation, not a promise for a session. Manual timing and rounding affect returns. There is no additional practice fee or PVP mode.'
        )}
      </p>
      <p>
        {translateUi(
          'Each round publishes a SHA-256 commitment before entry and reveals its seed after the crash. This checks that the revealed seed matches the earlier commitment; it is not an independent RNG certification.'
        )}
      </p>

      <p>
        {translateUi(
          'Autoplay requires an auto cash-out target and runs for up to ten entries per panel. It stops on a hidden tab, refresh, connection loss or an error. Stopping autoplay does not cancel an accepted ticket.'
        )}
      </p>
      <p>
        {translateUi(
          'Round history and My bets cover the latest 12 rounds. Top shows the highest confirmed returns in the last 24 hours. Previous results cannot predict the next round.'
        )}
      </p>
    </>
  );
}
function CrashRulesDialog() {
  const { t: translateUi } = useInterfaceLanguage();

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className="crash-rules-trigger">
          <ShieldCheck size={15} />
          {translateUi('How to play')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="crash-history-overlay" />
        <Dialog.Content className="crash-history-dialog crash-rules-dialog">
          <Dialog.Close
            className="crash-history-close"
            aria-label={translateUi('Close game rules')}
          >
            <X size={20} />
          </Dialog.Close>
          <p className="crash-history-eyebrow">{translateUi('SALEM BET · PRACTICE ONLY')}</p>
          <Dialog.Title>{translateUi('Crash Point rules')}</Dialog.Title>
          <Dialog.Description>
            {translateUi(
              'Choose a stake, follow the rising multiplier, and cash out before the crash.'
            )}
          </Dialog.Description>
          <CrashRulesContent />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function RoundHistory({ rounds }: { rounds: CrashPointRound[] }) {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastViewedId, setLastViewedId] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const completed = rounds
    .filter((r) => r.crashCents !== null)
    .sort((a, b) => b.opensAt - a.opensAt);
  const selected = completed.find((r) => r.id === selectedId);
  const tickets = selected?.tickets ?? (selected?.ticket ? [{ ...selected.ticket, slot: 1 }] : []);
  return (
    <section className="crash-history" aria-labelledby="crash-history-title">
      <div className="crash-history-heading">
        <History size={18} />
        <div>
          <h2 id="crash-history-title" tabIndex={-1} ref={historyHeading}>
            {translateUi('Round history')}
          </h2>
          <p>
            {translateUi(
              'Completed results · Tap a round for details. Previous rounds do not predict the next result.'
            )}
          </p>
        </div>
      </div>
      <div className="crash-history-grid">
        {completed.map((r) => (
          <button
            key={r.id}
            type="button"
            className={r.crashCents! >= 1000 ? 'peak' : r.crashCents! >= 200 ? 'high' : ''}
            aria-label={translateUi('View completed round {id}: {value}×', {
              id: r.id,
              value: (r.crashCents! / 100).toFixed(2),
            })}
            title={translateUi('{value} · View round details', {
              value: new Date(r.startsAt).toLocaleString(interfaceLocale),
            })}
            aria-haspopup="dialog"
            aria-current={r.id === lastViewedId ? true : undefined}
            onClick={(event) => {
              opener.current = event.currentTarget;
              setSelectedId(r.id);
              setLastViewedId(r.id);
            }}
          >
            <strong>{(r.crashCents! / 100).toFixed(2)}×</strong>
            {r.id === lastViewedId && (
              <Check className="crash-history-selected-mark" aria-hidden="true" />
            )}
            <time dateTime={new Date(r.startsAt).toISOString()}>
              {new Date(r.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          </button>
        ))}
      </div>
      {!completed.length && <p>{translateUi('Completed rounds will appear here.')}</p>}
      <Dialog.Root
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="crash-history-overlay" />
          <Dialog.Content
            className="crash-history-dialog crash-round-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (opener.current?.isConnected) opener.current.focus();
              else historyHeading.current?.focus();
            }}
          >
            <p className="crash-history-eyebrow">{translateUi('COMPLETED ROUND')}</p>
            <Dialog.Title>{translateUi('Round result')}</Dialog.Title>
            <Dialog.Description className="sr-only">
              {translateUi(
                'Completed result. Your current ticket and cash-out target stay unchanged.'
              )}
            </Dialog.Description>
            <Dialog.Close asChild>
              <button
                className="crash-history-close"
                aria-label={translateUi('Close round details')}
              >
                <X size={20} />
              </button>
            </Dialog.Close>
            {selected ? (
              <>
                <div className="crash-past-result">
                  <span>{translateUi('Crash point')}</span>
                  <strong>{(selected.crashCents! / 100).toFixed(2)}×</strong>
                  <time dateTime={new Date(selected.startsAt).toISOString()}>
                    {new Date(selected.startsAt).toLocaleDateString([], {
                      month: 'short',
                      day: 'numeric',
                    })}
                    {' · '}
                    {new Date(selected.startsAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                {tickets.length > 0 && <h3>{translateUi('Your tickets')}</h3>}
                {tickets.length ? (
                  tickets.map((ticket) => (
                    <dl
                      key={ticket.slot}
                      className="crash-past-ticket"
                      aria-label={translateUi('Past bet {slot} receipt', { slot: ticket.slot })}
                    >
                      <dt>{translateUi('Bet {slot}', { slot: ticket.slot })}</dt>
                      <dd>{translateUi('{stake} ETB staked', { stake: ticket.stake })}</dd>
                      <dt>{translateUi('Cash-out')}</dt>
                      <dd>{ticket.paidCents ? `${(ticket.paidCents / 100).toFixed(2)}×` : '—'}</dd>
                      <dt>{translateUi('Return')}</dt>
                      <dd>
                        {ticket.payout === null
                          ? translateUi('Pending settlement')
                          : translateUi('{payout} ETB', { payout: ticket.payout })}
                      </dd>
                    </dl>
                  ))
                ) : (
                  <p className="crash-history-empty">
                    {translateUi('You did not enter this round.')}
                  </p>
                )}
                {selected.seed && (
                  <details className="crash-history-verification">
                    <summary>{translateUi('Round verification')}</summary>
                    <RoundProof key={selected.id} round={selected} />
                  </details>
                )}
              </>
            ) : (
              <p className="crash-history-empty">
                {translateUi(
                  'This round has left recent history. Close this view and select another result.'
                )}
              </p>
            )}
            <Dialog.Close asChild>
              <button type="button" className="crash-history-done">
                {translateUi('Done')}
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
function RoundProof({ round }: { round: CrashPointRound }) {
  const { t: translateUi } = useInterfaceLanguage();

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
      <span>{translateUi('Commitment: {commitment}', { commitment: round.commitment })}</span>
      <span>{translateUi('Revealed seed: {seed}', { seed: round.seed ?? '' })}</span>
      <button onClick={verify}>{translateUi('Verify round')}</button>
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
  const { t: translateUi } = useInterfaceLanguage();

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
    <section className="crash-public-activity" aria-label={translateUi('Public practice tickets')}>
      <div className="crash-feed-heading">
        <strong>
          {translateUi('{value} tickets', {
            value: previousSelected ? translateUi('Previous round') : translateUi('Current round'),
          })}
        </strong>
        <button
          aria-pressed={previousSelected}
          disabled={!previous}
          onClick={() => setPreviousSelected((v) => !v)}
        >
          {previousSelected ? translateUi('Back to current') : translateUi('Previous round')}
        </button>
      </div>
      <p className="crash-activity-caption">
        {translateUi('{value} · anonymous practice players', {
          value: selected?.id ?? translateUi('Waiting for round'),
        })}
      </p>
      {feed.isError ? (
        <p role="status">{translateUi('Activity unavailable. Reconnecting…')}</p>
      ) : feed.isPending ? (
        <p role="status">{translateUi('Loading activity…')}</p>
      ) : (
        <>
          <p>
            {translateUi('Total tickets:') + ' '}
            <strong>{feed.data.totalTickets}</strong>
          </p>
          {feed.data.tickets.length ? (
            <div className="crash-ticket-table">
              <table>
                <caption className="sr-only">
                  {translateUi('Public practice tickets for {roundId}', {
                    roundId: feed.data.roundId,
                  })}
                </caption>
                <thead>
                  <tr>
                    <th>{translateUi('Player')}</th>
                    <th>{translateUi('Stake')}</th>
                    <th>{translateUi('Cash-out')}</th>
                    <th>{translateUi('Return')}</th>
                  </tr>
                </thead>
                <tbody>
                  {feed.data.tickets.map((t) => (
                    <tr key={t.player}>
                      <td>{t.player}</td>
                      <td>{t.stake}</td>
                      <td>
                        {t.payout === null
                          ? translateUi('Pending')
                          : t.paidCents
                            ? `${(t.paidCents / 100).toFixed(2)}×`
                            : '—'}
                      </td>
                      <td>{t.payout === null ? translateUi('Pending') : t.payout}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="crash-activity-empty">{translateUi('No tickets in this round.')}</p>
          )}
          {feed.data.totalTickets > feed.data.tickets.length && (
            <p>
              {translateUi('Showing {length} of {totalTickets} tickets.', {
                length: feed.data.tickets.length,
                totalTickets: feed.data.totalTickets,
              })}
            </p>
          )}
        </>
      )}
      <p className="crash-activity-caption">
        {translateUi('Returns appear only after server settlement. Amounts are practice ETB.')}
      </p>
    </section>
  );
}

function PublicLeaderboard({ userId }: { userId: string }) {
  const { t: translateUi } = useInterfaceLanguage();

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
    <section aria-label={translateUi('Public top returns')}>
      <h2>{translateUi('Top returns · last 24 hours')}</h2>
      <p className="crash-activity-caption">
        {translateUi('Highest confirmed ticket returns · practice ETB · includes stake')}
      </p>
      {feed.isError ? (
        <p role="status">{translateUi('Leaderboard unavailable. Reconnecting…')}</p>
      ) : feed.isPending ? (
        <p role="status">{translateUi('Loading leaderboard…')}</p>
      ) : feed.data.tickets.length ? (
        <div className="crash-ticket-table">
          <table>
            <thead>
              <tr>
                <th>{translateUi('Player')}</th>
                <th>{translateUi('Stake')}</th>
                <th>{translateUi('Cash-out')}</th>
                <th>{translateUi('Return')}</th>
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
        <p className="crash-activity-empty">
          {translateUi('No confirmed returns in the last 24 hours.')}
        </p>
      )}
    </section>
  );
}
