import { useTogetherText, useTogetherNotice, groupErrorNotice } from '@/lib/i18n/together-text';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, ShieldCheck, Clock3, Trophy, ArrowRight, Wallet, Download } from 'lucide-react';
import {
  TOGETHER_GAMES,
  TOGETHER_GAME_DURATION_MS,
  togetherGame,
  togetherGameGuide,
  togetherSelection,
  togetherPayoutEstimate,
  type TogetherGame,
  type TogetherCurrency,
  type TogetherSettings,
  type TogetherSnapshot,
  type TogetherActivityRound,
  togetherRevealTimeline,
} from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import { verifyTogetherRound } from '@/lib/together-proof';
import { useAuth } from '@/providers/auth-provider';
import { GroupSocialNav } from '@/components/groups/group-social-nav';
import { GameArtwork } from '@/components/member/game-artwork';
import { TogetherSelection } from './play-together-selection';
import { ArenaChat } from '@/components/together/arena-chat';
import { TogetherLobby as RoundLobby } from '@/components/together/together-lobby';
import '@/components/together/group-arena.css';
import { TogetherGameResult } from '@/components/together/together-game-result';
import { useRoundUpdates } from '@/components/together/use-round-updates';
import './play-together.css';

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
  rounds: (Omit<TogetherActivityRound, 'groupName'> & {
    groupId: string | null;
    groupName: string | null;
    feeBps: number;
  })[];
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
  const { t, num, money, guideNotes } = useTogetherText();

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
    [notice, setNotice] = useTogetherNotice();
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
            ? {
                message: '{amount} free practice points added. Your real wallet is unchanged.',
                values: { amount: data.added },
              }
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
        groupErrorNotice(
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
        {t('Loading shared game rooms…')}
      </div>
    );
  if (!query.data)
    return (
      <div className="together-page">
        <p role="alert">{t('Group rooms are temporarily unavailable.')}</p>
        <button onClick={() => void query.refetch()}>{t('Try again')}</button>
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
  const recentResult = s.rounds.find((r) => ['PAID', 'REFUNDED'].includes(r.state));
  const liveRounds = s.rounds.filter((r) => ['OPEN', 'LOCKED', 'DRAWN'].includes(r.state));
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
      {groupId && <GroupSocialNav groupId={groupId} showRoundActivity={false} />}
      <header className="together-hero">
        <div>
          <p className="together-eyebrow">
            <Users size={16} /> {s.group?.name ?? t('Shared moments. Fair play.')}
          </p>
          <h1>
            {t('Play together')}
            <span>.</span>
          </h1>
          <p>{t('Choose a game. Confirm your own entry. Share the moment.')}</p>
        </div>
        <div className="together-wallet">
          <Wallet size={20} />
          <div>
            <span>{t('Real wallet')}</span>
            <strong>{money(s.balances.cashAvailable, 'ETB')}</strong>
            <small>
              {t('{amount} in group rounds', { amount: money(s.balances.cashReserved, 'ETB') })}
            </small>
          </div>
        </div>
      </header>
      <ol className="together-journey" aria-label={t('How group play works')}>
        <li>
          <b>{num(1)}</b>
          <span>
            <strong>{t('Choose together')}</strong>
            <small>{t('The owner publishes. Each player confirms their own entry.')}</small>
          </span>
        </li>
        <li>
          <b>{num(2)}</b>
          <span>
            <strong>{t('Watch together')}</strong>
            <small>{t('Every member can watch the same round for free.')}</small>
          </span>
        </li>
        <li>
          <b>{num(3)}</b>
          <span>
            <strong>{t('See the result')}</strong>
            <small>{t('Results are saved and payouts arrive automatically.')}</small>
          </span>
        </li>
      </ol>
      {(liveRounds.length > 0 || recentResult) && (
        <section
          className="together-panel together-room-doorway"
          aria-label={t('Your group rounds')}
        >
          <h2>{groupId ? t('Your group’s shared screen') : t('Happening in your groups')}</h2>
          <p>{t('Open a round to watch. Only your own confirmation places an entry.')}</p>
          <div className="together-history">
            {liveRounds.map((r) => (
              <Link key={r.id} to={'/play-together/rounds/' + r.id}>
                <span>
                  <strong>{t(togetherGame(r.game).name)}</strong>
                  <small>
                    {t('{group} · {count} confirmed · {amount} per entry', {
                      group: r.groupName ?? t('Shared room'),
                      count: r.participants,
                      amount: money(r.entryAmount, r.currency),
                    })}
                  </small>
                </span>
                <span>{r.state === 'OPEN' ? t('Watch or join round') : t('Watch round')} →</span>
              </Link>
            ))}
            {recentResult && (
              <Link to={'/play-together/rounds/' + recentResult.id + '#group-results'}>
                <span>
                  <strong>{t(togetherGame(recentResult.game).name)}</strong>
                  <small>
                    {t('{group} · Latest completed round', {
                      group: recentResult.groupName ?? t('Shared room'),
                    })}
                  </small>
                </span>
                <span>{t('View group result →')}</span>
              </Link>
            )}
          </div>
          <a href="#round-history">{t('All rounds and results ↓')}</a>
        </section>
      )}
      <div className="together-mode" role="group" aria-label={t('Choose balance')}>
        <button
          aria-pressed={currency === 'GAME_POINTS'}
          onClick={() => {
            setCurrency('GAME_POINTS');
            setAmount('1000');
          }}
        >
          {t('Practice · points')}
        </button>
        <button
          aria-pressed={currency === 'ETB'}
          onClick={() => {
            setCurrency('ETB');
            setAmount('10');
          }}
        >
          {t('Real Birr')}
        </button>
        <span>
          <strong>{t('Available: {amount}', { amount: money(available, currency) })}</strong>
        </span>
      </div>
      {currency === 'ETB' && !s.cashAvailable && (
        <p className="together-notice">
          {t(
            'Real-money group play is not open for your account yet. You can explore the rules and play practice rounds.'
          )}
        </p>
      )}
      {currency === 'GAME_POINTS' && (
        <div className="together-notice">
          <p>
            {t(
              'Practice points have no cash value and cannot be withdrawn. They are separate from your real and reward Birr.'
            )}
          </p>
          <button
            disabled={busy || !s.settings.practiceEnabled}
            onClick={() => submit('/play-together/practice-points', {})}
          >
            {t('Refill practice points')}
          </button>
          <small>
            {t(
              'Free refill up to 10,000 points once per UTC day, including points already reserved.'
            )}
          </small>
        </div>
      )}
      {!s.workerReady && (
        <p role="status" className="together-notice">
          {t(
            'Group processing is reconnecting. New entries are paused; accepted rounds remain protected.'
          )}
        </p>
      )}
      {!s.admissionsEnabled && (
        <p role="status" className="together-notice">
          {t(
            'New group rounds and entries are paused. Accepted rounds still settle automatically.'
          )}
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
          {t('Check the same request again')}
        </button>
      )}
      {s.legacyPending && groupId && (
        <p className="together-notice">
          {t('A previous points round is still active. Finish it before starting a new one.')}{' '}
          <Link to={'/groups/' + groupId + '/games/legacy'}>{t('Finish that round')}</Link>
        </p>
      )}
      <details className="together-catalogue" open={!groupId || (own && !active)}>
        <summary>{t('Choose a game and read the rules')}</summary>
        <section aria-labelledby="together-games-title">
          <h2 id="together-games-title">{t('Find your group’s game')}</h2>
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
                  <strong>{t(g.name)}</strong>
                  <span>{enabled ? t('View group rules') : t('Group mode preparing')}</span>
                </button>
              );
            })}
          </div>
        </section>
        <section className="together-panel">
          <p className="together-eyebrow">{t('The rules, before you enter')}</p>
          <h2>{t(togetherGame(game).name)}</h2>
          <p>{t(togetherGame(game).rules)}</p>
          <p>{t(togetherGameGuide(game).choiceNote)}</p>
          <ul>
            {togetherGameGuide(game).mechanics.map((line) => (
              <li key={line}>{t(line)}</li>
            ))}
          </ul>
          {guideNotes(game).map((note) => (
            <p key={note}>{note}</p>
          ))}
          <p>{t(togetherGameGuide(game).tieRule)}</p>
          <p>
            <ShieldCheck size={16} />
            {t(
              'The fee is {percent}% of winning profit before fees. No additional entry or winner fee.',
              { percent: s.settings.feeBps / 100 }
            )}
          </p>
        </section>
      </details>
      {groupId ? (
        active ? null : own ? (
          <section className="together-panel">
            <h2>{t('Create a round')}</h2>
            <p>
              {t(
                'Publishing a round costs nothing. You and every member confirm your own entry separately.'
              )}
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
              className="together-form"
            >
              <label>
                {t('Entry per player ({currency})', {
                  currency: currency === 'ETB' ? t('Birr') : t('points'),
                })}
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
                {t('Minimum players')}
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
                {t('Maximum players')}
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
                {t('Betting closes after')}
                <select value={duration} onChange={(e) => setDuration(e.target.value)}>
                  <option value="120">{t('{count} minutes', { count: 2 })}</option>
                  <option value="300">{t('{count} minutes', { count: 5 })}</option>
                  <option value="600">{t('{count} minutes', { count: 10 })}</option>
                </select>
              </label>
              {currency === 'GAME_POINTS' && (
                <p>
                  {t('Game duration: {seconds} seconds', {
                    seconds: TOGETHER_GAME_DURATION_MS[game] / 1000,
                  })}
                </p>
              )}
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
                {t('Publish round')}
              </button>
            </form>
          </section>
        ) : (
          <p className="together-notice">
            {t(
              'The group owner can publish a round. Each member then chooses and confirms their own entry.'
            )}
          </p>
        )
      ) : (
        <section className="together-columns">
          <div className="together-panel">
            <h2>{t('Join a shared room')}</h2>
            <p>{t('Play with other members. Opening the room does not place a bet.')}</p>
            <p>
              {t('Entry: {amount} · {min}–{max} players · {minutes}-minute betting window', {
                amount: money(s.settings.minEntry, currency),
                min: 2,
                max: 20,
                minutes: 2,
              })}
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
              {t('Open shared room')}
              <ArrowRight size={17} />
            </button>
            {!s.settings.publicRoomsEnabled && (
              <small>
                {t('Public rooms are being prepared. Private group rooms are available below.')}
              </small>
            )}
          </div>
          <div className="together-panel">
            <h2>{t('Play with your group')}</h2>
            <p>{t('Invite friends through the group’s Members page. Joining a group is free.')}</p>
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
            <Link to="/groups">{t('Create or join a group →')}</Link>
          </div>
        </section>
      )}
      {s.rounds.length > 0 && (
        <section className="together-panel" id="round-history">
          <h2>{t('Rounds and results')}</h2>
          <div className="together-history">
            {s.rounds.map((r) => (
              <Link key={r.id} to={'/play-together/rounds/' + r.id}>
                <span>
                  <strong>{t(togetherGame(r.game).name)}</strong>
                  <small>
                    {t('{group} · {amount} entry · {count} players', {
                      group: r.groupName ?? t('Shared room'),
                      amount: money(r.entryAmount, r.currency),
                      count: r.participants,
                    })}
                  </small>
                </span>
                <span>
                  {r.state === 'PAID'
                    ? t('View result')
                    : r.state === 'REFUNDED'
                      ? t('Refunded')
                      : r.state === 'OPEN'
                        ? t('Open')
                        : t('In progress')}{' '}
                  →
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {groupId && (
        <Link to={'/groups/' + groupId + '/games/legacy'}>
          {t('Previous points rounds and history')}
        </Link>
      )}
    </div>
  );
}

function TogetherRound({ userId, roundId }: { userId: string; roundId: string }) {
  const { t, num, money, target, date, rankDetail, errorText } = useTogetherText();

  const location = useLocation();
  const cache = useQueryClient(),
    [clock, setClock] = useState(performance.now()),
    [picks, setPicks] = useState<number[]>([]);
  const [crashText, setCrashText] = useState(''),
    [notice, setNotice] = useTogetherNotice(),
    [checking, setChecking] = useState(false),
    [shareNotice, setShareNotice] = useTogetherNotice();
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
    void cache.invalidateQueries({ queryKey: ['together-group-activity', userId] });
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
          ? groupErrorNotice(reply.reason, 'Entry was not accepted.')
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
        groupErrorNotice(
          error,
          'Could not confirm. Your receipt is saved; check the same request again.'
        )
      );
      invalidate();
    },
  });
  const s = query.data?.snapshot,
    r = s?.round;
  useRoundUpdates(userId, roundId, r?.eventSequence);
  useEffect(() => {
    if (r?.id && location.hash === '#group-results') {
      document.getElementById('group-results')?.scrollIntoView?.({ block: 'start' });
    }
  }, [r?.id, location.hash]);
  const age = query.data ? Math.max(clock, performance.now()) - query.data.sent : Infinity;
  const connected =
    !!query.data &&
    !query.isError &&
    !query.isPaused &&
    age < 5000 &&
    query.data.received - query.data.sent < 2000;
  // Entry deadlines stay conservative. Presentation uses a separate midpoint
  // estimate so network round trips do not advance the shared reveal by a full RTT.
  const now = s ? s.serverTime + age : 0;
  const visualNow =
    s && query.data && connected
      ? s.serverTime +
        (query.data.received - query.data.sent) / 2 +
        Math.max(0, Math.max(clock, performance.now()) - query.data.received)
      : null;
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
        {t('Loading round…')}
      </div>
    );
  if (!r || !s)
    return (
      <div className="together-page">
        <p role="alert">{errorText(query.error, 'Round unavailable.')}</p>
        <button onClick={() => void query.refetch()}>{t('Try again')}</button>
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
  const verify = async () => {
    setChecking(true);
    try {
      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem(termsKey);
      } catch {}
      setNotice(await verifyTogetherRound(r, saved));
    } catch (error) {
      setNotice(groupErrorNotice(error, 'Result verification is unavailable.'));
    } finally {
      setChecking(false);
    }
  };
  const copyLink = async () => {
    const url = new URL('/play-together/rounds/' + roundId, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      setShareNotice(
        'Round link copied. Group members can open it to watch or confirm their own entry.'
      );
    } catch {
      setShareNotice({ message: 'Copy this round link: {url}', values: { url } });
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
    <div className="together-page together-round-page">
      <header className="together-round-header">
        <div>
          <Link to={r.groupId ? '/messages/' + r.groupId : '/play-together'}>
            ← {r.groupName ?? t('Public shared room')}
          </Link>
          <h1>{t(game.name)}</h1>
        </div>
        <button onClick={() => void copyLink()}>{t('Copy round link')}</button>
      </header>
      {shareNotice && (
        <p role="status" className="together-notice">
          {shareNotice}
        </p>
      )}
      <div className="together-status">
        <span role="timer">
          <Clock3 size={17} />
          {r.state === 'OPEN'
            ? seconds
              ? t('Betting closes in {time}', {
                  time:
                    num(Math.floor(seconds / 60)) +
                    ':' +
                    num(seconds % 60, { minimumIntegerDigits: 2, useGrouping: false }),
                })
              : t('Betting closed — locking entries')
            : r.state === 'LOCKED'
              ? t('Entries locked — preparing the shared result')
              : r.state === 'DRAWN'
                ? r.presentation
                  ? r.presentation.resultAvailable
                    ? t('Game finished—confirming payout')
                    : t('Live game')
                  : t('Result recorded — paying wallets')
                : r.state === 'PAID'
                  ? t('Paid')
                  : t('Refunded')}
        </span>
        <span>
          {t('{count} confirmed · minimum {min} · maximum {max}', {
            count: funded,
            min: r.minPlayers,
            max: r.maxPlayers,
          })}
        </span>
      </div>
      {!connected && (
        <p role="alert" className="together-notice">
          {t('Reconnecting. Entry controls are paused until the server confirms this round.')}
        </p>
      )}
      {changedTerms && (
        <p role="alert" className="together-notice">
          {t(
            'This round differs from its saved terms. New confirmation is blocked. Keep your receipt and contact support.'
          )}
        </p>
      )}
      {!s.admissionsEnabled && (
        <p role="status" className="together-notice">
          {t('New entries are paused. Accepted entries remain protected.')}
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
            {t(
              'Your confirmation is being checked. Its receipt is saved so retrying cannot charge you twice.'
            )}
          </p>
          <button
            disabled={mutation.isPending || !connected}
            onClick={() => {
              if (!pendingRef.current || actionRef.current) return;
              actionRef.current = true;
              mutation.mutate({ kind: 'enter', entry: pendingRef.current });
            }}
          >
            {t('Check the same confirmation')}
          </button>
        </div>
      )}
      <div className="together-arena-layout">
        <div className="together-arena-main">
          {!r.outcome && !r.presentation && !paid && (
            <RoundLobby round={r} userId={userId} serverNow={visualNow} />
          )}
          <TogetherGameResult round={r} userId={userId} serverNow={visualNow} />
        </div>
        {r.groupId && <ArenaChat groupId={r.groupId} userId={userId} />}
      </div>
      <div className="together-columns">
        <details className="together-panel together-entry-panel" open={open || paid || undefined}>
          <summary>{confirmed ? t('Your confirmed entry') : t('Your choice')}</summary>
          <div className="together-wallet">
            <Wallet size={17} />
            <div>
              <span>
                {r.currency === 'ETB' ? t('Available real Birr') : t('Available practice points')}
              </span>
              <strong>{money(available, r.currency)}</strong>
            </div>
          </div>
          <p className="together-eyebrow">{t('Your choice')}</p>
          <p className="together-eyebrow" role="status">
            {pending || mutation.isPending
              ? t('Confirming')
              : confirmed
                ? t('Confirmed')
                : picks.length
                  ? t('Choosing')
                  : t('Watching')}
          </p>
          <h2>
            {paid
              ? t('Round complete')
              : confirmed
                ? t('Your confirmed entry')
                : r.state === 'OPEN' && seconds > 0
                  ? t('Choose your entry or watch')
                  : t('You’re watching')}
          </h2>
          <p>
            {t('{amount} per player. {percent}% fee on winning profit before fees.', {
              amount: money(r.entryAmount, r.currency),
              percent: r.feeBps / 100,
            })}
          </p>
          {r.presentationDurationMs && (
            <p>
              {t('Game duration: {seconds} seconds', { seconds: r.presentationDurationMs / 1000 })}
            </p>
          )}
          {!paid && (open || confirmed) && (
            <TogetherSelection
              game={r.game}
              selected={selected}
              disabled={!open || busy || confirmed}
              onChange={setPicks}
              crashText={crashText}
              onCrashText={setCrashText}
            />
          )}
          {!confirmed && !paid && r.state === 'OPEN' && seconds > 0 && (
            <div className="together-confirm">
              <dl>
                <div>
                  <dt>{t('Maximum you can lose')}</dt>
                  <dd>{money(r.entryAmount, r.currency)}</dd>
                </div>
                <div>
                  <dt>{t('Available after confirmation')}</dt>
                  <dd>{money(Math.max(0, available - r.entryAmount), r.currency)}</dd>
                </div>
                <div>
                  <dt>{t('If you join now and win alone')}</dt>
                  <dd>
                    {estimate.soleWinnerPayout
                      ? money(estimate.soleWinnerPayout, r.currency)
                      : t('Waiting for a second player')}
                  </dd>
                </div>
              </dl>
              <small>
                {t(
                  'This estimate includes your returned entry. The final payout depends on confirmed players and tied winners. Full refunds for too few players, all ties, or no qualifying winner.'
                )}
              </small>
              <button className="together-primary" disabled={!canEnter} onClick={enter}>
                {t('Confirm {amount} entry', { amount: money(r.entryAmount, r.currency) })}
              </button>
              {available < r.entryAmount && (
                <p>
                  {t('Insufficient available balance.')}{' '}
                  {r.currency === 'ETB' ? (
                    <Link to="/wallet">{t('Open wallet')}</Link>
                  ) : (
                    <Link to="/play-together">{t('Get free practice points')}</Link>
                  )}
                </p>
              )}
              {r.currency === 'ETB' && !s.cashAvailable && (
                <p>{t('Real-money group play is not open for your account yet.')}</p>
              )}
            </div>
          )}
          {confirmed && !paid && (
            <div className="together-confirm">
              <p>
                <ShieldCheck size={17} />
                {t('Your entry is accepted. It will settle automatically, even if you disconnect.')}
              </p>
              {open && (
                <button disabled={busy} onClick={() => act('refund')}>
                  {t('Cancel my entry and return {amount}', {
                    amount: money(r.entryAmount, r.currency),
                  })}
                </button>
              )}
            </div>
          )}
          {!confirmed && !mine && (
            <p className="together-notice">
              {t('You’re watching. No entry has been charged.')}{' '}
              {paid
                ? t('You can see the group’s result and payouts below.')
                : t('Only clicking the confirmation button enters you in this round.')}
            </p>
          )}
          {paid && mine && (
            <div className="together-personal-result">
              <Trophy size={27} />
              <h3>
                {mine.state === 'REFUNDED'
                  ? t('Your entry was returned')
                  : mine.payout
                    ? t('Your payout')
                    : t('Round finished')}
              </h3>
              <strong>{money(mine.payout ?? 0, r.currency)}</strong>
              <p>
                {mine.state === 'REFUNDED'
                  ? t('No fee was charged.')
                  : t('Net result: {amount}', {
                      amount: money((mine.payout ?? 0) - mine.amount, r.currency),
                    })}
              </p>
              <Link to="/wallet">{t('View wallet activity →')}</Link>
              <small>{t('Entry receipt: {receipt}', { receipt: mine.id })}</small>
            </div>
          )}
          {r.creatorId === userId && open && (
            <button className="together-cancel" disabled={busy} onClick={() => act('cancel')}>
              {t('Cancel this round and refund everyone')}
            </button>
          )}
        </details>
        <details
          className="together-panel"
          id="group-results"
          open={paid || open || undefined}
          aria-label={t('Group participants and results')}
        >
          <summary>
            <h2 className="inline">
              {paid ? t('Group result and payouts') : t('Confirmed participants')}
            </h2>{' '}
            · {num(participants.length)}
          </summary>
          <div className="together-pool">
            <span>{t('Funded pool')}</span>
            <strong>{money(r.settlement?.funded ?? funded * r.entryAmount, r.currency)}</strong>
            <small>
              {r.settlement
                ? t('Platform fee: {amount}', {
                    amount: money(r.settlement.platformFee, r.currency),
                  })
                : t('Only confirmed entries count. No fee is collected on a refunded round.')}
            </small>
          </div>
          {!participants.length && (
            <p>
              {t(
                'No confirmed entries yet. Invited members and spectators do not contribute to the pool.'
              )}
            </p>
          )}
          <div className="together-participants">
            {participants.map((e) => {
              const result = r.ranking.find((rank) => rank.entryId === e.id);
              const prediction =
                e.selection === null
                  ? t('Selection sealed')
                  : !e.selection.length
                    ? t('Equal entry')
                    : ['blackjack', 'virtual_football_3d'].includes(r.game)
                      ? e.selection
                          .map(
                            (n) =>
                              (r.game === 'blackjack'
                                ? [t('Win'), t('Draw'), t('Lose')]
                                : [t('Home win'), t('Draw'), t('Away win')])[n]
                          )
                          .join(' · ')
                      : ['sky_crash', 'crash_point'].includes(r.game)
                        ? target(e.selection[0])
                        : e.selection.map((value) => num(value)).join(' · ');
              return (
                <div key={e.id}>
                  <span className="together-avatar">{e.username.slice(0, 1).toUpperCase()}</span>
                  <span>
                    <strong>
                      {e.userId === userId ? t('{name} · You', { name: e.username }) : e.username}
                    </strong>
                    <small>{prediction}</small>
                    {result && <small>{rankDetail(result.detail)}</small>}
                  </span>
                  <span className="together-member-amount">
                    {money(e.payout ?? e.amount, r.currency)}
                    <small>
                      {e.state === 'SETTLED'
                        ? t('Paid')
                        : e.state === 'REFUNDED'
                          ? t('Refunded')
                          : t('Confirmed')}
                    </small>
                  </span>
                </div>
              );
            })}
          </div>
          {r.state === 'REFUNDED' && (
            <p className="together-notice">
              {(
                {
                  ALL_TIED: t('Everyone tied. All entries were returned.'),
                  NO_WINNERS: t('Nobody qualified. All entries were returned.'),
                  NOT_ENOUGH_PLAYERS: t('Too few players confirmed before the deadline.'),
                  OWNER_CANCELLED: t('The owner cancelled before betting closed.'),
                  GROUP_CLOSED: t('The group closed before betting locked.'),
                  RESULT_UNAVAILABLE: t('A verified result could not be recovered in time.'),
                } as Record<string, string>
              )[r.settlement?.reason ?? r.voidReason ?? ''] ?? t('The round was refunded.')}
            </p>
          )}
          {(paid || r.presentation?.resultAvailable) && (
            <div className="together-result-actions">
              <button onClick={download}>
                <Download size={16} />
                {t('Download round receipt')}
              </button>
              {r.proof && (
                <button disabled={checking} onClick={() => void verify()}>
                  <ShieldCheck size={16} />
                  {checking
                    ? t('Checking result…')
                    : paid
                      ? t('Verify result and payouts')
                      : t('Verify outcome')}
                </button>
              )}
            </div>
          )}
        </details>
      </div>
      <details className="together-panel">
        <summary>{t('Round rules and interruption policy')}</summary>
        <p>{t(game.rules)}</p>
        <p>
          {t(
            'Selections are private until betting closes. Everyone pays the same entry. The owner cannot place a bet for you or change accepted round terms.'
          )}
        </p>
        <p>
          {t(
            'You may cancel your own entry before the deadline. After closure, accepted entries continue through disconnection. A saved result is never redrawn.'
          )}
        </p>
        <p>
          {t(
            'If a verified result cannot be recovered by {date}, all entries are returned. A payment delay after a valid result remains a payout owed and will be retried.',
            { date: date(r.recoveryDeadline, { dateStyle: 'medium', timeStyle: 'short' }) }
          )}
        </p>
        <p>
          {t(
            'Tied leaders share equally, with at most one smallest currency unit difference for rounding. The fee applies only to the shared profit; your original entry is included once in the payout.'
          )}
        </p>
        <small>
          {t('Round: {id}', { id: r.id })}
          <br />
          {t('Rules: {id}', { id: r.rulesId })}
          <br />
          {t('Fee policy: {policy}', { policy: r.feePolicy })}
          <br />
          {t('Terms commitment: {hash}', { hash: r.termsHash })}
        </small>
      </details>
      {paid && (
        <Link
          className="together-primary"
          to={r.groupId ? '/groups/' + r.groupId + '/games' : '/play-together'}
        >
          {t('Choose another round')}
          <ArrowRight size={17} />
        </Link>
      )}
    </div>
  );
}
