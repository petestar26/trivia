import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { GroupBannedMemberInfo } from '@socialplay/shared';
import { api } from '@/lib/api';
import {
  applyUnbannedMember,
  bannedMembersQueryKey,
  flattenBannedMembersPages,
  toBannedMembersPage,
  type BannedMembersInbox,
  type BannedMembersPage,
} from '@/lib/group-banned-members-pages';
import type { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type ListFailure = 'initial' | 'refresh' | 'next-page';

/** The page's own toast function — see the note on the prop below. */
type Toast = ReturnType<typeof useToast>['toast'];

const BANNED_PAGE_LIMIT = 20;

// Not written as an escape sequence: an invisible character in source is one
// stray edit away from being lost.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

const memberName = (member: GroupBannedMemberInfo) => member.user.displayName || member.user.username;

function errorMessage(err: unknown, fallback: string): string {
  try {
    return JSON.parse((err as Error).message)?.message ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * What one Unban confirmation is FOR — captured when it opens, and carried
 * unchanged through the request, its callbacks and its cache writes.
 *
 * The group is part of it, deliberately. This component is handed a `groupId`
 * that changes when the user moves between groups, and a request outlives the
 * render that started it: read the live `groupId` anywhere after the click
 * and an Unban confirmed for group A can be sent to — or clean up the caches
 * of — group B. The page also keys this component by group so that nothing
 * survives the move; this is the layer that still holds if it ever does.
 */
interface UnbanTarget {
  groupId: string;
  groupName: string;
  userId: string;
  /** The person's name as the confirmation showed it, whatever the list does afterwards. */
  name: string;
}

/** Focus that has to survive a change to the list; see the layout effect below. */
interface FocusRequest {
  trigger: HTMLElement;
  knownUserIds: ReadonlySet<string>;
}

/**
 * The manager's "Banned members" list, with an Unban action per row.
 *
 * Rendered ONLY for OWNER/ADMIN of an active group (the page decides), so a
 * non-manager neither sees the section nor causes the request that would fetch
 * banned identities. It owns its own query — pages of the banned list, fetched
 * by offset — and everything that follows an unban.
 *
 * `toast` is the page's own. `useToast()` re-renders every component that calls
 * it on every toast, and the page already does; a second subscriber would only
 * be one more component re-rendered, for nothing, each time anything toasts.
 *
 * `groupId` decides which list is SHOWN. It never decides what an Unban does:
 * that is the group captured in the confirmation (see UnbanTarget).
 */
export function BannedMembersSection({
  groupId,
  groupName,
  toast,
}: {
  groupId: string;
  groupName: string;
  toast: Toast;
}) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const confirmTitleId = useId();
  const confirmBodyId = useId();

  const query = useInfiniteQuery({
    // Group-scoped, and the same key the page's ban mutation invalidates.
    queryKey: bannedMembersQueryKey(groupId),
    queryFn: async ({ pageParam }): Promise<BannedMembersPage> =>
      toBannedMembersPage(await api.listBannedMembers(groupId, { limit: BANNED_PAGE_LIMIT, page: pageParam }), pageParam),
    initialPageParam: 1,
    // Derived from the successful `lastPageParam` — never trusted from
    // `meta.page` — and only advances while the server claims another page.
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.hasNextPage ? (lastPageParam as number) + 1 : undefined,
    enabled: !!groupId,
  });

  // Every loaded page flattened, one row per user. The cache keeps exactly what
  // the server sent; the de-duplication is render-only.
  const members = flattenBannedMembersPages(query.data?.pages);
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetching, isFetchNextPageError } = query;
  const hasData = query.data !== undefined;

  // WHICH failure is on screen, remembered across the retry that follows it.
  // React Query clears or reclassifies its own error the moment a retry starts,
  // so deriving the message from it alone would unmount the very Retry button
  // the user just activated — and Chromium answers that by dropping focus onto
  // <body> for the whole request. State adjusted during render: no frame of lag.
  const [rememberedFailure, setRememberedFailure] = useState<ListFailure | null>(null);
  let failure: ListFailure | null = rememberedFailure;
  if (query.isSuccess) {
    failure = null;
  } else if (query.isError && !isFetching) {
    failure = !hasData ? 'initial' : isFetchNextPageError ? 'next-page' : 'refresh';
  }
  if (failure !== rememberedFailure) setRememberedFailure(failure);
  const nextPageFailed = hasData && isFetchNextPageError;

  // Outcomes of loading are announced through one live region. The nonce makes
  // a REPEATED identical message a real DOM change, so it is announced again.
  const [announcement, setAnnouncement] = useState({ message: '', nonce: 0 });
  const announce = (message: string) => setAnnouncement((prev) => ({ message, nonce: prev.nonce + 1 }));
  const announcementText =
    announcement.message === '' ? '' : `${announcement.message}${announcement.nonce % 2 ? ZERO_WIDTH_SPACE : ''}`;

  const sectionRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const focusRequestRef = useRef<FocusRequest | null>(null);

  // A burst of "Load more" activations must produce exactly one request.
  // `isFetchingNextPage` updates a render late, so two same-tick clicks can both
  // see it false; a ref flips synchronously and drops the second one.
  const nextPageInFlightRef = useRef(false);

  const loadNextPage = (trigger: HTMLElement) => {
    if (nextPageInFlightRef.current) return;
    // A background refresh is not a user next-page request: refetching page 1
    // now could reorder the list under a focused control. Load more is
    // aria-disabled meanwhile and works again the moment the refresh settles.
    if (isFetching && !isFetchingNextPage) return;
    nextPageInFlightRef.current = true;
    const knownUserIds = new Set(members.map((m) => m.user.id));
    const pagesBefore = query.data?.pages.length ?? 0;
    focusRequestRef.current = document.activeElement === trigger ? { trigger, knownUserIds } : null;
    announce('Loading more banned members…');
    void fetchNextPage()
      .then((result) => {
        if (result.isFetchNextPageError) {
          announce('Failed to load more banned members.');
          return;
        }
        // "Loaded" means a NEW PAGE arrived. A request cancelled and superseded
        // by a reconciling refetch resolves too, with no new page; that
        // outcome is not this request's to announce.
        if ((result.data?.pages.length ?? 0) <= pagesBefore) {
          focusRequestRef.current = null;
          return;
        }
        const added = flattenBannedMembersPages(result.data?.pages).filter((m) => !knownUserIds.has(m.user.id)).length;
        announce(added > 0 ? `Loaded ${added} more banned member${added === 1 ? '' : 's'}.` : 'No more banned members to load.');
      })
      .finally(() => {
        nextPageInFlightRef.current = false;
      });
  };

  // Retry after a failed first load or a failed refresh.
  const retryList = (trigger: HTMLElement) => {
    if (isFetching) return;
    focusRequestRef.current =
      document.activeElement === trigger ? { trigger, knownUserIds: new Set(members.map((m) => m.user.id)) } : null;
    void query.refetch();
  };

  // Runs after every render while a focus request is pending, so it sees the
  // DOM the settled state actually produced. A control that removes itself —
  // the last page takes Load more away, a successful retry dismisses its
  // banner, a refetch drops the row an Unban button belonged to — must not
  // leave keyboard focus on <body>.
  useLayoutEffect(() => {
    const request = focusRequestRef.current;
    if (!request || isFetching) return;
    focusRequestRef.current = null;
    // The control is still there: focus never left it.
    if (request.trigger.isConnected) return;
    // Focus that went somewhere on purpose is left alone; only lost focus is repaired.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const rows = Array.from(sectionRef.current?.querySelectorAll<HTMLElement>('[data-banned-user-id]') ?? []);
    const appended = rows.filter((row) => !request.knownUserIds.has(row.dataset.bannedUserId ?? ''));
    // The first row the user has not seen yet, so the next Tab continues from
    // where the new content begins; failing that, the section heading.
    const firstAction = appended
      .map((row) => row.querySelector<HTMLElement>('[data-action="unban"]'))
      .find((el): el is HTMLElement => el !== null);
    (firstAction ?? headingRef.current)?.focus();
  });

  // ─── Unban ────────────────────────────────────────────────────────

  const [target, setTarget] = useState<UnbanTarget | null>(null);
  // The Unban button that opened the confirmation, so Cancel (and a failed
  // unban) can put focus back exactly where the user left it.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  // Guards against a double activation sending two unbans. `isPending` cannot
  // do this alone: it has not updated yet when a second click arrives in the
  // SAME tick. A ref flips synchronously, so the second click is dropped.
  const unbanInFlightRef = useRef(false);

  // Moving focus into the confirmation is what makes it a real confirmation
  // step: without it a keyboard or screen reader user gets no sign anything
  // happened.
  useEffect(() => {
    if (target) confirmRef.current?.focus();
  }, [target]);

  function closeConfirm(restoreTo: 'trigger' | 'heading') {
    setTarget(null);
    unbanInFlightRef.current = false;
    const trigger = triggerRef.current;
    // A trigger that left the DOM can't take focus, so fall back to the heading.
    const destination = restoreTo === 'trigger' && trigger && trigger.isConnected ? trigger : headingRef.current;
    destination?.focus();
    triggerRef.current = null;
  }

  // Everything below reads the group from the VARIABLES the request was made
  // with — never from `groupId`, which is whatever group the page shows by the
  // time a response arrives. (TanStack hands an in-flight mutation the latest
  // render's callbacks, so a closure over the prop is not protection.)
  const unbanMutation = useMutation({
    mutationFn: ({ groupId: targetGroupId, userId }: UnbanTarget) => api.unbanGroupMember(targetGroupId, userId),
    onSuccess: (_res, { groupId: targetGroupId, groupName: targetGroupName, userId, name }) => {
      // Only this user leaves, from every loaded page, NOW: were it left until
      // the refetch below succeeds, a slow or failed refresh would keep offering
      // Unban for someone who is no longer banned.
      queryClient.setQueryData<BannedMembersInbox>(bannedMembersQueryKey(targetGroupId), (current) =>
        applyUnbannedMember(current, userId)
      );
      // The backend is the authority on what an unban did; these bring every
      // view of the group in line. The unbanned member is LEFT, not ACTIVE, so
      // the members list and the pending requests are refreshed too — an
      // unban must never look like an admission, and neither list should be
      // left showing a state that predates it.
      queryClient.invalidateQueries({ queryKey: bannedMembersQueryKey(targetGroupId) });
      queryClient.invalidateQueries({ queryKey: ['group', targetGroupId] });
      queryClient.invalidateQueries({ queryKey: ['group-members', targetGroupId] });
      queryClient.invalidateQueries({ queryKey: ['group-requests', targetGroupId] });
      // Names the group: the person may have moved on to another one by now.
      toast({
        title: 'Member unbanned',
        description: `${name} was unbanned from ${targetGroupName}. They may request to join again or receive a new invitation.`,
      });
      // The row — and the Unban button that opened this — is gone, so focus
      // goes to the heading, a control that survives.
      closeConfirm('heading');
    },
    onError: (err, { groupId: targetGroupId, groupName: targetGroupName, name }) => {
      toast({
        title: 'Error',
        description: `Couldn't unban ${name} from ${targetGroupName}. ${errorMessage(err, 'Please try again.')}`,
        variant: 'destructive',
      });
      // The unban failed, so the row and its Unban button are still there —
      // send focus back to where the flow started...
      closeConfirm('trigger');
      const trigger = document.activeElement;
      // ...and reconcile with the server: the usual reason for a refusal is that
      // the list was stale (someone else already unbanned this member). If that
      // takes the row away, the focus repair above moves focus to the heading.
      if (trigger instanceof HTMLElement && trigger.dataset.action === 'unban') {
        focusRequestRef.current = { trigger, knownUserIds: new Set(members.map((m) => m.user.id)) };
      }
      queryClient.invalidateQueries({ queryKey: bannedMembersQueryKey(targetGroupId) });
    },
  });

  const pending = unbanMutation.isPending;

  const openConfirm = (member: GroupBannedMemberInfo, trigger: HTMLButtonElement) => {
    // With a request running the target cannot change under it.
    if (unbanInFlightRef.current) return;
    triggerRef.current = trigger;
    setTarget({ groupId, groupName, userId: member.user.id, name: memberName(member) });
  };

  const handleConfirm = () => {
    if (!target || unbanInFlightRef.current) return;
    unbanInFlightRef.current = true;
    // Deliberately does NOT close the confirmation here: it stays mounted for
    // the whole request so its "Unbanning…" state is actually reachable, and
    // closing is left to the mutation's settled callbacks.
    announce(`Unbanning ${target.name}…`);
    unbanMutation.mutate(target);
  };

  const handleCancel = () => {
    if (unbanInFlightRef.current) return;
    closeConfirm('trigger');
  };

  // Native `disabled` would make Chromium drop focus from a focused control the
  // moment it turned on; aria-disabled keeps it focusable — and the "Unbanning…"
  // text on it reachable — while the handlers refuse to act.
  const inertClass = 'aria-disabled:opacity-50 aria-disabled:cursor-not-allowed';

  return (
    <Card role="region" aria-labelledby={headingId}>
      <CardHeader className="pb-2">
        <CardTitle id={headingId} ref={headingRef} tabIndex={-1} className="text-sm">
          Banned members
        </CardTitle>
      </CardHeader>
      <CardContent ref={sectionRef} className="space-y-2">
        {query.isLoading && (
          <p role="status" className="text-xs text-gray-500">
            Loading banned members…
          </p>
        )}

        {/* The first load failed: say so, and offer the way out. Stays mounted
            (aria-disabled, "Retrying…") while the retry runs. */}
        {failure === 'initial' && members.length === 0 && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              Couldn&apos;t load banned members.
            </p>
            <Button
              size="sm"
              variant="outline"
              data-action="retry-banned"
              className={inertClass}
              aria-label="Retry loading banned members"
              aria-disabled={isFetching || undefined}
              onClick={(e) => retryList(e.currentTarget)}
            >
              {isFetching ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        )}

        {hasData && members.length === 0 && failure !== 'initial' && (
          <p className="text-xs text-gray-500">No banned members.</p>
        )}

        {members.length > 0 && (
          <ul className="space-y-2">
            {members.map((m) => (
              <li
                key={m.user.id}
                data-banned-user-id={m.user.id}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <span className="text-sm font-medium">{memberName(m)}</span>
                  {m.user.displayName && <span className="ml-2 text-xs text-gray-500">@{m.user.username}</span>}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  data-action="unban"
                  className={inertClass}
                  aria-label={`Unban ${memberName(m)}`}
                  aria-disabled={pending || undefined}
                  onClick={(e) => openConfirm(m, e.currentTarget)}
                >
                  Unban
                </Button>
              </li>
            ))}
          </ul>
        )}

        {/* A failed background refresh must not disturb the loaded rows — every
            page stays — but it needs a distinct, retryable signal that is NOT a
            "load more" error. The banner and its Retry stay mounted while the
            retry runs. */}
        {failure === 'refresh' && members.length > 0 && (
          <div className="flex items-center gap-3 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-600 dark:bg-red-900/30 dark:text-red-200">
            <span role="alert" className="flex-1">
              Couldn&apos;t refresh banned members.
            </span>
            <Button
              size="sm"
              variant="outline"
              data-action="retry-banned"
              className={inertClass}
              aria-label="Retry refreshing banned members"
              aria-disabled={isFetching || undefined}
              onClick={(e) => retryList(e.currentTarget)}
            >
              {isFetching ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        )}

        {/* Load more and its Retry are ONE control: the same element in the same
            place through every state, so a keyboard user who activates it keeps
            their place. */}
        {(hasNextPage || nextPageFailed) && (
          <div className="flex flex-col items-center gap-2 pt-2">
            {nextPageFailed && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                Couldn&apos;t load more banned members.
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              data-next-banned-page
              className={inertClass}
              aria-label={nextPageFailed ? 'Retry loading more banned members' : undefined}
              aria-disabled={isFetching || undefined}
              aria-busy={isFetchingNextPage}
              onClick={(e) => loadNextPage(e.currentTarget)}
            >
              {isFetchingNextPage ? (nextPageFailed ? 'Retrying…' : 'Loading…') : nextPageFailed ? 'Retry' : 'Load more'}
            </Button>
          </div>
        )}

        {target && (
          <div
            role="group"
            aria-labelledby={confirmTitleId}
            aria-describedby={confirmBodyId}
            className="space-y-3 rounded-md border border-amber-300 p-3 dark:border-amber-600"
          >
            <p id={confirmTitleId} className="text-sm font-medium">
              {`Unban ${target.name}?`}
            </p>
            <p id={confirmBodyId} className="text-sm text-gray-600 dark:text-gray-400">
              They will not automatically rejoin the group. They may request to join again or receive a new invitation.
            </p>
            <div className="flex gap-2">
              <Button
                ref={confirmRef}
                size="sm"
                data-action="confirm-unban"
                className={inertClass}
                aria-disabled={pending || undefined}
                aria-busy={pending}
                onClick={handleConfirm}
              >
                {pending ? 'Unbanning…' : 'Confirm unban'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-action="cancel-unban"
                className={inertClass}
                aria-disabled={pending || undefined}
                onClick={handleCancel}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        <p role="status" aria-live="polite" className="sr-only">
          {announcementText}
        </p>
      </CardContent>
    </Card>
  );
}
