import { useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, Pause, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import { InstallAppButton, InstallAppCard } from '@/components/app-install';
import { LanguageSelect } from '@/components/layout/language-select';
import '@/components/layout/public-language.css';
import './member-auth-shell.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function MemberAuthShell({
  mode,
  children,
}: {
  mode: 'login' | 'register';
  children: ReactNode;
}) {
  const { t: translateUi } = useInterfaceLanguage();

  const [paused, setPaused] = useState(false);
  const joining = mode === 'register';

  return (
    <div className={`qube-auth pq-auth-shell salem-public-entry${paused ? ' is-paused' : ''}`}>
      <header className="pq-auth-header">
        <Link className="pq-auth-brand" to="/" aria-label={translateUi('Salem Bet home')}>
          {translateUi('SALEM')}
          <span>{' ' + translateUi('BET')}</span>
          <small>{translateUi('THE MEMBER LOUNGE')}</small>
        </Link>
        <div className="pq-auth-header-actions">
          <div className="salem-public-language">
            <LanguageSelect />
          </div>
          <Link className="pq-auth-browse" to="/explore">
            <ArrowLeft size={14} aria-hidden="true" />
            {' ' + translateUi('Browse the collection')}
          </Link>
          <InstallAppButton />
        </div>
      </header>

      <main className="pq-auth-layout">
        <aside className="pq-auth-story" aria-label={translateUi('The Salem Bet lounge')}>
          <p className="pq-auth-eyebrow">{translateUi('RUBY GRAND · SALEM BET')}</p>
          <h1>
            {joining ? translateUi('Your next chapter.') : translateUi('Your place to play.')}
            <em>
              {joining ? translateUi('Make it your own.') : translateUi('Your people await.')}
            </em>
          </h1>
          <p className="pq-auth-description">
            {joining
              ? translateUi(
                  'Discover the collection, find your group, and bring your own style to the lounge.'
                )
              : translateUi(
                  'Return to the collection, catch up with your groups, and choose what comes next.'
                )}
          </p>

          <div className="pq-auth-art" aria-hidden="true">
            <div className="pq-auth-ring pq-auth-ring-one" />
            <div className="pq-auth-ring pq-auth-ring-two" />
            <div className="pq-auth-pass">
              <span className="pq-auth-pass-label">{translateUi('THE MEMBER LOUNGE')}</span>
              <span className="pq-auth-pass-mark">{'S'}</span>
              <span className="pq-auth-pass-footer">
                {translateUi('PLAY · CONNECT · DISCOVER')}
              </span>
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
            {paused ? translateUi('Resume animation') : translateUi('Pause animation')}
          </button>
          <p className="pq-auth-story-footer">
            {translateUi('A world of play. Your kind of company.') + ' '}
            <ArrowUpRight size={14} aria-hidden="true" />
          </p>
        </aside>

        <section
          className="pq-auth-form-panel"
          aria-label={joining ? translateUi('Create account') : translateUi('Sign in')}
        >
          <InstallAppCard />
          <div className="pq-auth-form-eyebrow">
            <span />{' '}
            {joining ? translateUi('MAKE YOUR ENTRANCE') : translateUi('BACK TO YOUR LOUNGE')}
          </div>
          {children}
        </section>
      </main>
    </div>
  );
}
