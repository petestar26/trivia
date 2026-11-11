import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Heart, Search } from 'lucide-react';
import { useLanguage } from '@/providers/language-provider';
import { useGuestAuth } from '@/components/auth/guest-auth-prompt';
import { GameArtwork } from './game-artwork';

/** Shipped product descriptions, not a live availability feed or player activity. */
export const GUEST_GAMES = [
  ['spin_win', 'Spin', 'A shared spin. One result for the room.'],
  ['turbo_keno', 'Turbo Keno', 'Choose numbers and follow the shared draw.'],
  ['sky_crash', 'Sky Crash', 'Follow the flight in a shared game room.'],
  ['thunder_derby_3d', 'Derby', 'A race-day experience with your group.'],
  ['virtual_football_3d', 'Football', 'Bring your group to the virtual stadium.'],
  ['neon_hounds_3d', 'Dog Racing', 'Trackside action in a shared room.'],
  ['crash_point', 'Crash Point', 'A shared round with a rising multiplier.'],
  ['roulette_keno', 'Roulette Keno', 'A number game with a roulette-inspired draw.'],
  ['dice', 'Dice', 'A classic roll, shared with your group.'],
  ['number_challenge', 'Number Challenge', 'Explore the number game with friends.'],
  ['lucky_six', 'Lucky Six', 'Follow the numbers as the draw unfolds.'],
  ['blackjack', 'Blackjack', 'Discover the classic card game.'],
] as const;

export function GuestGameCollection() {
  const { t } = useLanguage();
  const { requestSignIn } = useGuestAuth();
  const [search, setSearch] = useState('');
  const games = GUEST_GAMES.filter(([, name]) =>
    t(name).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  );
  return (
    <div className="salem-collection">
      <div className="salem-collection-controls">
        <div className="salem-tabs" role="group" aria-label={t('Game collection')}>
          <button aria-pressed="true" onClick={() => setSearch('')}>
            {t('All games')}
          </button>
          <button onClick={() => requestSignIn(t('Sign in to save and view your favorite games.'))}>
            <Heart size={14} />
            {t('Favorites')}
          </button>
        </div>
        <label className="salem-search">
          <Search size={17} />
          <span className="sr-only">{t('Search games')}</span>
          <input
            type="search"
            placeholder={t('Search games')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {games.length ? (
        <div className="salem-own-grid">
          {games.map(([key, name]) => (
            <div className="salem-own-tile" key={key}>
              <Link
                to={`/play-together?game=${key}`}
                aria-label={t('Explore {name}', { name: t(name) })}
              >
                <GameArtwork kind={key} practiceAvailable />
                <div className="salem-own-caption">
                  <h3>{t(name)}</h3>
                  <span>
                    {t('Explore game')}
                    <ArrowUpRight size={15} />
                  </span>
                </div>
              </Link>
              <button
                className="salem-favorite"
                aria-label={t('Add {name} to favorites', { name: t(name) })}
                onClick={() => requestSignIn(t('Sign in to save your favorite games.'))}
              >
                <Heart size={16} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="salem-empty">
          <Search size={26} />
          <h3>{t('No games found')}</h3>
          <p>{t('Try another search.')}</p>
          <button onClick={() => setSearch('')}>{t('Clear filters')}</button>
        </div>
      )}
      <p className="salem-footnote">
        {t(
          'Explore the game collection. Sign in to check current availability and room rules before joining.'
        )}
      </p>
    </div>
  );
}
