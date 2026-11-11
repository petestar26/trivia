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

/** Only section landing pages survive authentication, never an action or session. */
export function getGuestReturnTo(pathname: string) {
  if (pathname.split(/[?#]/)[0] === '/games/provider-demos')
    return { pathname: '/casino', search: '', hash: '' };
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

export function guestReturnTo(location: { pathname: string }) {
  return getGuestReturnTo(location.pathname);
}
