import { Link, useLocation } from 'react-router-dom';
import { Menu, Wallet } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { NotificationBell } from '@/components/notifications/notification-bell';

export function Header({ onMenuClick }: { onMenuClick?: () => void }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const section = pathname.split('/')[1];
  const labels: Record<string, string> = {
    casino: 'Casino',
    games: 'Games',
    groups: 'Groups',
    messages: 'Messages',
    wallet: 'Wallet',
    gifts: 'Gifts',
    profile: 'Profile',
    rewards: 'Rewards',
    challenges: 'Challenges',
    competitions: 'Competitions',
  };
  return (
    <header className="qube-header sticky top-0 z-40">
      <div className="flex min-w-0 items-center gap-3">
        {onMenuClick && (
          <button
            onClick={onMenuClick}
            className="qube-icon-button lg:hidden"
            aria-label="Open navigation menu"
          >
            <Menu size={22} />
          </button>
        )}
        <div>
          <span className="qube-header-eyebrow">MEMBER LOUNGE</span>
          <p className="qube-header-title">{labels[section] || 'Welcome to PlayQube'}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        <Link to="/wallet" className="qube-wallet-link">
          <Wallet size={17} aria-hidden="true" />
          <span className="hidden sm:inline">My wallet</span>
        </Link>
        <NotificationBell />
        <Link to="/profile" aria-label="Your profile" className="qube-avatar">
          {(user?.displayName || user?.username || 'U')[0].toUpperCase()}
        </Link>
      </div>
    </header>
  );
}
