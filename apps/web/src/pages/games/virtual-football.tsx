import { clubById } from '@/lib/football/clubs';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  VF_RULES_DIGEST,
  VF_RULES_ID,
  VF_TIMING,
  cycleAt,
  fixtureOffer,
  matchweekId,
  parseTicketInput,
  TicketRuleError,
  type VfAdmission,
  type VfFixtureView,
  type VfMatchweekView,
  type VfSnapshot,
  type VfTicketView,
} from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useAuth } from '@/providers/auth-provider';
import { ClubBadge } from '@/components/football/club-badge';
import { MatchCentre, Scoreboard, Scorecard } from '@/components/football/match-centre';
import { MarketPanel } from '@/components/football/markets';
import { ReviewDialog, Slip } from '@/components/football/slip';
import { ResultsPanel, StandingsPanel, TicketsPanel } from '@/components/football/results';
import { RulesDialog } from '@/components/football/rules-dialog';
import { GameArena } from '@/components/games/game-arena';
import { createFootballAudio } from '@/lib/football/audio';
import {
  createServerClock,
  ServerClockProvider,
  useServerNow,
  type ServerClock,
} from '@/lib/football/clock';
import { isDefinitiveRefusal, parseFootballError, refusalMessage } from '@/lib/football/errors';
import { weekLabel } from '@/lib/football/fixtures';
import { formatClock, formatCredits } from '@/lib/football/format';
import { useReducedMotion } from '@/lib/football/motion';
import {
  clearPending,
  loadPending,
  newReceiptKey,
  savePending,
  type PendingReceipt,
} from '@/lib/football/receipts';
import { displayFixture, matchweekRevealAt, type DisplayFixture } from '@/lib/football/reveal';
import {
  buildLines,
  currentQuote,
  emptySlip,
  previewSlip,
  slipReducer,
  stalePicks,
} from '@/lib/football/slip';
import './virtual-football.css';

const FootballScene = lazy(() => import('@/components/football/football-scene'));
const endpoint = '/games/virtual-football';
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

type Tab = 'markets' | 'results' | 'table' | 'tickets';
type Notice = { kind: 'ok' | 'error' | 'info'; text: string } | null;

export function VirtualFootballPage() {
  const { user } = useAuth();
  return user ? <FootballConnected key={user.id} userId={user.id} /> : null;
}

function FootballConnected({ userId }: { userId: string }) {
  const clock = useMemo(() => createServerClock(), []);
  useEffect(() => {
    // A sleeping tab can freeze the monotonic timer, so nothing may be confirmed until resynced.
    const stale = () => {
      if (!document.hidden) clock.invalidate();
    };
    document.addEventListener('visibilitychange', stale);
    window.addEventListener('online', stale);
    window.addEventListener('pageshow', stale);
    return () => {
      document.removeEventListener('visibilitychange', stale);
      window.removeEventListener('online', stale);
      window.removeEventListener('pageshow', stale);
    };
  }, [clock]);
  return (
    <ServerClockProvider clock={clock}>
      <FootballGame userId={userId} clock={clock} />
    </ServerClockProvider>
  );
}

/** Live display of one fixture from the server clock, re-rendered only when it changes. */
function useDisplay(
  fixture: VfFixtureView,
  week: Pick<VfMatchweekView, 'kickoffAt'>,
  quantumMs: number
): DisplayFixture {
  const server = useServerNow(quantumMs);
  return useMemo(
    () => displayFixture(fixture.live, (server ?? week.kickoffAt) - week.kickoffAt),
    [fixture.live, server, week.kickoffAt]
  );
}

function LiveScorecard({
  fixture,
  week,
  selected,
  picked,
  onSelect,
}: {
  fixture: VfFixtureView;
  week: VfMatchweekView;
  selected: boolean;
  picked: number;
  onSelect: () => void;
}) {
  const display = useDisplay(fixture, week, 250);
  return (
    <Scorecard
      fixture={fixture}
      display={display}
      selected={selected}
      picked={picked}
      onSelect={onSelect}
    />
  );
}
function LiveBoard({ fixture, week }: { fixture: VfFixtureView; week: VfMatchweekView }) {
  const display = useDisplay(fixture, week, 100);
  return (
    <Scoreboard fixture={fixture} display={display} week={weekLabel(week.seasonNo, week.weekNo)} />
  );
}
function LiveCentre({ fixture, week }: { fixture: VfFixtureView; week: VfMatchweekView }) {
  const display = useDisplay(fixture, week, 100);
  return (
    <MatchCentre fixture={fixture} display={display} week={weekLabel(week.seasonNo, week.weekNo)} />
  );
}

/** Where the matchweek is, in words, with the countdown that matters right now. */
function PhaseBar({
  week,
  live,
  nextOpensAt,
}: {
  week: VfMatchweekView;
  live: boolean;
  nextOpensAt: number | null;
}) {
  const server = useServerNow(250) ?? week.opensAt;
  let label: string;
  let clockText = '';
  let phase: string;
  if (!live) {
    phase = 'past';
    label = 'Last played matchweek';
    if (nextOpensAt !== null && nextOpensAt > server) {
      label += ' · next opens in';
      clockText = formatClock(nextOpensAt - server);
    }
  } else if (server < week.opensAt) {
    phase = 'wait';
    label = 'Next matchweek opens in';
    clockText = formatClock(week.opensAt - server);
  } else if (server < week.kickoffAt) {
    phase = 'open';
    label = 'Selections open · close in';
    clockText = formatClock(week.kickoffAt - server);
  } else if (server < week.halftimeAt) {
    phase = 'play';
    label = 'First half';
  } else if (server < week.secondHalfAt) {
    phase = 'play';
    label = 'Half-time';
  } else if (server < week.fullTimeAt) {
    phase = 'play';
    label = 'Second half';
  } else if (server < week.endsAt) {
    phase = 'results';
    label = 'Full time · next matchweek in';
    clockText = formatClock(week.endsAt - server);
  } else {
    phase = 'wait';
    label = 'Loading the next matchweek…';
  }
  const remaining = week.kickoffAt - server;
  const announce =
    live && remaining > 0 && remaining <= 10_000
      ? 'Selections close in 10 seconds'
      : live && remaining > 0 && remaining <= 30_000
        ? 'Selections close in 30 seconds'
        : live && server >= week.kickoffAt && server < week.kickoffAt + 1500
          ? 'Selections are closed. Kick-off.'
          : '';
  return (
    <div className="vf-phase" data-phase={phase}>
      <span className="vf-phase-dot" aria-hidden="true" />
      <span>
        {label} {clockText && <b>{clockText}</b>}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}

/** Nothing is on yet: a matchweek only exists if someone opens the game while its selections are open. */
function NextMatchweek({ endsAt }: { endsAt: number }) {
  const server = useServerNow(250) ?? 0;
  const left = endsAt - server;
  return (
    <p role="status" className="vf-solo-note">
      {left > 0
        ? `The next matchweek opens in ${formatClock(left)}. Matches are created only while selections are open, so a matchweek that nobody opens is never played.`
        : 'The next matchweek is opening…'}
    </p>
  );
}

/** Whistles at the moments the server clock crosses the phase boundaries (not on first load). */
function usePhaseWhistles(
  week: VfMatchweekView | null,
  live: boolean,
  audio: ReturnType<typeof createFootballAudio>,
  sound: boolean
) {
  const server = useServerNow(250);
  const phase =
    !week || !live || server === null
      ? null
      : server < week.kickoffAt
        ? 'open'
        : server < week.halftimeAt
          ? 'first'
          : server < week.secondHalfAt
            ? 'half'
            : server < week.fullTimeAt
              ? 'second'
              : 'full';
  const previous = useRef<{ id: string; phase: string | null } | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = week ? { id: week.id, phase } : null;
    if (
      !sound ||
      !week ||
      !before ||
      before.id !== week.id ||
      before.phase === phase ||
      phase === null ||
      before.phase === null
    )
      return;
    if (phase === 'first') audio.whistle('kickoff');
    else if (phase === 'half') audio.whistle('half');
    else if (phase === 'second') audio.whistle('half');
    else if (phase === 'full') audio.whistle('full');
  }, [phase, week, sound, audio]);
}

function FootballGame({ userId, clock }: { userId: string; clock: ServerClock }) {
  const serverNow = useServerNow(250);
  const [weekView, setWeekView] = useState<{ seasonNo: number; weekNo: number } | null>(null);
  const [tab, setTab] = useState<Tab>('markets');
  const [slot, setSlot] = useState(1);
  const [slip, dispatch] = useReducer(slipReducer, null, () => emptySlip());
  const [pending, setPending] = useState<PendingReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [text, setText] = useState(false);
  const [reduced, setReducedOverride] = useReducedMotion();
  const audio = useMemo(() => createFootballAudio(), []);
  const [sound, setSound] = useState(false);
  const busyRef = useRef(false);
  const autoTried = useRef(false);

  const query = useQuery({
    queryKey: ['vf3d', userId, weekView?.seasonNo ?? 0, weekView?.weekNo ?? 0],
    queryFn: async ({ signal }) => {
      const started = now();
      const data = unwrapData(
        await boundedRequest(
          (s) =>
            api.get<VfSnapshot>(
              endpoint,
              weekView ? { seasonNo: weekView.seasonNo, weekNo: weekView.weekNo } : undefined,
              { signal: s }
            ),
          signal
        )
      );
      clock.sync(data.serverTime, started, now());
      return data;
    },
    // Faster while a match is on (from two seconds before kick-off), relaxed otherwise.
    refetchInterval: () => {
      const t = clock.now();
      return t !== null &&
        (t - VF_TIMING.anchorMs) % VF_TIMING.cycleMs >= VF_TIMING.selectionMs - 2000
        ? 1500
        : 3000;
    },
    retry: 1,
    placeholderData: keepPreviousData,
  });
  const snapshot = query.data;
  const refetch = query.refetch;

  // --- which matchweek is on stage ------------------------------------------------------
  const cycle = serverNow !== null ? cycleAt(serverNow) : null;
  const liveWeek =
    snapshot?.current && cycle && snapshot.current.id === matchweekId(cycle.seasonNo, cycle.weekNo)
      ? snapshot.current
      : null;
  const stageWeek = liveWeek ?? snapshot?.latestCompleted ?? snapshot?.current ?? null;

  // A boundary has passed in this browser: fetch straight away rather than wait for the poll.
  const lastBoundary = useRef('');
  useEffect(() => {
    if (!snapshot || serverNow === null || !cycle) return;
    const expected = matchweekId(cycle.seasonNo, cycle.weekNo);
    if (snapshot.current?.id === expected || lastBoundary.current === expected) return;
    lastBoundary.current = expected;
    void refetch();
  }, [snapshot, serverNow, cycle, refetch]);

  useEffect(() => {
    dispatch({ type: 'reset', matchweekId: liveWeek?.id ?? null });
    setReviewOpen(false);
  }, [liveWeek?.id]);

  useEffect(() => () => audio.dispose(), [audio]);
  usePhaseWhistles(stageWeek, !!liveWeek, audio, sound);
  async function toggleSound() {
    if (sound) {
      audio.disable();
      setSound(false);
      return;
    }
    const ok = await audio.enable();
    setSound(ok);
    if (!ok) setNotice({ kind: 'info', text: 'Sound is not available in this browser.' });
  }

  // A success message is a courtesy, not a record (the ticket stays under "My tickets").
  useEffect(() => {
    if (notice?.kind !== 'ok') return;
    const id = window.setTimeout(() => setNotice(null), 9000);
    return () => window.clearTimeout(id);
  }, [notice]);

  // --- unresolved receipt recovery ------------------------------------------------------------
  useEffect(() => {
    const stored = loadPending(userId);
    if (stored === 'unreadable')
      setNotice({
        kind: 'error',
        text: 'A saved confirmation could not be read, so it was discarded. Check "My tickets" before trying again.',
      });
    else if (stored) setPending(stored);
  }, [userId]);

  const fresh = !query.isError && clock.age() < 9000;
  const rulesOk =
    !snapshot || (snapshot.rulesId === VF_RULES_ID && snapshot.rulesDigest === VF_RULES_DIGEST);
  const fixtures = useMemo(() => stageWeek?.fixtures ?? [], [stageWeek]);
  const pricesVerified = useMemo(
    () => fixtures.every((f) => fixtureOffer(f.params).digest === f.offerDigest),
    [fixtures]
  );
  const selectionsOpen =
    !!liveWeek &&
    serverNow !== null &&
    serverNow >= liveWeek.opensAt &&
    serverNow < liveWeek.kickoffAt;
  const closing = !!liveWeek && serverNow !== null && serverNow >= liveWeek.kickoffAt - 1000;
  const pauseReason = !rulesOk
    ? 'These rules were updated. Refresh the page.'
    : !selectionsOpen || closing
      ? 'Selections are closed.'
      : !fresh
        ? 'Selections are paused while the connection recovers.'
        : !pricesVerified
          ? 'Prices could not be verified. Refresh the page.'
          : null;
  const canSelect = selectionsOpen && fresh && rulesOk && pricesVerified && !closing && !pending;

  const fixture = fixtures.find((f) => f.slot === slot) ?? fixtures[0];
  const picked = useMemo(
    () => new Set(slip.picks.filter((p) => p.fixtureId === fixture?.id).map((p) => p.selection)),
    [slip.picks, fixture?.id]
  );
  const pickedCount = useCallback(
    (f: VfFixtureView) => slip.picks.filter((p) => p.fixtureId === f.id).length,
    [slip.picks]
  );
  const paramsOf = useCallback(
    (id: string) => fixtures.find((f) => f.id === id)?.params ?? null,
    [fixtures]
  );
  const preview = useMemo(() => previewSlip(slip, paramsOf), [slip, paramsOf]);
  const stale = useMemo(
    () =>
      stalePicks(slip, (fid, sel) => {
        const f = fixtures.find((x) => x.id === fid);
        return f ? currentQuote(f, sel) : null;
      }),
    [slip, fixtures]
  );

  // --- the balance never moves ahead of the goals the member has seen ---------------------------
  const revealAt = useCallback(
    (id: string) =>
      snapshot?.current?.id === id
        ? matchweekRevealAt(snapshot.current)
        : snapshot?.latestCompleted?.id === id
          ? matchweekRevealAt(snapshot.latestCompleted)
          : 0,
    [snapshot]
  );
  const isRevealed = useCallback(
    (t: VfTicketView) => (serverNow ?? 0) >= revealAt(t.matchweekId),
    [serverNow, revealAt]
  );
  const shownBalance = snapshot
    ? snapshot.balance -
      snapshot.tickets
        .filter((t) => t.settledAt !== null && !isRevealed(t))
        .reduce((n, t) => n + (t.totalReturn ?? 0), 0)
    : 0;
  const tableReady =
    !snapshot?.latestCompleted || (serverNow ?? 0) >= matchweekRevealAt(snapshot.latestCompleted);
  const ticketsPlaced =
    snapshot && stageWeek
      ? snapshot.tickets.filter((t) => t.matchweekId === stageWeek.id).length
      : 0;

  // --- admission ---------------------------------------------------------------------------------
  const submit = useCallback(
    async (receipt: PendingReceipt) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setNotice(null);
      try {
        const admission = unwrapData(
          await boundedRequest(
            (signal) =>
              api.post<VfAdmission>(`${endpoint}/tickets`, receipt, undefined, { signal }),
            undefined,
            10_000
          )
        );
        clearPending(userId);
        setPending(null);
        dispatch({ type: 'clear' });
        setNotice({
          kind: 'ok',
          text: admission.isReplay
            ? 'Your earlier confirmation was found and is on your tickets. You were not charged twice.'
            : `Ticket confirmed: ${formatCredits(admission.ticket.totalStake)} practice credits staked. Good luck!`,
        });
      } catch (e) {
        const failure = parseFootballError(e);
        if (isDefinitiveRefusal(failure)) {
          clearPending(userId);
          setPending(null);
          setNotice({ kind: 'error', text: refusalMessage(failure) });
        } else {
          setNotice({
            kind: 'error',
            text: 'Confirmation is unresolved. Check this same ticket again: it can never be charged twice.',
          });
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
        void refetch();
      }
    },
    [userId, refetch]
  );

  useEffect(() => {
    if (pending && snapshot && !autoTried.current) {
      autoTried.current = true;
      void submit(pending);
    }
  }, [pending, snapshot, submit]);

  function confirm() {
    if (!liveWeek || busyRef.current || !canSelect) return;
    try {
      const receipt = parseTicketInput({
        idempotencyKey: newReceiptKey(),
        matchweekId: liveWeek.id,
        rulesId: VF_RULES_ID,
        lines: buildLines(slip),
      });
      const saved: PendingReceipt = {
        idempotencyKey: receipt.idempotencyKey,
        matchweekId: receipt.matchweekId,
        rulesId: receipt.rulesId,
        lines: receipt.lines,
      };
      savePending(userId, saved);
      setPending(saved);
      setReviewOpen(false);
      void submit(saved);
    } catch (e) {
      setReviewOpen(false);
      setNotice({
        kind: 'error',
        text:
          e instanceof TicketRuleError || e instanceof Error
            ? e.message
            : 'The ticket could not be prepared.',
      });
    }
  }

  // --- 3D scene inputs -----------------------------------------------------------------------------
  const kickoffRef = useRef(0);
  kickoffRef.current = stageWeek?.kickoffAt ?? 0;
  const getElapsed = useCallback(
    () => (clock.now() ?? kickoffRef.current) - kickoffRef.current,
    [clock]
  );
  const onGoalMoment = useCallback(
    (n: number) => {
      // The renderer also reports goals that were already old when the page opened; stay silent for those.
      const goal = fixture?.live.events.find((g) => g.n === n);
      if (goal && getElapsed() - goal.atMs < 4500) audio.goal();
    },
    [fixture, getElapsed, audio]
  );
  const matchKey = fixture
    ? `${fixture.id}|${fixture.live.events.length}|${fixture.live.fullTime ? 1 : 0}`
    : '';
  const matchInput = useMemo(
    () =>
      fixture
        ? {
            matchKey: fixture.id,
            homeClub: fixture.homeClub,
            awayClub: fixture.awayClub,
            goals: fixture.live.events.map((g) => ({ n: g.n, side: g.side, atMs: g.atMs })),
            fullTime: fixture.live.fullTime,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [matchKey]
  );
  const previousWeek =
    snapshot?.latestCompleted && snapshot.latestCompleted.id !== stageWeek?.id
      ? snapshot.latestCompleted
      : null;
  const previousFixture =
    previousWeek?.fixtures.find((f) => f.slot === slot) ?? previousWeek?.fixtures[0];
  const previousFinal =
    previousWeek && previousFixture && serverNow !== null
      ? displayFixture(previousFixture.live, serverNow - previousWeek.kickoffAt).fullTime
      : null;

  if (!snapshot) {
    return (
      <main className="vf-page">
        <Link to="/games">← Games</Link>
        <h1 className="vf-solo-title">Virtual Football 3D</h1>
        <p role="status">
          {query.isError
            ? 'Practice is unavailable. Please try again later.'
            : 'Preparing the stadium…'}
        </p>
        <button type="button" className="vf-secondary" onClick={() => refetch()}>
          Refresh
        </button>
      </main>
    );
  }
  if (!stageWeek) {
    return (
      <main className="vf-page">
        <Link to="/games">← Games</Link>
        <h1 className="vf-solo-title">Virtual Football 3D</h1>
        <NextMatchweek endsAt={snapshot.cycle.endsAt} />
        <button type="button" className="vf-secondary" onClick={() => refetch()}>
          Refresh
        </button>
      </main>
    );
  }

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const order: Tab[] = ['markets', 'results', 'table', 'tickets'];
    const i = order.indexOf(tab);
    const next =
      event.key === 'ArrowRight'
        ? order[(i + 1) % 4]
        : event.key === 'ArrowLeft'
          ? order[(i + 3) % 4]
          : event.key === 'Home'
            ? order[0]
            : event.key === 'End'
              ? order[3]
              : null;
    if (!next) return;
    event.preventDefault();
    setTab(next);
    document.getElementById(`vf-tab-${next}`)?.focus();
  };
  const slipView = (
    <Slip
      slip={slip}
      dispatch={dispatch}
      fixtures={fixtures}
      balance={shownBalance}
      closedReason={pauseReason}
      busy={busy}
      locked={!!pending}
      stale={stale}
      preview={preview}
      ticketsPlaced={ticketsPlaced}
      onReview={() => setReviewOpen(true)}
    />
  );
  const lines = buildLines(slip);

  return (
    <main className="vf-page">
      <header className="vf-header">
        <div>
          <Link to="/games">← All games</Link>
          <h1>
            PLAYQUBE <em>VIRTUAL FOOTBALL</em>
            <small>CLUB FOOTBALL · 3D PRACTICE</small>
          </h1>
        </div>
        <div className="vf-credit">
          <span>Free practice</span>
          <strong>
            {formatCredits(shownBalance)} <small>credits</small>
          </strong>
          <p>No Coins · No cash prizes</p>
        </div>
      </header>

      <p className="vf-scene-note">
        Premier League club-themed simulation · Original kits and badges · Not real fixtures or
        player likenesses
      </p>

      <div className="vf-toolbar">
        <PhaseBar week={stageWeek} live={!!liveWeek} nextOpensAt={cycle?.endsAt ?? null} />
        <div className="vf-toolbar-actions">
          <button
            type="button"
            className="vf-link"
            aria-pressed={text}
            onClick={() => setText((v) => !v)}
          >
            {text ? 'Show 3D match' : 'Text match centre'}
          </button>
          <button
            type="button"
            className="vf-link"
            aria-pressed={sound}
            onClick={() => void toggleSound()}
          >
            {sound ? 'Sound on' : 'Sound off'}
          </button>
          <label>
            <input
              type="checkbox"
              checked={reduced}
              onChange={(e) => setReducedOverride(e.target.checked)}
            />{' '}
            Reduced motion
          </label>
          <RulesDialog />
        </div>
      </div>

      {!rulesOk && (
        <p role="alert" className="vf-alert">
          These rules have been updated. Refresh the page to continue. No new ticket can be
          confirmed until you do.
        </p>
      )}
      {!pricesVerified && (
        <p role="alert" className="vf-alert">
          Prices for this matchweek could not be verified in your browser, so selections are paused.
          Refresh to try again.
        </p>
      )}
      {(!fresh || query.isError) && (
        <p role="alert" className="vf-alert">
          Connection interrupted. Selections are paused until the game status refreshes.
        </p>
      )}
      {notice && (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`vf-notice vf-notice--${notice.kind}`}
        >
          {notice.text}
        </p>
      )}
      {pending && (
        <div className="vf-alert" role="alert">
          <p>
            A ticket confirmation is unresolved ({pending.lines.length} line
            {pending.lines.length === 1 ? '' : 's'},{' '}
            {formatCredits(pending.lines.reduce((n, l) => n + l.stake, 0))} credits). Checking it
            again cannot charge you twice.
          </p>
          <button
            type="button"
            className="vf-secondary"
            disabled={busy}
            onClick={() => void submit(pending)}
          >
            Check this confirmation
          </button>
        </div>
      )}

      {previousWeek && previousFixture && previousFinal && (
        <section className="vf-previous-result" aria-label="Previous featured result">
          <div>
            <small>
              Last completed matchweek · {weekLabel(previousWeek.seasonNo, previousWeek.weekNo)}
            </small>
            <strong>
              {clubById(previousFixture.homeClub).name} {previousFinal.home} – {previousFinal.away}{' '}
              {clubById(previousFixture.awayClub).name}
            </strong>
            <span>
              Full time ·{' '}
              {previousFinal.home === previousFinal.away
                ? 'Draw'
                : `${clubById(previousFinal.home > previousFinal.away ? previousFixture.homeClub : previousFixture.awayClub).name} wins`}
            </span>
          </div>
          <button
            type="button"
            className="vf-secondary"
            onClick={() => {
              setWeekView(null);
              setTab('results');
            }}
          >
            All results
          </button>
        </section>
      )}

      <GameArena title="Virtual Football" className="vf-arena">
        <section className="vf-stage" aria-label="Match view">
          <div className="vf-stage-frame">
            {text || !fixture ? (
              fixture && <LiveCentre fixture={fixture} week={stageWeek} />
            ) : (
              <>
                <Suspense
                  fallback={
                    <div className="vf-scene-loading" role="status">
                      Preparing the stadium…
                    </div>
                  }
                >
                  <FootballScene
                    match={matchInput}
                    getElapsed={getElapsed}
                    reduced={reduced}
                    label={`3D view of ${matchTitle(fixture)}`}
                    onGoalMoment={onGoalMoment}
                    fallback={<LiveCentre fixture={fixture} week={stageWeek} />}
                  />
                </Suspense>
                <div className="vf-board-overlay">
                  <LiveBoard fixture={fixture} week={stageWeek} />
                </div>
              </>
            )}
          </div>
          <div className="vf-strip" role="group" aria-label="Matches this week">
            {fixtures.map((f) => (
              <LiveScorecard
                key={f.id}
                fixture={f}
                week={stageWeek}
                selected={f.id === fixture?.id}
                picked={pickedCount(f)}
                onSelect={() => setSlot(f.slot)}
              />
            ))}
          </div>
        </section>
      </GameArena>

      <div className="vf-layout">
        <section className="vf-main">
          <div className="vf-tabs" role="tablist" aria-label="Game sections" onKeyDown={onTabKey}>
            {(
              [
                ['markets', 'Markets'],
                ['results', 'Results'],
                ['table', 'League table'],
                [
                  'tickets',
                  `My tickets${snapshot.tickets.length ? ` (${snapshot.tickets.length})` : ''}`,
                ],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                id={`vf-tab-${key}`}
                role="tab"
                type="button"
                aria-selected={tab === key}
                aria-controls={`vf-panel-${key}`}
                tabIndex={tab === key ? 0 : -1}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            id={`vf-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`vf-tab-${tab}`}
            className="vf-tabpanel"
          >
            {tab === 'markets' && fixture && (
              <>
                <h2 className="vf-fixture-title">
                  <span className="vf-fixture-badges">
                    <ClubBadge club={fixture.homeClub} size={24} />
                    <ClubBadge club={fixture.awayClub} size={24} />
                  </span>
                  <span>{matchTitle(fixture)}</span>
                </h2>
                {!canSelect && (
                  <p className="vf-fine" role="status">
                    {pending
                      ? 'Resolve your unconfirmed ticket to add more selections.'
                      : liveWeek && serverNow !== null && serverNow < liveWeek.kickoffAt
                        ? 'Selections are paused while the connection recovers.'
                        : 'Selections are closed for this matchweek. The next one opens soon.'}
                  </p>
                )}
                <MarketPanel
                  fixture={fixture}
                  picked={picked}
                  disabled={!canSelect}
                  onToggle={(selection, oddsCents) =>
                    dispatch({
                      type: 'toggle',
                      pick: {
                        fixtureId: fixture.id,
                        selection,
                        quotedCents: oddsCents,
                        offerDigest: fixture.offerDigest,
                      },
                    })
                  }
                />
              </>
            )}
            {tab === 'results' && (
              <ResultsPanel
                snapshot={snapshot}
                serverNow={serverNow ?? 0}
                weekView={weekView}
                onWeek={setWeekView}
                loading={query.isPlaceholderData}
              />
            )}
            {tab === 'table' && <StandingsPanel snapshot={snapshot} ready={tableReady} />}
            {tab === 'tickets' && (
              <TicketsPanel tickets={snapshot.tickets} isRevealed={isRevealed} />
            )}
          </div>
        </section>
        <div className="vf-side">{slipView}</div>
      </div>

      <p className="vf-disclaimer">
        Club names are a visual theme for simulated matches, not real fixtures or player likenesses.
        Results are random and previous matches do not predict the next. Practice credits have no
        monetary value.
      </p>

      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        lines={lines}
        fixtures={fixtures}
        balance={shownBalance}
        totalStake={preview.totalStake}
        totalReturn={preview.totalMaxReturn}
        busy={busy}
        closing={!canSelect}
        onConfirm={confirm}
      />
      <MobileTray count={slip.picks.length} stake={preview.totalStake} />
    </main>
  );
}

const matchTitle = (f: VfFixtureView) =>
  `${clubById(f.homeClub).name} v ${clubById(f.awayClub).name}`;

/** Phones: a persistent bar that scrolls to the slip, so the ticket is never lost below the fold. */
function MobileTray({ count, stake }: { count: number; stake: number }) {
  if (!count) return null;
  return (
    <div className="vf-tray">
      <button
        type="button"
        onClick={() =>
          document.querySelector('.vf-slip')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      >
        <span>
          Ticket · {count} selection{count === 1 ? '' : 's'}
        </span>
        <b>{formatCredits(stake)} credits</b>
      </button>
    </div>
  );
}
