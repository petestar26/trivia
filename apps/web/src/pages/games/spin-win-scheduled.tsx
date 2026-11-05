import { SpinStakeInput, parseSpinStake } from '@/components/spin/spin-stake-input';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SpinStage } from '@/components/spin/spin-stage';
import { requestStatus } from '@/lib/request-error';
import { useQuery } from '@tanstack/react-query';
import {
  parseSpin90Bets,
  SCHEDULED_SPIN_MAX_TICKETS,
  SPIN90_MARKETS,
  SPIN_WHEEL,
} from '@socialplay/shared';
import type {
  ScheduledPracticeRound,
  ScheduledPracticeSnapshot,
  SpinBet,
} from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

const ENDPOINT = '/games/scheduled/spin-win';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_SNAPSHOT_AGE_MS = 5000;
const MAX_TIMING_UNCERTAINTY_MS = 1000;
interface Entry {
  roundId: string;
  slot: number;
  bets: SpinBet[];
}
interface Draft {
  bets: SpinBet[];
  stakeText: string;
}
interface Editor {
  roundId: string;
  slot: number;
  drafts: Record<number, Draft>;
}
interface Submission {
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
const storageKey = (id: string) => `salem.spin.pending.v1.${id}`;
const emptyDraft = (): Draft => ({ bets: [], stakeText: '40' });
const stakeOf = (bets: SpinBet[]) => bets.reduce((sum, bet) => sum + bet.amount, 0);
const labels = (bets: SpinBet[]) =>
  bets
    .map(
      (b) =>
        `${SPIN90_MARKETS.find((m) => m.id === b.marketId)?.label ?? b.marketId} · ${b.amount} ETB`
    )
    .join(' / ');
const savedTickets = (round?: ScheduledPracticeRound) =>
  round?.tickets ?? (round?.ticket ? [{ ...round.ticket, slot: 1 }] : []);
export function readSpinPending(id: string): Entry | null {
  const raw = sessionStorage.getItem(storageKey(id));
  if (!raw) return null;
  const entry = JSON.parse(raw) as Entry;
  if (
    !entry ||
    typeof entry.roundId !== 'string' ||
    !/^spin-win-practice-v1:[0-9]{1,16}$/.test(entry.roundId) ||
    !Number.isInteger(entry.slot) ||
    entry.slot < 1 ||
    entry.slot > SCHEDULED_SPIN_MAX_TICKETS
  )
    throw Error('Invalid saved ticket');
  const bets = parseSpin90Bets(entry.bets);
  if (stakeOf(bets) > 480) throw Error('Invalid saved stake');
  return { roundId: entry.roundId, slot: entry.slot, bets };
}
export function SpinWinScheduledPage() {
  const { user } = useAuth();
  return user ? <ScheduledTable key={user.id} userId={user.id} /> : null;
}
function ScheduledTable({ userId }: { userId: string }) {
  const [initial] = useState(() => {
    try {
      return { entry: readSpinPending(userId), error: '' };
    } catch {
      return {
        entry: null,
        error: 'Browser storage could not be read. Restore storage and reload before entering.',
      };
    }
  });
  const [storageError, setStorageError] = useState(initial.error);
  const [clock, setClock] = useState(performance.now());
  const [editor, setEditor] = useState<Editor | null>(
    initial.entry ? { roundId: initial.entry.roundId, slot: initial.entry.slot, drafts: {} } : null
  );
  const [pending, setPending] = useState<Entry | null>(initial.entry);
  const [confirmed, setConfirmed] = useState<Entry[]>([]);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [rotation, setRotation] = useState(0);
  const lastDraw = useRef<string | null>(null);
  const submission = useRef<Submission | null>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const selectedTab = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const releaseSubmission = () => {
    const attempt = submission.current;
    submission.current = null;
    if (attempt) {
      clearTimeout(attempt.timer);
      attempt.controller.abort();
    }
  };
  const clearPending = () => {
    setPending(null);
    try {
      sessionStorage.removeItem(storageKey(userId));
    } catch {
      setStorageError('Could not clear your saved ticket. Restore browser storage and reload.');
    }
  };
  const query = useQuery({
    queryKey: ['scheduled-practice', userId],
    queryFn: async ({ signal }) => {
      const startedAt = performance.now();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
      try {
        const snapshot = unwrapData(
          await api.get<ScheduledPracticeSnapshot>(ENDPOINT, undefined, {
            signal: controller.signal,
          })
        );
        return { snapshot, startedAt, receivedAt: performance.now() };
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      }
    },
    refetchInterval: (q) => ([401, 403, 404].includes(requestStatus(q.state.error)) ? false : 2000),
    retry: false,
  });
  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => setClock(performance.now()), 250);
    return () => {
      alive.current = false;
      releaseSubmission();
      clearInterval(timer);
    };
  }, []);
  const snapshot = query.data?.snapshot;
  // Charge the full round trip to server time. Slow or stale samples cannot extend entry.
  const sampledAt = Math.max(clock, performance.now());
  const elapsed = query.data ? Math.max(0, sampledAt - query.data.startedAt) : Infinity;
  const now = snapshot ? snapshot.serverTime + elapsed : 0;
  const signInRequired = requestStatus(query.error) === 401;
  const connected =
    !!query.data &&
    !query.isError &&
    !query.isPaused &&
    query.data.receivedAt - query.data.startedAt <= MAX_TIMING_UNCERTAINTY_MS &&
    elapsed < MAX_SNAPSHOT_AGE_MS;
  const current = snapshot?.rounds.find((r) => r.opensAt <= now && now < r.endsAt);
  const display = current ?? snapshot?.rounds[0];
  useEffect(() => setMessage(''), [display?.id]);
  const recentDraw = snapshot?.rounds.find((r) => r.outcome !== null);
  const open = !!(
    connected &&
    snapshot?.enabled &&
    current?.state === 'OPEN' &&
    now < current.closesAt
  );
  const maxTickets = Number.isInteger(snapshot?.maxTickets)
    ? Math.max(1, Math.min(SCHEDULED_SPIN_MAX_TICKETS, snapshot!.maxTickets!))
    : 1;
  const sameEditor = editor?.roundId === display?.id ? editor : null;
  const slot = sameEditor?.slot ?? (pending && pending.roundId === display?.id ? pending.slot : 1);
  useEffect(() => {
    const strip = tabStrip.current,
      selected = selectedTab.current;
    if (!strip || !selected) return;
    if (selected.offsetLeft < strip.scrollLeft) strip.scrollLeft = selected.offsetLeft;
    else if (selected.offsetLeft + selected.offsetWidth > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = selected.offsetLeft + selected.offsetWidth - strip.clientWidth;
  }, [slot, display?.id]);
  const drafts = sameEditor?.drafts ?? {};
  const serverTickets = savedTickets(display);
  const tickets = [
    ...serverTickets,
    ...confirmed
      .filter((e) => e.roundId === display?.id && !serverTickets.some((t) => t.slot === e.slot))
      .map((e) => ({ ...e, stake: stakeOf(e.bets), payout: null })),
  ].sort((a, b) => a.slot - b.slot);
  const ticket = tickets.find((t) => t.slot === slot);
  const accepted = !!ticket;
  const selectedPending =
    pending && pending.roundId === display?.id && pending.slot === slot ? pending : null;
  const draft = drafts[slot] ?? emptyDraft();
  const bets = ticket?.bets ?? selectedPending?.bets ?? draft.bets;
  const stakeText = draft.stakeText;
  const chip = parseSpinStake(stakeText, 480);
  const total = stakeOf(bets);
  const locked = !open || accepted || sending || !!pending || !!storageError || slot > maxTickets;
  const slots = [
    ...new Set([
      1,
      ...Object.keys(drafts).map(Number),
      ...tickets.map((t) => t.slot),
      ...(pending && pending.roundId === display?.id ? [pending.slot] : []),
    ]),
  ].sort((a, b) => a - b);
  const nextSlot = Array.from({ length: maxTickets }, (_, i) => i + 1).find(
    (n) => !slots.includes(n)
  );
  const edit = (patch: Partial<Draft>) => {
    if (!current || locked) return;
    setEditor({ roundId: current.id, slot, drafts: { ...drafts, [slot]: { ...draft, ...patch } } });
  };
  const chooseSlot = (n: number) => {
    if (!display) return;
    setEditor({
      roundId: display.id,
      slot: n,
      drafts: { ...drafts, [n]: drafts[n] ?? emptyDraft() },
    });
  };
  useEffect(() => {
    // Only the matching slot can resolve this pending request; another saved bet cannot.
    if (pending) {
      const round = snapshot?.rounds.find((r) => r.id === pending.roundId);
      const receipt = savedTickets(round).find((t) => t.slot === pending.slot);
      if (receipt) {
        releaseSubmission();
        setSending(false);
        clearPending();
        setMessage(`Bet ${pending.slot} is saved. Its confirmed selections are shown below.`);
      }
    }
    setConfirmed((entries) =>
      entries.filter((e) => snapshot?.rounds.some((r) => r.id === e.roundId))
    );
  }, [pending, snapshot]);
  useEffect(() => {
    if (!recentDraw || recentDraw.outcome === null || lastDraw.current === recentDraw.id) return;
    lastDraw.current = recentDraw.id;
    const target =
      (360 - (SPIN_WHEEL.indexOf(recentDraw.outcome as (typeof SPIN_WHEEL)[number]) * 360) / 37) %
      360;
    setRotation((value) => value + 720 + ((target - (value % 360) + 360) % 360));
  }, [recentDraw]);
  const canEnterNow = () => {
    if (!open || !query.data || !current || slot > maxTickets) return false;
    const age = Math.max(0, performance.now() - query.data.startedAt);
    return age < MAX_SNAPSHOT_AGE_MS && snapshot!.serverTime + age < current.closesAt;
  };
  const add = (marketId: string) => {
    if (locked || !chip || !canEnterNow() || total + chip > 480) return;
    edit({
      bets: bets.some((b) => b.marketId === marketId)
        ? bets.map((b) => (b.marketId === marketId ? { ...b, amount: b.amount + chip } : b))
        : [...bets, { marketId, amount: chip }],
    });
  };
  const submit = async () => {
    if (submission.current || !connected || storageError || (pending?.slot ?? slot) > maxTickets)
      return;
    const entry =
      pending ??
      (canEnterNow() && !accepted && current && total > 0
        ? { roundId: current.id, slot, bets: parseSpin90Bets(bets) }
        : null);
    if (!entry) return;
    try {
      sessionStorage.setItem(storageKey(userId), JSON.stringify(entry));
    } catch {
      setStorageError(
        'Could not save your ticket safely. Restore browser storage before entering.'
      );
      return;
    }
    const attempt: Submission = { controller: new AbortController() };
    submission.current = attempt;
    setPending(entry);
    setSending(true);
    attempt.timer = setTimeout(() => {
      if (submission.current !== attempt) return;
      releaseSubmission();
      setSending(false);
      setMessage('Confirmation interrupted. Retry this same ticket; do not place a replacement.');
      void query.refetch();
    }, REQUEST_TIMEOUT_MS);
    try {
      unwrapData(
        await api.post(ENDPOINT + '/tickets', entry, undefined, {
          signal: attempt.controller.signal,
        })
      );
      if (!alive.current || submission.current !== attempt) return;
      setConfirmed((entries) => [
        ...entries.filter((e) => e.roundId !== entry.roundId || e.slot !== entry.slot),
        entry,
      ]);
      clearPending();
      setMessage(`Bet ${entry.slot} confirmed. Add another bet before entry closes.`);
      void query.refetch();
    } catch (error) {
      if (!alive.current || submission.current !== attempt) return;
      const status = requestStatus(error);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        clearPending();
        setMessage('Entry was not accepted. The round may be closed or this bet already saved.');
        void query.refetch();
      } else
        setMessage('Confirmation interrupted. Retry this same ticket; do not place a replacement.');
    } finally {
      if (submission.current === attempt) {
        releaseSubmission();
        if (alive.current) setSending(false);
      }
    }
  };
  const countdown = current ? Math.max(0, Math.ceil((current.closesAt - now) / 1000)) : 0;
  const tableStatus = signInRequired
    ? 'Sign in again'
    : !snapshot && query.isPending
      ? 'Connecting'
      : !connected
        ? 'Reconnecting'
        : open
          ? `${countdown}s · entry closes`
          : !snapshot?.enabled
            ? 'Paused'
            : current?.outcome !== null && current?.outcome !== undefined
              ? 'Result published'
              : 'Waiting for server';
  const status = signInRequired
    ? 'Your session is unavailable. Sign in again to reconnect.'
    : !connected
      ? 'Entries stay disabled until a fresh server response arrives.'
      : !snapshot?.enabled
        ? 'This practice table is paused. Previously accepted rounds can still finish.'
        : storageError ||
          ((open || pending) && message) ||
          (open
            ? 'Choose your selections, then confirm each bet before the countdown ends.'
            : current?.outcome !== null && current?.outcome !== undefined
              ? 'Shared result published. Each saved bet has its own return.'
              : 'Entries closed. Waiting for the shared result.');
  const history =
    snapshot?.rounds.filter((r) => r.id !== display?.id && savedTickets(r).length) ?? [];
  return (
    <SpinStage
      mode="scheduled"
      rotation={rotation}
      number={recentDraw?.outcome ?? null}
      outcomes={snapshot?.rounds.filter((r) => r.outcome !== null).map((r) => r.outcome!) ?? []}
      status={status}
      balance={tableStatus}
    >
      <div className="space-y-4">
        {signInRequired && (
          <Link
            to="/login"
            state={{ from: { pathname: '/games/spin-win' } }}
            className="inline-block rounded-lg bg-amber-200 px-4 py-2 font-semibold text-slate-950"
          >
            Sign in again
          </Link>
        )}
        {storageError && (
          <p
            role="alert"
            className="rounded-lg border border-amber-200/40 bg-amber-200/10 p-3 text-sm text-amber-100"
          >
            {storageError}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">
            Your bets{' '}
            <span className="ml-2 text-xs font-normal text-emerald-100/70">
              {tickets.length} / {maxTickets} confirmed
            </span>
          </h2>
          <span className="text-xs text-emerald-100/70">
            {display ? `Round ${display.sequence}` : 'Waiting for a round'}
          </span>
        </div>
        <div role="group" aria-label="Your Spin bets" className="flex items-stretch gap-2">
          <div ref={tabStrip} className="relative flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
            {slots.map((n) => {
              const saved = tickets.some((t) => t.slot === n);
              const waiting = pending && pending.roundId === display?.id && pending.slot === n;
              return (
                <button
                  key={n}
                  ref={slot === n ? selectedTab : undefined}
                  type="button"
                  aria-pressed={slot === n}
                  onClick={() => chooseSlot(n)}
                  className={`min-w-[82px] shrink-0 rounded-xl border px-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-100 ${slot === n ? 'border-amber-100 bg-amber-200 font-bold text-slate-950 shadow-md' : 'border-white/20 bg-black/20 text-emerald-50'}`}
                >
                  <span className="block text-sm">Bet {n}</span>
                  <span className="mt-1 block text-[10px] opacity-80">
                    {saved ? 'Confirmed' : waiting ? 'Checking' : 'Draft'}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={!open || sending || !!pending || !!storageError || !nextSlot}
            onClick={() => nextSlot && canEnterNow() && chooseSlot(nextSlot)}
            className="min-w-[92px] shrink-0 rounded-xl border border-dashed border-amber-200/40 px-3 py-3 text-xs font-semibold text-amber-100 focus-visible:ring-2 focus-visible:ring-amber-100 disabled:opacity-40"
          >
            + Add bet
          </button>
        </div>
        <p className="text-xs text-emerald-100/75">
          Each bet has its own selections and total. All bets use the same Spin result.
        </p>
        <SpinStakeInput
          currency="practice ETB"
          value={stakeText}
          onChange={(value) => edit({ stakeText: value })}
          maximum={480}
          disabled={locked}
        />
        <h2 className="font-semibold">
          {accepted ? `Bet ${slot} · Confirmed selections` : `Bet ${slot} · Choose selections`}
        </h2>
        <div
          role="group"
          aria-label="Scheduled practice markets"
          className="grid grid-cols-3 gap-2 sm:grid-cols-6"
        >
          {SPIN90_MARKETS.map((market) => {
            const amount = bets.find((b) => b.marketId === market.id)?.amount;
            return (
              <button
                key={market.id}
                type="button"
                onClick={() => add(market.id)}
                disabled={locked || !chip || total + chip > 480}
                aria-pressed={!!amount}
                aria-label={`Select ${market.label}`}
                className={`min-h-12 rounded-lg border p-2 text-sm focus-visible:ring-2 focus-visible:ring-amber-200 ${amount ? 'border-amber-100 bg-amber-200 font-bold text-slate-950 ring-1 ring-amber-100' : 'border-white/15 bg-black/20 disabled:opacity-40'}`}
              >
                <span className="block">{market.label}</span>
                {amount ? <span className="mt-1 block text-xs font-bold">{amount} ETB</span> : null}
              </button>
            );
          })}
        </div>
        {total > 0 && (
          <div
            className="rounded-xl border border-amber-200/30 bg-black/15 p-3 text-sm"
            aria-label={`Bet ${slot} summary`}
          >
            <p className="font-semibold text-amber-100">
              {accepted ? 'Confirmed selection' : 'Selected for this bet'}
            </p>
            <p className="mt-1 leading-relaxed text-emerald-50">{labels(bets)}</p>
            {ticket && (
              <p className="mt-2 font-semibold text-amber-100">
                {ticket.payout === null
                  ? 'Awaiting the published result'
                  : `Practice return ${ticket.payout} ETB`}
              </p>
            )}
          </div>
        )}
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#d6b475]/30 bg-[#07281f]/95 p-4 shadow-xl">
          <p className="text-sm">
            Bet {slot} total: <strong>{total}</strong> ETB
            {pending && (
              <span className="mt-1 block text-xs text-amber-100">
                Checking Bet {pending.slot} · Round {pending.roundId.split(':')[1]}
              </span>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => edit({ bets: [] })}
              disabled={locked || !total}
              className="rounded-lg border border-white/20 px-4 py-2 text-sm disabled:opacity-40"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={
                sending ||
                !connected ||
                !!storageError ||
                (pending?.slot ?? slot) > maxTickets ||
                (!pending && (locked || !total))
              }
              className="rounded-lg bg-amber-200 px-5 py-3 text-sm font-bold text-slate-950 disabled:opacity-40"
            >
              {sending
                ? 'Confirming…'
                : pending
                  ? 'Retry same ticket'
                  : accepted
                    ? `Bet ${slot} confirmed`
                    : `Confirm Bet ${slot}`}
            </button>
          </div>
        </div>
        {!open && !pending && connected && snapshot?.enabled && (
          <p className="text-sm text-emerald-100/70">
            Entry is closed. Wait for the next server-opened round.
          </p>
        )}
        {tickets.length > 0 && (
          <section aria-label="Saved Spin bets" className="space-y-2">
            <h2 className="text-sm font-semibold text-amber-100">Saved bets this round</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {tickets.map((t) => (
                <button
                  key={t.slot}
                  type="button"
                  onClick={() => chooseSlot(t.slot)}
                  className={`rounded-xl border p-3 text-left text-xs focus-visible:ring-2 focus-visible:ring-amber-100 ${slot === t.slot ? 'border-amber-200/70 bg-amber-200/10' : 'border-white/15 bg-black/15'}`}
                >
                  <span className="flex justify-between gap-3 font-bold text-amber-100">
                    <span>Bet {t.slot}</span>
                    <span>{t.stake} ETB</span>
                  </span>
                  <span className="mt-2 block leading-relaxed text-emerald-100/80">
                    {labels(t.bets)}
                  </span>
                  <span className="mt-2 block font-semibold">
                    {t.payout === null ? 'Confirmed · awaiting result' : `Return ${t.payout} ETB`}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        {history.length > 0 && (
          <details className="rounded-xl border border-white/15 p-4 text-sm">
            <summary className="cursor-pointer font-semibold text-amber-100">
              Recent tickets
            </summary>
            <div className="mt-3 space-y-3">
              {history.map((r) => (
                <div key={r.id} className="space-y-2 border-b border-white/10 pb-3">
                  <p className="font-semibold">
                    Round {r.sequence} · Result {r.outcome ?? 'pending'}
                  </p>
                  {savedTickets(r).map((t) => (
                    <div key={t.slot}>
                      <p>
                        Bet {t.slot} · Stake {t.stake} ETB ·{' '}
                        {t.payout === null ? 'Return pending' : `Return ${t.payout} ETB`}
                      </p>
                      <p className="text-xs leading-relaxed text-emerald-100/70">
                        {labels(t.bets)}
                      </p>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </details>
        )}
        <details className="rounded-xl border border-white/10 p-4 text-sm">
          <summary className="cursor-pointer font-semibold text-amber-100">
            Schedule & rules
          </summary>
          <div className="mt-3 space-y-2 text-emerald-100/70">
            <p>
              45 seconds to join, followed by 10 seconds reveal time and 5 seconds result time. The
              server publishes the result; outages can delay rounds.
            </p>
            <p>
              Each number 0–36 has a 1/37 chance. A 40 ETB exact-number win returns 1,332; sector
              222; dozen 111; outside 74. Returns include stake. Zero loses outside selections.
            </p>
            <p>
              Up to {maxTickets} independent bets per round. Use steps of 40 ETB, with at most 480
              practice ETB per ticket. Each tap adds the entered amount to that selection. Confirmed
              bets cannot be changed.
            </p>
            <p>
              90% theoretical return over repeated play. These practice selections do not debit a
              balance or earn cash. Your saved tickets and the last 12 results survive refresh. No
              automatic repeat bets.
            </p>
            <Link to="/games/spin-win/verify" className="text-amber-200 underline">
              Round-proof verifier
            </Link>
          </div>
        </details>
      </div>
    </SpinStage>
  );
}
