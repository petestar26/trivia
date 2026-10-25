import { useCallback, useEffect, useState } from 'react';

const MAX_FAVORITES = 100;
const MAX_STORAGE_CHARS = 65_536;
const EMPTY_IDS: readonly string[] = [];

interface FavoriteState {
  scope: string | null;
  ids: readonly string[];
  unavailable: boolean;
  dirty: boolean;
}

function validId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 200 &&
    id === id.trim() &&
    !/[\u0000-\u001f\u007f]/.test(id)
  );
}

function storageScope(userId: string | null | undefined): string | null {
  if (!validId(userId)) return null;
  try {
    return `playqube.favorite-games.v1:${encodeURIComponent(userId)}`;
  } catch {
    return null;
  }
}

function parseFavorites(raw: string | null): readonly string[] {
  if (raw === null) return EMPTY_IDS;
  if (raw.length > MAX_STORAGE_CHARS) throw new Error('Favorites storage is too large');
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'ids,version'
  ) {
    throw new Error('Invalid favorites storage');
  }
  const record = value as { version?: unknown; ids?: unknown };
  if (
    record.version !== 1 ||
    !Array.isArray(record.ids) ||
    record.ids.length > MAX_FAVORITES ||
    !record.ids.every(validId) ||
    new Set(record.ids).size !== record.ids.length
  ) {
    throw new Error('Invalid favorites storage');
  }
  return record.ids;
}

/** A device-local preference, isolated by authenticated account; never a play entitlement. */
export function useFavoriteGames(userId: string | null | undefined) {
  const scope = storageScope(userId);
  const [state, setState] = useState<FavoriteState>({
    scope: null,
    ids: EMPTY_IDS,
    unavailable: false,
    dirty: false,
  });

  useEffect(() => {
    if (!scope) {
      setState({ scope: null, ids: EMPTY_IDS, unavailable: false, dirty: false });
      return;
    }
    try {
      const ids = parseFavorites(window.localStorage.getItem(scope));
      setState({ scope, ids, unavailable: false, dirty: false });
    } catch {
      setState({ scope, ids: EMPTY_IDS, unavailable: true, dirty: false });
    }
  }, [scope]);

  useEffect(() => {
    if (!scope || state.scope !== scope || !state.dirty || state.unavailable) return;
    try {
      window.localStorage.setItem(scope, JSON.stringify({ version: 1, ids: state.ids }));
    } catch {
      setState({ scope, ids: EMPTY_IDS, unavailable: true, dirty: false });
    }
  }, [scope, state]);

  const toggleFavorite = useCallback(
    (id: string) => {
      if (!scope || !validId(id)) return;
      setState((previous) => {
        if (previous.scope !== scope || previous.unavailable) return previous;
        const exists = previous.ids.includes(id);
        if (!exists && previous.ids.length >= MAX_FAVORITES) return previous;
        return {
          scope,
          ids: exists ? previous.ids.filter((value) => value !== id) : [...previous.ids, id],
          unavailable: false,
          dirty: true,
        };
      });
    },
    [scope]
  );

  // A changed account never sees the previous account's values, even before effects run.
  const current = state.scope === scope;
  return {
    favoriteIds: current && scope && !state.unavailable ? state.ids : EMPTY_IDS,
    toggleFavorite,
    storageUnavailable: !!scope && current && state.unavailable,
  };
}
