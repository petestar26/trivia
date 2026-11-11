import { useLanguage } from '@/providers/language-provider';
import { LanguageSelect } from './language-select';
import { Link, useLocation } from 'react-router-dom';
import { guestReturnTo } from '@/lib/guest-return-to';
import { PRACTICE_ETB } from '@/lib/practice-etb';
import { Menu, Wallet } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function Header({ onMenuClick }: { onMenuClick?: () => void }) {
  const { t: translateUi } = useInterfaceLanguage();

  const { user } = useAuth();
  const { t } = useLanguage();
  const location = useLocation();
  const { pathname } = location;
  const section = pathname.split('/')[1];
  const labels: Record<string, string> = {
    dashboard: 'Home',
    casino: 'Casino',
    sports: 'Sports',
    games: 'Play together',
    'play-together': 'Play together',
    groups: 'Groups',
    messages: 'Messages',
    wallet: 'Wallet',
    gifts: 'Gifts',
    profile: 'Profile',
    support: 'Support',
    rewards: 'Rewards',
    challenges: 'Challenges',
    competitions: 'Competitions',
  };
  return (
    <header className="qube-header sticky top-0 z-40">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {onMenuClick && (
          <button
            onClick={onMenuClick}
            className="qube-icon-button lg:hidden"
            aria-label={translateUi('Open navigation menu')}
          >
            <Menu size={22} />
          </button>
        )}
        <div className="min-w-0">
          <span className="qube-header-eyebrow">{'SALEM BET'}</span>
          <p className="qube-header-title truncate">{t(labels[section] || 'Home')}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        {user &&
          PRACTICE_ETB &&
          !['sports', 'play-together', 'groups', 'games'].includes(section) && (
            <span className="salem-mode-badge">
              {translateUi('Practice') + ' '}
              <b>{'ETB'}</b>
            </span>
          )}
        {user ? (
          <>
            <Link
              to="/wallet"
              className="qube-wallet-link"
              aria-label={translateUi('Open your wallet')}
            >
              <Wallet size={17} aria-hidden="true" />
              <span className="hidden sm:inline">{t('Wallet')}</span>
            </Link>
            <LanguageSelect />
            <NotificationBell />
            <Link to="/profile" aria-label={translateUi('Your profile')} className="qube-avatar">
              {(user?.displayName || user?.username || 'U')[0].toUpperCase()}
            </Link>
          </>
        ) : (
          <>
            <LanguageSelect />
            <Link
              to="/login"
              state={{ from: guestReturnTo(location) }}
              className="salem-guest-signin"
            >
              {t('Sign in')}
            </Link>
            <Link
              to="/register"
              state={{ from: guestReturnTo(location) }}
              className="salem-button salem-guest-register"
            >
              {t('Create account')}
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
