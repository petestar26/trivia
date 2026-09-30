import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { SPIN90_MARKETS, SPIN_WHEEL, spinColour } from '@socialplay/shared';
import type { ScheduledPracticeSnapshot, SpinBet } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { SpinWinWheel } from './spin-win';

const ENDPOINT = '/games/scheduled/spin-win';
interface Entry {
  roundId: string;
  bets: SpinBet[];
}
export function SpinWinScheduledPage() {
  const { user } = useAuth();
  return user ? <ScheduledTable key={user.id} userId={user.id} /> : null;
}
function ScheduledTable({ userId }: { userId: string }) {
  const [clock, setClock] = useState(performance.now());
  const [draft, setDraft] = useState<Entry | null>(null);
  const [pending, setPending] = useState<Entry | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(
    'Choose your selections before the shared countdown ends.'
  );
  const [rotation, setRotation] = useState(0);
  const lastDraw = useRef<string | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  const query = useQuery({
    queryKey: ['scheduled-practice', userId],
    queryFn: async ({ signal }) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 8000);
      try {
        const snapshot = unwrapData(
          await api.get<ScheduledPracticeSnapshot>(ENDPOINT, undefined, {
            signal: controller.signal,
          })
        );
        return { snapshot, receivedAt: performance.now() };
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      }
    },
    refetchInterval: 2000,
    retry: false,
  });
  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => setClock(performance.now()), 250);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  const snapshot = query.data?.snapshot;
  // A monotonic timer avoids a local clock change extending the betting window.
  // The server still makes the authoritative cutoff check after taking its lock.
  const elapsed = query.data ? Math.max(0, clock - query.data.receivedAt) : Infinity;
  const now = snapshot ? snapshot.serverTime + elapsed : 0;
  const connected = !!snapshot && !query.isError && elapsed < 5000;
  const current = snapshot?.rounds.find((r) => r.opensAt <= now && now < r.endsAt);
  const recentDraw = snapshot?.rounds.find((r) => r.outcome !== null);
  const open =
    connected && snapshot?.enabled && current?.state === 'OPEN' && now < current.closesAt;
  const accepted = !!current?.ticket || confirmed === current?.id;
  const locked = !open || accepted || sending || !!pending;
  const bets = current && draft?.roundId === current.id ? draft.bets : [];
  const total = bets.reduce((sum, bet) => sum + bet.amount, 0);
  useEffect(() => {
    if (!recentDraw || recentDraw.outcome === null || lastDraw.current === recentDraw.id) return;
    lastDraw.current = recentDraw.id;
    const target =
      (360 - (SPIN_WHEEL.indexOf(recentDraw.outcome as (typeof SPIN_WHEEL)[number]) * 360) / 37) %
      360;
    setRotation((value) => value + 720 + ((target - (value % 360) + 360) % 360));
  }, [recentDraw]);
  const add = (marketId: string) => {
    if (locked || !current || total + 40 > 480) return;
    setDraft({
      roundId: current.id,
      bets: bets.some((b) => b.marketId === marketId)
        ? bets.map((b) => (b.marketId === marketId ? { ...b, amount: b.amount + 40 } : b))
        : [...bets, { marketId, amount: 40 }],
    });
  };
  const submit = async () => {
    if (submitting.current) return;
    const entry =
      pending ?? (open && !accepted && current && total > 0 ? { roundId: current.id, bets } : null);
    if (!entry) return;
    submitting.current = true;
    setPending(entry);
    setSending(true);
    try {
      unwrapData(await api.post(ENDPOINT + '/tickets', entry));
      if (!alive.current) return;
      setConfirmed(entry.roundId);
      setPending(null);
      setDraft(null);
      setMessage('Ticket locked. Every player sees the same server result.');
      await query.refetch();
    } catch (error) {
      if (!alive.current) return;
      let status = 0;
      try {
        status = JSON.parse(error instanceof Error ? error.message : '').status ?? 0;
      } catch {
        /* transport error */
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        setPending(null);
        setMessage(
          'Entry was not accepted. The round may be closed or already have a locked ticket.'
        );
        void query.refetch();
      } else
        setMessage('Confirmation interrupted. Retry this same ticket; do not place a replacement.');
    } finally {
      submitting.current = false;
      if (alive.current) setSending(false);
    }
  };
  const countdown = current ? Math.max(0, Math.ceil((current.closesAt - now) / 1000)) : 0;
  return (
    <section className="mx-auto max-w-7xl space-y-4">
      <Link to="/games/spin-win" className="text-sm text-primary-600">
        ← Solo practice
      </Link>
      <div className="overflow-hidden rounded-3xl border border-slate-700 bg-[#0b1424] text-white shadow-xl">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 p-6">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-amber-200">
              Shared practice table
            </p>
            <h1 className="mt-2 text-3xl font-bold">Spin Win · Scheduled rounds</h1>
          </div>
          <div className="rounded-xl bg-white/5 px-5 py-3 text-right">
            <p className="text-xs text-slate-400">{open ? 'Entry closes in' : 'Table status'}</p>
            <p className="text-xl font-bold tabular-nums text-amber-200">
              {!connected
                ? 'Reconnecting'
                : open
                  ? `${countdown}s`
                  : !snapshot?.enabled
                    ? 'Paused'
                    : current?.outcome !== null && current?.outcome !== undefined
                      ? 'Result published'
                      : 'Waiting for server'}
            </p>
          </div>
        </header>
        <p className="border-b border-amber-200/10 bg-amber-200/5 px-6 py-3 text-sm text-amber-100">
          Practice only · No Coins, deposits, fees or redeemable prizes. Selections lock once per
          round.
        </p>
        <div className="grid gap-6 p-5 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
          <div className="space-y-4">
            <SpinWinWheel rotation={rotation} />
            <div
              role="status"
              className="rounded-xl bg-white/5 p-4 text-center text-sm"
              aria-live="polite"
            >
              {message}
            </div>
            <h2 className="text-sm font-semibold text-amber-100">Recent shared results</h2>
            <div className="flex flex-wrap gap-2">
              {snapshot?.rounds
                .filter((r) => r.outcome !== null)
                .map((r) => (
                  <span
                    key={r.id}
                    title={`Round ${r.sequence}`}
                    className={`rounded-lg px-3 py-2 font-bold ${spinColour(r.outcome!) === 'red' ? 'bg-rose-800' : r.outcome === 0 ? 'bg-emerald-800' : 'bg-slate-700'}`}
                  >
                    {r.outcome}
                  </span>
                ))}
            </div>
            {snapshot?.rounds
              .filter((r) => r.ticket)
              .map((r) => (
                <div key={r.id} className="rounded-xl border border-white/10 p-3 text-sm">
                  <p>Round {r.sequence} · Your locked ticket</p>
                  <p className="mt-1 text-slate-300">
                    Practice stake {r.ticket!.stake} ·{' '}
                    {r.ticket!.payout === null
                      ? 'Awaiting the published result'
                      : `Practice return ${r.ticket!.payout}`}
                  </p>
                </div>
              ))}
            <p className="text-xs text-slate-400">
              Last 12 rounds. Server results survive refresh and reconnect. A delayed result is
              never replaced with a local spin.
            </p>
          </div>
          <div className="space-y-4">
            <h2 className="font-semibold">Choose selections · 40 practice credits per tap</h2>
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
                    disabled={locked || total >= 480}
                    aria-pressed={!!amount}
                    aria-label={`Select ${market.label}`}
                    className={`min-h-12 rounded-lg border p-2 text-sm disabled:opacity-40 ${amount ? 'border-amber-200 bg-amber-200/15' : 'border-white/15 bg-white/5'}`}
                  >
                    {market.label}
                    {amount ? <span className="ml-1 text-amber-200">{amount}</span> : null}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/5 p-4">
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
                disabled={sending || (!pending && (locked || !total))}
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
            {!open && !pending && (
              <p className="text-sm text-slate-300">
                {!connected
                  ? 'Entries stay disabled until a fresh server response arrives.'
                  : !snapshot?.enabled
                    ? 'This practice table is paused. Previously accepted rounds can still finish.'
                    : 'Entry is closed. Wait for the next server-opened round.'}
              </p>
            )}
            <details className="rounded-xl border border-white/10 p-4 text-sm">
              <summary className="cursor-pointer font-semibold text-amber-100">
                Schedule & rules
              </summary>
              <div className="mt-3 space-y-2 text-slate-300">
                <p>
                  45 seconds to join, followed by 10 seconds reveal time and 5 seconds result time.
                  The server must publish a result before it is displayed. Outages may delay rounds.
                </p>
                <p>
                  Uniform single-zero wheel: each number 0–36 has a 1/37 chance. A 40-credit winning
                  exact-number selection returns 1,332; six-number sector 222; dozen 111; outside
                  market 74. Total returns include stake. Zero loses all outside selections.
                </p>
                <p>
                  90% theoretical return over repeated play; individual results vary. Maximum 480
                  practice credits per ticket. This table cannot spend or earn Coins.
                </p>
              </div>
            </details>
          </div>
        </div>
      </div>
    </section>
  );
}
