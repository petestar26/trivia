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
 * An invitation link belongs to the visitor who opened it, and its page only
 * accepts on a click, so it survives sign-in exactly as the release did before
 * the guest shell. Tokens are random UUIDs; anything else is not an invite.
 * The route matches case-insensitively and after one decode, like the router.
 */
export function invitePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const match = /^\/groups\/invite\/([A-Za-z0-9_-]{8,128})\/?$/i.exec(decoded);
  return match ? `/groups/invite/${match[1]}` : null;
}

/**
 * Replace confirmed guests' action-bearing URLs before rendering browsing UI. Sanitizing
 * only the login return value would leave the old action URL in browser history,
 * where Back (or a later identity change) could mount an automatic member launch.
 * An initial unresolved session must be held, not redirected: an existing
 * authenticated member's deep link must survive the session probe.
 * No token, action query or private resource ID survives this boundary.
 * Only the known Home catalogue anchor is retained.
 */
export function guestBrowseLocation(location: { pathname: string; search: string; hash: string }) {
  const { pathname, search, hash } = location;
  // The skip link's in-page anchor carries no action and must keep working for guests.
  const skipLink = hash === '#main-content' ? hash : '';
  // Keep only the invitation path itself: no query, other fragment or other segment.
  const invite = invitePath(pathname);
  if (invite) return invite !== pathname || search || hash !== skipLink ? invite + skipLink : null;
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
  const nextHash = ['/', '/dashboard'].includes(target) && hash === '#our-games' ? hash : skipLink;
  return target !== pathname || nextSearch !== search || nextHash !== hash
    ? `${target}${nextSearch}${nextHash}`
    : null;
}
