import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  CircleDot,
  Dice5,
  Gamepad2,
  Heart,
  Pause,
  Play,
  Rocket,
  Search,
  ShieldCheck,
  Spade,
  Trophy,
  Wallet,
} from 'lucide-react';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useFavoriteGames } from '@/lib/use-favorite-games';
import { sessionRevision } from '@/lib/session';
import { consumeLaunchPermit, type LaunchPermit } from '@/lib/launch-intent';
import './provider-lobby.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export interface TestGame {
  id: string;
  name: string;
  provider: string;
  category: string;
  categories?: string[];
  image?: string;
  imageFallback?: string;
}

const PAGE_SIZE = 36;
const CATEGORIES = [
  ['spin', 'Spin'],
  ['slots', 'Slots'],
  ['live', 'Live casino'],
  ['table', 'Table games'],
  ['crash', 'Crash'],
  ['instant', 'Instant'],
  ['keno', 'Keno'],
  ['bingo', 'Bingo'],
  ['virtual', 'Virtual sports'],
  ['fishing', 'Fishing'],
  ['other', 'More games'],
] as const;
const categoryLabel = (category: string) =>
  CATEGORIES.find(([key]) => key === category)?.[1] ?? 'More games';
const belongsTo = (game: TestGame, category: string) =>
  game.category === category || game.categories?.includes(category) === true;
const casinoFailureMessage = (error: unknown) => {
  let code = '';
  try {
    code = JSON.parse(error instanceof Error ? error.message : '').code;
  } catch {
    /* Use safe fallback. */
  }
  switch (code) {
    case 'CASINO_GAME_REGION_UNAVAILABLE':
      return 'This provider does not offer this game in Ethiopia. Choose another game.';
    case 'CASINO_GAME_CURRENCY_UNAVAILABLE':
      return 'This game does not support the ETB practice wallet. Choose another game.';
    case 'CASINO_GAME_ADDRESS_PENDING':
      return 'This game is awaiting connection. Please choose another game for now.';
    case 'CASINO_PROVIDER_TIMEOUT':
      return 'The game provider took too long to respond. Please try again.';
    case 'CASINO_PROVIDER_BUSY':
      return 'Please wait a moment before opening another game.';
    case 'CASINO_PROVIDER_UNAVAILABLE':
      return 'The game provider is temporarily unavailable. Try again later or choose another game.';
    default:
      return 'Try again or choose another game.';
  }
};
const categoryIcon = (category: string) =>
  category === 'crash'
    ? Rocket
    : ['table', 'live'].includes(category)
      ? Spade
      : ['virtual', 'sportsbook'].includes(category)
        ? Trophy
        : ['keno', 'bingo', 'spin'].includes(category)
          ? CircleDot
          : Dice5;

export function GameArtwork({ game, motion }: { game: TestGame; motion: boolean }) {
  const { t: translateUi } = useInterfaceLanguage();
  const [imageIndex, setImageIndex] = useState(0);
  const sources = [...new Set([game.image, game.imageFallback].filter(Boolean))];
  const image = sources[imageIndex];
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const art = useRef<HTMLDivElement>(null);
  const Icon = categoryIcon(game.category);
  useEffect(() => {
    if (!art.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.1,
    });
    observer.observe(art.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={art}
      className="casino-tile-art"
      data-category={game.category}
      data-motion={motion && visible && loaded}
      data-loaded={loaded}
    >
      {image ? (
        <img
          key={image}
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setImageIndex((index) => index + 1);
          }}
        />
      ) : (
        <div className="casino-tile-fallback" aria-hidden="true">
          <span className="casino-tile-orbit" />
          <Icon strokeWidth={1.1} />
          <span>{translateUi(categoryLabel(game.category))}</span>
        </div>
      )}
      <span className="casino-tile-play" aria-hidden="true">
        <Play fill="currentColor" size={17} />
      </span>
    </div>
  );
}

export function ProviderTestPage() {
  const { t: translateUi } = useInterfaceLanguage();

  const { user } = useAuth();
  const location = useLocation();
  return user ? (
    <ProviderTestSession key={`${user.id}:${sessionRevision()}:${location.key}`} userId={user.id} />
  ) : (
    <p>{translateUi('Sign in to browse the casino.')}</p>
  );
}

function ProviderTestSession({ userId }: { userId: string }) {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();
  const { favoriteIds, toggleFavorite, storageUnavailable, limitReached, maxFavorites } =
    useFavoriteGames(userId, 'casino');
  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);
  const favoritesTab = useRef<HTMLButtonElement>(null);

  const [searchParams] = useSearchParams();
  const requestedGame = searchParams.get('game');
  const attemptedGame = useRef<string | null>(null);
  // Authorization belongs to this mounted navigation, target and session only.
  // Keep the spent nonce in the URL: reload/Back cannot consume it again, and
  // sanitizing the route must never transfer permission to a newer navigation.
  const [launchOnArrival, setLaunchOnArrival] = useState<boolean | null>(null);
  const arrival = useRef<Promise<LaunchPermit | null> | null>(null);
  const revision = useRef(sessionRevision());
  const arrivalDeadline = useRef(0);
  const activePage = useRef(true);
  useEffect(() => {
    activePage.current = true;
    const leave = () => {
      activePage.current = false;
    };
    window.addEventListener('pagehide', leave);
    return () => {
      leave();
      window.removeEventListener('pagehide', leave);
    };
  }, []);
  useEffect(() => {
    let active = true;
    arrival.current ??= consumeLaunchPermit(
      'casino',
      userId,
      searchParams.get('intent'),
      requestedGame ?? ''
    );
    void arrival.current.then((permit) => {
      if (active && activePage.current) {
        arrivalDeadline.current = permit?.expiresAt ?? 0;
        setLaunchOnArrival(permit !== null && revision.current === sessionRevision());
      }
    });
    return () => {
      active = false;
    };
  }, [searchParams, userId, requestedGame]);
  const [selectionError, setSelectionError] = useState(false);
  const [motionEnabled, setMotionEnabled] = useState(
    () =>
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
  );
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onPreference = () => {
      if (preference.matches) setMotionEnabled(false);
    };
    const onVisibility = () => setPageVisible(!document.hidden);
    preference.addEventListener?.('change', onPreference);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      preference.removeEventListener?.('change', onPreference);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [provider, setProvider] = useState('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<TestGame | null>(null);
  const status = useQuery({
    queryKey: ['provider-test-status', userId],
    refetchInterval: 15000,
    retry: false,
    queryFn: async () =>
      unwrapData(
        await api.get<{
          enabled: boolean;
          launchReady: boolean;
          unavailableReason?: 'paused' | 'restricted' | 'setup-required' | null;
        }>('/provider-test/status')
      ),
  });
  const accessGranted = status.data?.enabled === true && !status.isError;
  const catalogue = useQuery({
    queryKey: ['provider-test-games', userId],
    enabled: accessGranted,
    retry: false,
    queryFn: async () => unwrapData(await api.get<TestGame[]>('/provider-test/games')),
  });
  const wallet = useQuery({
    queryKey: ['provider-test-wallet', userId],
    enabled: accessGranted,
    retry: false,
    refetchInterval: accessGranted ? 5000 : false,
    queryFn: async () =>
      unwrapData(
        await api.get<{
          balanceCents: number;
          created: boolean;
          movements: { action: string; amountCents: number; error: number; at: string }[];
        }>('/provider-test/wallet')
      ),
  });
  const launch = useMutation({
    mutationFn: async (game: TestGame) => {
      if (!activePage.current || revision.current !== sessionRevision())
        throw new Error('Session changed');
      const launchRevision = revision.current;
      const result = unwrapData(
        await api.post<{ url: string; mode: string }>('/provider-test/launch', {
          gameId: game.id,
          // Keep older API deployments compatible; the server enforces Ethiopia.
          country: 'ET',
          mobile: window.matchMedia('(max-width: 767px)').matches,
        })
      );
      if (!activePage.current || launchRevision !== sessionRevision())
        throw new Error('Session changed');
      const url = new URL(result.url);
      if (
        result.mode !== 'virtual-test' ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password
      )
        throw new Error('Invalid test launch');
      return result;
    },
  });
  const resetLaunch = launch.reset;
  useEffect(() => {
    if (!accessGranted) {
      resetLaunch();
      setSelected(null);
    }
  }, [accessGranted, resetLaunch]);
  const allGames = useMemo(
    () => (catalogue.data ?? []).filter((game) => !belongsTo(game, 'sportsbook')),
    [catalogue.data]
  );
  const providers = useMemo(
    () => [...new Set(allGames.map((game) => game.provider))].sort((a, b) => a.localeCompare(b)),
    [allGames]
  );
  const matchingGames = useMemo(
    () =>
      allGames.filter(
        (game) =>
          (provider === 'all' || game.provider === provider) &&
          `${game.name} ${game.provider}`.toLowerCase().includes(search.trim().toLowerCase())
      ),
    [allGames, provider, search]
  );
  const games = useMemo(() => {
    const matches = matchingGames.filter((game) =>
      category === 'favorites'
        ? favoriteSet.has(game.id)
        : category === 'all' || belongsTo(game, category)
    );
    // Put standalone wheels/tops first; roulette stays discoverable below them.
    return category === 'spin'
      ? matches.sort(
          (a, b) => Number(/\broulette\b/i.test(a.name)) - Number(/\broulette\b/i.test(b.name))
        )
      : matches;
  }, [matchingGames, category, favoriteSet]);
  const favoriteCount = matchingGames.filter((game) => favoriteSet.has(game.id)).length;
  const hasAvailableFavorites = allGames.some((game) => favoriteSet.has(game.id));
  const categories = useMemo(
    () =>
      CATEGORIES.filter(([key]) => allGames.some((game) => belongsTo(game, key))).map(
        ([key, label]) => ({
          key,
          label,
          count: matchingGames.filter((game) => belongsTo(game, key)).length,
        })
      ),
    [allGames, matchingGames]
  );
  const canLaunch =
    accessGranted && status.data?.launchReady === true && !wallet.isError && !!wallet.data;
  const launchGame = launch.mutate;
  useEffect(() => {
    if (
      launchOnArrival === null ||
      !requestedGame ||
      !canLaunch ||
      !catalogue.data ||
      catalogue.isError ||
      attemptedGame.current === requestedGame
    )
      return;
    attemptedGame.current = requestedGame;
    const game = allGames.find((item) => item.id === requestedGame);
    if (!game) {
      setSelectionError(true);
      return;
    }
    setSelectionError(false);
    setSelected(game);
    resetLaunch();
    if (
      launchOnArrival &&
      activePage.current &&
      revision.current === sessionRevision() &&
      Date.now() <= arrivalDeadline.current
    )
      launchGame(game);
    setLaunchOnArrival(false);
  }, [
    requestedGame,
    canLaunch,
    catalogue.data,
    allGames,
    catalogue.isError,
    launchOnArrival,
    resetLaunch,
    launchGame,
  ]);
  const close = () => {
    launch.reset();
    setSelected(null);
  };
  const balance =
    wallet.data && !wallet.isError
      ? (wallet.data.balanceCents / 100).toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : '—';

  return (
    <main className="casino-lobby">
      <div className="casino-topline">
        <Link to="/games">
          <ArrowLeft size={15} />
          {' ' + translateUi('Back to our games')}
        </Link>
        <Link to="/sports">
          <Trophy size={15} />
          {' ' + translateUi('Sports · Real wallet')}
        </Link>
        <span>
          <ShieldCheck size={14} />
          {' ' + translateUi('Virtual play')}
        </span>
      </div>
      <header className="casino-heading">
        <div>
          <p className="casino-eyebrow">{translateUi('SALEM BET COLLECTION')}</p>
          <h1>
            {translateUi('Casino')}
            <span aria-hidden="true">.</span>
          </h1>
          <p className="casino-subtitle">{translateUi('Find your game. Make it your moment.')}</p>
        </div>
        {accessGranted && (
          <section aria-label={translateUi('Test wallet')} className="casino-balance">
            <Wallet size={21} aria-hidden="true" />
            <div>
              <span>{translateUi('Virtual test balance')}</span>
              <strong>
                {balance} <small>{'ETB'}</small>
              </strong>
            </div>
          </section>
        )}
      </header>
      <p className="casino-practice-note">
        <span />
        {' ' + translateUi('Virtual ETB · No cash value')}
      </p>
      {selectionError && (
        <p className="casino-notice" role="status">
          {translateUi('That game is no longer in the collection. Choose another game below.')}
        </p>
      )}
      {status.isLoading && (
        <p className="casino-notice" role="status">
          {translateUi('Checking casino access…')}
        </p>
      )}
      {status.isError && (
        <div className="casino-notice" role="alert">
          {translateUi('Could not check casino availability.')}{' '}
          <button onClick={() => void status.refetch()}>{translateUi('Retry')}</button>
        </div>
      )}
      {!status.isError && status.data?.enabled === false && (
        <p className="casino-notice" role="status">
          {status.data.unavailableReason === 'paused'
            ? translateUi('Casino practice is temporarily paused. Please try again later.')
            : status.data.unavailableReason === 'setup-required'
              ? translateUi('Casino practice is temporarily unavailable. Please try again shortly.')
              : translateUi('Casino practice is not available for this account.')}{' '}
          <button onClick={() => void status.refetch()}>{translateUi('Check again')}</button>
        </p>
      )}
      {accessGranted && wallet.isError && (
        <p className="casino-notice" role="alert">
          {translateUi('Could not check the test balance.')}{' '}
          <button onClick={() => void wallet.refetch()}>{translateUi('Refresh balance')}</button>
        </p>
      )}
      {accessGranted && status.data?.launchReady === false && (
        <p className="casino-notice" role="status">
          {translateUi('Games are temporarily unavailable. Please try again shortly.')}
        </p>
      )}

      {accessGranted && selected ? (
        <section aria-label={translateUi('Selected provider game')} className="casino-player">
          <div className="casino-player-toolbar">
            <button onClick={close} className="casino-back-button">
              <ArrowLeft size={17} />
              {' ' + translateUi('Back to casino')}
            </button>
            <div>
              <h2>{selected.name}</h2>
              <span>{selected.provider}</span>
            </div>
            <span className="casino-player-mode">{translateUi('Virtual play')}</span>
          </div>
          {launch.isIdle && (
            <div className="casino-player-placeholder">
              <Gamepad2 size={36} aria-hidden="true" />
              <h3>{selected.name}</h3>
              <p>{translateUi('Nothing starts until you choose Play.')}</p>
              <button
                className="casino-primary-button"
                disabled={!canLaunch}
                onClick={() => launch.mutate(selected)}
              >
                {translateUi('Play')}
              </button>
            </div>
          )}
          {launch.isPending && (
            <div className="casino-player-placeholder" role="status">
              <span className="casino-loading-ring" />
              {translateUi('Opening') + ' '}
              {selected.name}…
            </div>
          )}
          {launch.isError && (
            <div className="casino-player-placeholder" role="alert">
              <Gamepad2 size={36} />
              <h3>{translateUi('This game could not be opened.')}</h3>
              <p>{translateUi(casinoFailureMessage(launch.error))}</p>
              <button
                className="casino-primary-button"
                disabled={!canLaunch}
                onClick={() => launch.mutate(selected)}
              >
                {translateUi('Try again')}
              </button>
            </div>
          )}
          {launch.data && (
            <>
              <div className="casino-frame-help">
                <span>{translateUi('Game not loading?')}</span>
                <a
                  href={launch.data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  {translateUi('Open game in a new tab')}{' '}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              </div>
              <iframe
                title={translateUi('{name} test', { name: selected.name })}
                src={launch.data.url}
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
                allow="fullscreen"
                allowFullScreen
              />
            </>
          )}
        </section>
      ) : (
        accessGranted && (
          <section aria-label={translateUi('Casino game lobby')}>
            <div className="casino-browser-bar">
              <h2>
                <Gamepad2 size={21} />
                {' ' + translateUi('The game collection')}{' '}
                <span>
                  {catalogue.data ? allGames.length.toLocaleString(interfaceLocale) : '—'}
                </span>
              </h2>
              <div className="casino-browser-controls">
                <button
                  type="button"
                  className="casino-motion-toggle"
                  aria-label={
                    motionEnabled ? translateUi('Pause previews') : translateUi('Animate previews')
                  }
                  aria-pressed={motionEnabled}
                  onClick={() => setMotionEnabled((enabled) => !enabled)}
                >
                  {motionEnabled ? <Pause size={15} /> : <Play size={15} />}
                  <span>
                    {motionEnabled
                      ? translateUi('Pause previews')
                      : translateUi('Animate previews')}
                  </span>
                </button>
                <label className="casino-search">
                  <Search size={18} aria-hidden="true" />
                  <span className="sr-only">{translateUi('Search games or providers')}</span>
                  <input
                    type="search"
                    placeholder={translateUi('Search games or providers')}
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setVisibleCount(PAGE_SIZE);
                    }}
                  />
                </label>
                <label className="casino-provider-filter">
                  <span className="sr-only">{translateUi('Game provider')}</span>
                  <select
                    value={provider}
                    onChange={(event) => {
                      setProvider(event.target.value);
                      setVisibleCount(PAGE_SIZE);
                    }}
                  >
                    <option value="all">{translateUi('All providers')}</option>
                    {providers.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <div
              className="casino-categories"
              role="group"
              aria-label={translateUi('Game categories')}
            >
              <button
                ref={favoritesTab}
                aria-label={translateUi('Favorites')}
                aria-describedby="casino-count-favorites"
                aria-pressed={category === 'favorites'}
                onClick={() => {
                  setCategory('favorites');
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                <Heart size={14} aria-hidden="true" />
                {translateUi('Favorites')}
                <span id="casino-count-favorites" className="casino-category-count">
                  {favoriteCount.toLocaleString(interfaceLocale)}
                </span>
              </button>
              <button
                aria-label={translateUi('All games')}
                aria-describedby="casino-count-all"
                aria-pressed={category === 'all'}
                onClick={() => {
                  setCategory('all');
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                {translateUi('All games')}
                <span id="casino-count-all" className="casino-category-count">
                  {matchingGames.length.toLocaleString(interfaceLocale)}
                </span>
              </button>
              {categories.map(({ key, label, count }) => (
                <button
                  key={key}
                  aria-label={translateUi(label)}
                  aria-describedby={`casino-count-${key}`}
                  aria-pressed={category === key}
                  onClick={() => {
                    setCategory(key);
                    setVisibleCount(PAGE_SIZE);
                  }}
                >
                  {translateUi(label)}
                  <span id={`casino-count-${key}`} className="casino-category-count">
                    {count.toLocaleString(interfaceLocale)}
                  </span>
                </button>
              ))}
            </div>
            {category === 'spin' && (
              <p className="casino-collection-note">
                {translateUi('Wheel, roulette and spinner games.')}
              </p>
            )}
            {storageUnavailable ? (
              <p className="casino-collection-note" role="status">
                {translateUi('Favorites are unavailable in this browser.')}
              </p>
            ) : (
              category === 'favorites' && (
                <p className="casino-collection-note">
                  {translateUi('Favorites are saved for this account on this device.')}
                </p>
              )
            )}
            {!storageUnavailable && limitReached && (
              <p className="casino-collection-note" role="status">
                {translateUi(
                  'You can save up to {count} favorite games. Remove one to add another.',
                  { count: maxFavorites }
                )}
              </p>
            )}
            {catalogue.isLoading && (
              <>
                <p className="casino-notice" role="status">
                  {translateUi('Loading games…')}
                </p>
                <div className="casino-game-grid" aria-hidden="true">
                  {Array.from({ length: 12 }, (_, i) => (
                    <div className="casino-tile-skeleton" key={i} />
                  ))}
                </div>
              </>
            )}
            {catalogue.isError && (
              <div className="casino-notice" role="alert">
                {translateUi('Provider games are temporarily unavailable.')}{' '}
                <button onClick={() => void catalogue.refetch()}>{translateUi('Retry')}</button>
              </div>
            )}
            {catalogue.data &&
              !catalogue.isError &&
              !games.length &&
              !(category === 'favorites' && storageUnavailable) && (
                <div className="casino-empty">
                  {category === 'favorites' && !hasAvailableFavorites ? (
                    <Heart size={30} />
                  ) : (
                    <Search size={30} />
                  )}
                  <h3>
                    {translateUi(
                      category === 'favorites' && !hasAvailableFavorites
                        ? 'No favorites yet'
                        : 'No games found'
                    )}
                  </h3>
                  <p>
                    {translateUi(
                      category === 'favorites' && !hasAvailableFavorites
                        ? 'Tap the heart on a game to save it here.'
                        : 'Try another title, provider, or category.'
                    )}
                  </p>
                  {(search || category !== 'all' || provider !== 'all') && (
                    <button
                      className="casino-primary-button"
                      onClick={() => {
                        setSearch('');
                        setCategory(
                          category === 'favorites' && hasAvailableFavorites ? 'favorites' : 'all'
                        );
                        setProvider('all');
                        setVisibleCount(PAGE_SIZE);
                      }}
                    >
                      {translateUi(
                        category === 'favorites' && !hasAvailableFavorites
                          ? 'Browse games'
                          : 'Clear filters'
                      )}
                    </button>
                  )}
                </div>
              )}
            <div className="casino-game-grid">
              {games.slice(0, visibleCount).map((game) => (
                <div className="casino-game-card" key={game.id}>
                  <button
                    type="button"
                    className="casino-game-tile"
                    aria-label={translateUi('Play {name}', { name: game.name })}
                    disabled={!canLaunch}
                    onClick={() => {
                      launch.reset();
                      setSelected(game);
                      launch.mutate(game);
                    }}
                  >
                    <GameArtwork
                      key={`${game.id}:${game.image ?? ''}:${game.imageFallback ?? ''}`}
                      game={game}
                      motion={motionEnabled && pageVisible}
                    />
                    <div className="casino-tile-caption">
                      <h3>{game.name}</h3>
                      <p>
                        {game.provider}
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="casino-favorite"
                    disabled={storageUnavailable || (limitReached && !favoriteSet.has(game.id))}
                    aria-label={translateUi(
                      favoriteSet.has(game.id)
                        ? 'Remove {name} from favorites'
                        : 'Add {name} to favorites',
                      { name: game.name }
                    )}
                    aria-pressed={favoriteSet.has(game.id)}
                    onClick={() => {
                      if (category === 'favorites') favoritesTab.current?.focus();
                      toggleFavorite(game.id);
                    }}
                  >
                    <Heart
                      size={18}
                      aria-hidden="true"
                      fill={favoriteSet.has(game.id) ? 'currentColor' : 'none'}
                    />
                  </button>
                </div>
              ))}
            </div>
            {games.length > 0 && (
              <div className="casino-more">
                <p>
                  {translateUi('Showing {value} of {value2} games', {
                    value: Math.min(visibleCount, games.length).toLocaleString(interfaceLocale),
                    value2: games.length.toLocaleString(interfaceLocale),
                  })}
                </p>
                {visibleCount < games.length && (
                  <button onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                    {translateUi('Show more games') + ' '}
                    <ChevronDown size={17} />
                  </button>
                )}
              </div>
            )}
          </section>
        )
      )}
      {accessGranted && wallet.data && wallet.data.movements.length > 0 && (
        <details className="casino-activity">
          <summary>{translateUi('Recent test wallet activity')}</summary>
          <ul>
            {wallet.data.movements.map((m, i) => (
              <li key={`${m.at}-${i}`}>
                <span>
                  {m.action === 'debit' ? translateUi('Bet') : translateUi('Win / refund')}
                </span>
                <strong>
                  {translateUi('{value} ETB', { value: (m.amountCents / 100).toFixed(2) })}
                </strong>
                <span>{m.error ? translateUi('Declined') : translateUi('Confirmed')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
