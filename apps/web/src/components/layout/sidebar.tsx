import { useLanguage } from '@/providers/language-provider';
import { Link, useLocation } from 'react-router-dom';
import {
  Home,
  Users,
  MessageCircle,
  Wallet,
  Gamepad2,
  Dice5,
  Trophy,
  Gift,
  LogOut,
  Hexagon,
  Sparkles,
  Headphones,
} from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';

const sections = [
  {
    title: 'Discover',
    items: [
      { name: 'Home', href: '/dashboard', icon: Home },
      { name: 'Play together', href: '/play-together', icon: Gamepad2 },
      { name: 'Casino', href: '/casino', icon: Dice5 },
      { name: 'Sports', href: '/sports', icon: Trophy },
    ],
  },
  {
    title: 'Together',
    items: [
      { name: 'Groups', href: '/groups', icon: Users },
      { name: 'Messages', href: '/messages', icon: MessageCircle },
    ],
  },
  {
    title: 'Your space',
    items: [
      { name: 'Wallet', href: '/wallet', icon: Wallet },
      { name: 'Gifts', href: '/gifts', icon: Gift },
      { name: 'Rewards', href: '/rewards', icon: Sparkles },
      { name: 'Support', href: '/support', icon: Headphones },
    ],
  },
];
export function Sidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { user, logout } = useAuth();
  const { t } = useLanguage();
  const { pathname } = useLocation();
  const providerDemoAlias = pathname === '/games/provider-demos';
  return (
    <aside className="qube-sidebar fixed inset-y-0 left-0 z-50 w-64 h-full">
      <Link to="/" onClick={onNavigate} className="qube-brand">
        <span className="qube-brand-mark">
          <Hexagon size={25} />
        </span>
        Salem Bet<span className="qube-brand-dot">•</span>
      </Link>
      <nav aria-label="Member navigation" className="qube-navigation">
        {user &&
          ['ADMIN', 'SUPER_ADMIN'].includes(
            (user as typeof user & { role?: string }).role ?? ''
          ) && (
            <Link to="/admin" onClick={onNavigate} className="qube-staff-link">
              Administration dashboard →
            </Link>
          )}
        {sections.map((section) => (
          <div className="qube-nav-section" key={section.title}>
            <p>{section.title}</p>
            {section.items.map(({ name, href, icon: Icon }) => {
              const active =
                href === '/casino'
                  ? providerDemoAlias || pathname === '/casino' || pathname.startsWith('/casino/')
                  : href === '/games'
                    ? !providerDemoAlias &&
                      (pathname === '/games' || pathname.startsWith('/games/'))
                    : pathname === href || (href !== '/' && pathname.startsWith(`${href}/`));
              return (
                <Link
                  key={href}
                  to={href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={`qube-nav-link ${active ? 'is-active' : ''}`}
                >
                  <Icon size={19} aria-hidden="true" />
                  {t(name)}
                </Link>
              );
            })}
          </div>
        ))}
        <details className="salem-nav-more">
          <summary>{t('More')}</summary>
          <Link to="/challenges" onClick={onNavigate}>
            Challenges
          </Link>
          <Link to="/competitions" onClick={onNavigate}>
            Competitions
          </Link>
          <Link to="/profile" onClick={onNavigate}>
            {t('Profile')}
          </Link>
        </details>
      </nav>
      <div className="qube-account">
        <Link to="/profile" onClick={onNavigate} className="qube-account-profile">
          <span className="qube-avatar">
            {(user?.displayName || user?.username || 'U')[0].toUpperCase()}
          </span>
          <span className="min-w-0">
            <strong className="block truncate">{user?.displayName || user?.username}</strong>
            <small className="block truncate">@{user?.username}</small>
          </span>
        </Link>
        <button onClick={() => logout()} className="qube-signout">
          <LogOut size={17} aria-hidden="true" />
          {t('Sign out')}
        </button>
      </div>
    </aside>
  );
}
