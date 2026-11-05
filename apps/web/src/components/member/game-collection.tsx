import { requestStatus } from '@/lib/request-error';
import { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Heart, ArrowUpRight } from 'lucide-react';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useLanguage } from '@/providers/language-provider';
import { useFavoriteGames } from '@/lib/use-favorite-games';
import { GameArtwork } from './game-artwork';
import {
  compareMemberGameKeys,
  memberGameDestination,
  memberGameVisible,
  memberGameName,
  type MemberGame,
} from '@/lib/member-game-catalog';

export function GameCollection({ mode }: { mode?: 'WAGER' | 'BONUS' }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { favoriteIds, toggleFavorite, storageUnavailable } = useFavoriteGames(user?.id);
  const catalog = useQuery({
    queryKey: ['games'],
    queryFn: async () => unwrapData(await api.get<MemberGame[]>('/games')),
    staleTime: 60_000,
  });
  const games = (catalog.data ?? [])
    .filter(
      (g) =>
        memberGameVisible(g) &&
        (!mode || g.mode === mode) &&
        (!favorites || favoriteIds.includes(g.id)) &&
        memberGameName(g).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    )
    .sort((a, b) => compareMemberGameKeys(a.key, b.key));
  return (
    <div className="salem-collection">
      <div className="salem-collection-controls">
        <div className="salem-tabs" role="group" aria-label="Game collection">
          <button aria-pressed={!favorites} onClick={() => setFavorites(false)}>
            {t('All games')}
          </button>
          <button aria-pressed={favorites} onClick={() => setFavorites(true)}>
            <Heart size={14} />
            {t('Favorites')}
          </button>
        </div>
        <label className="salem-search">
          <Search size={17} />
          <span className="sr-only">{t('Search games')}</span>
          <input
            ref={input}
            type="search"
            placeholder={t('Search games')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      {catalog.isPending ? (
        <p role="status">{t('Loading…')}</p>
      ) : catalog.isError ? (
        <div role="alert" className="salem-empty">
          {requestStatus(catalog.error) === 401 ? (
            <>
              <p>Your session is unavailable.</p>
              <Link to="/login">Sign in again</Link>
            </>
          ) : (
            <>
              Unable to load games.{' '}
              <button onClick={() => void catalog.refetch()}>{t('Retry')}</button>
            </>
          )}
        </div>
      ) : games.length ? (
        <div className="salem-own-grid">
          {games.map((game) => {
            const to = memberGameDestination(game);
            const name = memberGameName(game);
            const content = (
              <>
                <GameArtwork kind={game.key} practiceAvailable={game.practiceAvailable} />
                <div className="salem-own-caption">
                  <h3>{name}</h3>
                  <span>
                    {to ? t('Group play') : 'Temporarily unavailable'}
                    {to && <ArrowUpRight size={15} />}
                  </span>
                </div>
              </>
            );
            return (
              <div className="salem-own-tile" key={game.id}>
                {to ? (
                  <Link to={to} aria-label={`${t('Play')} ${name}`}>
                    {content}
                  </Link>
                ) : (
                  <article aria-label={`${name}: temporarily unavailable`}>{content}</article>
                )}
                <button
                  className="salem-favorite"
                  disabled={storageUnavailable || !user?.id}
                  aria-label={`${favoriteIds.includes(game.id) ? 'Remove' : 'Add'} ${name} ${favoriteIds.includes(game.id) ? 'from' : 'to'} favorites`}
                  aria-pressed={favoriteIds.includes(game.id)}
                  onClick={() => {
                    if (favorites) input.current?.focus();
                    toggleFavorite(game.id);
                  }}
                >
                  <Heart size={16} fill={favoriteIds.includes(game.id) ? 'currentColor' : 'none'} />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="salem-empty">
          <Search size={26} />
          <h3>{t('No games found')}</h3>
          <p>{t('Try another search.')}</p>
          <button
            onClick={() => {
              setSearch('');
              setFavorites(false);
              input.current?.focus();
            }}
          >
            {t('Clear filters')}
          </button>
        </div>
      )}
      {storageUnavailable && (
        <p role="status" className="salem-footnote">
          Favorites are unavailable in this browser.
        </p>
      )}
      <p className="salem-footnote">
        Practice ETB · No cash value · Each game has a separate balance.
      </p>
    </div>
  );
}
