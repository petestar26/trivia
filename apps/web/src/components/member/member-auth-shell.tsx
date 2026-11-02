import { useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, Pause, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import './member-auth-shell.css';

export function MemberAuthShell({
  mode,
  children,
}: {
  mode: 'login' | 'register';
  children: ReactNode;
}) {
  const [paused, setPaused] = useState(false);
  const joining = mode === 'register';

  return (
    <div className={`qube-auth pq-auth-shell${paused ? ' is-paused' : ''}`}>
      <header className="pq-auth-header">
        <Link className="pq-auth-brand" to="/" aria-label="PlayQube home">
          PLAY<span>QUBE</span>
          <small>THE MEMBER LOUNGE</small>
        </Link>
        <Link className="pq-auth-browse" to="/explore">
          <ArrowLeft size={14} aria-hidden="true" /> Browse the collection
        </Link>
      </header>

      <main className="pq-auth-layout">
        <aside className="pq-auth-story" aria-label="The PlayQube lounge">
          <p className="pq-auth-eyebrow">RUBY GRAND · PLAYQUBE</p>
          <h1>
            {joining ? 'Your next chapter.' : 'Your place to play.'}
            <em>{joining ? 'Make it your own.' : 'Your people await.'}</em>
          </h1>
          <p className="pq-auth-description">
            {joining
              ? 'Discover the collection, find your group, and bring your own style to the lounge.'
              : 'Return to the collection, catch up with your groups, and choose what comes next.'}
          </p>

          <div className="pq-auth-art" aria-hidden="true">
            <div className="pq-auth-ring pq-auth-ring-one" />
            <div className="pq-auth-ring pq-auth-ring-two" />
            <div className="pq-auth-pass">
              <span className="pq-auth-pass-label">THE MEMBER LOUNGE</span>
              <span className="pq-auth-pass-mark">Q</span>
              <span className="pq-auth-pass-footer">PLAY · CONNECT · DISCOVER</span>
            </div>
            <div className="pq-auth-disc pq-auth-disc-one" />
            <div className="pq-auth-disc pq-auth-disc-two" />
          </div>
          <button
            type="button"
            className="pq-auth-motion"
            aria-pressed={paused}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? (
              <Play size={13} aria-hidden="true" />
            ) : (
              <Pause size={13} aria-hidden="true" />
            )}
            {paused ? 'Resume animation' : 'Pause animation'}
          </button>
          <p className="pq-auth-story-footer">
            A world of play. Your kind of company. <ArrowUpRight size={14} aria-hidden="true" />
          </p>
        </aside>

        <section className="pq-auth-form-panel" aria-label={joining ? 'Create account' : 'Sign in'}>
          <div className="pq-auth-form-eyebrow">
            <span /> {joining ? 'MAKE YOUR ENTRANCE' : 'BACK TO YOUR LOUNGE'}
          </div>
          {children}
        </section>
      </main>
    </div>
  );
}
