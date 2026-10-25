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
    const load = () => {
      if (!scope) {
        setState({ scope: null, ids: EMPTY_IDS, unavailable: false, dirty: false });
        return;
      }
      try {
        setState({
          scope,
          ids: parseFavorites(window.localStorage.getItem(scope)),
          unavailable: false,
          dirty: false,
        });
      } catch {
        setState({ scope, ids: EMPTY_IDS, unavailable: true, dirty: false });
      }
    };
    const changed = (event: StorageEvent) => {
      if (event.key === scope || event.key === null) load();
    };
    load();
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [scope]);

  const toggleFavorite = useCallback(
    (id: string) => {
      if (!scope || !validId(id) || state.scope !== scope || state.unavailable) return;
      try {
        const current = parseFavorites(window.localStorage.getItem(scope));
        const exists = current.includes(id);
        if (!exists && current.length >= MAX_FAVORITES) return;
        const ids = exists ? current.filter((value) => value !== id) : [...current, id];
        window.localStorage.setItem(scope, JSON.stringify({ version: 1, ids }));
        setState({ scope, ids, unavailable: false, dirty: false });
      } catch {
        setState({ scope, ids: EMPTY_IDS, unavailable: true, dirty: false });
      }
    },
    [scope, state.scope, state.unavailable]
  );

  // A changed account never sees the previous account's values, even before effects run.
  const current = state.scope === scope;
  return {
    favoriteIds: current && scope && !state.unavailable ? state.ids : EMPTY_IDS,
    toggleFavorite,
    storageUnavailable: !!scope && current && state.unavailable,
  };
}
