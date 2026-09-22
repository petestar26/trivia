import { useMutationState, type QueryClient } from '@tanstack/react-query';

/**
 * Every group-scoped action on the group page, by what it does. The kind is the
 * second element of the mutation key, so the mutation CACHE — not a component —
 * is what knows which of them are running.
 */
export type GroupActionKind =
  | 'join'
  | 'leave'
  | 'approve'
  | 'reject'
  | 'remove'
  | 'ban'
  | 'role'
  | 'invite'
  | 'revoke'
  | 'transfer'
  | 'unban';

/**
 * Who and what a group action is FOR — captured at the moment it is initiated,
 * carried as part of the mutation's VARIABLES, and read from there by the
 * request, every callback, every cache write and every toast.
 *
 * Never read `groupId` from a prop, the route or a query result after the
 * click. The page stays mounted when the route moves from one group to another,
 * a request outlives the render that started it, and TanStack hands an
 * in-flight mutation the LATEST render's callbacks — so a closure over the live
 * group is not protection: it turns "Ban this person in group A" into a request
 * to group B, or a late answer from A into an invalidation of B's data.
 */
export interface GroupActionIdentity {
  groupId: string;
  /** For wording only: a late answer must say WHICH group it is about. */
  groupName: string;
  /** The member, join request or invite it targets; absent for actions on the group itself. */
  targetId?: string;
}

/** Which running action to look for: a group, and optionally one target within it. */
export interface GroupActionQuery {
  groupId: string;
  /** Omit to match any target in the group. */
  targetId?: string;
}

export const GROUP_ACTION_KEY = 'group-action';

/**
 * A STATIC key per kind. A key that depended on the variables would change from
 * one action to the next, and TanStack resets a mutation observer whose key
 * changes.
 */
export const groupActionKey = (kind: GroupActionKind) => [GROUP_ACTION_KEY, kind] as const;

function matches(query: GroupActionQuery, variables: unknown): boolean {
  if (typeof variables !== 'object' || variables === null) return false;
  const v = variables as Partial<GroupActionIdentity>;
  return v.groupId === query.groupId && (query.targetId === undefined || v.targetId === query.targetId);
}

/**
 * Is this action — same kind, same group, same target — already running,
 * ANYWHERE? Read from the mutation cache, synchronously, so it sees a request
 * started by a page instance that has since been unmounted (the user went to
 * another group and came back) and one started a moment ago in the same tick.
 * A component's own `isPending` sees neither.
 */
export function hasPendingGroupAction(
  client: QueryClient,
  kind: GroupActionKind | readonly GroupActionKind[],
  query: GroupActionQuery
): boolean {
  const kinds = Array.isArray(kind) ? (kind as readonly GroupActionKind[]) : [kind as GroupActionKind];
  return kinds.some(
    (k) =>
      client.isMutating({
        mutationKey: groupActionKey(k),
        predicate: (mutation) => matches(query, mutation.state.variables),
      }) > 0
  );
}

/**
 * The same question as a hook, for rendering: re-renders when an action starts
 * or settles, in this component or any other. Use it to make a control inert;
 * use {@link hasPendingGroupAction} to refuse a request.
 */
export function useGroupActionPending(): (kind: GroupActionKind | readonly GroupActionKind[], query: GroupActionQuery) => boolean {
  const pending = useMutationState({
    filters: { mutationKey: [GROUP_ACTION_KEY], status: 'pending' },
    select: (mutation) => ({
      kind: mutation.options.mutationKey?.[1] as GroupActionKind | undefined,
      variables: mutation.state.variables,
    }),
  });
  return (kind, query) => {
    const kinds = Array.isArray(kind) ? (kind as readonly GroupActionKind[]) : [kind as GroupActionKind];
    return pending.some((p) => p.kind !== undefined && kinds.includes(p.kind) && matches(query, p.variables));
  };
}

/**
 * A safe, user-facing message from a failed API call: the server's own message
 * when it sent one, the caller's fallback otherwise. Never a raw payload.
 */
export function actionErrorMessage(err: unknown, fallback: string): string {
  try {
    return JSON.parse((err as Error).message)?.message ?? fallback;
  } catch {
    return fallback;
  }
}
