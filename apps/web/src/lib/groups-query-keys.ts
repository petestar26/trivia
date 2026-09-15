/**
 * Canonical React Query keys for the two group-list views.
 *
 * Both `GroupsPage` (the flat browser) and `CompetitionsPage` (the
 * membership-filtered hub picker) fetch `GET /groups`. Group create/join
 * mutations must invalidate BOTH lists together, and that only works if the
 * keys never drift apart — so they live here instead of being hand-written
 * in each page.
 *
 * The competitions hub deliberately keeps a DISTINCT single-segment key
 * (`['groups-for-competitions']`), so neither list key is a prefix of the
 * other. React Query's `invalidateQueries({ queryKey })` matches by PREFIX
 * unless `exact: true` is supplied: invalidating one of these keys also
 * refreshes any query whose key starts with it, but never the other list.
 */
export const GROUPS_QUERY_KEY = ['groups'] as const;
export const COMPETITIONS_HUB_GROUPS_QUERY_KEY = ['groups-for-competitions'] as const;

export const GROUP_LIST_QUERY_KEYS = [GROUPS_QUERY_KEY, COMPETITIONS_HUB_GROUPS_QUERY_KEY] as const;
