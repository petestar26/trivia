import { useLanguage } from '@/providers/language-provider';
import { NavLink, useLocation } from 'react-router-dom';
import { Home, Gamepad2, Dice5, Users, Wallet, Trophy } from 'lucide-react';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

const destinations = [
  { to: '/dashboard', label: 'Home', icon: Home },
  { to: '/play-together', label: 'Play together', icon: Gamepad2 },
  { to: '/casino', label: 'Casino', icon: Dice5 },
  { to: '/sports', label: 'Sports', icon: Trophy },
  { to: '/groups', label: 'Groups', icon: Users },
  { to: '/wallet', label: 'Wallet', icon: Wallet },
];
export function MobileNavigation() {
  const { t: translateUi } = useInterfaceLanguage();

  const { pathname } = useLocation();
  const { t } = useLanguage();
  // Give game controls and chat composers the entire mobile viewport.
  if (/^\/games\/.+/.test(pathname) || /^\/messages(?:\/|$)/.test(pathname)) return null;
  return (
    <nav className="salem-mobile-nav lg:hidden" aria-label={translateUi('Quick navigation')}>
      {destinations.map(({ to, label, icon: Icon }) => (
        <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'is-active' : '')}>
          <Icon size={20} aria-hidden="true" />
          <span>{t(label)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
