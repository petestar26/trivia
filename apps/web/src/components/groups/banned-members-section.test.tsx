import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GroupBannedMemberInfo } from '@socialplay/shared';
import { bannedMembersQueryKey, type BannedMembersInbox } from '@/lib/group-banned-members-pages';
import { BannedMembersSection } from './banned-members-section';

// The SECOND layer of protection against acting on the wrong group.
//
// The page keys this component by group, so a move from group A to group B
// remounts it and nothing survives (see group-detail-unban-navigation.test.tsx,
// which drives that with the real router). This file is about what still has
// to hold if a component instance is ever handed a different `groupId` WITHOUT
// remounting — the shape of the original bug: an Unban confirmed for A was sent
// to B, because the request, its callbacks and its cache writes all read the
// live `groupId` prop.
//
// Every test therefore re-renders the SAME instance with another group (no key)
// and asserts that the request, the cache writes, the invalidations and the
// toast all belong to the group the confirmation was opened for.

vi.mock('@/lib/api', () => ({
  api: {
    listBannedMembers: vi.fn(),
    unbanGroupMember: vi.fn(),
  },
}));

import { api } from '@/lib/api';

const mocked = api as unknown as Record<'listBannedMembers' | 'unbanGroupMember', ReturnType<typeof vi.fn>>;

const person = (id: string, name: string): GroupBannedMemberInfo => ({
  id: `m-${id}`,
  groupId: 'ignored',
  user: { id, username: name.toLowerCase().replace(/\s/g, ''), displayName: name, avatarUrl: null },
});

// The SAME user is banned in both groups, so a request sent to the wrong group
// is observable rather than a 404.
const SHARED = person('u-shared', 'Banned 2');
const ROWS: Record<string, GroupBannedMemberInfo[]> = {
  'g-a': [person('u-a1', 'Banned 1'), SHARED, person('u-a3', 'Banned 3')],
  'g-b': [SHARED, person('u-b4', 'Banned 4')],
};

const meta = (total: number) => ({ total, page: 1, limit: 20, totalPages: 1, hasNextPage: false, hasPrevPage: false });

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const idsIn = (data: unknown): string[] =>
  ((data as BannedMembersInbox | undefined)?.pages ?? []).flatMap((p) => p.members.map((m) => m.user.id));

let client: QueryClient;
const toast = vi.fn();

const tree = (groupId: string, groupName: string) => (
  <QueryClientProvider client={client}>
    <BannedMembersSection groupId={groupId} groupName={groupName} toast={toast} />
  </QueryClientProvider>
);

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  toast.mockReset();
  // No garbage collection: both groups' lists stay cached, as they do for a
  // user moving back and forth between two groups.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  mocked.listBannedMembers.mockImplementation(async (groupId: string) => ({
    success: true,
    data: ROWS[groupId],
    meta: meta(ROWS[groupId].length),
  }));
});

afterEach(() => {
  cleanup();
});

/** Open the confirmation for "Banned 2" in group A, then hand the SAME instance group B. */
async function openInAThenSwitchToB() {
  const view = render(tree('g-a', 'Group A'));
  await screen.findByText('Banned 1');
  fireEvent.click(screen.getByRole('button', { name: 'Unban Banned 2' }));
  await screen.findByRole('group', { name: 'Unban Banned 2?' });

  view.rerender(tree('g-b', 'Group B'));
  // B's list is on screen now (its rows are B's), and the confirmation is still
  // the one that was opened for A.
  await screen.findByText('Banned 4');
  return view;
}

describe('an instance handed another group still acts on the group the confirmation was opened for', () => {
  it('the request goes to A — never to the live groupId', async () => {
    await openInAThenSwitchToB();
    mocked.unbanGroupMember.mockResolvedValue({ success: true, data: { message: 'Member unbanned' } });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm unban' }));

    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    expect(mocked.unbanGroupMember).toHaveBeenCalledWith('g-a', 'u-shared');
    expect(mocked.unbanGroupMember).not.toHaveBeenCalledWith('g-b', expect.anything());
    // (settle before the test ends, so nothing lands after it)
    await waitFor(() => expect(toast).toHaveBeenCalled());
  });

  it('success: only A\'s cache changes, only A\'s keys are invalidated, and the toast names A', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await openInAThenSwitchToB();
    const aBefore = idsIn(client.getQueryData(bannedMembersQueryKey('g-a')));
    expect(aBefore).toContain('u-shared');
    const request = deferred();
    mocked.unbanGroupMember.mockReturnValue(request.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    const invalidationsBefore = invalidate.mock.calls.length;
    const listCallsBefore = mocked.listBannedMembers.mock.calls.filter((c: unknown[]) => c[0] === 'g-b').length;

    request.resolve({ success: true, data: { message: 'Member unbanned' } });
    await waitFor(() => expect(toast).toHaveBeenCalled());

    // A: the user is gone from A's cache (the patch), and A's keys are marked stale.
    expect(idsIn(client.getQueryData(bannedMembersQueryKey('g-a')))).toEqual(['u-a1', 'u-a3']);
    const keys = invalidate.mock.calls.slice(invalidationsBefore).map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    for (const key of [
      ['group-banned-members', 'g-a'],
      ['group', 'g-a'],
      ['group-members', 'g-a'],
      ['group-requests', 'g-a'],
    ]) {
      expect(keys).toContain(JSON.stringify(key));
    }
    // B: untouched — its cache, its keys, and no refetch caused by A's answer.
    expect(keys.filter((k) => k.includes('g-b'))).toEqual([]);
    expect(idsIn(client.getQueryData(bannedMembersQueryKey('g-b')))).toEqual(['u-shared', 'u-b4']);
    expect(mocked.listBannedMembers.mock.calls.filter((c: unknown[]) => c[0] === 'g-b').length).toBe(listCallsBefore);
    // The toast says WHICH group, so it cannot be read as being about the one on screen.
    expect(toast).toHaveBeenCalledWith({
      title: 'Member unbanned',
      description: 'Banned 2 was unbanned from Group A. They may request to join again or receive a new invitation.',
    });
    expect(JSON.stringify(toast.mock.calls)).not.toContain('Group B');
  });

  it('failure: only A\'s list is reconciled, B is left alone, and the toast names A', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await openInAThenSwitchToB();
    const request = deferred();
    mocked.unbanGroupMember.mockReturnValue(request.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    const invalidationsBefore = invalidate.mock.calls.length;

    request.reject(new Error(JSON.stringify({ status: 409, message: 'This member is not banned' })));
    await waitFor(() => expect(toast).toHaveBeenCalled());

    const keys = invalidate.mock.calls.slice(invalidationsBefore).map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(['group-banned-members', 'g-a']));
    expect(keys.filter((k) => k.includes('g-b'))).toEqual([]);
    // A's cache is NOT patched by a failure; B's is untouched.
    expect(idsIn(client.getQueryData(bannedMembersQueryKey('g-a')))).toContain('u-shared');
    expect(idsIn(client.getQueryData(bannedMembersQueryKey('g-b')))).toEqual(['u-shared', 'u-b4']);
    expect(toast).toHaveBeenCalledWith({
      title: 'Error',
      description: "Couldn't unban Banned 2 from Group A. This member is not banned",
      variant: 'destructive',
    });
    expect(JSON.stringify(toast.mock.calls)).not.toContain('Group B');
  });

  it('the confirmation names the person it was opened for and stays that way when the list beneath it changes', async () => {
    await openInAThenSwitchToB();
    // The row is on screen in B too — same person — but the target is what was captured.
    expect(screen.getByRole('group', { name: 'Unban Banned 2?' })).toBeInTheDocument();
    mocked.unbanGroupMember.mockResolvedValue({ success: true, data: { message: 'Member unbanned' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
  });
});
