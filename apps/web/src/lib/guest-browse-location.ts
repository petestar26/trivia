import { PRACTICE_ROUTES } from './member-game-catalog';

const sections = new Set([
  'dashboard',
  'casino',
  'sports',
  'play-together',
  'groups',
  'messages',
  'wallet',
  'gifts',
  'rewards',
  'support',
  'profile',
  'challenges',
  'competitions',
]);

/**
 * Replace action-bearing guest URLs before rendering any browsing UI. Sanitizing
 * only the login return value would leave the old action URL in browser history,
 * where Back (or a late session probe) could mount an automatic member launch.
 * No token, action query or private resource ID survives this boundary.
 * Only the known Home catalogue anchor is retained.
 */
export function guestBrowseLocation(location: { pathname: string; search: string; hash: string }) {
  const { pathname, search, hash } = location;
  // React Router is case-insensitive and decodes URL segments. Never let an
  // encoded/case-variant action URL evade the guest boundary. Unknown or malformed
  // paths fail closed to Home rather than remaining latent member destinations.
  let canonical: string;
  try {
    canonical = decodeURIComponent(pathname).toLowerCase();
  } catch {
    return '/dashboard';
  }
  if (!/^\/[a-z0-9/_-]*$/.test(canonical)) return '/dashboard';
  const section = canonical.split('/')[1];
  let target = '/dashboard';
  if (canonical === '/' || canonical === '/explore') target = canonical;
  else if (canonical === '/games/provider-demos') target = '/casino';
  else if (canonical === '/games/history') target = '/games/history';
  else if (section === 'games') target = '/play-together';
  else if (sections.has(section)) target = `/${section}`;

  // A known game key is a read-only selection in the shared lobby, never admission.
  let selected: string | null = null;
  if (target === '/play-together') {
    selected =
      new URLSearchParams(search).get('game') ||
      Object.entries(PRACTICE_ROUTES).find(([, route]) => route === canonical)?.[0] ||
      null;
    if (!selected || !Object.hasOwn(PRACTICE_ROUTES, selected)) selected = null;
  }
  const nextSearch = selected ? `?game=${encodeURIComponent(selected)}` : '';
  // Only canonical, safe routes remain in history when identity changes.
  const nextHash = ['/', '/dashboard'].includes(target) && hash === '#our-games' ? hash : '';
  return target !== pathname || nextSearch !== search || nextHash !== hash
    ? `${target}${nextSearch}${nextHash}`
    : null;
}
