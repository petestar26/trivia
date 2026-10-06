import type { InfiniteData } from '@tanstack/react-query';
import type { GroupBannedMemberInfo, PaginationMeta } from '@socialplay/shared';
import type { ApiResponse } from '@/lib/api';

/** One fetched page of banned members, exactly as the query stores it. */
export interface BannedMembersPage {
  members: GroupBannedMemberInfo[];
  /** The page number that was requested — the cursor `getNextPageParam` advances from. */
  page: number;
  hasNextPage: boolean;
}

export type BannedMembersInbox = InfiniteData<BannedMembersPage, number>;

/** The query key of the banned list, scoped to one group. */
export const bannedMembersQueryKey = (groupId: string) => ['group-banned-members', groupId] as const;

/** Map an API list response onto the page shape the query cache stores. */
export function toBannedMembersPage(
  res: ApiResponse<GroupBannedMemberInfo[], PaginationMeta>,
  requestedPage: number
): BannedMembersPage {
  if (!res.success) throw new Error(res.error?.message ?? 'Failed to load banned members');
  return {
    members: Array.isArray(res.data) ? res.data : [],
    page: requestedPage,
    // Never trusts `meta.page` — only the server's claim that a further page
    // exists, and only that.
    hasNextPage: res.meta?.hasNextPage === true,
  };
}

/**
 * Every loaded page, flattened in order, one row per USER.
 *
 * Pages are fetched by offset, so a ban landing at the top between two page
 * fetches shifts rows down and the same member can appear at the end of one
 * page and the start of the next. Deduplication happens here — at render time
 * only — and never in the cache, so the stored pages stay exactly what the
 * server sent. Keyed on the user, not the membership row: the user is what a
 * manager acts on.
 */
export function flattenBannedMembersPages(pages: readonly BannedMembersPage[] | undefined): GroupBannedMemberInfo[] {
  const seen = new Set<string>();
  const out: GroupBannedMemberInfo[] = [];
  for (const page of pages ?? []) {
    for (const member of page.members) {
      if (seen.has(member.user.id)) continue;
      seen.add(member.user.id);
      out.push(member);
    }
  }
  return out;
}

/**
 * Take ONE unbanned user out of every loaded page, keeping the pages and the
 * cursor. Nobody else is touched, and the list does not have to wait for the
 * refetch that follows to stop showing a member who is no longer banned.
 * Returns undefined when nothing is cached, so setQueryData will not write.
 */
export function applyUnbannedMember(data: BannedMembersInbox | undefined, userId: string): BannedMembersInbox | undefined {
  if (!data) return undefined;
  return {
    ...data,
    pages: data.pages.map((page) => ({ ...page, members: page.members.filter((m) => m.user.id !== userId) })),
  };
}
