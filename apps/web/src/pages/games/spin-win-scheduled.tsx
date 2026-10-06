import { SpinStakeInput, parseSpinStake } from '@/components/spin/spin-stake-input';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SpinStage } from '@/components/spin/spin-stage';
import { requestStatus } from '@/lib/request-error';
import { useQuery } from '@tanstack/react-query';
import { SPIN90_MARKETS, SPIN_WHEEL } from '@socialplay/shared';
import type { ScheduledPracticeSnapshot, SpinBet } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

const ENDPOINT = '/games/scheduled/spin-win';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_SNAPSHOT_AGE_MS = 5000;
const MAX_TIMING_UNCERTAINTY_MS = 1000;
interface Entry {
  roundId: string;
  bets: SpinBet[];
}
interface Submission {
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
export function SpinWinScheduledPage() {
  const { user } = useAuth();
  return user ? <ScheduledTable key={user.id} userId={user.id} /> : null;
}
function ScheduledTable({ userId }: { userId: string }) {
  const [stakeText, setStakeText] = useState('40');
  const chip = parseSpinStake(stakeText, 480);
  const [clock, setClock] = useState(performance.now());
  const [draft, setDraft] = useState<Entry | null>(null);
  const [pending, setPending] = useState<Entry | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(
    'Choose your selections before the system countdown ends.'
  );
  const [rotation, setRotation] = useState(0);
  const lastDraw = useRef<string | null>(null);
  const submission = useRef<Submission | null>(null);
  const alive = useRef(true);
  const releaseSubmission = () => {
    const attempt = submission.current;
    submission.current = null;
    if (attempt) {
      clearTimeout(attempt.timer);
      attempt.controller.abort();
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
    refetchInterval: (query) => (requestStatus(query.state.error) === 401 ? false : 2000),
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
  // Charge the full request round trip to the server clock. This is a conservative
  // upper bound: response transit cannot extend the entry window. Slow samples
  // cannot enable entry, and freshness starts at request dispatch, not receipt.
  // Read performance.now() here too so a response between interval ticks is aged.
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
  const recentDraw = snapshot?.rounds.find((r) => r.outcome !== null);
  const open =
    connected && snapshot?.enabled && current?.state === 'OPEN' && now < current.closesAt;
  const accepted = !!current?.ticket || confirmed === current?.id;
  const locked = !open || accepted || sending || !!pending;
  const bets = current && draft?.roundId === current.id ? draft.bets : [];
  const total = bets.reduce((sum, bet) => sum + bet.amount, 0);
  useEffect(() => {
    // A GET can prove admission even if its POST response never arrives. Tickets
    // are immutable per user/round; the stored ticket is authoritative, including
    // when another tab submitted it. Old request callbacks must not change state.
    if (!pending || !snapshot?.rounds.some((r) => r.id === pending.roundId && r.ticket)) return;
    releaseSubmission();
    setSending(false);
    setConfirmed(pending.roundId);
    setPending(null);
    setDraft((value) => (value?.roundId === pending.roundId ? null : value));
    setMessage('Your saved ticket is locked. Every player sees the same server result.');
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
    if (!open || !query.data || !current) return false;
    const age = Math.max(0, performance.now() - query.data.startedAt);
    return age < MAX_SNAPSHOT_AGE_MS && snapshot!.serverTime + age < current.closesAt;
  };
  const add = (marketId: string) => {
    if (locked || !chip || !canEnterNow() || !current || total + chip > 480) return;
    setDraft({
      roundId: current.id,
      bets: bets.some((b) => b.marketId === marketId)
        ? bets.map((b) => (b.marketId === marketId ? { ...b, amount: b.amount + chip } : b))
        : [...bets, { marketId, amount: chip }],
    });
  };
  const submit = async () => {
    if (submission.current || !connected) return;
    const entry =
      pending ??
      (canEnterNow() && !accepted && current && total > 0 ? { roundId: current.id, bets } : null);
    if (!entry) return;
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
      setConfirmed(entry.roundId);
      setPending(null);
      setDraft(null);
      setMessage('Ticket locked. Every player sees the same server result.');
      void query.refetch();
    } catch (error) {
      if (!alive.current || submission.current !== attempt) return;
      const status = requestStatus(error);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        setPending(null);
        setMessage(
          'Entry was not accepted. The round may be closed or already have a locked ticket.'
        );
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
        : message;
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
            state={{ from: { pathname: '/games/spin-win/live' } }}
            className="inline-block rounded-lg bg-amber-200 px-4 py-2 font-semibold text-slate-950"
          >
            Sign in again
          </Link>
        )}
        {snapshot?.rounds
          .filter((r) => r.ticket)
          .map((r) => (
            <div key={r.id} className="rounded-xl border border-white/15 p-3 text-sm">
              <p>Round {r.sequence} · Your locked ticket</p>
              <p className="mt-1 text-emerald-100/70">
                Practice stake {r.ticket!.stake} ·{' '}
                {r.ticket!.payout === null
                  ? 'Awaiting the published result'
                  : `Practice return ${r.ticket!.payout}`}
              </p>
            </div>
          ))}
        <SpinStakeInput value={stakeText} onChange={setStakeText} maximum={480} disabled={locked} />
        <h2 className="font-semibold">Choose selections</h2>
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
                onClick={() => add(market.id)}
                disabled={locked || !chip || total + chip > 480}
                aria-pressed={!!amount}
                aria-label={`Select ${market.label}`}
                className={`min-h-12 rounded-lg border p-2 text-sm focus-visible:ring-2 focus-visible:ring-amber-200 disabled:opacity-40 ${amount ? 'border-amber-200 bg-amber-200/15' : 'border-white/15 bg-black/20'}`}
              >
                {market.label}
                {amount ? <span className="ml-1 text-amber-200">{amount}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#d6b475]/30 bg-[#07281f]/95 p-4 shadow-xl">
          <p>
            Total: <strong>{total}</strong> practice credits
          </p>
          <button
            onClick={() => setDraft(null)}
            disabled={locked || !total}
            className="rounded-lg border border-white/20 px-4 py-2 disabled:opacity-40"
          >
            Clear
          </button>
          <button
            onClick={() => void submit()}
            disabled={sending || !connected || (!pending && (locked || !total))}
            className="rounded-lg bg-amber-200 px-5 py-3 font-bold text-slate-950 disabled:opacity-40"
          >
            {sending
              ? 'Confirming…'
              : pending
                ? 'Retry same ticket'
                : accepted
                  ? 'Ticket locked'
                  : 'Join this practice round'}
          </button>
        </div>
        {!open && !pending && connected && snapshot?.enabled && (
          <p className="text-sm text-emerald-100/70">
            Entry is closed. Wait for the next server-opened round.
          </p>
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
              Each number 0–36 has a 1/37 chance. A 40-credit exact-number win returns 1,332; sector
              222; dozen 111; outside 74. Returns include stake. Zero loses outside selections.
            </p>
            <p>
              90% theoretical return over repeated play; maximum 480 practice credits per ticket.
              This table cannot spend or earn Coins. The last 12 results survive refresh and
              reconnect.
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