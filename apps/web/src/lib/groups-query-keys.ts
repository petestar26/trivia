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
 * (`['groups-for-competitions']`) that is a PREFIX of neither `['groups']`
 * nor anything else; consumers invalidate these exact keys, not wildcards.
 */
export const GROUPS_QUERY_KEY = ['groups'] as const;
export const COMPETITIONS_HUB_GROUPS_QUERY_KEY = ['groups-for-competitions'] as const;

export const GROUP_LIST_QUERY_KEYS = [GROUPS_QUERY_KEY, COMPETITIONS_HUB_GROUPS_QUERY_KEY] as const;