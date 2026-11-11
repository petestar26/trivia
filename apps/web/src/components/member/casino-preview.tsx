import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ArrowRight, Dice5 } from 'lucide-react';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useLanguage } from '@/providers/language-provider';
import { GameArtwork, type TestGame } from '@/pages/games/provider-test';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';
import { createLaunchIntent } from '@/lib/launch-intent';

export function CasinoPreview() {
  const { t: translateUi } = useInterfaceLanguage();

  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const status = useQuery({
    queryKey: ['provider-test-status', user?.id],
    enabled: !!user?.id,
    retry: false,
    staleTime: 15_000,
    queryFn: async () =>
      unwrapData(
        await api.get<{ enabled: boolean; launchReady: boolean }>('/provider-test/status')
      ),
  });
  const allowed = !!user?.id && status.data?.enabled === true && !status.isError;
  const games = useQuery({
    queryKey: ['provider-test-games', user?.id],
    enabled: allowed,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => unwrapData(await api.get<TestGame[]>('/provider-test/games')),
  });
  return (
    <section className="salem-home-casino" aria-labelledby="home-casino-title">
      <div className="salem-section-heading">
        <div>
          <span className="salem-eyebrow">{translateUi('THE CASINO COLLECTION')}</span>
          <h2 id="home-casino-title">{t('Casino')}</h2>
        </div>
        <Link to="/casino">
          {t('View all')}
          <ArrowRight size={17} />
        </Link>
      </div>
      {allowed && games.data && !games.isError ? (
        <>
          <div className="salem-casino-shelf">
            {games.data.slice(0, 6).map((game) => (
              <Link
                to={`/casino?game=${encodeURIComponent(game.id)}`}
                onClick={(event) => {
                  // A plain click opens the game now; a new-tab or modified click only selects it.
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  const intent = user && createLaunchIntent('casino', user.id, game.id);
                  if (!intent) return;
                  event.preventDefault();
                  navigate(`/casino?game=${encodeURIComponent(game.id)}&intent=${intent}`);
                }}
                className="casino-game-tile"
                aria-label={`${t('Play')} ${game.name}`}
                key={game.id}
              >
                <GameArtwork game={game} motion={false} />
                <div className="casino-tile-caption">
                  <h3>{game.name}</h3>
                  <p>
                    {game.provider}
                    <ArrowUpRight size={14} />
                  </p>
                </div>
              </Link>
            ))}
          </div>
          <p className="salem-footnote">{translateUi('Virtual ETB · No cash value')}</p>
        </>
      ) : user && (status.isPending || (allowed && games.isPending)) ? (
        <p role="status">{t('Loading…')}</p>
      ) : (
        <div className="salem-casino-intro">
          <Dice5 size={30} />
          <div>
            <h3>{t('Casino')}</h3>
            <p>
              {status.isError || games.isError
                ? translateUi('The collection could not be loaded. Open Casino to retry.')
                : translateUi('Browse the casino and check availability for your account.')}
            </p>
          </div>
          <Link to="/casino">
            {t('View all')}
            <ArrowRight size={16} />
          </Link>
        </div>
      )}
    </section>
  );
}
