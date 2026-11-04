import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

interface DemoGame {
  id: string;
  name: string;
  provider: string;
  category: string;
}

export function ProviderDemoPage() {
  const { user } = useAuth();
  return user ? (
    <ProviderDemoSession key={user.id} userId={user.id} />
  ) : (
    <p>Sign in to try provider demos.</p>
  );
}

function ProviderDemoSession({ userId }: { userId: string }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<DemoGame | null>(null);
  const status = useQuery({
    queryKey: ['provider-demo-status', userId],
    retry: false,
    queryFn: async () => unwrapData(await api.get<{ enabled: boolean }>('/provider-demo/status')),
  });
  const accessGranted = status.data?.enabled === true && !status.isError;
  const catalogue = useQuery({
    queryKey: ['provider-demo-games', userId],
    enabled: accessGranted,
    retry: false,
    queryFn: async () => unwrapData(await api.get<DemoGame[]>('/provider-demo/games')),
  });
  const launch = useMutation({
    mutationFn: async (game: DemoGame) => {
      const result = unwrapData(
        await api.post<{ url: string; mode: string }>('/provider-demo/launch', {
          gameId: game.id,
          mobile: window.matchMedia('(max-width: 767px)').matches,
        })
      );
      const url = new URL(result.url);
      if (result.mode !== 'demo' || url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Invalid demo launch');
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
  const games = (catalogue.data ?? []).filter((game) =>
    `${game.name} ${game.provider}`.toLowerCase().includes(search.toLowerCase())
  );
  const close = () => {
    launch.reset();
    setSelected(null);
  };

  return (
    <main className="space-y-5 text-slate-100">
      <Link to="/games" className="text-sm text-rose-200">
        ← Back to our games
      </Link>
      <header className="rounded-2xl border border-rose-300/20 bg-slate-900 p-6">
        <p className="text-xs uppercase tracking-widest text-rose-300">
          Provider games · Demo preview
        </p>
        <h1 className="mt-2 text-3xl font-bold">Casino</h1>
        <p className="mt-3 text-slate-300">
          Demo games use virtual balances with no cash value. Your Salem Bet wallet is not
          connected.
        </p>
      </header>
      {status.isLoading && <p role="status">Checking demo access…</p>}
      {status.isError && (
        <div role="alert">
          Could not check demo access.{' '}
          <button onClick={() => void status.refetch()} className="underline">
            Retry
          </button>
        </div>
      )}
      {status.data?.enabled === false && (
        <p role="status">Provider demos are not enabled for your account yet.</p>
      )}
      {accessGranted && catalogue.isFetching && <p role="status">Loading provider games…</p>}
      {accessGranted && catalogue.isError && (
        <div role="alert">
          Provider games are temporarily unavailable.{' '}
          <button onClick={() => void catalogue.refetch()} className="underline">
            Retry
          </button>
        </div>
      )}
      {accessGranted && selected && (
        <section aria-label="Selected provider game" className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-bold">{selected.name} · Demo</h2>
            <button onClick={close} className="rounded-lg border px-4 py-2">
              Close game
            </button>
          </div>
          {launch.isPending && <p role="status">Opening demo…</p>}
          {launch.isError && (
            <div role="alert">
              This demo could not be opened.{' '}
              <button className="underline" onClick={() => launch.mutate(selected)}>
                Try again
              </button>
            </div>
          )}
          {launch.data && (
            <iframe
              title={`${selected.name} demo`}
              src={launch.data.url}
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
              allow="fullscreen"
              allowFullScreen
              className="w-full rounded-xl border border-white/20 bg-black"
              style={{ height: 'calc(100dvh - 180px)', minHeight: 320 }}
            />
          )}
        </section>
      )}
      {accessGranted && catalogue.data && !selected && (
        <>
          <label className="block">
            Search games or providers
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
              className="mt-2 block w-full rounded-lg border border-slate-600 bg-slate-900 p-3"
              type="search"
            />
          </label>
          {!games.length && <p>No demo games available{search ? ' for this search' : ''}.</p>}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {games.slice(page * 24, (page + 1) * 24).map((game) => (
              <article key={game.id} className="rounded-xl border border-white/10 bg-slate-900 p-5">
                <p className="text-xs uppercase text-rose-300">{game.category} · Demo</p>
                <h2 className="mt-2 text-lg font-semibold">{game.name}</h2>
                <p className="mt-1 text-sm text-slate-400">{game.provider}</p>
                <button
                  className="mt-4 rounded-lg bg-rose-700 px-4 py-2 font-semibold text-white"
                  onClick={() => {
                    launch.reset();
                    setSelected(game);
                    launch.mutate(game);
                  }}
                >
                  Try demo
                </button>
              </article>
            ))}
          </div>
          {games.length > 24 && (
            <nav aria-label="Provider game pages" className="flex items-center gap-4">
              <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span>
                Page {page + 1} of {Math.ceil(games.length / 24)}
              </span>
              <button disabled={(page + 1) * 24 >= games.length} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </main>
  );
}
