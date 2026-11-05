import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, ShieldCheck, Clock3, Trophy, ArrowRight, Wallet, Download } from 'lucide-react';
import {
  TOGETHER_GAMES,
  togetherGame,
  togetherSelection,
  togetherPayoutEstimate,
  type TogetherGame,
  type TogetherCurrency,
  type TogetherSettings,
  type TogetherSnapshot,
} from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { getErrorMessage } from '@/lib/error-message';
import { requestStatus } from '@/lib/request-error';
import { verifyTogetherRound } from '@/lib/together-proof';
import { useAuth } from '@/providers/auth-provider';
import { GroupSocialNav } from '@/components/groups/group-social-nav';
import { GameArtwork } from '@/components/member/game-artwork';
import './play-together.css';

const money = (n: number, currency: TogetherCurrency) =>
  currency === 'ETB'
    ? (n / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
      ' Birr'
    : n.toLocaleString() + ' points';
const get = async <T,>(path: string, signal?: AbortSignal) =>
  unwrapData(
    await boundedRequest((active) => api.get<T>(path, undefined, { signal: active }), signal)
  );
type Group = { id: string; name: string; ownerId: string };
type Lobby = {
  serverTime: number;
  workerReady: boolean;
  admissionsEnabled: boolean;
  settings: TogetherSettings;
  cashAvailable: boolean;
  group: (Group & { status: string }) | null;
  groups: Group[];
  balances: TogetherSnapshot['balances'];
  legacyPending: boolean;
  rounds: {
    id: string;
    groupId: string | null;
    game: TogetherGame;
    currency: TogetherCurrency;
    entryAmount: number;
    state: string;
    closesAt: number;
    participants: number;
    feeBps: number;
  }[];
};
type PendingEntry = { requestId: string; termsHash: string; selection: number[] };
function readPending(key: string): PendingEntry | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return value &&
      typeof value.requestId === 'string' &&
      /^[a-f0-9-]{36}$/i.test(value.requestId) &&
      /^[a-f0-9]{64}$/.test(value.termsHash) &&
      Array.isArray(value.selection) &&
      value.selection.length <= 6 &&
      value.selection.every(Number.isInteger)
      ? value
      : null;
  } catch {
    return null;
  }
}
function storage(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* Private browsing can disable storage. */
  }
}
export function PlayTogetherPage() {
  const { user } = useAuth(),
    { id: groupId, roundId } = useParams<{ id: string; roundId: string }>();
  if (!user) return null;
  return roundId ? (
    <TogetherRound key={user.id + ':' + roundId} userId={user.id} roundId={roundId} />
  ) : (
    <TogetherLobby key={user.id + ':' + (groupId ?? 'public')} userId={user.id} groupId={groupId} />
  );
}
function TogetherLobby({ userId, groupId }: { userId: string; groupId?: string }) {
  const navigate = useNavigate(),
    cache = useQueryClient(),
    [search] = useSearchParams();
  const selected = search.get('game');
  const [game, setGame] = useState<TogetherGame>(
    () => TOGETHER_GAMES.find((g) => g.key === selected)?.key ?? 'spin_win'
  );
  const [currency, setCurrency] = useState<TogetherCurrency>('GAME_POINTS');
  const [amount, setAmount] = useState('1000'),
    [minPlayers, setMinPlayers] = useState('2'),
    [maxPlayers, setMaxPlayers] = useState('20');
  const [duration, setDuration] = useState('120'),
    [notice, setNotice] = useState('');
  const requestRef = useRef<{ path: string; body: unknown } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const query = useQuery({
    queryKey: ['together-lobby', userId, groupId],
    queryFn: ({ signal }) =>
      get<Lobby>(
        '/play-together/' + (groupId ? '?groupId=' + encodeURIComponent(groupId) : ''),
        signal
      ),
    refetchInterval: 3000,
    retry: false,
    refetchOnReconnect: 'always',
  });
  const mutation = useMutation({
    mutationFn: async (action: { path: string; body: unknown }) =>
      unwrapData(
        await boundedRequest((signal) =>
          api.post<{ roundId?: string; added?: number; nextRefillAt?: string }>(
            action.path,
            action.body,
            undefined,
            { signal }
          )
        )
      ),
    onSuccess: (data) => {
      requestRef.current = null;
      setUncertain(false);
      if (data.roundId) navigate('/play-together/rounds/' + data.roundId);
      else {
        setNotice(
          data.added
            ? data.added.toLocaleString() +
                ' free practice points added. Your real wallet is unchanged.'
            : 'Your practice balance is sufficient, or today’s refill has already been used.'
        );
        void cache.invalidateQueries({ queryKey: ['together-lobby', userId] });
        void cache.invalidateQueries({ queryKey: ['wallet', userId] });
      }
    },
    onError: (error) => {
      const status = requestStatus(error);
      if (status >= 400 && status < 500 && status !== 408) {
        requestRef.current = null;
        setUncertain(false);
      } else setUncertain(true);
      setNotice(
        getErrorMessage(
          error,
          'Could not confirm the request. Retry safely using the same receipt.'
        )
      );
    },
  });
  const submit = (path: string, body: unknown) => {
    if (requestRef.current) return;
    const action = { path, body };
    requestRef.current = action;
    mutation.mutate(action);
  };
  if (query.isPending)
    return (
      <div className="together-page" role="status">
        Loading shared game rooms…
      </div>
    );
  if (!query.data)
    return (
      <div className="together-page">
        <p role="alert">Group rooms are temporarily unavailable.</p>
        <button onClick={() => void query.refetch()}>Try again</button>
      </div>
    );
  const s = query.data,
    own = s.group?.ownerId === userId;
  const busy =
    mutation.isPending ||
    uncertain ||
    query.isError ||
    !s.admissionsEnabled ||
    Date.now() - query.dataUpdatedAt > 6000;
  const available = currency === 'ETB' ? s.balances.cashAvailable : s.balances.pointsAvailable;
  const active = s.rounds.find(
    (r) => r.groupId === groupId && ['OPEN', 'LOCKED', 'DRAWN'].includes(r.state)
  );
  const scale = currency === 'ETB' ? 100 : 1;
  const create = () => {
    const entry = Number(amount) * scale;
    if (
      !Number.isSafeInteger(entry) ||
      entry % 100 ||
      entry < s.settings.minEntry ||
      entry > s.settings.maxEntry
    ) {
      setNotice('Choose an entry within the displayed limits.');
      return;
    }
    submit('/play-together/rounds', {
      groupId,
      game,
      currency,
      entryAmount: entry,
      minPlayers: Number(minPlayers),
      maxPlayers: Number(maxPlayers),
      lobbySeconds: Number(duration),
      requestId: crypto.randomUUID(),
    });
  };
  return (
    <div className="together-page">
      {groupId && <GroupSocialNav groupId={groupId} />}
      <header className="together-hero">
        <div>
          <p className="together-eyebrow">
            <Users size={16} /> {s.group?.name ?? 'Shared moments. Fair play.'}
          </p>
          <h1>
            Play together<span>.</span>
          </h1>
          <p>Choose a game. Confirm your own entry. Share the moment.</p>
        </div>
        <div className="together-wallet">
          <Wallet size={20} />
          <div>
            <span>Real wallet</span>
            <strong>{money(s.balances.cashAvailable, 'ETB')}</strong>
            <small>{money(s.balances.cashReserved, 'ETB')} in group rounds</small>
          </div>
        </div>
      </header>
      <div className="together-mode" role="group" aria-label="Choose balance">
        <button
          aria-pressed={currency === 'GAME_POINTS'}
          onClick={() => {
            setCurrency('GAME_POINTS');
            setAmount('1000');
          }}
        >
          Practice · points
        </button>
        <button
          aria-pressed={currency === 'ETB'}
          onClick={() => {
            setCurrency('ETB');
            setAmount('10');
          }}
        >
          Real Birr
        </button>
        <span>
          Available: <strong>{money(available, currency)}</strong>
        </span>
      </div>
      {currency === 'ETB' && !s.cashAvailable && (
        <p className="together-notice">
          Real-money group play is not open for your account yet. You can explore the rules and play
          practice rounds.
        </p>
      )}
      {currency === 'GAME_POINTS' && (
        <div className="together-notice">
          <p>
            Practice points have no cash value and cannot be withdrawn. They are separate from your
            real and reward Birr.
          </p>
          <button
            disabled={busy || !s.settings.practiceEnabled}
            onClick={() => submit('/play-together/practice-points', {})}
          >
            Refill practice points
          </button>
          <small>
            Free refill up to 10,000 points once per UTC day, including points already reserved.
          </small>
        </div>
      )}
      {!s.workerReady && (
        <p role="status" className="together-notice">
          Group processing is reconnecting. New entries are paused; accepted rounds remain
          protected.
        </p>
      )}
      {!s.admissionsEnabled && (
        <p role="status" className="together-notice">
          New group rounds and entries are paused. Accepted rounds still settle automatically.
        </p>
      )}
      {notice && (
        <p role="status" className="together-notice">
          {notice}
        </p>
      )}
      {uncertain && (
        <button
          disabled={mutation.isPending}
          onClick={() => requestRef.current && mutation.mutate(requestRef.current)}
        >
          Check the same request again
        </button>
      )}
      {s.legacyPending && groupId && (
        <p className="together-notice">
          A previous points round is still active.{' '}
          <Link to={'/groups/' + groupId + '/games/legacy'}>Finish that round</Link> before starting
          a new one.
        </p>
      )}
      <section aria-labelledby="together-games-title">
        <h2 id="together-games-title">Find your group’s game</h2>
        <div className="together-game-grid">
          {TOGETHER_GAMES.map((g) => {
            const enabled = s.settings.enabledGames.includes(g.key);
            return (
              <button
                key={g.key}
                className={'together-game ' + (game === g.key ? 'selected' : '')}
                disabled={!enabled || busy}
                aria-pressed={game === g.key}
                onClick={() => setGame(g.key)}
              >
                <div className="together-art">
                  <GameArtwork kind={g.key} practiceAvailable={enabled} />
                </div>
                <strong>{g.name}</strong>
                <span>{enabled ? 'View group rules' : 'Group mode preparing'}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="together-panel">
        <p className="together-eyebrow">The rules, before you enter</p>
        <h2>{togetherGame(game).name}</h2>
        <p>{togetherGame(game).rules}</p>
        <p>
          Tied leaders share. If everyone ties or nobody qualifies, everyone receives their entry
          back with no fee.
        </p>
        <p>
          <ShieldCheck size={16} /> The fee is {s.settings.feeBps / 100}% of winning profit before
          fees. No additional entry or winner fee.
        </p>
      </section>
      {groupId ? (
        active ? (
          <section className="together-panel">
            <h2>Your group’s current round</h2>
            <p>
              {togetherGame(active.game).name} · {money(active.entryAmount, active.currency)} entry
              · {active.participants} confirmed
            </p>
            <Link className="together-primary" to={'/play-together/rounds/' + active.id}>
              Open round <ArrowRight size={17} />
            </Link>
          </section>
        ) : own ? (
          <section className="together-panel">
            <h2>Create a round</h2>
            <p>
              Publishing a round costs nothing. You and every member confirm your own entry
              separately.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
              className="together-form"
            >
              <label>
                Entry per player ({currency === 'ETB' ? 'Birr' : 'points'})
                <input
                  type="number"
                  step={100 / scale}
                  min={s.settings.minEntry / scale}
                  max={s.settings.maxEntry / scale}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
                <small>
                  {money(s.settings.minEntry, currency)}–{money(s.settings.maxEntry, currency)}
                </small>
              </label>
              <label>
                Minimum players
                <input
                  type="number"
                  min="2"
                  max="20"
                  value={minPlayers}
                  onChange={(e) => setMinPlayers(e.target.value)}
                  required
                />
              </label>
              <label>
                Maximum players
                <input
                  type="number"
                  min={minPlayers}
                  max="20"
                  value={maxPlayers}
                  onChange={(e) => setMaxPlayers(e.target.value)}
                  required
                />
              </label>
              <label>
                Betting closes after
                <select value={duration} onChange={(e) => setDuration(e.target.value)}>
                  <option value="120">2 minutes</option>
                  <option value="300">5 minutes</option>
                  <option value="600">10 minutes</option>
                </select>
              </label>
              <button
                className="together-primary"
                disabled={
                  busy ||
                  !s.workerReady ||
                  s.legacyPending ||
                  (currency === 'ETB' && !s.cashAvailable) ||
                  !s.settings.enabledGames.includes(game)
                }
              >
                Publish round
              </button>
            </form>
          </section>
        ) : (
          <p className="together-notice">
            The group owner can publish a round. Each member then chooses and confirms their own
            entry.
          </p>
        )
      ) : (
        <section className="together-columns">
          <div className="together-panel">
            <h2>Join a shared room</h2>
            <p>Play with other members. Opening the room does not place a bet.</p>
            <p>
              Entry: {money(s.settings.minEntry, currency)} · 2–20 players · 2-minute betting window
            </p>
            <button
              className="together-primary"
              disabled={
                busy ||
                !s.workerReady ||
                !s.settings.publicRoomsEnabled ||
                (currency === 'ETB' && !s.cashAvailable) ||
                !s.settings.enabledGames.includes(game)
              }
              onClick={() => submit('/play-together/public', { game, currency })}
            >
              Open shared room <ArrowRight size={17} />
            </button>
            {!s.settings.publicRoomsEnabled && (
              <small>
                Public rooms are being prepared. Private group rooms are available below.
              </small>
            )}
          </div>
          <div className="together-panel">
            <h2>Play with your group</h2>
            <p>Invite friends through the group’s Members page. Joining a group is free.</p>
            {s.groups.map((g) => (
              <Link
                className="together-group-link"
                key={g.id}
                to={'/groups/' + g.id + '/games?game=' + game}
              >
                {g.name}
                <ArrowRight size={16} />
              </Link>
            ))}
            <Link to="/groups">Create or join a group →</Link>
          </div>
        </section>
      )}
      {s.rounds.length > 0 && (
        <section className="together-panel">
          <h2>Rounds and receipts</h2>
          <div className="together-history">
            {s.rounds.map((r) => (
              <Link key={r.id} to={'/play-together/rounds/' + r.id}>
                <span>
                  <strong>{togetherGame(r.game).name}</strong>
                  <small>
                    {money(r.entryAmount, r.currency)} entry · {r.participants} players
                  </small>
                </span>
                <span>
                  {r.state === 'PAID'
                    ? 'Paid'
                    : r.state === 'REFUNDED'
                      ? 'Refunded'
                      : r.state === 'OPEN'
                        ? 'Open'
                        : 'In progress'}{' '}
                  →
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {groupId && (
        <Link to={'/groups/' + groupId + '/games/legacy'}>Previous points rounds and history</Link>
      )}
    </div>
  );
}

function TogetherRound({ userId, roundId }: { userId: string; roundId: string }) {
  const cache = useQueryClient(),
    [clock, setClock] = useState(performance.now()),
    [picks, setPicks] = useState<number[]>([]);
  const [crashText, setCrashText] = useState(''),
    [notice, setNotice] = useState(''),
    [checking, setChecking] = useState(false);
  const key = 'together-entry:' + userId + ':' + roundId,
    termsKey = 'together-terms:' + userId + ':' + roundId;
  const [pending, setPending] = useState<PendingEntry | null>(() => readPending(key));
  const pendingRef = useRef(pending),
    actionRef = useRef(false);
  const clear = () => {
    pendingRef.current = null;
    setPending(null);
    storage(key, null);
  };
  const query = useQuery({
    queryKey: ['together-round', userId, roundId],
    queryFn: async ({ signal }) => {
      const sent = performance.now();
      const snapshot = await get<TogetherSnapshot>('/play-together/rounds/' + roundId, signal);
      return { snapshot, sent, received: performance.now() };
    },
    refetchInterval: 1000,
    retry: false,
    refetchOnReconnect: 'always',
    refetchOnWindowFocus: 'always',
  });
  useEffect(() => {
    const timer = setInterval(() => setClock(performance.now()), 200);
    return () => clearInterval(timer);
  }, []);
  const invalidate = () => {
    void cache.invalidateQueries({ queryKey: ['together-round', userId, roundId] });
    void cache.invalidateQueries({ queryKey: ['together-lobby', userId] });
    void cache.invalidateQueries({ queryKey: ['wallet', userId] });
  };
  const mutation = useMutation({
    mutationFn: async (action: {
      kind: 'enter' | 'refund' | 'cancel';
      entry?: PendingEntry;
      entryId?: string;
    }) => {
      const root = '/play-together/rounds/' + roundId;
      return unwrapData(
        await boundedRequest((signal) =>
          api.post<{ accepted?: boolean; reason?: string }>(
            root +
              (action.kind === 'enter'
                ? '/entries'
                : action.kind === 'refund'
                  ? '/entries/' + action.entryId + '/refund'
                  : '/cancel'),
            action.entry ?? {},
            undefined,
            { signal }
          )
        )
      );
    },
    onSuccess: (reply, action) => {
      actionRef.current = false;
      if (action.kind === 'enter') clear();
      setNotice(
        reply.accepted === false
          ? (reply.reason ?? 'Entry was not accepted.')
          : action.kind === 'enter'
            ? 'Your entry is confirmed.'
            : action.kind === 'refund'
              ? 'Your full entry has been returned.'
              : 'The round has been cancelled.'
      );
      invalidate();
    },
    onError: (error, action) => {
      actionRef.current = false;
      const status = requestStatus(error);
      if (action.kind === 'enter' && status >= 400 && status < 500 && status !== 408) clear();
      setNotice(
        getErrorMessage(
          error,
          'Could not confirm. Your receipt is saved; check the same request again.'
        )
      );
      invalidate();
    },
  });
  const s = query.data?.snapshot,
    r = s?.round;
  const age = query.data ? Math.max(clock, performance.now()) - query.data.sent : Infinity;
  const connected =
    !!query.data &&
    !query.isError &&
    !query.isPaused &&
    age < 5000 &&
    query.data.received - query.data.sent < 2000;
  const now = s ? s.serverTime + age : 0;
  const ownEntries =
    r?.entries.filter((e) => e.userId === userId).sort((a, b) => b.createdAt - a.createdAt) ?? [];
  const mine = ownEntries.find((e) => e.state !== 'REFUNDED') ?? ownEntries[0];
  useEffect(() => {
    if (!r || !connected) return;
    if (r.state === 'OPEN') {
      try {
        if (!sessionStorage.getItem(termsKey)) storage(termsKey, r.termsHash);
      } catch {}
    }
    const pending = pendingRef.current;
    if (!pending) return;
    const receipt = r.entries.find((e) => e.userId === userId && e.requestId === pending.requestId);
    if (receipt) {
      clear();
      setNotice(
        receipt.state === 'REFUNDED'
          ? 'Your entry was refunded.'
          : 'Your entry was confirmed by the server.'
      );
      invalidate();
    } else if (r.state !== 'OPEN') {
      clear();
      setNotice('Betting has closed. No entry for this request was accepted.');
    }
  }, [query.data, connected]);
  if (query.isPending)
    return (
      <div className="together-page" role="status">
        Loading round…
      </div>
    );
  if (!r || !s)
    return (
      <div className="together-page">
        <p role="alert">{getErrorMessage(query.error, 'Round unavailable.')}</p>
        <button onClick={() => void query.refetch()}>Try again</button>
      </div>
    );
  const game = togetherGame(r.game),
    paid = r.state === 'PAID' || r.state === 'REFUNDED';
  const participants = r.entries.filter(
    (e) => e.state !== 'REFUNDED' || r.settlement?.payouts.some((p) => p.entryId === e.id)
  );
  const funded = participants.length,
    seconds = Math.max(0, Math.ceil((r.closesAt - now) / 1000));
  const open = connected && r.state === 'OPEN' && seconds > 0;
  const confirmed = mine?.state === 'ACCEPTED' || mine?.state === 'SETTLED';
  const selected = confirmed ? (mine!.selection ?? []) : picks;
  const busy = mutation.isPending || !!pending || !connected;
  let valid = false;
  try {
    togetherSelection(r.game, selected);
    valid = true;
  } catch {
    /* Incomplete selection. */
  }
  const available = r.currency === 'ETB' ? s.balances.cashAvailable : s.balances.pointsAvailable;
  let changedTerms = false;
  try {
    const saved = sessionStorage.getItem(termsKey);
    changedTerms = !!saved && saved !== r.termsHash;
  } catch {}
  const estimate = togetherPayoutEstimate(
    r.entryAmount,
    Math.min(r.maxPlayers, funded + (confirmed ? 0 : 1)),
    r.feeBps
  );
  const canEnter =
    open &&
    s.workerReady &&
    s.admissionsEnabled &&
    !changedTerms &&
    !busy &&
    !confirmed &&
    valid &&
    available >= r.entryAmount &&
    funded < r.maxPlayers &&
    s.settings.enabledGames.includes(r.game) &&
    (r.currency === 'ETB' ? s.cashAvailable : s.settings.practiceEnabled);
  const enter = () => {
    if (pendingRef.current || actionRef.current || !canEnter) return;
    const request = {
      requestId: crypto.randomUUID(),
      termsHash: r.termsHash,
      selection: togetherSelection(r.game, selected),
    };
    pendingRef.current = request;
    setPending(request);
    storage(key, JSON.stringify(request));
    actionRef.current = true;
    mutation.mutate({ kind: 'enter', entry: request });
  };
  const act = (kind: 'refund' | 'cancel') => {
    if (actionRef.current || busy) return;
    actionRef.current = true;
    mutation.mutate({ kind, entryId: mine?.id });
  };
  const numberPick = (number: number) => {
    if (!open || busy || confirmed) return;
    setPicks((current) =>
      game.picks === 1
        ? [number]
        : current.includes(number)
          ? current.filter((n) => n !== number)
          : current.length < game.picks
            ? [...current, number]
            : current
    );
  };
  const verify = async () => {
    setChecking(true);
    try {
      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem(termsKey);
      } catch {}
      setNotice(await verifyTogetherRound(r, saved));
    } catch (error) {
      setNotice(getErrorMessage(error, 'Result verification is unavailable.'));
    } finally {
      setChecking(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'salem-round-' + r.id + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="together-page">
      {r.groupId ? (
        <GroupSocialNav groupId={r.groupId} />
      ) : (
        <Link to="/play-together">← Shared rooms</Link>
      )}
      <header className="together-hero">
        <div>
          <p className="together-eyebrow">
            <Users size={16} />
            {r.groupName ?? 'Public shared room'}
          </p>
          <h1>
            {game.name}
            <span>.</span>
          </h1>
          <p>{game.rules}</p>
        </div>
        <div className="together-wallet">
          <Wallet size={20} />
          <div>
            <span>
              {r.currency === 'ETB' ? 'Available real Birr' : 'Available practice points'}
            </span>
            <strong>{money(available, r.currency)}</strong>
            <small>
              {r.currency === 'GAME_POINTS' ? 'No cash value' : 'Reward Birr is separate'}
            </small>
          </div>
        </div>
      </header>
      <div className="together-status">
        <span role="timer">
          <Clock3 size={17} />
          {r.state === 'OPEN'
            ? seconds
              ? 'Betting closes in ' +
                Math.floor(seconds / 60) +
                ':' +
                String(seconds % 60).padStart(2, '0')
              : 'Betting closed — locking entries'
            : r.state === 'LOCKED'
              ? 'Entries locked — preparing the shared result'
              : r.state === 'DRAWN'
                ? 'Result recorded — paying wallets'
                : r.state === 'PAID'
                  ? 'Paid'
                  : 'Refunded'}
        </span>
        <span>
          {funded} confirmed · minimum {r.minPlayers} · maximum {r.maxPlayers}
        </span>
      </div>
      {!connected && (
        <p role="alert" className="together-notice">
          Reconnecting. Entry controls are paused until the server confirms this round.
        </p>
      )}
      {changedTerms && (
        <p role="alert" className="together-notice">
          This round differs from its saved terms. New confirmation is blocked. Keep your receipt
          and contact support.
        </p>
      )}
      {!s.admissionsEnabled && (
        <p role="status" className="together-notice">
          New entries are paused. Accepted entries remain protected.
        </p>
      )}
      {notice && (
        <p role="status" className="together-notice">
          {notice}
        </p>
      )}
      {pending && (
        <div className="together-notice">
          <p>
            Your confirmation is being checked. Its receipt is saved so retrying cannot charge you
            twice.
          </p>
          <button
            disabled={mutation.isPending || !connected}
            onClick={() => {
              if (!pendingRef.current || actionRef.current) return;
              actionRef.current = true;
              mutation.mutate({ kind: 'enter', entry: pendingRef.current });
            }}
          >
            Check the same confirmation
          </button>
        </div>
      )}
      <div className="together-columns">
        <section className="together-panel">
          <p className="together-eyebrow">Your choice</p>
          <h2>
            {confirmed ? 'Your confirmed entry' : paid ? 'Round complete' : 'Choose your entry'}
          </h2>
          <p>
            {money(r.entryAmount, r.currency)} per player. {r.feeBps / 100}% fee on winning profit
            before fees.
          </p>
          {!paid && game.picks === 0 && (
            <div className="together-choice-note">
              <ShieldCheck size={26} />
              <p>
                {game.rules}
                <br />
                Every member authorizes one entry.
              </p>
            </div>
          )}
          {game.picks > 0 &&
            ![
              'blackjack',
              'virtual_football_3d',
              'sky_crash',
              'crash_point',
              'number_challenge',
            ].includes(r.game) && (
              <>
                <p>
                  {selected.length} of {game.picks} selected
                </p>
                <div className="together-number-grid">
                  {Array.from({ length: game.max - game.min + 1 }, (_, i) => i + game.min).map(
                    (n) => (
                      <button
                        key={n}
                        aria-label={'Choose ' + n}
                        aria-pressed={selected.includes(n)}
                        disabled={!open || busy || confirmed}
                        onClick={() => numberPick(n)}
                      >
                        {n}
                      </button>
                    )
                  )}
                </div>
              </>
            )}
          {r.game === 'number_challenge' && (
            <label className="together-field">
              Your number (1–100)
              <input
                type="number"
                min="1"
                max="100"
                step="1"
                disabled={!open || busy || confirmed}
                value={selected[0] ?? ''}
                onChange={(e) => setPicks(e.target.value === '' ? [] : [Number(e.target.value)])}
              />
            </label>
          )}
          {['sky_crash', 'crash_point'].includes(r.game) && (
            <label className="together-field">
              Automatic exit target (1.01×–20×)
              <input
                inputMode="decimal"
                placeholder="2.00"
                disabled={!open || busy || confirmed}
                value={confirmed ? (selected[0] / 100).toFixed(2) : crashText}
                onChange={(e) => {
                  setCrashText(e.target.value);
                  const m = /^(\d{1,2})(?:\.(\d{0,2}))?$/.exec(e.target.value);
                  setPicks(m ? [Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))] : []);
                }}
              />
              <small>
                This is a contest target, not a payout multiplier. Reaching the crash exactly counts
                as a loss.
              </small>
            </label>
          )}
          {['blackjack', 'virtual_football_3d'].includes(r.game) && (
            <div className="together-predictions">
              {Array.from({ length: game.picks }, (_, i) => (
                <label key={i}>
                  {r.game === 'blackjack'
                    ? 'Hand ' + (i + 1) + ' vs dealer'
                    : 'Simulated match ' + (i + 1)}
                  <select
                    disabled={!open || busy || confirmed}
                    value={selected[i] ?? ''}
                    onChange={(e) =>
                      setPicks((current) => {
                        const next = Array.from({ length: game.picks }, (_, j) => current[j] ?? -1);
                        next[i] = Number(e.target.value);
                        return next;
                      })
                    }
                  >
                    <option value="" disabled>
                      Choose a prediction
                    </option>
                    {(r.game === 'blackjack'
                      ? ['Win', 'Draw', 'Lose']
                      : ['Home win', 'Draw', 'Away win']
                    ).map((label, n) => (
                      <option value={n} key={n}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          {!confirmed && !paid && (
            <div className="together-confirm">
              <dl>
                <div>
                  <dt>Maximum you can lose</dt>
                  <dd>{money(r.entryAmount, r.currency)}</dd>
                </div>
                <div>
                  <dt>Available after confirmation</dt>
                  <dd>{money(Math.max(0, available - r.entryAmount), r.currency)}</dd>
                </div>
                <div>
                  <dt>If you join now and win alone</dt>
                  <dd>
                    {estimate.soleWinnerPayout
                      ? money(estimate.soleWinnerPayout, r.currency)
                      : 'Waiting for a second player'}
                  </dd>
                </div>
              </dl>
              <small>
                This estimate includes your returned entry. The final payout depends on confirmed
                players and tied winners. Full refunds for too few players, all ties, or no
                qualifying winner.
              </small>
              <button className="together-primary" disabled={!canEnter} onClick={enter}>
                Confirm {money(r.entryAmount, r.currency)} entry
              </button>
              {available < r.entryAmount && (
                <p>
                  Insufficient available balance.{' '}
                  {r.currency === 'ETB' ? (
                    <Link to="/wallet">Open wallet</Link>
                  ) : (
                    <Link to="/play-together">Get free practice points</Link>
                  )}
                </p>
              )}
              {r.currency === 'ETB' && !s.cashAvailable && (
                <p>Real-money group play is not open for your account yet.</p>
              )}
            </div>
          )}
          {confirmed && !paid && (
            <div className="together-confirm">
              <p>
                <ShieldCheck size={17} /> Your entry is accepted. It will settle automatically, even
                if you disconnect.
              </p>
              {open && (
                <button disabled={busy} onClick={() => act('refund')}>
                  Cancel my entry and return {money(r.entryAmount, r.currency)}
                </button>
              )}
            </div>
          )}
          {paid && mine && (
            <div className="together-personal-result">
              <Trophy size={27} />
              <h3>
                {mine.state === 'REFUNDED'
                  ? 'Your entry was returned'
                  : mine.payout
                    ? 'Your payout'
                    : 'Round finished'}
              </h3>
              <strong>{money(mine.payout ?? 0, r.currency)}</strong>
              <p>
                {mine.state === 'REFUNDED'
                  ? 'No fee was charged.'
                  : 'Net result: ' + money((mine.payout ?? 0) - mine.amount, r.currency)}
              </p>
              <Link to="/wallet">View wallet activity →</Link>
              <small>Entry receipt: {mine.id}</small>
            </div>
          )}
          {r.creatorId === userId && open && (
            <button className="together-cancel" disabled={busy} onClick={() => act('cancel')}>
              Cancel this round and refund everyone
            </button>
          )}
        </section>
        <section className="together-panel">
          <p className="together-eyebrow">Everyone sees the same round</p>
          <h2>Confirmed participants</h2>
          <div className="together-pool">
            <span>Funded pool</span>
            <strong>{money(r.settlement?.funded ?? funded * r.entryAmount, r.currency)}</strong>
            <small>
              {r.settlement
                ? 'Platform fee: ' + money(r.settlement.platformFee, r.currency)
                : 'Only confirmed entries count. No fee is collected on a refunded round.'}
            </small>
          </div>
          {!participants.length && (
            <p>
              No confirmed entries yet. Invited members and spectators do not contribute to the
              pool.
            </p>
          )}
          <div className="together-participants">
            {participants.map((e) => {
              const result = r.ranking.find((rank) => rank.entryId === e.id);
              const prediction =
                e.selection === null
                  ? 'Selection sealed'
                  : !e.selection.length
                    ? 'Equal entry'
                    : ['blackjack', 'virtual_football_3d'].includes(r.game)
                      ? e.selection
                          .map(
                            (n) => (r.game === 'blackjack' ? ['W', 'D', 'L'] : ['H', 'D', 'A'])[n]
                          )
                          .join(' · ')
                      : ['sky_crash', 'crash_point'].includes(r.game)
                        ? (e.selection[0] / 100).toFixed(2) + '×'
                        : e.selection.join(', ');
              return (
                <div key={e.id}>
                  <span className="together-avatar">{e.username.slice(0, 1).toUpperCase()}</span>
                  <span>
                    <strong>
                      {e.username}
                      {e.userId === userId ? ' · You' : ''}
                    </strong>
                    <small>{prediction}</small>
                    {result && <small>{result.detail}</small>}
                  </span>
                  <span className="together-member-amount">
                    {money(e.payout ?? e.amount, r.currency)}
                    <small>
                      {e.state === 'SETTLED'
                        ? 'Paid'
                        : e.state === 'REFUNDED'
                          ? 'Refunded'
                          : 'Confirmed'}
                    </small>
                  </span>
                </div>
              );
            })}
          </div>
          {r.outcome && (
            <div className="together-result">
              <h3>Official result</h3>
              {r.game === 'spin_win' ? (
                <p>Winning segment: {r.outcome.numbers[0] + 1}</p>
              ) : r.outcome.football ? (
                <div>
                  {r.outcome.football.map((score, i) => (
                    <p key={i}>
                      Match {i + 1}: Home {score.home} – {score.away} Away
                    </p>
                  ))}
                </div>
              ) : r.outcome.hands ? (
                <div>
                  {r.outcome.numbers.map((v, i) => (
                    <p key={i}>
                      Hand {i + 1}: {['Win', 'Draw', 'Lose'][v]}
                    </p>
                  ))}
                </div>
              ) : ['sky_crash', 'crash_point'].includes(r.game) ? (
                <p>Crash: {(r.outcome.numbers[0] / 100).toFixed(2)}×</p>
              ) : r.game === 'dice' ? (
                <p>Each player’s dice and total are shown above.</p>
              ) : (
                <div className="together-balls">
                  {r.outcome.numbers.map((n, i) => (
                    <span key={i}>{n}</span>
                  ))}
                </div>
              )}
            </div>
          )}
          {r.state === 'REFUNDED' && (
            <p className="together-notice">
              {(
                {
                  ALL_TIED: 'Everyone tied. All entries were returned.',
                  NO_WINNERS: 'Nobody qualified. All entries were returned.',
                  NOT_ENOUGH_PLAYERS: 'Too few players confirmed before the deadline.',
                  OWNER_CANCELLED: 'The owner cancelled before betting closed.',
                  GROUP_CLOSED: 'The group closed before betting locked.',
                  RESULT_UNAVAILABLE: 'A verified result could not be recovered in time.',
                } as Record<string, string>
              )[r.settlement?.reason ?? r.voidReason ?? ''] ?? 'The round was refunded.'}
            </p>
          )}
          {paid && (
            <div className="together-result-actions">
              <button onClick={download}>
                <Download size={16} /> Download round receipt
              </button>
              {r.proof && (
                <button disabled={checking} onClick={() => void verify()}>
                  <ShieldCheck size={16} />
                  {checking ? 'Checking result…' : 'Verify result and payouts'}
                </button>
              )}
            </div>
          )}
        </section>
      </div>
      <details className="together-panel">
        <summary>Round rules and interruption policy</summary>
        <p>
          Selections are private until betting closes. Everyone pays the same entry. The owner
          cannot place a bet for you or change accepted round terms.
        </p>
        <p>
          You may cancel your own entry before the deadline. After closure, accepted entries
          continue through disconnection. A saved result is never redrawn.
        </p>
        <p>
          If a verified result cannot be recovered by{' '}
          {new Date(r.recoveryDeadline).toLocaleString()}, all entries are returned. A payment delay
          after a valid result remains a payout owed and will be retried.
        </p>
        <p>
          Tied leaders share equally, with at most one smallest currency unit difference for
          rounding. The fee applies only to the shared profit; your original entry is included once
          in the payout.
        </p>
        <small>
          Round: {r.id}
          <br />
          Rules: {r.rulesId}
          <br />
          Fee policy: {r.feePolicy}
          <br />
          Terms commitment: {r.termsHash}
        </small>
      </details>
      {paid && (
        <Link
          className="together-primary"
          to={r.groupId ? '/groups/' + r.groupId + '/games' : '/play-together'}
        >
          Choose another round <ArrowRight size={17} />
        </Link>
      )}
    </div>
  );
}
