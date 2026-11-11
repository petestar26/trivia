import { invitePath } from './guest-browse-location';
import { PRACTICE_ROUTES } from './member-game-catalog';

const BROWSE_SECTIONS = new Set([
  'dashboard',
  'casino',
  'sports',
  'play-together',
  'groups',
  'messages',
  'gifts',
  'rewards',
  'wallet',
  'support',
  'profile',
  'challenges',
  'competitions',
]);

/**
 * Only section landing pages survive authentication, never an action or
 * session. Two read-only exceptions keep the visitor's context: an invitation
 * page (accepting still needs a click) and a known Play Together game key
 * (it only chooses which game the lobby shows; entering a round needs a click).
 */
export function getGuestReturnTo(pathname: string, search = '') {
  const path = pathname.split(/[?#]/)[0];
  const invite = invitePath(path);
  if (invite) return { pathname: invite, search: '', hash: '' };
  if (path === '/games/provider-demos') return { pathname: '/casino', search: '', hash: '' };
  if (path.toLowerCase() === '/play-together') {
    const game = new URLSearchParams(search).get('game');
    if (game && Object.hasOwn(PRACTICE_ROUTES, game))
      return { pathname: '/play-together', search: `?game=${encodeURIComponent(game)}`, hash: '' };
  }
  const section = pathname.split(/[/?#]/)[1];
  return {
    pathname: BROWSE_SECTIONS.has(section)
      ? `/${section}`
      : section === 'games'
        ? '/play-together'
        : '/dashboard',
    search: '',
    hash: '',
  };
}

export function guestReturnTo(location: { pathname: string; search?: string }) {
  return getGuestReturnTo(location.pathname, location.search);
}
