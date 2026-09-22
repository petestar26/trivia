import type { InfiniteData } from '@tanstack/react-query';
import type { GroupInviteInfo, PaginationMeta } from '@socialplay/shared';
import type { ApiResponse } from '@/lib/api';

/** One fetched page of pending invites, exactly as the query stores it. */
export interface InvitesPage {
  invites: GroupInviteInfo[];
  /** The page number that was requested — the cursor `getNextPageParam` advances from. */
  page: number;
  hasNextPage: boolean;
}

export type InvitesInbox = InfiniteData<InvitesPage, number>;

/** Map an API list response onto the page shape the query cache stores. */
export function toInvitesPage(
  res: ApiResponse<GroupInviteInfo[], PaginationMeta>,
  requestedPage: number
): InvitesPage {
  if (!res.success) throw new Error(res.error?.message ?? 'Failed to load invites');
  const rows = Array.isArray(res.data) ? res.data : [];
  return {
    invites: rows,
    page: requestedPage,
    // Never trusts `meta.page` — only the server's claim that a further page
    // exists, and only that.
    hasNextPage: res.meta?.hasNextPage === true,
  };
}

/**
 * Every loaded page, flattened in order, one row per invite id.
 *
 * Pages are fetched by offset, so new invites landing at the top between two
 * page fetches shift rows down and the same invite can appear at the end of
 * one page and the start of the next. Deduplication happens here — at render
 * time only — and never in the cache, so the stored pages stay exactly what
 * the server sent.
 */
export function flattenInvitesPages(pages: readonly InvitesPage[] | undefined): GroupInviteInfo[] {
  const seen = new Set<string>();
  const out: GroupInviteInfo[] = [];
  for (const page of pages ?? []) {
    for (const invite of page.invites) {
      if (seen.has(invite.id)) continue;
      seen.add(invite.id);
      out.push(invite);
    }
  }
  return out;
}

/**
 * Put a freshly created invite at the top of the loaded list INSIDE the page
 * structure — every loaded page and the cursor stay, so a later refetch or a
 * failed refresh cannot make the new invite vanish.
 *
 * When nothing is cached yet (the list has not loaded, or its first load
 * failed) the invite still gets a page of its own: a link that exists must be
 * on screen whatever the list query is doing. That page claims no next page —
 * the refetch that follows learns the truth.
 */
export function applyCreatedInvite(data: InvitesInbox | undefined, invite: GroupInviteInfo): InvitesInbox {
  const first = data?.pages[0];
  if (!data || !first) return { pages: [{ page: 1, hasNextPage: false, invites: [invite] }], pageParams: [1] };
  const deduped = { ...first, invites: [invite, ...first.invites.filter((inv) => inv.id !== invite.id)] };
  return { ...data, pages: [deduped, ...data.pages.slice(1)] };
}

/**
 * Take a revoked invite out of EVERY loaded page, keeping the pages and the
 * cursor. Without this a revoked invite — and its still-copyable link — would
 * stay on screen as active until the refetch that follows succeeded.
 * Returns undefined when nothing is cached, so setQueryData will not write.
 */
export function applyRevokedInvite(data: InvitesInbox | undefined, inviteId: string): InvitesInbox | undefined {
  if (!data) return undefined;
  return { ...data, pages: data.pages.map((page) => ({ ...page, invites: page.invites.filter((inv) => inv.id !== inviteId) })) };
}
