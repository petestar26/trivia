import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { TOGETHER_GAMES, togetherGame, type TogetherSettings } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { useAuth } from '@/providers/auth-provider';
import '../play-together.css';

export function GroupPlayControlPage() {
  const { user } = useAuth(),
    cache = useQueryClient(),
    [notice, setNotice] = useState('');
  const settings = useQuery({
    queryKey: ['together-settings', user?.id],
    queryFn: async () =>
      unwrapData(await api.get<TogetherSettings>('/play-together/admin/settings')),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const rounds = useQuery({
    queryKey: ['together-operations', user?.id],
    queryFn: async () =>
      unwrapData(
        await api.get<
          {
            id: string;
            game: string;
            currency: string;
            state: string;
            closes_at: string;
            funded: number | null;
            platform_fee: number | null;
            void_reason: string | null;
          }[]
        >('/play-together/admin/rounds')
      ),
    retry: false,
    refetchInterval: 10000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post('/play-together/admin/rounds/' + id + '/retry', {}),
    onSuccess: () => {
      setNotice('Recovery checked. Recorded results and payment receipts are preserved.');
      void cache.invalidateQueries({ queryKey: ['together-operations'] });
    },
    onError: (error) => setNotice(getErrorMessage(error, 'Recovery is still pending.')),
  });
  return (
    <div className="together-page">
      <header className="together-hero">
        <div>
          <p className="together-eyebrow">Platform controls</p>
          <h1>
            Group play<span>.</span>
          </h1>
          <p>
            Set platform-wide rules for new rounds. Accepted entries keep the terms each player
            confirmed.
          </p>
        </div>
      </header>
      {notice && (
        <p role="status" className="together-notice">
          {notice}
        </p>
      )}
      {settings.isPending ? (
        <p role="status">Loading group controls…</p>
      ) : settings.isError ? (
        <p role="alert">
          Controls unavailable. <button onClick={() => void settings.refetch()}>Retry</button>
        </p>
      ) : (
        <SettingsEditor
          key={settings.data!.version}
          settings={settings.data!}
          saved={() => {
            setNotice('Settings saved for newly created rounds.');
            void cache.invalidateQueries({ queryKey: ['together-settings'] });
          }}
        />
      )}
      <section className="together-panel">
        <h2>Round processing</h2>
        <p>
          Rounds start and settle automatically. Recovery retries the existing result and receipts;
          it cannot choose a winner or pay twice.
        </p>
        {rounds.isError ? (
          <p role="alert">Round monitoring is unavailable.</p>
        ) : !rounds.data?.length ? (
          <p>No group rounds yet.</p>
        ) : (
          <div className="together-history">
            {rounds.data.map((r) => (
              <div key={r.id} className="together-notice">
                <strong>
                  {togetherGame(r.game).name} ·{' '}
                  {r.currency === 'ETB' ? 'Real Birr' : 'Practice points'}
                </strong>
                <p>
                  {r.state === 'DRAWN'
                    ? 'Settlement pending'
                    : r.state === 'LOCKED'
                      ? 'Waiting for verified result'
                      : r.state}{' '}
                  · Closes {new Date(r.closes_at).toLocaleString()}
                </p>
                {r.platform_fee !== null && (
                  <small>
                    Platform fee:{' '}
                    {r.currency === 'ETB'
                      ? (r.platform_fee / 100).toFixed(2) + ' Birr'
                      : r.platform_fee + ' points'}
                  </small>
                )}
                <small>Round {r.id}</small>
                {['OPEN', 'LOCKED', 'DRAWN'].includes(r.state) && (
                  <button disabled={retry.isPending} onClick={() => retry.mutate(r.id)}>
                    Check recovery
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      <p>
        <Link to="/play-together">Open member group rooms →</Link>
      </p>
    </div>
  );
}
function SettingsEditor({ settings, saved }: { settings: TogetherSettings; saved: () => void }) {
  const [draft, setDraft] = useState(settings),
    [fee, setFee] = useState(String(settings.feeBps / 100));
  const [min, setMin] = useState(String(settings.minEntry / 100)),
    [max, setMax] = useState(String(settings.maxEntry / 100));
  const [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: async (body: TogetherSettings) =>
      unwrapData(await api.put<TogetherSettings>('/play-together/admin/settings', body)),
    onSuccess: saved,
    onError: (error) => setError(getErrorMessage(error, 'Settings could not be saved.')),
  });
  const submit = () => {
    const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(fee);
    if (!match || !/^\d+$/.test(min) || !/^\d+$/.test(max)) {
      setError('Enter a valid percentage and whole-Birr entry limits.');
      return;
    }
    mutation.mutate({
      ...draft,
      feeBps: Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')),
      minEntry: Number(min) * 100,
      maxEntry: Number(max) * 100,
    });
  };
  return (
    <section className="together-panel">
      <h2>Rules for new rounds</h2>
      <p>
        The fee applies to winning profit before fees. All-tie, no-winner, cancelled and underfilled
        rounds have no fee.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="together-form">
          <label>
            Platform fee (%)
            <input
              inputMode="decimal"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              required
            />
          </label>
          <label>
            Minimum cash entry (Birr)
            <input
              inputMode="numeric"
              value={min}
              onChange={(e) => setMin(e.target.value)}
              required
            />
            <small>Practice minimum: {Number(min) * 100 || 0} points</small>
          </label>
          <label>
            Maximum cash entry (Birr)
            <input
              inputMode="numeric"
              value={max}
              onChange={(e) => setMax(e.target.value)}
              required
            />
            <small>Practice maximum: {Number(max) * 100 || 0} points</small>
          </label>
        </div>
        <div className="together-settings-checks">
          <label>
            <input
              type="checkbox"
              checked={draft.practiceEnabled}
              onChange={(e) => setDraft({ ...draft, practiceEnabled: e.target.checked })}
            />
            Practice group entries
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.publicRoomsEnabled}
              onChange={(e) => setDraft({ ...draft, publicRoomsEnabled: e.target.checked })}
            />
            Public shared rooms
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.cashEnabled}
              onChange={(e) => setDraft({ ...draft, cashEnabled: e.target.checked })}
            />
            Real-Birr group entries
          </label>
        </div>
        <p>
          Real-Birr entries also require the platform’s cash-play readiness controls. Turning
          entries off does not stop accepted payouts or refunds.
        </p>
        <h3>Games available to groups</h3>
        <div className="together-settings-checks">
          {TOGETHER_GAMES.map((g) => (
            <label key={g.key}>
              <input
                type="checkbox"
                checked={draft.enabledGames.includes(g.key)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    enabledGames: e.target.checked
                      ? [...draft.enabledGames, g.key]
                      : draft.enabledGames.filter((key) => key !== g.key),
                  })
                }
              />
              {g.name}
            </label>
          ))}
        </div>
        {error && (
          <p role="alert" className="together-notice">
            {error}
          </p>
        )}
        <button className="together-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save platform settings'}
        </button>
        <small>
          Policy version {settings.version}. Existing rounds retain their published fee and game
          rules.
        </small>
      </form>
    </section>
  );
}
