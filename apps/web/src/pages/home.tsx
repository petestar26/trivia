import { Link } from 'react-router-dom';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/providers/auth-provider';
import {
  Users,
  Wallet,
  MessageCircle,
  ArrowUpRight,
  ArrowRight,
  Sparkles,
  LockKeyhole,
  Plus,
  Search,
  X,
  Heart,
} from 'lucide-react';
import { GameArtwork } from '@/components/member/game-artwork';
import { MotionShelf } from '@/components/member/motion-shelf';
import { DashboardHighlights } from '@/components/member/dashboard-highlights';
import { useFavoriteGames } from '@/lib/use-favorite-games';
import { api, unwrapData } from '@/lib/api';
import {
  memberGameDestination,
  memberGameLabel,
  PRACTICE_ROUTES,
  type MemberGame,
} from '@/lib/member-game-catalog';
import './home.css';

interface LoungeGroup {
  id: string;
  name: string;
  description?: string | null;
  memberCount: number;
  isMember: boolean;
  isPrivate: boolean;
  status: string;
}

export function HomePage() {
  const { user } = useAuth();
  const [gameSearch, setGameSearch] = useState('');
  const [gameView, setGameView] = useState<'all' | 'ready' | 'upcoming' | 'favorites'>('all');
  const { favoriteIds, toggleFavorite, storageUnavailable } = useFavoriteGames(user?.id);
  const gameSearchInput = useRef<HTMLInputElement>(null);
  const catalog = useQuery({
    queryKey: ['games'],
    queryFn: async () =>
      unwrapData<MemberGame[]>(await api.get<MemberGame[]>('/games'), 'Games response'),
    staleTime: 60_000,
  });
  const groups = useQuery({
    queryKey: ['groups', 'dashboard'],
    queryFn: async () =>
      unwrapData<LoungeGroup[]>(await api.listGroups({ limit: 50 }), 'Groups response'),
    enabled: !!user?.id,
    refetchInterval: 60_000,
  });
  const wallet = useQuery({
    queryKey: ['wallet', user?.id],
    queryFn: async () =>
      unwrapData<{ coinsBalance: number; gamePointsBalance: number }>(
        await api.get('/wallet'),
        'Wallet response'
      ),
    enabled: !!user?.id,
  });
  const games = (catalog.data ?? [])
    .filter((g) => g.catalogStatus !== 'RETIRED')
    .sort(
      (a, b) =>
        Number(!!memberGameDestination(b)) - Number(!!memberGameDestination(a)) ||
        a.name.localeCompare(b.name)
    );
  const readyCount = games.filter((game) => !!memberGameDestination(game)).length;
  const search = gameSearch.trim().toLocaleLowerCase();
  const visibleGames = games.filter((game) => {
    const ready = !!memberGameDestination(game);
    return (
      (gameView === 'all' ||
        (gameView === 'favorites'
          ? favoriteIds.includes(game.id)
          : gameView === 'ready'
            ? ready
            : !ready)) &&
      `${game.name} ${game.key.replace(/_/g, ' ')}`.toLocaleLowerCase().includes(search)
    );
  });
  const showFutureCard = gameView === 'all' && !search;
  function clearGameFilters() {
    setGameSearch('');
    setGameView('all');
    gameSearchInput.current?.focus();
  }
  function clearGameSearch() {
    setGameSearch('');
    gameSearchInput.current?.focus();
  }
  // Private rooms appear only for their own members. "Active" describes open rooms, not online presence.
  const activeGroups = (groups.data ?? []).filter(
    (g) => g.status === 'ACTIVE' && (!g.isPrivate || g.isMember)
  );
  return (
    <div className="qube-home ruby-home">
      <section className="ruby-hero">
        <img src="/art/ruby-grand/lounge.webp" alt="" className="ruby-hero-art" />
        <div className="ruby-hero-copy">
          <p className="qube-eyebrow">
            <Sparkles size={14} /> PLAY TOGETHER. DISCOVER MORE.
          </p>
          <h1>
            Find your
            <br />
            <span>next game.</span>
          </h1>
          <p>
            Welcome back, {user?.displayName || user?.username || 'player'}. Your favorite games and
            your people, all in one place.
          </p>
          <a href="#lounge-games-title" className="qube-primary-link">
            Browse the collection <ArrowUpRight size={18} />
          </a>
          <p className="ruby-hero-note">Free practice · no cash prizes</p>
        </div>
        <span className="ruby-hero-seal">
          RUBY GRAND <span>THE MEMBER LOUNGE</span>
        </span>
      </section>
      <div className="ruby-welcome-strip">
        <div>
          <span className="ruby-status-dot" /> Your member lounge
          <small>Discover games. Find your people.</small>
        </div>
        <Link to="/wallet">
          <Wallet size={18} />
          <span>
            Coins <b>{wallet.isError ? '—' : (wallet.data?.coinsBalance ?? '—')}</b>
          </span>
          <span>
            Game Points <b>{wallet.isError ? '—' : (wallet.data?.gamePointsBalance ?? '—')}</b>
          </span>
          <ArrowUpRight size={16} />
        </Link>
        {(wallet.isPending || wallet.isError) && (
          <small className="ruby-wallet-state" role="status">
            {wallet.isError
              ? 'Balances unavailable. Open your wallet to retry.'
              : 'Loading balances…'}
          </small>
        )}
      </div>
      <DashboardHighlights
        userId={user?.id}
        games={games}
        catalogState={catalog.isPending ? 'loading' : catalog.isError ? 'error' : 'ready'}
      />
      <section aria-labelledby="lounge-games-title">
        <div className="qube-section-heading">
          <div>
            <p className="qube-eyebrow">THE GAME COLLECTION</p>
            <h2 id="lounge-games-title" tabIndex={-1}>
              Every game. Your way.
            </h2>
            <p className="ruby-collection-caption">
              The complete collection, including what’s coming next.
            </p>
          </div>
          <Link to="/casino">
            Casino <ArrowRight size={16} />
          </Link>
        </div>
        {!catalog.isPending && !catalog.isError && games.length > 0 && (
          <div className="ruby-game-discovery">
            <div className="ruby-game-toolbar">
              <div className="ruby-game-filters" role="group" aria-label="Game availability">
                {(
                  [
                    ['all', 'All games', games.length],
                    ['ready', 'Ready to explore', readyCount],
                    ['upcoming', 'Not yet available', games.length - readyCount],
                    [
                      'favorites',
                      'Favorites',
                      games.filter((game) => favoriteIds.includes(game.id)).length,
                    ],
                  ] as const
                ).map(([value, label, count]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={gameView === value}
                    onClick={() => setGameView(value)}
                  >
                    {label} <span>{count}</span>
                  </button>
                ))}
              </div>
              <div className="ruby-game-search" role="search" aria-label="Game collection">
                <label className="sr-only" htmlFor="lounge-game-search">
                  Search game collection
                </label>
                <Search size={18} aria-hidden="true" />
                <input
                  ref={gameSearchInput}
                  id="lounge-game-search"
                  type="search"
                  placeholder="Find your next game"
                  value={gameSearch}
                  onChange={(event) => setGameSearch(event.target.value)}
                />
                {gameSearch && (
                  <button type="button" aria-label="Clear game search" onClick={clearGameSearch}>
                    <X size={17} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
            <p className="ruby-game-results" role="status">
              Showing {visibleGames.length} of {games.length} games
            </p>
            <p className="ruby-favorites-note">
              {storageUnavailable
                ? 'Favorites are unavailable because this browser cannot safely load or save them.'
                : 'Your favorites are saved for this account in this browser.'}
            </p>
          </div>
        )}
        {catalog.isPending ? (
          <div className="ruby-loading" role="status">
            Loading the game collection…
          </div>
        ) : catalog.isError ? (
          <div className="ruby-empty" role="alert">
            <p>We couldn't load the games.</p>
            <button onClick={() => void catalog.refetch()}>Retry games</button>
          </div>
        ) : games.length && !visibleGames.length ? (
          <div className="ruby-empty ruby-game-no-results">
            <Search size={28} aria-hidden="true" />
            <h3>
              {gameView === 'favorites' && !search
                ? 'Your favorites start here.'
                : 'No games match these filters.'}
            </h3>
            <p>
              {gameView === 'favorites' && !search
                ? 'Use the heart beside a game to save it to this collection.'
                : 'Try another name or return to the full collection.'}
            </p>
            <button type="button" onClick={clearGameFilters}>
              Clear filters
            </button>
          </div>
        ) : games.length ? (
          <MotionShelf
            label="Games"
            count={visibleGames.length + Number(showFutureCard)}
            allowGrid
            initialView="grid"
          >
            {visibleGames.map((game) => {
              const to = memberGameDestination(game);
              const content = (
                <>
                  <GameArtwork kind={game.key} practiceAvailable={game.practiceAvailable} />
                  <div className="ruby-game-copy">
                    <span className={`ruby-game-status ${to ? 'is-ready' : ''}`}>
                      {memberGameLabel(game)}
                    </span>
                    <h3>{game.name}</h3>
                    <p>
                      {to && PRACTICE_ROUTES[game.key]
                        ? game.key === 'number_challenge'
                          ? 'Pick 1–100 · free practice scores, no stakes.'
                          : game.key === 'thunder_derby_3d'
                            ? 'Six or eight horses · practice credits only.'
                            : game.key === 'virtual_football_3d'
                              ? 'Ten matches every five minutes · practice credits only.'
                              : 'One-minute rounds · practice credits only.'
                        : to
                          ? game.mode === 'BONUS'
                            ? 'Test your knowledge. Play for free.'
                            : 'Explore the game and its published rules.'
                          : 'A new experience is on its way.'}
                    </p>
                    <span className="ruby-game-action">
                      {to ? (
                        <>
                          Explore game <ArrowUpRight size={17} />
                        </>
                      ) : (
                        <>
                          <LockKeyhole size={13} /> Not yet available
                        </>
                      )}
                    </span>
                  </div>
                </>
              );
              return (
                <div className="ruby-game-tile" key={game.id}>
                  {to ? (
                    <Link className="ruby-game-card" to={to}>
                      {content}
                    </Link>
                  ) : (
                    <article className="ruby-game-card is-upcoming">{content}</article>
                  )}
                  <button
                    type="button"
                    className="ruby-favorite-button"
                    disabled={storageUnavailable || !user?.id}
                    aria-label={`${favoriteIds.includes(game.id) ? 'Remove' : 'Add'} ${game.name} ${favoriteIds.includes(game.id) ? 'from' : 'to'} favorites`}
                    aria-pressed={favoriteIds.includes(game.id)}
                    onClick={() => {
                      // Removing the focused tile from the filtered view must leave focus on a stable control.
                      if (gameView === 'favorites' && favoriteIds.includes(game.id))
                        gameSearchInput.current?.focus();
                      toggleFavorite(game.id);
                    }}
                  >
                    <Heart
                      size={18}
                      aria-hidden="true"
                      fill={favoriteIds.includes(game.id) ? 'currentColor' : 'none'}
                    />
                  </button>
                </div>
              );
            })}
            {showFutureCard && (
              <article className="ruby-future-card">
                <div className="ruby-future-gem">
                  <Plus size={36} />
                </div>
                <span>THE COLLECTION GROWS</span>
                <h3>More to discover</h3>
                <p>
                  A place for the next game.
                  <br />
                  New releases appear here when ready.
                </p>
              </article>
            )}
          </MotionShelf>
        ) : (
          <div className="ruby-empty">The game collection is being prepared.</div>
        )}
        <p className="qube-disclosure">
          Practice credits have no cash value. Group games use Game Points. Upcoming games cannot be
          played yet.
        </p>
      </section>
      <section aria-labelledby="lounge-groups-title">
        <div className="qube-section-heading">
          <div>
            <p className="qube-eyebrow">BETTER TOGETHER</p>
            <h2 id="lounge-groups-title">Active groups</h2>
          </div>
          <Link to="/groups">
            Browse groups <ArrowRight size={16} />
          </Link>
        </div>
        {groups.isPending ? (
          <div className="ruby-loading" role="status">
            Loading active groups…
          </div>
        ) : groups.isError ? (
          <div className="ruby-empty" role="alert">
            <p>We couldn't load the groups.</p>
            <button onClick={() => void groups.refetch()}>Retry groups</button>
          </div>
        ) : activeGroups.length ? (
          <MotionShelf label="Groups" count={activeGroups.length}>
            {activeGroups.map((group, index) => (
              <Link to={`/groups/${group.id}`} className="ruby-group-card" key={group.id}>
                <div className={`ruby-group-scene ruby-group-scene--${index % 3}`}>
                  <Users size={46} strokeWidth={1.25} />
                  <span>{group.isPrivate ? 'PRIVATE · YOUR GROUP' : 'PUBLIC ROOM'}</span>
                </div>
                <div className="ruby-group-copy">
                  <span className="ruby-group-members">
                    <span className="ruby-status-dot" />
                    {group.memberCount} member{group.memberCount === 1 ? '' : 's'}
                  </span>
                  <h3>{group.name}</h3>
                  <p>{group.description || 'Talk, connect and choose your next game together.'}</p>
                  <span className="ruby-game-action">
                    {group.isMember ? 'Open your group' : 'View group'} <ArrowUpRight size={17} />
                  </span>
                </div>
              </Link>
            ))}
          </MotionShelf>
        ) : (
          <div className="ruby-empty ruby-group-empty">
            <Users size={32} />
            <div>
              <h3>Your next group starts here.</h3>
              <p>No active groups to show yet. Find your people or create a new room.</p>
            </div>
            <Link to="/groups" className="qube-primary-link">
              Explore groups <ArrowUpRight size={16} />
            </Link>
          </div>
        )}
      </section>
      <section aria-label="Quick access" className="qube-quick-grid">
        {[
          {
            to: '/groups',
            title: 'Your community',
            text: 'Choose a game. Share the moment.',
            Icon: Users,
          },
          {
            to: '/messages',
            title: 'Keep in touch',
            text: 'Conversations, reactions and gifts.',
            Icon: MessageCircle,
          },
          {
            to: '/wallet',
            title: 'Your wallet',
            text: 'Balances and transaction history.',
            Icon: Wallet,
          },
        ].map(({ to, title, text, Icon }) => (
          <Link to={to} key={to} className="qube-quick-card">
            <span className="qube-quick-icon">
              <Icon size={23} />
            </span>
            <div>
              <h2>{title}</h2>
              <p>{text}</p>
            </div>
            <ArrowUpRight size={18} className="qube-quick-arrow" />
          </Link>
        ))}
      </section>
    </div>
  );
}
