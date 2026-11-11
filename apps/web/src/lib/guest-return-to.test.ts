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
});
