import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

interface TestGame {
  id: string;
  name: string;
  provider: string;
  category: string;
}

export function ProviderTestPage() {
  const { user } = useAuth();
  return user ? (
    <ProviderTestSession key={user.id} userId={user.id} />
  ) : (
    <p>Sign in to try provider tests.</p>
  );
}

function ProviderTestSession({ userId }: { userId: string }) {
  const [search, setSearch] = useState('');
  const [country, setCountry] = useState('');
  const [page, setPage] = useState(0);
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
          country,
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
  const games = (catalogue.data ?? []).filter((game) =>
    `${game.name} ${game.provider}`.toLowerCase().includes(search.toLowerCase())
  );
  const canLaunch =
    status.data?.launchReady === true &&
    /^[A-Z]{2}$/.test(country) &&
    !wallet.isError &&
    !!wallet.data;
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
          Provider games · Integration test
        </p>
        <h1 className="mt-2 text-3xl font-bold">Casino</h1>
        <p className="mt-3 text-slate-300">
          Test games use a separate virtual ETB balance with no cash value. Your customer wallet is
          not connected. Provider commission uses your test credit.
        </p>
      </header>
      {status.isLoading && <p role="status">Checking test access…</p>}
      {status.isError && (
        <div role="alert">
          Could not check test access.{' '}
          <button onClick={() => void status.refetch()} className="underline">
            Retry
          </button>
        </div>
      )}
      {status.data?.enabled === false && (
        <p role="status">Provider testing is not enabled for your account yet.</p>
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
      {accessGranted && (
        <section
          className="rounded-xl border border-amber-200/20 bg-slate-900 p-4 space-y-3"
          aria-label="Test wallet"
        >
          <p>
            Virtual test balance:{' '}
            <strong>
              {wallet.data && !wallet.isError
                ? (wallet.data.balanceCents / 100).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                  })
                : '—'}{' '}
              ETB
            </strong>
          </p>
          {wallet.isError && (
            <p role="alert">
              Could not check the test balance.{' '}
              <button className="underline" onClick={() => void wallet.refetch()}>
                Refresh balance
              </button>
            </p>
          )}
          <label className="block">
            Country you are testing from
            <select
              value={country}
              onChange={(e) => {
                close();
                setCountry(e.target.value);
              }}
              className="ml-3 rounded-lg bg-slate-800 p-2"
            >
              <option value="">Choose your location</option>
              <option value="ET">Ethiopia</option>
              <option value="LA">Laos</option>
            </select>
          </label>
          <p className="text-sm text-slate-400">
            Choose your actual location. Provider country restrictions apply.
          </p>
          {status.data?.launchReady === false && (
            <p role="status">Test launch setup is being completed.</p>
          )}
        </section>
      )}
      {accessGranted && selected && (
        <section aria-label="Selected provider game" className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-bold">{selected.name} · Test</h2>
            <button onClick={close} className="rounded-lg border px-4 py-2">
              Close game
            </button>
          </div>
          {launch.isPending && <p role="status">Opening test game…</p>}
          {launch.isError && (
            <div role="alert">
              This test game could not be opened.{' '}
              <button
                className="underline"
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
              className="w-full rounded-xl border border-white/20 bg-black"
              style={{ height: 'calc(100dvh - 180px)', minHeight: 320 }}
            />
          )}
        </section>
      )}
      {accessGranted && wallet.data && wallet.data.movements.length > 0 && (
        <details className="rounded-xl border border-white/10 p-4">
          <summary>Recent test wallet activity</summary>
          <ul className="mt-3 space-y-2">
            {wallet.data.movements.map((m, i) => (
              <li key={`${m.at}-${i}`}>
                {m.action === 'debit' ? 'Bet' : 'Win / refund'} · {(m.amountCents / 100).toFixed(2)}{' '}
                ETB · {m.error ? 'Declined' : 'Confirmed'}
              </li>
            ))}
          </ul>
        </details>
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
          {!games.length && <p>No provider games available{search ? ' for this search' : ''}.</p>}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {games.slice(page * 24, (page + 1) * 24).map((game) => (
              <article key={game.id} className="rounded-xl border border-white/10 bg-slate-900 p-5">
                <p className="text-xs uppercase text-rose-300">{game.category} · Test</p>
                <h2 className="mt-2 text-lg font-semibold">{game.name}</h2>
                <p className="mt-1 text-sm text-slate-400">{game.provider}</p>
                <button
                  className="mt-4 rounded-lg bg-rose-700 px-4 py-2 font-semibold text-white disabled:opacity-40"
                  disabled={!canLaunch}
                  onClick={() => {
                    launch.reset();
                    setSelected(game);
                    launch.mutate(game);
                  }}
                >
                  Open test game
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
