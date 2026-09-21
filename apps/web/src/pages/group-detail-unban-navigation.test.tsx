import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { GroupBannedMemberInfo } from '@socialplay/shared';
import { bannedMembersQueryKey, type BannedMembersInbox } from '@/lib/group-banned-members-pages';
import { GroupDetailPage } from './group-detail';

// An Unban confirmed for group A must never act on group B.
//
// The route `/groups/:id` renders the SAME GroupDetailPage element for every
// group, so moving from one group to another inside the SPA does not unmount
// it: its children — and whatever state they hold — stay alive with a new
// `groupId`. The reproduction that motivated this file:
//   1. open group A;   2. open "Unban Banned 2?";
//   3. navigate to (cached) group B;   4. the confirmation survives;
//   5. confirm — and B is unbanned, with the user captured from A.
//
// Two independent layers stop it, and both are tested:
//   - the section is keyed by group, so nothing survives the move (here);
//   - the request carries the group it was opened for (banned-members-section
//     .test.tsx re-renders one instance with another group, no key).
//
// These tests use the REAL router and a REAL QueryClient with caching on
// (`gcTime: Infinity`), so group B is a cached group when it is navigated to —
// and the same user is banned in BOTH groups, so a request sent to the wrong
// group is observable rather than a 404.

const authState = vi.hoisted(() => ({
  current: { id: 'u-viewer', username: 'viewer', displayName: 'Viewer' } as { id: string; username: string; displayName: string } | null,
}));

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    user: authState.current,
    isAuthenticated: !!authState.current,
    isLoading: authState.current === null,
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getGroup: vi.fn(),
    getGroupMembers: vi.fn(),
    listGroupInvites: vi.fn(),
    listJoinRequests: vi.fn(),
    listBannedMembers: vi.fn(),
    unbanGroupMember: vi.fn(),
  },
}));

const toastMock = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: (...args: unknown[]) => toastMock(...args) }),
}));

import { api } from '@/lib/api';

const mocked = api as unknown as Record<
  'getGroup' | 'getGroupMembers' | 'listGroupInvites' | 'listJoinRequests' | 'listBannedMembers' | 'unbanGroupMember',
  ReturnType<typeof vi.fn>
>;

const groupFor = (id: string, name: string) => ({
  id,
  name,
  description: null,
  isPrivate: false,
  status: 'ACTIVE',
  memberCount: 3,
  isMember: true,
  memberRole: 'OWNER',
  viewerMembershipStatus: 'ACTIVE',
  owner: { id: 'u-viewer', username: 'viewer', displayName: 'Viewer' },
});
const GROUPS: Record<string, ReturnType<typeof groupFor>> = {
  'g-a': groupFor('g-a', 'Group A'),
  'g-b': groupFor('g-b', 'Group B'),
};

const person = (id: string, name: string): GroupBannedMemberInfo => ({
  id: `m-${id}`,
  groupId: 'ignored',
  user: { id, username: name.toLowerCase().replace(/\s/g, ''), displayName: name, avatarUrl: null },
});
// "Banned 2" is banned in BOTH groups: same user id, same name.
const SHARED = person('u-shared', 'Banned 2');

const pageMeta = (page: number, limit: number, total: number) => {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return { total, page, limit, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 };
};

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Two groups' banned lists, served in memory; an unban removes the user from THAT group only. */
function installServers() {
  const state = {
    rows: {
      'g-a': [person('u-a1', 'Banned 1'), SHARED, person('u-a3', 'Banned 3')],
      'g-b': [SHARED, person('u-b4', 'Banned 4')],
    } as Record<string, GroupBannedMemberInfo[]>,
    listCalls: [] as string[],
  };
  mocked.getGroup.mockImplementation(async (groupId: string) => ({ data: GROUPS[groupId] }));
  mocked.getGroupMembers.mockResolvedValue({ data: [] });
  mocked.listJoinRequests.mockResolvedValue({ data: [] });
  mocked.listGroupInvites.mockResolvedValue({ success: true, data: [], meta: pageMeta(1, 50, 0) });
  mocked.listBannedMembers.mockImplementation(async (groupId: string, params: { page: number; limit: number }) => {
    state.listCalls.push(groupId);
    return {
      success: true,
      data: [...state.rows[groupId]],
      meta: pageMeta(params.page, params.limit, state.rows[groupId].length),
    };
  });
  mocked.unbanGroupMember.mockImplementation(async (groupId: string, userId: string) => {
    state.rows[groupId] = state.rows[groupId].filter((r) => r.user.id !== userId);
    return { success: true, data: { message: 'Member unbanned' } };
  });
  return state;
}

function renderApp() {
  // Caching ON, and never collected: group B really is a cached group when the
  // user moves to it.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/groups/g-a']}>
        <nav>
          <Link to="/groups/g-a">go to A</Link>
          <Link to="/groups/g-b">go to B</Link>
        </nav>
        <Routes>
          <Route path="/groups/:id" element={<GroupDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { client, invalidate };
}

const goTo = (letter: 'A' | 'B') => fireEvent.click(screen.getByRole('link', { name: `go to ${letter}` }));
const onGroup = (name: string) => screen.findByRole('heading', { name });
const unbanButton = (name: string) => screen.getByRole('button', { name: `Unban ${name}` });
const anyConfirmation = () => screen.queryByRole('group', { name: /^Unban / });
const idsIn = (data: unknown): string[] =>
  ((data as BannedMembersInbox | undefined)?.pages ?? []).flatMap((p) => p.members.map((m) => m.user.id));
const unbanRowNames = () => screen.getAllByRole('button', { name: /^Unban / }).map((b) => b.getAttribute('aria-label'));
const listCallsFor = (groupId: string) => mocked.listBannedMembers.mock.calls.filter((c: unknown[]) => c[0] === groupId).length;

/** Visit B, then A again, so BOTH are cached before the scenario starts; leaves the app on A. */
async function prime() {
  await onGroup('Group A');
  await screen.findByText('Banned 1');
  goTo('B');
  await onGroup('Group B');
  await screen.findByText('Banned 4');
  goTo('A');
  await onGroup('Group A');
  await screen.findByText('Banned 1');
  mocked.unbanGroupMember.mockClear();
  toastMock.mockClear();
}

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  toastMock.mockReset();
  authState.current = { id: 'u-viewer', username: 'viewer', displayName: 'Viewer' };
});

describe('A. a confirmation opened in group A', () => {
  it('disappears when the user moves to group B, and B receives no request', async () => {
    installServers();
    renderApp();
    await prime();

    fireEvent.click(unbanButton('Banned 2'));
    expect(await screen.findByRole('group', { name: 'Unban Banned 2?' })).toBeInTheDocument();

    goTo('B');
    await onGroup('Group B');
    await screen.findByText('Banned 4');

    // The confirmation is gone — not merely hidden — with its Confirm button.
    expect(anyConfirmation()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm unban' })).not.toBeInTheDocument();
    // B shows ITS rows, including the very same person, each with a fresh Unban.
    expect(unbanRowNames()).toEqual(['Unban Banned 2', 'Unban Banned 4']);
    // Nothing was sent, to anyone.
    expect(mocked.unbanGroupMember).not.toHaveBeenCalled();
  });

  it('leaves group B\'s controls pristine: a NEW confirmation there targets B, once', async () => {
    installServers();
    renderApp();
    await prime();
    fireEvent.click(unbanButton('Banned 2'));
    await screen.findByRole('group', { name: 'Unban Banned 2?' });
    goTo('B');
    await onGroup('Group B');
    await screen.findByText('Banned 4');

    fireEvent.click(unbanButton('Banned 2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));

    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    expect(mocked.unbanGroupMember).toHaveBeenCalledWith('g-b', 'u-shared');
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Member unbanned' })));
  });
});

describe('B. an Unban in flight for A that SUCCEEDS after the user moved to B', () => {
  it('used A\'s group id, changed only A\'s cache and keys, and left B and its screen alone', async () => {
    const servers = installServers();
    const { client, invalidate } = renderApp();
    await prime();
    const request = deferred();
    mocked.unbanGroupMember.mockImplementation(async (groupId: string, userId: string) => {
      await request.promise;
      servers.rows[groupId] = servers.rows[groupId].filter((r) => r.user.id !== userId);
      return { success: true, data: { message: 'Member unbanned' } };
    });

    fireEvent.click(unbanButton('Banned 2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    // It is genuinely pending: the confirmation is showing "Unbanning…".
    expect(screen.getByRole('button', { name: 'Unbanning…' })).toBeInTheDocument();

    goTo('B');
    await onGroup('Group B');
    await screen.findByText('Banned 4');
    expect(anyConfirmation()).not.toBeInTheDocument();
    const bIdsBefore = idsIn(client.getQueryData(bannedMembersQueryKey('g-b')));
    expect(bIdsBefore).toEqual(['u-shared', 'u-b4']);
    const bListCallsBefore = listCallsFor('g-b');
    const invalidationsBefore = invalidate.mock.calls.length;

    request.resolve(undefined);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Member unbanned' })));

    // The request that was made was A's, and was made once.
    expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1);
    expect(mocked.unbanGroupMember).toHaveBeenCalledWith('g-a', 'u-shared');
    // Success is announced FOR A: the toast names it, and never names B.
    expect(toastMock).toHaveBeenCalledWith({
      title: 'Member unbanned',
      description: 'Banned 2 was unbanned from Group A. They may request to join again or receive a new invitation.',
    });
    expect(JSON.stringify(toastMock.mock.calls)).not.toContain('Group B');

    // A's cache lost exactly that user; its keys — and only its keys — were invalidated.
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
    expect(keys.filter((k) => k.includes('g-b'))).toEqual([]);

    // B is untouched: cache, screen, and not so much as a refetch caused by A's answer.
    expect(idsIn(client.getQueryData(bannedMembersQueryKey('g-b')))).toEqual(bIdsBefore);
    expect(unbanRowNames()).toEqual(['Unban Banned 2', 'Unban Banned 4']);
    expect(listCallsFor('g-b')).toBe(bListCallsBefore);
    expect(anyConfirmation()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm unban' })).not.toBeInTheDocument();
  });

  it('D. going back to A shows A\'s settled state: that member gone, nothing stale reappears', async () => {
    const servers = installServers();
    renderApp();
    await prime();
    const request = deferred();
    mocked.unbanGroupMember.mockImplementation(async (groupId: string, userId: string) => {
      await request.promise;
      servers.rows[groupId] = servers.rows[groupId].filter((r) => r.user.id !== userId);
      return { success: true, data: { message: 'Member unbanned' } };
    });
    fireEvent.click(unbanButton('Banned 2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    goTo('B');
    await onGroup('Group B');
    request.resolve(undefined);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Member unbanned' })));

    goTo('A');
    await onGroup('Group A');
    await waitFor(() => expect(unbanRowNames()).toEqual(['Unban Banned 1', 'Unban Banned 3']));
    expect(screen.queryByText('Banned 2')).not.toBeInTheDocument();
    expect(anyConfirmation()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Unbanning/ })).not.toBeInTheDocument();
    // ...and B, when visited again, still lists the member A's request never touched.
    goTo('B');
    await onGroup('Group B');
    expect(unbanRowNames()).toEqual(['Unban Banned 2', 'Unban Banned 4']);
    expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1);
  });
});

describe('C. an Unban in flight for A that FAILS after the user moved to B', () => {
  it('leaves B untouched, names A in the error, and does not move focus onto B\'s controls', async () => {
    installServers();
    const { client, invalidate } = renderApp();
    await prime();
    const request = deferred();
    mocked.unbanGroupMember.mockReturnValue(request.promise);

    fireEvent.click(unbanButton('Banned 2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    goTo('B');
    await onGroup('Group B');
    await screen.findByText('Banned 4');
    // The user is working in B: their focus is on one of B's controls.
    const bControl = unbanButton('Banned 4');
    bControl.focus();
    expect(bControl).toHaveFocus();
    const bIdsBefore = idsIn(client.getQueryData(bannedMembersQueryKey('g-b')));
    const bListCallsBefore = listCallsFor('g-b');
    const invalidationsBefore = invalidate.mock.calls.length;

    request.reject(new Error(JSON.stringify({ status: 403, message: 'Insufficient permissions' })));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error' })));

    // The error says which group it is about.
    expect(toastMock).toHaveBeenCalledWith({
      title: 'Error',
      description: "Couldn't unban Banned 2 from Group A. Insufficient permissions",
      variant: 'destructive',
    });
    expect(JSON.stringify(toastMock.mock.calls)).not.toContain('Group B');
    // Focus is still where the user put it — the failure did not go looking for
    // a "trigger" or a heading among B's controls.
    expect(bControl).toHaveFocus();
    // B is untouched: rows, cache, and no invalidation or refetch on its account.
    expect(unbanRowNames()).toEqual(['Unban Banned 2', 'Unban Banned 4']);
    expect(idsIn(client.getQueryData(bannedMembersQueryKey('g-b')))).toEqual(bIdsBefore);
    const keys = invalidate.mock.calls.slice(invalidationsBefore).map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys.filter((k) => k.includes('g-b'))).toEqual([]);
    expect(listCallsFor('g-b')).toBe(bListCallsBefore);
    expect(anyConfirmation()).not.toBeInTheDocument();

    // D. Back in A: the failure changed nothing, and no stale confirmation is waiting.
    goTo('A');
    await onGroup('Group A');
    await waitFor(() => expect(unbanRowNames()).toEqual(['Unban Banned 1', 'Unban Banned 2', 'Unban Banned 3']));
    expect(anyConfirmation()).not.toBeInTheDocument();
    expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1);
  });
});

describe('F. A -> B -> A with the request still running', () => {
  it('the member\'s Unban is inert on the re-opened A, no second confirmation is offered, and no second request starts', async () => {
    const servers = installServers();
    renderApp();
    await prime();
    const request = deferred();
    mocked.unbanGroupMember.mockImplementation(async (groupId: string, userId: string) => {
      await request.promise;
      servers.rows[groupId] = servers.rows[groupId].filter((r) => r.user.id !== userId);
      return { success: true, data: { message: 'Member unbanned' } };
    });
    fireEvent.click(unbanButton('Banned 2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));

    goTo('B');
    await onGroup('Group B');
    await screen.findByText('Banned 4');
    // B is not made inert by A's request: the same person in B can be unbanned.
    expect(unbanButton('Banned 2')).not.toHaveAttribute('aria-disabled');
    goTo('A');
    await onGroup('Group A');
    await screen.findByText('Banned 1');

    // A page instance that never made the request; the mutation cache did.
    await waitFor(() => expect(unbanButton('Banned 2')).toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(unbanButton('Banned 2'));
    expect(anyConfirmation()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm unban' })).not.toBeInTheDocument();
    expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1);
    // Everyone else in A is still available.
    expect(unbanButton('Banned 1')).not.toHaveAttribute('aria-disabled');

    request.resolve(undefined);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Member unbanned' })));
    await waitFor(() => expect(unbanRowNames()).toEqual(['Unban Banned 1', 'Unban Banned 3']));
    expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1);
  });
});

describe('E. rapid A -> B -> A navigation with cached queries', () => {
  it('leaves no stale target behind, and a fresh confirmation sends exactly one request, for A', async () => {
    installServers();
    renderApp();
    await prime();
    fireEvent.click(unbanButton('Banned 2'));
    await screen.findByRole('group', { name: 'Unban Banned 2?' });

    // Four moves in one tick, ending back on A.
    goTo('B');
    goTo('A');
    goTo('B');
    goTo('A');
    await onGroup('Group A');
    await screen.findByText('Banned 1');

    expect(anyConfirmation()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm unban' })).not.toBeInTheDocument();
    expect(mocked.unbanGroupMember).not.toHaveBeenCalled();

    fireEvent.click(unbanButton('Banned 2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    expect(mocked.unbanGroupMember).toHaveBeenCalledWith('g-a', 'u-shared');
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Member unbanned' })));
    expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1);
  });

  it('with a request in flight, bouncing between the groups sends no second request and touches only A', async () => {
    const servers = installServers();
    const { client, invalidate } = renderApp();
    await prime();
    const request = deferred();
    mocked.unbanGroupMember.mockImplementation(async (groupId: string, userId: string) => {
      await request.promise;
      servers.rows[groupId] = servers.rows[groupId].filter((r) => r.user.id !== userId);
      return { success: true, data: { message: 'Member unbanned' } };
    });
    fireEvent.click(unbanButton('Banned 2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    const invalidationsBefore = invalidate.mock.calls.length;

    goTo('B');
    goTo('A');
    goTo('B');
    goTo('A');
    goTo('B');
    await onGroup('Group B');
    await screen.findByText('Banned 4');
    expect(anyConfirmation()).not.toBeInTheDocument();

    request.resolve(undefined);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Member unbanned' })));

    expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1);
    expect(mocked.unbanGroupMember).toHaveBeenCalledWith('g-a', 'u-shared');
    expect(toastMock.mock.calls.filter((c: unknown[]) => (c[0] as { title?: string }).title === 'Member unbanned')).toHaveLength(1);
    expect(idsIn(client.getQueryData(bannedMembersQueryKey('g-b')))).toEqual(['u-shared', 'u-b4']);
    expect(idsIn(client.getQueryData(bannedMembersQueryKey('g-a')))).toEqual(['u-a1', 'u-a3']);
    const keys = invalidate.mock.calls.slice(invalidationsBefore).map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys.filter((k) => k.includes('g-b'))).toEqual([]);
    expect(within(screen.getByRole('region', { name: 'Banned members' })).getAllByRole('button', { name: /^Unban / })).toHaveLength(2);
  });
});
