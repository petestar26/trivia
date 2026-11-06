import { formatEtb } from '@/lib/payment-money';
import { PRACTICE_ETB } from '@/lib/practice-etb';
import { GameRoundSummary } from '@/components/games/game-round-summary';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { SystemKenoSnapshot } from '@socialplay/shared';
import { useAuth } from '@/providers/auth-provider';
import { useCasino } from '@/components/casino/CasinoProvider';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import { drawKeno, parseKenoStake } from '@/lib/keno-practice';
import { KenoMachine } from './keno';
import './keno.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

const endpoint = '/games/system-keno';
interface Entry {
  roundId: string;
  picks: number[];
  stakePerNumber: number;
  slot?: number;
}
const receiptKey = (id: string) => `playqube.keno.pending.v1.${id}`;
export function readKenoPending(id: string): Entry | null {
  const raw = sessionStorage.getItem(receiptKey(id));
  if (!raw) return null;
  const e = JSON.parse(raw) as Entry;
  if (
    !e ||
    typeof e.roundId !== 'string' ||
    !e.roundId ||
    e.roundId.length > 64 ||
    !Array.isArray(e.picks) ||
    e.picks.length < 1 ||
    e.picks.length > 10 ||
    new Set(e.picks).size !== e.picks.length ||
    e.picks.some((n) => !Number.isInteger(n) || n < 1 || n > 80) ||
    !parseKenoStake(String(e.stakePerNumber)) ||
    e.picks.length * e.stakePerNumber > 480 ||
    !Number.isInteger(e.slot ?? 1) ||
    (e.slot ?? 1) < 1 ||
    (e.slot ?? 1) > 10
  )
    throw Error('Invalid saved Keno ticket. Restore browser storage before playing.');
  return e;
}

export function SystemKenoPage() {
  const { user } = useAuth();
  return user ? <SystemKeno key={user.id} userId={user.id} /> : null;
}
function SystemKeno({ userId }: { userId: string }) {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const { coinsBalance, walletLoading, walletError } = useCasino();
  const [clock, setClock] = useState(performance.now());
  const [slot, setSlot] = useState(1);
  const [drafts, setDrafts] = useState<
    Record<number, { roundId: string; picks: number[]; stakeText: string }>
  >({});
  const [acknowledged, setAcknowledged] = useState<Entry[]>([]);
  const [initial] = useState(() => {
    try {
      return { entry: readKenoPending(userId), error: '' };
    } catch {
      return {
        entry: null,
        error: 'Browser storage could not be read. Restore storage and reload before entering.',
      };
    }
  });
  const [storageError, setStorageError] = useState(initial.error);
  const [notice, setNotice] = useState('Choose 1–10 numbers, then confirm your ticket.');
  const [pending, setPending] = useState<Entry | null>(initial.entry);
  const pendingRef = useRef<Entry | null>(initial.entry);
  const query = useQuery({
    queryKey: ['system-keno', userId],
    queryFn: async ({ signal }) => {
      const sentAt = performance.now();
      const snapshot = unwrapData(
        await boundedRequest(
          (s) => api.get<SystemKenoSnapshot>(endpoint, undefined, { signal: s }),
          signal
        )
      );
      return { snapshot, sentAt, receivedAt: performance.now() };
    },
    refetchInterval: (q) => ([401, 403, 404].includes(requestStatus(q.state.error)) ? false : 1000),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  });
  useEffect(() => {
    const timer = setInterval(() => setClock(performance.now()), 100);
    return () => {
      clearInterval(timer);
      pendingRef.current = null;
    };
  }, []);
  const s = query.data?.snapshot;
  const age = query.data ? Math.max(clock, performance.now()) - query.data.sentAt : Infinity;
  const connected =
    !!query.data &&
    !query.isError &&
    !query.isPaused &&
    age < 5000 &&
    query.data.receivedAt - query.data.sentAt < 1000;
  const now = s ? s.serverTime + age : 0;
  const round = s?.rounds.find((r) => r.opensAt <= now && now < r.endsAt);
  const display = round ?? s?.rounds[0];
  const open = !!round && connected && s?.enabled && now < round.closesAt;
  const maxTickets = Math.max(1, Math.min(10, s?.maxTickets ?? 1));
  const serverTickets =
    display?.tickets ?? (display?.ticket ? [{ ...display.ticket, slot: 1 }] : []);
  const local = acknowledged
    .filter(
      (e) => e.roundId === display?.id && !serverTickets.some((t) => t.slot === (e.slot ?? 1))
    )
    .map((e) => ({
      ...e,
      slot: e.slot ?? 1,
      stake: e.picks.length * e.stakePerNumber,
      payout: null,
    }));
  const tickets = [...serverTickets, ...local].sort((a, b) => a.slot - b.slot);
  const ticket = tickets.find((t) => t.slot === slot);
  const draft = drafts[slot]?.roundId === round?.id ? drafts[slot] : undefined;
  const selectedPending =
    pending && pending.roundId === round?.id && (pending.slot ?? 1) === slot ? pending : null;
  const picks = ticket?.picks ?? selectedPending?.picks ?? draft?.picks ?? [];
  const stakeText = draft?.stakeText ?? '5';
  const stake = parseKenoStake(stakeText);
  const busy = !!pending;
  const locked = !open || !!ticket || busy || !!storageError;
  const shownStake = ticket?.stakePerNumber ?? selectedPending?.stakePerNumber ?? stake;
  const cost = picks.length * shownStake;
  const count = display?.outcome
    ? Math.min(20, Math.max(0, Math.floor((now - display.closesAt) / 500)))
    : 0;
  const drawn = display?.outcome?.slice(0, count) ?? [];
  const hits = ticket?.picks.filter((n) => drawn.includes(n)) ?? [];
  const slots = Array.from(
    new Set([
      1,
      ...tickets.map((t) => t.slot),
      ...Object.entries(drafts)
        .filter(([, d]) => d.roundId === round?.id)
        .map(([key]) => Number(key)),
      ...(pending && pending.roundId === round?.id ? [pending.slot ?? 1] : []),
    ])
  ).sort((a, b) => a - b);
  const nextSlot = Array.from({ length: maxTickets }, (_, i) => i + 1).find(
    (n) => !slots.includes(n)
  );
  const updateDraft = (values: Partial<{ picks: number[]; stakeText: string }>) => {
    if (!locked && round)
      setDrafts((ds) => ({ ...ds, [slot]: { roundId: round.id, picks, stakeText, ...values } }));
  };
  useEffect(() => {
    setSlot(1);
    setAcknowledged((es) => es.filter((e) => e.roundId === round?.id));
  }, [round?.id]);
  const clearPending = () => {
    pendingRef.current = null;
    setPending(null);
    try {
      sessionStorage.removeItem(receiptKey(userId));
    } catch {
      setStorageError(
        'Could not clear the saved ticket. Restore storage and reload before entering.'
      );
    }
  };
  const seconds = round
    ? Math.max(0, Math.ceil(((now < round.closesAt ? round.closesAt : round.endsAt) - now) / 1000))
    : 0;
  const mutation = useMutation({
    mutationFn: (entry: Entry) =>
      boundedRequest((signal) => api.post(`${endpoint}/tickets`, entry, undefined, { signal })),
    onSuccess: async (_data, entry) => {
      if (pendingRef.current !== entry) return;
      setAcknowledged((es) => [
        ...es.filter((e) => e.roundId !== entry.roundId || (e.slot ?? 1) !== (entry.slot ?? 1)),
        entry,
      ]);
      clearPending();
      setNotice('Ticket accepted. Add another bet or view your saved tickets.');
      await query.refetch();
    },
    onError: async (error, entry) => {
      if (pendingRef.current !== entry) return;
      const status = requestStatus(error);
      if (status >= 400 && status < 500 && status !== 408) {
        clearPending();
      }
      setNotice(
        status === 409
          ? 'Betting closed or your ticket was already confirmed. Checking the server.'
          : 'Ticket not confirmed. Checking the server; retry keeps the same ticket.'
      );
      await query.refetch();
    },
  });
  useEffect(() => {
    const entry = pendingRef.current;
    if (!entry) return;
    const saved = s?.rounds.find((r) => r.id === entry.roundId);
    const accepted =
      saved?.tickets?.find((t) => t.slot === (entry.slot ?? 1)) ??
      ((entry.slot ?? 1) === 1 ? saved?.ticket : null);
    if (accepted) {
      clearPending();
      mutation.reset();
      setNotice('Confirmed by the server. Your ticket is saved.');
    }
  }, [query.data, pending]);
  const submit = (entry: Entry) => {
    if (mutation.isPending || (pendingRef.current && pendingRef.current !== entry) || storageError)
      return;
    try {
      sessionStorage.setItem(receiptKey(userId), JSON.stringify(entry));
    } catch {
      setStorageError('Could not save your ticket safely. Restore storage before entering.');
      return;
    }
    pendingRef.current = entry;
    setPending(entry);
    mutation.mutate(entry);
  };
  const toggle = (n: number) => {
    if (locked || !round) return;
    const next = picks.includes(n)
      ? picks.filter((v) => v !== n)
      : picks.length < 10
        ? [...picks, n].sort((a, b) => a - b)
        : picks;
    updateDraft({ picks: next });
  };
  return (
    <div className="keno-page keno-system">
      <div className="keno-navigation">
        <Link to="/games">{translateUi('← Games')}</Link>
        <Link to="/groups">{translateUi('PVP · play in a group →')}</Link>
      </div>
      <GameRoundSummary
        game="Keno"
        label={
          count === 20
            ? translateUi('Draw result')
            : count
              ? translateUi('Ball reveal')
              : translateUi('Keno draw')
        }
        value={
          count
            ? `${count}/20 balls${count === 20 && ticket ? ` · ${hits.length} matches` : ''}`
            : open
              ? 'Choose your numbers'
              : 'Awaiting draw'
        }
        detail={
          count === 20 && ticket
            ? ticket.payout === null
              ? 'Return pending'
              : `${ticket.payout} ETB returned`
            : 'Free practice · no cash value'
        }
        clock={`${!connected ? 'Reconnecting · ' : ''}${open ? 'Closes' : 'Next round'} ${seconds}s`}
      />
      <section className="keno-stage" aria-label={translateUi('System Keno practice')}>
        <header className="keno-header">
          <div>
            <p className="keno-eyebrow">{translateUi('SALEM BET ORIGINALS · SYSTEM TABLE')}</p>
            <h1>
              {translateUi('Turbo') + ' '}
              <span>{translateUi('Keno')}</span>
            </h1>
            <p>{translateUi('One new round every minute.')}</p>
          </div>
          <div className="keno-balances">
            {!PRACTICE_ETB && (
              <div className="keno-wallet">
                <span>{translateUi('ACCOUNT BALANCE')}</span>
                <strong>
                  {walletLoading
                    ? translateUi('Loading…')
                    : walletError
                      ? translateUi('Unavailable')
                      : formatEtb(coinsBalance)}
                </strong>
                <small>{translateUi('Not used in practice')}</small>
              </div>
            )}
            <div className="keno-balance">
              <span>{translateUi('PRACTICE BALANCE')}</span>
              <strong>{s?.balance.toLocaleString(interfaceLocale) ?? '—'}</strong>
              <small>{translateUi('ETB · no cash value')}</small>
            </div>
          </div>
        </header>
        <div className="keno-economics">
          <span>{translateUi('90% theoretical return')}</span>
          <span>{translateUi('10% expected house edge')}</span>
          <span>{translateUi('3.6× return per matching number')}</span>
        </div>
        <div className="keno-practice-note">
          {translateUi(
            'Server practice · No deposits or redeemable prizes · 45 seconds to enter, 15 seconds for results'
          )}
        </div>
        {!connected && (
          <p role="alert" className="px-6 py-3">
            {query.isPending
              ? translateUi('Connecting to the system table…')
              : requestStatus(query.error) === 401
                ? translateUi('Your session has expired. Sign in again to play.')
                : [403, 404].includes(requestStatus(query.error))
                  ? translateUi(
                      'This Keno table is currently unavailable. Please return to the casino.'
                    )
                  : translateUi(
                      'Reconnecting. Ticket entry is paused until a fresh server update arrives.'
                    )}
          </p>
        )}
        {connected && !round && (
          <p role="status" className="px-6 py-3">
            {translateUi('Waiting for the next scheduled round…')}
          </p>
        )}
        <div className="keno-ticket-tabs" role="group" aria-label={translateUi('Keno tickets')}>
          {slots.map((n) => (
            <button key={n} aria-pressed={slot === n} onClick={() => setSlot(n)}>
              {translateUi('Bet') + ' '}
              {n}
              <small>
                {tickets.some((t) => t.slot === n)
                  ? translateUi('Confirmed')
                  : pending && pending.roundId === round?.id && (pending.slot ?? 1) === n
                    ? translateUi('Checking')
                    : translateUi('Draft')}
              </small>
            </button>
          ))}
          {nextSlot && (
            <button
              className="keno-add-ticket"
              disabled={!open || busy || !!storageError}
              onClick={() => {
                if (round) {
                  setDrafts((ds) => ({
                    ...ds,
                    [nextSlot]: { roundId: round.id, picks: [], stakeText: '5' },
                  }));
                  setSlot(nextSlot);
                  setNotice(`Choose numbers for Bet ${nextSlot}.`);
                }
              }}
            >
              {translateUi('+ Add bet')}
            </button>
          )}
        </div>
        <p className="keno-ticket-help">
          {translateUi(
            'Bet {slot} · Up to {maxTickets} tickets per round · Each ticket is confirmed separately',
            { slot: slot, maxTickets: maxTickets }
          )}
        </p>
        {storageError && (
          <p role="alert" className="keno-storage">
            {translateUi(storageError)}
          </p>
        )}
        <div className="keno-layout">
          <div className="keno-board-panel">
            <div className="keno-draw-heading">
              <h2>
                {open
                  ? translateUi('PLACE YOUR TICKET')
                  : round
                    ? translateUi('ENTRIES LOCKED')
                    : translateUi('SYSTEM TABLE')}
              </h2>
              <span
                role="timer"
                aria-label={open ? translateUi('Betting closes in') : translateUi('Next round in')}
              >
                {String(seconds).padStart(2, '0')}
                {translateUi('sec') + ' '}
                <b>{count}/20</b>
              </span>
            </div>
            <div
              className="keno-board"
              role="group"
              aria-label={translateUi('Choose Keno numbers')}
            >
              {Array.from({ length: 80 }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-label={translateUi('Number {n}', { n: n })}
                  aria-pressed={picks.includes(n)}
                  disabled={locked}
                  onClick={() => toggle(n)}
                  className={`keno-number ${picks.includes(n) ? 'is-selected' : ''} ${drawn.includes(n) ? 'is-drawn' : ''} ${hits.includes(n) ? 'is-hit' : ''} ${drawn.at(-1) === n ? 'is-latest' : ''}`}
                >
                  {n}
                  {picks.includes(n) && (
                    <i className="keno-selection-mark" aria-hidden="true">
                      ●
                    </i>
                  )}
                  {hits.includes(n) && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
            <div className="keno-legend">
              <span>
                <i className="legend-selected" />
                {translateUi('Selected')}
              </span>
              <span>
                <i className="legend-drawn" />
                {translateUi('Drawn')}
              </span>
              <span>
                <i className="legend-hit" />
                {translateUi('Match')}
              </span>
            </div>
          </div>
          <aside className="keno-machine-panel">
            <div className="keno-machine-title">
              <span>{translateUi('SERVER BALL REVEAL')}</span>
              <strong>
                {open
                  ? translateUi('Waiting for the draw')
                  : translateUi('{count} of 20', { count: count })}
              </strong>
            </div>
            <KenoMachine number={drawn.at(-1) ?? null} running={!!display?.outcome && count < 20} />
            <div className="keno-result" role="status">
              {count === 20
                ? ticket
                  ? translateUi('{length} matches · {value}', {
                      length: hits.length,
                      value:
                        ticket.payout === null
                          ? translateUi('Return pending')
                          : translateUi('{payout} ETB returned', { payout: ticket.payout }),
                    })
                  : translateUi('Draw complete')
                : count
                  ? translateUi('{count} of 20 balls revealed', { count: count })
                  : ticket
                    ? translateUi('Ticket confirmed. Waiting for the draw.')
                    : translateUi('Select your numbers before the countdown ends.')}
            </div>
          </aside>
        </div>
        <div className="keno-stake-panel">
          <div>
            <label htmlFor="system-keno-stake">{translateUi('Bet amount per number')}</label>
            <div className="keno-stake-row">
              <input
                id="system-keno-stake"
                inputMode="numeric"
                value={ticket || selectedPending ? String(shownStake) : stakeText}
                onChange={(e) => updateDraft({ stakeText: e.target.value })}
                disabled={locked}
              />
              <span>{translateUi('practice ETB')}</span>
            </div>
            <p>{translateUi('Steps of 5 · Maximum 480 ETB per ticket')}</p>
          </div>
          <div className="keno-ticket-summary">
            <span>{translateUi('TOTAL BET')}</span>
            <strong>{translateUi('{cost} ETB', { cost: cost })}</strong>
            <small>
              {translateUi('{length} numbers × {value} ETB', {
                length: picks.length,
                value: shownStake || '—',
              })}
            </small>
          </div>
        </div>
        <div className="keno-controls">
          <div>
            <h2>{translateUi('{length}/10 numbers selected', { length: picks.length })}</h2>
            <p>{translateUi(notice)}</p>
            <p className="keno-picks">
              {picks.join(' · ') || translateUi('Your selections appear here')}
            </p>
          </div>
          <div className="keno-actions">
            <button
              disabled={locked}
              onClick={() => {
                updateDraft({
                  picks: drawKeno()
                    .slice(0, 5)
                    .sort((a, b) => a - b),
                });
              }}
            >
              {translateUi('Quick pick 5')}
            </button>
            <button disabled={locked || !picks.length} onClick={() => updateDraft({ picks: [] })}>
              {translateUi('Clear')}
            </button>
            <button
              className="keno-play"
              disabled={locked || !picks.length || !stake || cost > 480 || cost > (s?.balance ?? 0)}
              onClick={() =>
                round &&
                submit({
                  roundId: round.id,
                  picks: [...picks],
                  stakePerNumber: stake,
                  ...(slot > 1 ? { slot } : {}),
                })
              }
            >
              {ticket
                ? translateUi('Ticket confirmed')
                : pending
                  ? translateUi('Checking ticket…')
                  : translateUi('Confirm ticket · {cost} ETB', { cost: cost })}
            </button>
          </div>
        </div>
        {pending && !mutation.isPending && (
          <div className="px-6 pb-4">
            <button disabled={!connected} onClick={() => submit(pending)}>
              {translateUi('Retry unconfirmed ticket')}
            </button>
          </div>
        )}
        <section className="keno-saved-tickets" aria-label={translateUi('Saved tickets')}>
          {tickets.map((t) => (
            <article key={t.slot}>
              <header>
                <strong>{translateUi('Bet {slot}', { slot: t.slot })}</strong>
                <span>{translateUi('{stake} ETB', { stake: t.stake })}</span>
              </header>
              <p>{t.picks.join(' · ')}</p>
              <small>
                {count === 20
                  ? translateUi('{length} matches · {value}', {
                      length: t.picks.filter((n) => drawn.includes(n)).length,
                      value:
                        t.payout === null
                          ? translateUi('Return pending')
                          : translateUi('{payout} ETB returned', { payout: t.payout }),
                    })
                  : translateUi('Confirmed · waiting for draw')}
              </small>
            </article>
          ))}
        </section>
        <footer className="keno-footer">
          <details>
            <summary>{translateUi('Rules & recent server draws')}</summary>
            <p>
              {translateUi(
                'Choose 1–10 numbers from 1–80. Each matching number returns 3.6× its stake, including the original stake on that number. Twenty different numbers are drawn. The 25% chance × 3.6× return gives 90% theoretical return over repeated play.'
              )}
            </p>
            <p>
              {translateUi(
                'The server runs a new round every minute, including when nobody is watching. Entries close after 45 seconds. Refreshing or reconnecting restores your saved ticket and result. You can confirm up to 10 separate tickets before the deadline. Confirmed tickets cannot be edited. Tickets are never placed automatically. Group PVP uses separate rules and a 7% completion fee.'
              )}
            </p>
            <ol>
              {s?.rounds
                .filter((r) => r.outcome && now >= r.endsAt - 5000)
                .map((r) => (
                  <li key={r.id}>
                    <strong>{r.id}</strong> · {r.outcome!.join(', ')}
                    {(r.tickets ?? (r.ticket ? [{ ...r.ticket, slot: 1 }] : [])).map((t) => (
                      <span key={t.slot}>
                        {' ' +
                          translateUi('· Bet {slot}: {value} ETB', {
                            slot: t.slot,
                            value: t.payout ?? translateUi('pending'),
                          })}
                      </span>
                    ))}
                  </li>
                ))}
            </ol>
          </details>
        </footer>
      </section>
    </div>
  );
}
