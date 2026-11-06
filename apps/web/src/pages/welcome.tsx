import { InstallAppButton, InstallAppCard } from '@/components/app-install';
import { LanguageSelect } from '@/components/layout/language-select';
import '@/components/layout/public-language.css';
import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, MessageCircle, Sparkles, Pause, Play } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { useMemberTheme } from '@/components/member/use-member-theme';
import { GameArtwork } from '@/components/member/game-artwork';
import { compareMemberGameKeys } from '@/lib/member-game-catalog';
import './welcome.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

const collection = [
  ['crash_point', 'Crash Point', '/games/crash-point'],
  ['dice', 'Dice', '/games/dice'],
  ['spin_win', 'Lucky Spin', '/games/spin-win'],
  ['turbo_keno', 'Turbo Keno', '/games/turbo-keno'],
  ['sky_crash', 'Sky Crash', '/games/sky-crash'],
  ['thunder_derby_3d', 'Derby', '/games/thunder-derby'],
  ['neon_hounds_3d', 'Dog Racing', '/games/dog-racing'],
  ['roulette_keno', 'Roulette Keno', '/games/roulette-keno'],
  ['virtual_football_3d', 'Football', '/games/virtual-football'],
  ['number_challenge', 'Number Challenge', '/games/number-challenge'],
  ['lucky_six', 'Lucky Six', '/games/lucky-six'],
  ['blackjack', 'Blackjack', '/games/blackjack'],
] as const;
const orderedCollection = [...collection].sort(([a], [b]) => compareMemberGameKeys(a, b));

function PublicHeader() {
  const { t: translateUi } = useInterfaceLanguage();

  const { isAuthenticated } = useAuth();
  return (
    <header className="pq-public-header">
      <Link className="pq-public-brand" to="/">
        {translateUi('SALEM')}
        <span>{' ' + translateUi('BET')}</span>
        <small>{translateUi('THE MEMBER LOUNGE')}</small>
      </Link>
      <nav aria-label={translateUi('Account')}>
        <div className="salem-public-language">
          <LanguageSelect />
        </div>
        <InstallAppButton />
        {isAuthenticated ? (
          <Link className="pq-public-account" to="/dashboard">
            {translateUi('Open your lounge') + ' '}
            <ArrowUpRight size={15} />
          </Link>
        ) : (
          <>
            <Link to="/login">{translateUi('Sign in')}</Link>
            <Link className="pq-public-account" to="/register">
              {translateUi('Create account') + ' '}
              <ArrowUpRight size={15} />
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}

export function WelcomePage() {
  const { t: translateUi } = useInterfaceLanguage();

  useMemberTheme();
  const { isAuthenticated } = useAuth();
  const [paused, setPaused] = useState(false);
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  return (
    <div className={`pq-public pq-welcome salem-public-entry ${paused ? 'is-paused' : ''}`}>
      <PublicHeader />
      <main className="pq-welcome-stage">
        <div className="pq-welcome-copy">
          <p className="pq-public-eyebrow">{translateUi('RUBY GRAND · SALEM BET')}</p>
          <h1>
            {translateUi('A world of play.')}
            <br />
            <em>{translateUi('Your kind of company.')}</em>
          </h1>
          <p>
            {translateUi(
              'Step into the lounge. Discover the collection, find your people, and choose your next game.'
            )}
          </p>
          <Link to="/explore" className="pq-public-primary">
            {translateUi('Enter the lounge') + ' '}
            <ArrowRight size={19} />
          </Link>
          <small>{translateUi("Browse first. Sign in when you're ready to join.")}</small>
          <InstallAppCard />
        </div>
        <div className="pq-welcome-sculpture" aria-hidden="true">
          <div className="pq-orbit pq-orbit-one" />
          <div className="pq-orbit pq-orbit-two" />
          <div className="pq-monogram">
            {'S'}
            <span>{'SALEM BET'}</span>
          </div>
          <div className="pq-chip pq-chip-one">{translateUi('PLAY')}</div>
          <div className="pq-chip pq-chip-two">{translateUi('CONNECT')}</div>
          <div className="pq-chip pq-chip-three">{translateUi('DISCOVER')}</div>
          <div className="pq-sculpture-base" />
        </div>
        <button
          type="button"
          className="pq-motion-control"
          aria-pressed={paused}
          onClick={() => setPaused(!paused)}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? translateUi('Resume animation') : translateUi('Pause animation')}
        </button>
      </main>
      <footer className="pq-public-footer">
        <span>
          <Sparkles size={16} />
          {' ' + translateUi('Play. Connect. Discover.')}
        </span>
        <Link to="/explore">
          {translateUi('Discover what’s inside') + ' '}
          <ArrowRight size={15} />
        </Link>
      </footer>
    </div>
  );
}

/** Public discovery uses no authenticated feeds, private groups, balances or fabricated winners. */
export function ExplorePage() {
  const { t: translateUi } = useInterfaceLanguage();

  useMemberTheme();
  const { isAuthenticated } = useAuth();
  return (
    <div className="pq-public pq-explore salem-public-entry">
      <PublicHeader />
      <main>
        <section className="pq-explore-intro">
          <p className="pq-public-eyebrow">{translateUi('WELCOME TO THE LOUNGE')}</p>
          <h1>
            {translateUi('Look around.')}
            <br />
            <em>{translateUi('Find your next game.')}</em>
          </h1>
          <p>
            {isAuthenticated
              ? translateUi(
                  'Explore the collection. Choose a game to check availability, or open your member lounge.'
                )
              : translateUi(
                  'Explore the collection without an account. Sign in to check availability and join a game or group.'
                )}
          </p>
        </section>
        <section aria-labelledby="public-collection">
          <div className="pq-public-section-title">
            <h2 id="public-collection">{translateUi('The game collection')}</h2>
            <span>{translateUi('Choose your next experience.')}</span>
          </div>
          <div className="pq-public-games">
            {orderedCollection.map(([key, name, destination]) => {
              const content = (
                <>
                  <GameArtwork kind={key} practiceAvailable={false} />
                  <div>
                    <h3>{translateUi(name)}</h3>
                    <span>
                      {isAuthenticated
                        ? translateUi('Check availability')
                        : translateUi('Sign in to check availability')}
                      <ArrowUpRight size={14} />
                    </span>
                  </div>
                </>
              );
              return (
                <Link
                  key={key}
                  to={isAuthenticated ? destination : '/login'}
                  state={isAuthenticated ? undefined : { from: { pathname: destination } }}
                  className="pq-public-game"
                >
                  {content}
                </Link>
              );
            })}
          </div>
        </section>
        <section className="pq-public-groups" aria-labelledby="public-groups">
          <div className="pq-chat-emblem">
            <MessageCircle size={35} />
          </div>
          <div>
            <p className="pq-public-eyebrow">{translateUi('BETTER TOGETHER')}</p>
            <h2 id="public-groups">{translateUi('A place for your people.')}</h2>
            <p>
              {isAuthenticated
                ? translateUi('Open groups to find your conversations and membership options.')
                : translateUi(
                    'Discover groups, join the conversation and choose a game together. Sign in to view groups and membership options.'
                  )}
            </p>
          </div>
          <Link
            className="pq-public-primary"
            to={isAuthenticated ? '/groups' : '/login'}
            state={isAuthenticated ? undefined : { from: { pathname: '/groups' } }}
          >
            {translateUi('Find a group') + ' '}
            <ArrowRight size={17} />
          </Link>
        </section>
      </main>
      <footer className="pq-public-footer">
        <span>{translateUi('Browsing is public. Joining requires an account.')}</span>
        <Link to={isAuthenticated ? '/dashboard' : '/register'}>
          {isAuthenticated ? translateUi('Open your lounge') : translateUi('Create your account')}{' '}
          <ArrowRight size={15} />
        </Link>
      </footer>
    </div>
  );
}
