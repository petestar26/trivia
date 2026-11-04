import { NavLink, useLocation } from 'react-router-dom';
import { Home, Gamepad2, Gift, Users, Wallet } from 'lucide-react';
const destinations = [
  { to: '/dashboard', label: 'Home', icon: Home },
  { to: '/games', label: 'Games', icon: Gamepad2 },
  { to: '/gifts', label: 'Gifts', icon: Gift },
  { to: '/groups', label: 'Groups', icon: Users },
  { to: '/wallet', label: 'Wallet', icon: Wallet },
];
export function MobileNavigation() {
  const { pathname } = useLocation();
  // Give game controls and chat composers the entire mobile viewport.
  if (/^\/games\/.+/.test(pathname) || /^\/messages(?:\/|$)/.test(pathname)) return null;
  return <nav className="salem-mobile-nav lg:hidden" aria-label="Quick navigation">
    {destinations.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} className={({isActive}) => isActive ? 'is-active' : ''}>
      <Icon size={20} aria-hidden="true"/><span>{label}</span>
    </NavLink>)}
  </nav>;
}
