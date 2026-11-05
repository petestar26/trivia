import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  CircleDot,
  Dice5,
  Gamepad2,
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
import './provider-lobby.css';

interface TestGame {
  id: string;
  name: string;
  provider: string;
  category: string;
  image?: string;
  imageFallback?: string;
}

const PAGE_SIZE = 36;
const CATEGORIES = [
  ['slots', 'Slots'],
  ['live', 'Live casino'],
  ['table', 'Table games'],
  ['crash', 'Crash'],
  ['instant', 'Instant'],
  ['keno', 'Keno'],
  ['bingo', 'Bingo'],
  ['virtual', 'Virtual sports'],
  ['sportsbook', 'Sports'],
  ['fishing', 'Fishing'],
  ['other', 'More games'],
] as const;
const categoryLabel = (category: string) =>
  CATEGORIES.find(([key]) => key === category)?.[1] ?? 'More games';
const categoryIcon = (category: string) =>
  category === 'crash'
    ? Rocket
    : ['table', 'live'].includes(category)
      ? Spade
      : ['virtual', 'sportsbook'].includes(category)
        ? Trophy
        : ['keno', 'bingo'].includes(category)
          ? CircleDot
          : Dice5;

function GameArtwork({ game, motion }: { game: TestGame; motion: boolean }) {
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
          <span>{categoryLabel(game.category)}</span>
        </div>
      )}
      <span className="casino-tile-play" aria-hidden="true">
        <Play fill="currentColor" size={17} />
      </span>
    </div>
  );
}

export function ProviderTestPage() {
  const { user } = useAuth();
  return user ? (
    <ProviderTestSession key={user.id} userId={user.id} />
  ) : (
    <p>Sign in to browse the casino.</p>
  );
}

function ProviderTestSession({ userId }: { userId: string }) {
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
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<TestGame | null>(null);
  const status = useQuery({
    queryKey: ['provider-test-status', userId],
    refetchInterval: 15000,
    retry: false,
    queryFn: async () =>
      unwrapData(
        await api.get<{ enabled: boolean; launchReady: boolean }>('/provider-test/status')
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
      const result = unwrapData(
        await api.post<{ url: string; mode: string }>('/provider-test/launch', {
          gameId: game.id,
          // Keep older API deployments compatible; the server enforces Ethiopia.
          country: 'ET',
          mobile: window.matchMedia('(max-width: 767px)').matches,
        })
      );
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
  const games = useMemo(
    () =>
      (catalogue.data ?? []).filter(
        (game) =>
          (category === 'all' || game.category === category) &&
          `${game.name} ${game.provider}`.toLowerCase().includes(search.trim().toLowerCase())
      ),
    [catalogue.data, category, search]
  );
  const categories = useMemo(
    () => CATEGORIES.filter(([key]) => catalogue.data?.some((game) => game.category === key)),
    [catalogue.data]
  );
  const canLaunch =
    accessGranted && status.data?.launchReady === true && !wallet.isError && !!wallet.data;
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
          <ArrowLeft size={15} /> Back to our games
        </Link>
        <span>
          <ShieldCheck size={14} /> Virtual play
        </span>
      </div>
      <header className="casino-heading">
        <div>
          <p className="casino-eyebrow">SALEM BET COLLECTION</p>
          <h1>
            Casino<span aria-hidden="true">.</span>
          </h1>
          <p className="casino-subtitle">Find your game. Make it your moment.</p>
        </div>
        {accessGranted && (
          <section aria-label="Test wallet" className="casino-balance">
            <Wallet size={21} aria-hidden="true" />
            <div>
              <span>Virtual test balance</span>
              <strong>
                {balance} <small>ETB</small>
              </strong>
            </div>
          </section>
        )}
      </header>
      <p className="casino-practice-note">
        <span /> Virtual ETB · No cash value
      </p>
      {status.isLoading && (
        <p className="casino-notice" role="status">
          Checking test access…
        </p>
      )}
      {status.isError && (
        <div className="casino-notice" role="alert">
          Could not check test access. <button onClick={() => void status.refetch()}>Retry</button>
        </div>
      )}
      {status.data?.enabled === false && (
        <p className="casino-notice" role="status">
          Provider testing is not enabled for your account yet.
        </p>
      )}
      {accessGranted && wallet.isError && (
        <p className="casino-notice" role="alert">
          Could not check the test balance.{' '}
          <button onClick={() => void wallet.refetch()}>Refresh balance</button>
        </p>
      )}
      {accessGranted && status.data?.launchReady === false && (
        <p className="casino-notice" role="status">
          Test launch setup is being completed.
        </p>
      )}

      {accessGranted && selected ? (
        <section aria-label="Selected provider game" className="casino-player">
          <div className="casino-player-toolbar">
            <button onClick={close} className="casino-back-button">
              <ArrowLeft size={17} /> Back to casino
            </button>
            <div>
              <h2>{selected.name}</h2>
              <span>{selected.provider}</span>
            </div>
            <span className="casino-player-mode">Virtual play</span>
          </div>
          {launch.isPending && (
            <div className="casino-player-placeholder" role="status">
              <span className="casino-loading-ring" />
              Opening {selected.name}…
            </div>
          )}
          {launch.isError && (
            <div className="casino-player-placeholder" role="alert">
              <Gamepad2 size={36} />
              <h3>This game could not be opened.</h3>
              <p>Try again or choose another game.</p>
              <button
                className="casino-primary-button"
                disabled={!canLaunch}
                onClick={() => launch.mutate(selected)}
              >
                Try again
              </button>
            </div>
          )}
          {launch.data && (
            <iframe
              title={`${selected.name} test`}
              src={launch.data.url}
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
              allow="fullscreen"
              allowFullScreen
            />
          )}
        </section>
      ) : (
        accessGranted && (
          <section aria-label="Casino game lobby">
            <div className="casino-browser-bar">
              <h2>
                <Gamepad2 size={21} /> The game collection{' '}
                <span>{catalogue.data?.length.toLocaleString() ?? '—'}</span>
              </h2>
              <div className="casino-browser-controls">
                <button
                  type="button"
                  className="casino-motion-toggle"
                  aria-label={motionEnabled ? 'Pause previews' : 'Animate previews'}
                  aria-pressed={motionEnabled}
                  onClick={() => setMotionEnabled((enabled) => !enabled)}
                >
                  {motionEnabled ? <Pause size={15} /> : <Play size={15} />}
                  <span>{motionEnabled ? 'Pause previews' : 'Animate previews'}</span>
                </button>
                <label className="casino-search">
                  <Search size={18} aria-hidden="true" />
                  <span className="sr-only">Search games or providers</span>
                  <input
                    type="search"
                    placeholder="Search games or providers"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setVisibleCount(PAGE_SIZE);
                    }}
                  />
                </label>
              </div>
            </div>
            <div className="casino-categories" role="group" aria-label="Game categories">
              <button
                aria-pressed={category === 'all'}
                onClick={() => {
                  setCategory('all');
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                All games
              </button>
              {categories.map(([key, label]) => (
                <button
                  key={key}
                  aria-pressed={category === key}
                  onClick={() => {
                    setCategory(key);
                    setVisibleCount(PAGE_SIZE);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {catalogue.isLoading && (
              <>
                <p className="casino-notice" role="status">
                  Loading games…
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
                Provider games are temporarily unavailable.{' '}
                <button onClick={() => void catalogue.refetch()}>Retry</button>
              </div>
            )}
            {catalogue.data && !games.length && (
              <div className="casino-empty">
                <Search size={30} />
                <h3>No games found</h3>
                <p>Try another title, provider, or category.</p>
                {(search || category !== 'all') && (
                  <button
                    className="casino-primary-button"
                    onClick={() => {
                      setSearch('');
                      setCategory('all');
                      setVisibleCount(PAGE_SIZE);
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}
            <div className="casino-game-grid">
              {games.slice(0, visibleCount).map((game) => (
                <button
                  key={game.id}
                  type="button"
                  className="casino-game-tile"
                  aria-label={`Play ${game.name}`}
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
              ))}
            </div>
            {games.length > 0 && (
              <div className="casino-more">
                <p>
                  Showing {Math.min(visibleCount, games.length).toLocaleString()} of{' '}
                  {games.length.toLocaleString()} games
                </p>
                {visibleCount < games.length && (
                  <button onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                    Show more games <ChevronDown size={17} />
                  </button>
                )}
              </div>
            )}
          </section>
        )
      )}
      {accessGranted && wallet.data && wallet.data.movements.length > 0 && (
        <details className="casino-activity">
          <summary>Recent test wallet activity</summary>
          <ul>
            {wallet.data.movements.map((m, i) => (
              <li key={`${m.at}-${i}`}>
                <span>{m.action === 'debit' ? 'Bet' : 'Win / refund'}</span>
                <strong>{(m.amountCents / 100).toFixed(2)} ETB</strong>
                <span>{m.error ? 'Declined' : 'Confirmed'}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
