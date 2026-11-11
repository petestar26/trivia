import { describe, expect, it } from 'vitest';
import { getGuestReturnTo } from './guest-return-to';

describe('getGuestReturnTo', () => {
  it.each([
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
  ])('keeps only the %s landing page', (section) => {
    expect(getGuestReturnTo(`/${section}/private-action?token=secret#launch`)).toEqual({
      pathname: `/${section}`,
      search: '',
      hash: '',
    });
  });
  it.each([
    ['/', '/dashboard'],
    ['/explore', '/dashboard'],
    ['/sports/open?event=1', '/sports'],
    ['/groups/invite/secret', '/groups'],
    ['/groups/invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566/x', '/groups'],
    ['/games/practice', '/play-together'],
    ['/games/spin-win/play?session=secret', '/play-together'],
    ['/wallet/deposit', '/wallet'],
    ['/login?next=https://evil.test', '/dashboard'],
    ['//evil.test/sports', '/dashboard'],
    ['https://evil.test/groups', '/dashboard'],
    ['/sports%2fopen', '/dashboard'],
  ])('sanitizes %s', (input, pathname) => {
    expect(getGuestReturnTo(input)).toEqual({ pathname, search: '', hash: '' });
  });

  it('keeps an invitation through sign-in; its page accepts only on a click', () => {
    expect(
      getGuestReturnTo('/groups/invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566?accept=1')
    ).toEqual({
      pathname: '/groups/invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566',
      search: '',
      hash: '',
    });
  });
  it.each([
    ['?game=dice&join=1', '?game=dice'],
    ['?game=__proto__', ''],
    ['?game=unreleased', ''],
    ['', ''],
  ])('keeps only a known Play Together game choice from %j', (search, expected) => {
    expect(getGuestReturnTo('/play-together', search)).toEqual({
      pathname: '/play-together',
      search: expected,
      hash: '',
    });
  });
});
