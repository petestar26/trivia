import { describe, expect, it } from 'vitest';
import { guestBrowseLocation } from './guest-browse-location';
const location = (url: string) => {
  const u = new URL(url, 'https://example.test');
  return { pathname: u.pathname, search: u.search, hash: u.hash };
};
describe('guest URL boundary', () => {
  it.each([
    ['/sports/open?token=secret#session', '/sports'],
    ['/Sports/open', '/sports'],
    ['/%73ports/open', '/sports'],
    ['/CASINO?game=provider-id', '/casino'],
    ['/%63asino?game=provider-id', '/casino'],
    ['/%2573ports/open', '/dashboard'],
    ['/%E0%A4%A', '/dashboard'],
    ['/unknown', '/dashboard'],
    ['/casino?game=provider-id', '/casino'],
    ['/games/provider-demos?game=provider-id', '/casino'],
    // An invitation keeps its own path (accepting needs a click); nothing else survives.
    ['/groups/invite/private-token?accept=1', '/groups/invite/private-token'],
    [
      '/Groups/Invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566#accept',
      '/groups/invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566',
    ],
    ['/groups/invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566/accept', '/groups'],
    ['/groups/invite/short', '/groups'],
    ['/groups/invite/', '/groups'],
    ['/groups/private-id/games?game=dice', '/groups'],
    ['/wallet/withdraw?amount=50', '/wallet'],
    ['/play-together/rounds/private-round?join=1', '/play-together'],
    ['/messages/private-room', '/messages'],
    ['/games/sky-crash', '/play-together?game=sky_crash'],
    ['/games/spin-win/play', '/play-together'],
    ['/play-together?game=dice&join=1#entry', '/play-together?game=dice'],
    ['/play-together?game=__proto__', '/play-together'],
    ['/play-together?game=constructor', '/play-together'],
    ['/play-together?game=unreleased', '/play-together'],
    ['/dashboard?launch=1#action', '/dashboard'],
    // The skip link's anchor survives; it carries no action.
    ['/sports/open#main-content', '/sports#main-content'],
    ['/casino?game=provider-id#main-content', '/casino#main-content'],
    ['/wallet#main-content-launch', '/wallet'],
    [
      '/groups/invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566?accept=1#main-content',
      '/groups/invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566#main-content',
    ],
  ])('replaces %s with safe browsing %s', (input, target) =>
    expect(guestBrowseLocation(location(input))).toBe(target)
  );
  it.each([
    '/',
    '/dashboard',
    '/explore',
    '/casino',
    '/sports',
    '/play-together?game=dice',
    '/games/history',
    '/dashboard#our-games',
    '/#our-games',
    '/groups/invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566',
    '/dashboard#main-content',
    '/wallet#main-content',
    '/play-together?game=dice#main-content',
    '/groups/invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566#main-content',
  ])('leaves safe route %s stable', (path) =>
    expect(guestBrowseLocation(location(path))).toBeNull()
  );
});
