import { StrictMode, useLayoutEffect } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFavoriteGames } from './use-favorite-games';

const key = (user: string) => `playqube.favorite-games.v1:${encodeURIComponent(user)}`;
const saved = (ids: unknown[]) => JSON.stringify({ version: 1, ids });

const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
beforeEach(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, String(value));
    },
    removeItem: (name) => {
      values.delete(name);
    },
    clear: () => {
      values.clear();
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'localStorage', originalStorage);
});

describe('account-scoped local favorite games', () => {
  it('starts empty and persists additions/removals under only the current account', () => {
    const { result, unmount } = renderHook(() => useFavoriteGames('alice'));
    expect(result.current.favoriteIds).toEqual([]);
    expect(result.current.storageUnavailable).toBe(false);
    act(() => result.current.toggleFavorite('sky'));
    expect(result.current.favoriteIds).toEqual(['sky']);
    expect(window.localStorage.getItem(key('alice'))).toBe(saved(['sky']));
    act(() => result.current.toggleFavorite('sky'));
    expect(result.current.favoriteIds).toEqual([]);
    act(() => result.current.toggleFavorite('derby'));
    unmount();
    const restored = renderHook(() => useFavoriteGames('alice'));
    expect(restored.result.current.favoriteIds).toEqual(['derby']);
    expect(window.localStorage.length).toBe(1);
  });

  it('does not expose old account IDs during account change or write them to the new scope', () => {
    window.localStorage.setItem(key('alice'), saved(['alice-game']));
    window.localStorage.setItem(key('bob'), saved(['bob-game']));
    const writes = vi.spyOn(window.localStorage, 'setItem');
    const observations: Array<{ user: string; ids: readonly string[] }> = [];
    const { result, rerender } = renderHook(
      ({ user }: { user: string }) => {
        const favorites = useFavoriteGames(user);
        useLayoutEffect(() => {
          observations.push({ user, ids: [...favorites.favoriteIds] });
        });
        return favorites;
      },
      { initialProps: { user: 'alice' } }
    );
    expect(result.current.favoriteIds).toEqual(['alice-game']);
    act(() => result.current.toggleFavorite('second-alice'));
    rerender({ user: 'bob' });
    expect(result.current.favoriteIds).toEqual(['bob-game']);
    expect(observations.filter((item) => item.user === 'bob')).toEqual([
      { user: 'bob', ids: [] },
      { user: 'bob', ids: ['bob-game'] },
    ]);
    expect(writes.mock.calls).toEqual([[key('alice'), saved(['alice-game', 'second-alice'])]]);
    act(() => result.current.toggleFavorite('second-bob'));
    expect(window.localStorage.getItem(key('alice'))).toBe(saved(['alice-game', 'second-alice']));
    expect(window.localStorage.getItem(key('bob'))).toBe(saved(['bob-game', 'second-bob']));
  });

  it('shows no favorites after logout and performs no anonymous persistence', () => {
    window.localStorage.setItem(key('alice'), saved(['sky']));
    const writes = vi.spyOn(window.localStorage, 'setItem');
    const { result, rerender } = renderHook(({ user }) => useFavoriteGames(user), {
      initialProps: { user: 'alice' as string | null },
    });
    rerender({ user: null });
    act(() => result.current.toggleFavorite('derby'));
    expect(result.current.favoriteIds).toEqual([]);
    expect(result.current.storageUnavailable).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });

  it('preserves batched toggles without updater side effects under StrictMode', () => {
    const writes = vi.spyOn(window.localStorage, 'setItem');
    const { result } = renderHook(() => useFavoriteGames('alice'), {
      wrapper: StrictMode,
    });
    act(() => {
      result.current.toggleFavorite('sky');
      result.current.toggleFavorite('derby');
      result.current.toggleFavorite('sky');
    });
    expect(result.current.favoriteIds).toEqual(['derby']);
    expect(writes.mock.calls).toEqual([[key('alice'), saved(['derby'])]]);
  });

  it.each([
    ['malformed JSON', '{'],
    ['legacy array', '["sky"]'],
    ['null root', 'null'],
    ['wrong version', '{"version":2,"ids":["sky"]}'],
    ['extra root property', '{"version":1,"ids":["sky"],"user":"alice"}'],
    ['non-array IDs', '{"version":1,"ids":"sky"}'],
    ['non-string ID', saved([42])],
    ['empty ID', saved([''])],
    ['whitespace ID', saved([' sky'])],
    ['control character', saved(['sky\n'])],
    ['oversized ID', saved(['a'.repeat(201)])],
    ['duplicate IDs', saved(['sky', 'sky'])],
    ['too many IDs', saved(Array.from({ length: 101 }, (_, index) => `game-${index}`))],
    ['oversized raw storage', ' '.repeat(65_537)],
  ])('refuses %s without exposing values or overwriting storage', (_name, raw) => {
    window.localStorage.setItem(key('alice'), raw);
    const writes = vi.spyOn(window.localStorage, 'setItem');
    const { result } = renderHook(() => useFavoriteGames('alice'));
    expect(result.current.favoriteIds).toEqual([]);
    expect(result.current.storageUnavailable).toBe(true);
    act(() => result.current.toggleFavorite('derby'));
    expect(writes).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(key('alice'))).toBe(raw);
  });

  it('bounds favorites at 100 while allowing removal', () => {
    const ids = Array.from({ length: 100 }, (_, index) => `game-${index}`);
    window.localStorage.setItem(key('alice'), saved(ids));
    const { result } = renderHook(() => useFavoriteGames('alice'));
    act(() => result.current.toggleFavorite('one-more'));
    expect(result.current.favoriteIds).toEqual(ids);
    act(() => result.current.toggleFavorite('game-0'));
    act(() => result.current.toggleFavorite('one-more'));
    expect(result.current.favoriteIds).toHaveLength(100);
    expect(result.current.favoriteIds).toContain('one-more');
    expect(result.current.favoriteIds).not.toContain('game-0');
  });

  it('refuses invalid toggle IDs without writing', () => {
    const writes = vi.spyOn(window.localStorage, 'setItem');
    const { result } = renderHook(() => useFavoriteGames('alice'));
    act(() => {
      for (const id of ['', ' sky ', 'a'.repeat(201), '\u0000']) result.current.toggleFavorite(id);
    });
    expect(result.current.favoriteIds).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
  });

  it('fails closed when local storage cannot be read', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });
    const writes = vi.spyOn(window.localStorage, 'setItem');
    const { result } = renderHook(() => useFavoriteGames('alice'));
    expect(result.current.favoriteIds).toEqual([]);
    expect(result.current.storageUnavailable).toBe(true);
    act(() => result.current.toggleFavorite('sky'));
    expect(writes).not.toHaveBeenCalled();
  });

  it('clears all displayed IDs and blocks further writes after persistence failure', () => {
    window.localStorage.setItem(key('alice'), saved(['sky']));
    const { result } = renderHook(() => useFavoriteGames('alice'));
    const writes = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    act(() => result.current.toggleFavorite('derby'));
    expect(result.current.favoriteIds).toEqual([]);
    expect(result.current.storageUnavailable).toBe(true);
    act(() => result.current.toggleFavorite('football'));
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('isolates account keys containing separators and rejects unusable account identities', () => {
    const { result, rerender } = renderHook(({ user }) => useFavoriteGames(user), {
      initialProps: { user: 'alice:bob' },
    });
    act(() => result.current.toggleFavorite('sky'));
    expect(window.localStorage.getItem('playqube.favorite-games.v1:alice%3Abob')).toBe(
      saved(['sky'])
    );
    rerender({ user: '\ud800' });
    act(() => result.current.toggleFavorite('derby'));
    expect(result.current.favoriteIds).toEqual([]);
    expect(window.localStorage.length).toBe(1);
  });
});
