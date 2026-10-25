import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, MessageCircle, Sparkles, Pause, Play } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { useMemberTheme } from '@/components/member/use-member-theme';
import { GameArtwork } from '@/components/member/game-artwork';
import './welcome.css';

const collection = [
  ['crash_point', 'Crash Point', '/games/crash-point'],
  ['dice', 'Dice', '/games/dice'],
  ['spin_win', 'Lucky Spin', '/games/spin-win'],
  ['turbo_keno', 'Turbo Keno', '/games/turbo-keno'],
  ['sky_crash', 'Sky Crash', '/games/sky-crash'],
  ['thunder_derby_3d', 'Thunder Derby', '/games/thunder-derby'],
  ['virtual_football_3d', 'Virtual Football', '/games/virtual-football'],
  ['number_challenge', 'Number Challenge', '/games/number-challenge'],
  ['trivia', 'Trivia', '/games/trivia'],
] as const;

function PublicHeader() {
  const { isAuthenticated } = useAuth();
  return (
    <header className="pq-public-header">
      <Link className="pq-public-brand" to="/">
        PLAY<span>QUBE</span>
        <small>THE MEMBER LOUNGE</small>
      </Link>
      <nav aria-label="Account">
        {isAuthenticated ? (
          <Link className="pq-public-account" to="/dashboard">
            Open your lounge <ArrowUpRight size={15} />
          </Link>
        ) : (
          <>
            <Link to="/login">Sign in</Link>
            <Link className="pq-public-account" to="/register">
              Create account <ArrowUpRight size={15} />
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}

export function WelcomePage() {
  useMemberTheme();
  const { isAuthenticated } = useAuth();
  const [paused, setPaused] = useState(false);
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  return (
    <div className={`pq-public pq-welcome ${paused ? 'is-paused' : ''}`}>
      <PublicHeader />
      <main className="pq-welcome-stage">
        <div className="pq-welcome-copy">
          <p className="pq-public-eyebrow">RUBY GRAND · PLAYQUBE</p>
          <h1>
            A world of play.
            <br />
            <em>Your kind of company.</em>
          </h1>
          <p>
            Step into the lounge. Discover the collection, find your people, and choose your next
            game.
          </p>
          <Link to="/explore" className="pq-public-primary">
            Enter the lounge <ArrowRight size={19} />
          </Link>
          <small>Browse first. Sign in when you're ready to join.</small>
        </div>
        <div className="pq-welcome-sculpture" aria-hidden="true">
          <div className="pq-orbit pq-orbit-one" />
          <div className="pq-orbit pq-orbit-two" />
          <div className="pq-monogram">
            Q<span>PLAYQUBE</span>
          </div>
          <div className="pq-chip pq-chip-one">PLAY</div>
          <div className="pq-chip pq-chip-two">CONNECT</div>
          <div className="pq-chip pq-chip-three">DISCOVER</div>
          <div className="pq-sculpture-base" />
        </div>
        <button
          type="button"
          className="pq-motion-control"
          aria-pressed={paused}
          onClick={() => setPaused(!paused)}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? 'Resume animation' : 'Pause animation'}
        </button>
      </main>
      <footer className="pq-public-footer">
        <span>
          <Sparkles size={16} /> Play. Connect. Discover.
        </span>
        <Link to="/explore">
          Discover what’s inside <ArrowRight size={15} />
        </Link>
      </footer>
    </div>
  );
}

/** Public discovery uses no authenticated feeds, private groups, balances or fabricated winners. */
export function ExplorePage() {
  useMemberTheme();
  const { isAuthenticated } = useAuth();
  return (
    <div className="pq-public pq-explore">
      <PublicHeader />
      <main>
        <section className="pq-explore-intro">
          <p className="pq-public-eyebrow">WELCOME TO THE LOUNGE</p>
          <h1>
            Look around.
            <br />
            <em>Find your next game.</em>
          </h1>
          <p>
            {isAuthenticated
              ? 'Explore the collection. Choose a game to check availability, or open your member lounge.'
              : 'Explore the collection without an account. Sign in to check availability and join a game or group.'}
          </p>
        </section>
        <section aria-labelledby="public-collection">
          <div className="pq-public-section-title">
            <h2 id="public-collection">The game collection</h2>
            <span>Choose your next experience.</span>
          </div>
          <div className="pq-public-games">
            {collection.map(([key, name, destination]) => (
              <Link
                key={key}
                to={isAuthenticated ? destination : '/login'}
                state={isAuthenticated ? undefined : { from: { pathname: destination } }}
                className="pq-public-game"
              >
                <GameArtwork kind={key} practiceAvailable={false} />
                <div>
                  <h3>{name}</h3>
                  <span>
                    {isAuthenticated ? 'Check availability' : 'Sign in to check availability'}{' '}
                    <ArrowUpRight size={14} />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>
        <section className="pq-public-groups" aria-labelledby="public-groups">
          <div className="pq-chat-emblem">
            <MessageCircle size={35} />
          </div>
          <div>
            <p className="pq-public-eyebrow">BETTER TOGETHER</p>
            <h2 id="public-groups">A place for your people.</h2>
            <p>
              {isAuthenticated
                ? 'Open groups to find your conversations and membership options.'
                : 'Discover groups, join the conversation and choose a game together. Sign in to view groups and membership options.'}
            </p>
          </div>
          <Link
            className="pq-public-primary"
            to={isAuthenticated ? '/groups' : '/login'}
            state={isAuthenticated ? undefined : { from: { pathname: '/groups' } }}
          >
            Find a group <ArrowRight size={17} />
          </Link>
        </section>
      </main>
      <footer className="pq-public-footer">
        <span>Browsing is public. Joining requires an account.</span>
        <Link to={isAuthenticated ? '/dashboard' : '/register'}>
          {isAuthenticated ? 'Open your lounge' : 'Create your account'} <ArrowRight size={15} />
        </Link>
      </footer>
    </div>
  );
}
