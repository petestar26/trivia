import { useLanguage } from '@/providers/language-provider';
import { Link, useLocation } from 'react-router-dom';
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
export function MobileNavigation({ guest = false }: { guest?: boolean } = {}) {
  const { t: translateUi } = useInterfaceLanguage();

  const { pathname } = useLocation();
  const { t } = useLanguage();
  // Give game controls and chat composers the entire mobile viewport.
  if (!guest && (/^\/games\/.+/.test(pathname) || /^\/messages(?:\/|$)/.test(pathname)))
    return null;
  return (
    <nav className="salem-mobile-nav lg:hidden" aria-label={translateUi('Quick navigation')}>
      {destinations.map(({ to, label, icon: Icon }) => {
        const active =
          pathname === to ||
          pathname.startsWith(`${to}/`) ||
          (to === '/dashboard' && ['/', '/explore'].includes(pathname));
        return (
          <Link
            key={to}
            to={to}
            className={active ? 'is-active' : ''}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{t(label)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
