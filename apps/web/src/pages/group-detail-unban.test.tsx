import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { GroupBannedMemberInfo } from '@socialplay/shared';
import { GroupDetailPage } from './group-detail';

// The Unban side of the group detail page: the manager's "Banned members"
// section, its own paginated query, and the confirm-then-unban flow.
//
// The API is a small in-memory server (`installServer`) that honours paging
// and forgets a member once they are unbanned, so what the page shows after a
// success is what a real refetch would return — and the tests that need the
// PAGE to be right before that refetch lands hold the refetch open.

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
    banGroupMember: vi.fn(),
    removeGroupMember: vi.fn(),
    transferOwnership: vi.fn(),
    approveJoinRequest: vi.fn(),
  },
}));

// One shared reference, so a test can assert on what was shown to the user.
const toastMock = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: (...args: unknown[]) => toastMock(...args) }),
}));

import { api } from '@/lib/api';

const mocked = api as unknown as Record<
  | 'getGroup'
  | 'getGroupMembers'
  | 'listGroupInvites'
  | 'listJoinRequests'
  | 'listBannedMembers'
  | 'unbanGroupMember'
  | 'banGroupMember'
  | 'removeGroupMember'
  | 'transferOwnership'
  | 'approveJoinRequest',
  ReturnType<typeof vi.fn>
>;

const baseGroup = {
  id: 'g-1',
  name: 'Test Group',
  description: 'A test group',
  isPrivate: true,
  status: 'ACTIVE',
  memberCount: 3,
  isMember: true,
  memberRole: 'OWNER',
  viewerMembershipStatus: 'ACTIVE',
  owner: { id: 'u-owner', username: 'owner', displayName: 'Owner' },
};

const banned = (n: number): GroupBannedMemberInfo => ({
  id: `bm-${n}`,
  groupId: 'g-1',
  user: { id: `u-b${n}`, username: `banned${n}`, displayName: `Banned ${n}`, avatarUrl: null },
});
const bannedRows = (count: number) => Array.from({ length: count }, (_, i) => banned(i + 1));

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

/** A tiny server: honours paging, and forgets a member once unbanned. */
function installServer(initial: GroupBannedMemberInfo[]) {
  const state = { rows: [...initial], lists: [] as { page: number; limit: number }[] };
  mocked.listBannedMembers.mockImplementation(async (_groupId: string, params: { page: number; limit: number }) => {
    state.lists.push(params);
    const start = (params.page - 1) * params.limit;
    return {
      success: true,
      data: state.rows.slice(start, start + params.limit),
      meta: pageMeta(params.page, params.limit, state.rows.length),
    };
  });
  mocked.unbanGroupMember.mockImplementation(async (_groupId: string, userId: string) => {
    state.rows = state.rows.filter((r) => r.user.id !== userId);
    return { success: true, data: { message: 'Member unbanned' } };
  });
  return state;
}

function renderPage(client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/groups/g-1']}>
          <Routes>
            <Route path="/groups/:id" element={<GroupDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  authState.current = { id: 'u-viewer', username: 'viewer', displayName: 'Viewer' };
  mocked.getGroup.mockResolvedValue({ data: baseGroup });
  mocked.getGroupMembers.mockResolvedValue({ data: [] });
  mocked.listGroupInvites.mockResolvedValue({ success: true, data: [], meta: { ...pageMeta(1, 50, 0), totalPages: 0 } });
  mocked.listJoinRequests.mockResolvedValue({ data: [] });
});

const unbanButton = (n: number) => screen.getByRole('button', { name: `Unban Banned ${n}` });
const section = () => screen.findByRole('region', { name: 'Banned members' });
const confirmation = (name: string) => screen.findByRole('group', { name: `Unban ${name}?` });
const loadMore = () => screen.getByRole('button', { name: /^(Load more|Loading…)$/ });

describe('banned members section — who sees it', () => {
  it.each(['OWNER', 'ADMIN'])('%s sees the banned members, fetched once with the group id', async (role) => {
    mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: role } });
    installServer(bannedRows(2));
    renderPage();

    const region = await section();
    expect(await within(region).findByText('Banned 1')).toBeInTheDocument();
    expect(within(region).getByText('Banned 2')).toBeInTheDocument();
    expect(within(region).getAllByRole('button', { name: /^Unban / })).toHaveLength(2);
    expect(mocked.listBannedMembers).toHaveBeenCalledTimes(1);
    expect(mocked.listBannedMembers).toHaveBeenCalledWith('g-1', { limit: 20, page: 1 });
  });

  it.each(['MEMBER', 'MODERATOR'])('a %s never sees the section, and the banned list is never even requested', async (role) => {
    mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: role } });
    installServer(bannedRows(2));
    renderPage();

    await screen.findByText('Test Group');
    await waitFor(() => expect(mocked.getGroupMembers).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Banned members' })).not.toBeInTheDocument();
    expect(screen.queryByText('Banned members')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Banned 1');
    expect(screen.queryByRole('button', { name: /^Unban / })).not.toBeInTheDocument();
    expect(mocked.listBannedMembers).not.toHaveBeenCalled();
  });

  it('a viewer who is not a member sees nothing of it either', async () => {
    mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, isMember: false, memberRole: null } });
    installServer(bannedRows(2));
    renderPage();

    await screen.findByText('Test Group');
    expect(screen.queryByText('Banned members')).not.toBeInTheDocument();
    expect(mocked.listBannedMembers).not.toHaveBeenCalled();
  });

  it.each(['ARCHIVED', 'INACTIVE'])('a manager of a %s group gets no section (the API refuses inactive groups)', async (status) => {
    mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, status } });
    installServer(bannedRows(2));
    renderPage();

    await screen.findByText('Test Group');
    await waitFor(() => expect(mocked.getGroupMembers).toHaveBeenCalled());
    expect(screen.queryByText('Banned members')).not.toBeInTheDocument();
    expect(mocked.listBannedMembers).not.toHaveBeenCalled();
  });

  it('says so when nobody is banned', async () => {
    installServer([]);
    renderPage();

    const region = await section();
    expect(await within(region).findByText('No banned members.')).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: /^Unban / })).not.toBeInTheDocument();
  });

  it('shows the first load as a status while it runs', async () => {
    const pending = deferred();
    mocked.listBannedMembers.mockReturnValue(pending.promise);
    renderPage();

    const region = await section();
    expect(await within(region).findByText('Loading banned members…')).toBeInTheDocument();
    expect(within(region).getByText('Loading banned members…')).toHaveAttribute('role', 'status');

    pending.resolve({ success: true, data: [banned(1)], meta: pageMeta(1, 20, 1) });
    expect(await within(region).findByText('Banned 1')).toBeInTheDocument();
  });

  it('a failed first load is an alert with a Retry that loads the list', async () => {
    installServer(bannedRows(1));
    const realList = mocked.listBannedMembers.getMockImplementation()!;
    mocked.listBannedMembers.mockRejectedValueOnce(new Error('boom'));
    renderPage();

    const region = await section();
    expect(await within(region).findByRole('alert')).toHaveTextContent("Couldn't load banned members.");
    fireEvent.click(within(region).getByRole('button', { name: 'Retry loading banned members' }));
    expect(await within(region).findByText('Banned 1')).toBeInTheDocument();
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
    expect(realList).toBeDefined();
  });
});

describe('banned members section — pagination', () => {
  it('Load more appends the next page to the first instead of replacing it, and is gone on the last page', async () => {
    const server = installServer(bannedRows(45));
    renderPage();

    const region = await section();
    await within(region).findByText('Banned 1');
    expect(within(region).getAllByRole('button', { name: /^Unban / })).toHaveLength(20);

    fireEvent.click(loadMore());
    await within(region).findByText('Banned 21');
    expect(within(region).getAllByRole('button', { name: /^Unban / })).toHaveLength(40);
    expect(within(region).getByText('Banned 1')).toBeInTheDocument();

    fireEvent.click(loadMore());
    await within(region).findByText('Banned 45');
    expect(within(region).getAllByRole('button', { name: /^Unban / })).toHaveLength(45);
    await waitFor(() => expect(screen.queryByRole('button', { name: /^(Load more|Loading…)$/ })).not.toBeInTheDocument());
    expect(server.lists).toEqual([
      { limit: 20, page: 1 },
      { limit: 20, page: 2 },
      { limit: 20, page: 3 },
    ]);
  });

  it('a member that lands on two pages (offset paging shifts rows) is shown once', async () => {
    installServer([]);
    const first = bannedRows(20);
    // Page 2 repeats the last row of page 1, as it would if a ban landed at the top in between.
    const second = [banned(20), banned(21), banned(22)];
    mocked.listBannedMembers
      .mockResolvedValueOnce({ success: true, data: first, meta: pageMeta(1, 20, 22) })
      .mockResolvedValueOnce({ success: true, data: second, meta: pageMeta(2, 20, 23) });
    renderPage();

    const region = await section();
    await within(region).findByText('Banned 1');
    fireEvent.click(loadMore());
    await within(region).findByText('Banned 22');

    expect(within(region).getAllByText('Banned 20')).toHaveLength(1);
    expect(within(region).getAllByRole('button', { name: /^Unban / })).toHaveLength(22);
  });

  it('two same-tick Load more activations send ONE request; the control stays aria-disabled and mounted while it runs', async () => {
    installServer(bannedRows(30));
    const region = await (async () => {
      renderPage();
      return section();
    })();
    await within(region).findByText('Banned 1');
    const pending = deferred();
    mocked.listBannedMembers.mockReturnValueOnce(pending.promise);

    const control = loadMore();
    fireEvent.click(control);
    fireEvent.click(control);

    await waitFor(() => expect(control).toHaveAttribute('aria-busy', 'true'));
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(control).not.toBeDisabled();
    expect(mocked.listBannedMembers).toHaveBeenCalledTimes(2); // page 1 + exactly one page 2

    pending.resolve({ success: true, data: bannedRows(30).slice(20), meta: pageMeta(2, 20, 30) });
    await within(region).findByText('Banned 30');
  });

  it('announces what loaded, through a live region', async () => {
    installServer(bannedRows(23));
    renderPage();
    const region = await section();
    await within(region).findByText('Banned 1');

    fireEvent.click(loadMore());

    await waitFor(() => expect(within(region).getByRole('status', { name: '' })).toBeInTheDocument());
    await waitFor(() => expect(region).toHaveTextContent('Loaded 3 more banned members.'));
  });

  it('a failed next page is an alert (never a success), and Retry — the same control — loads it', async () => {
    installServer(bannedRows(30));
    renderPage();
    const region = await section();
    await within(region).findByText('Banned 1');
    mocked.listBannedMembers.mockRejectedValueOnce(new Error('boom'));

    fireEvent.click(loadMore());

    expect(await within(region).findByRole('alert')).toHaveTextContent("Couldn't load more banned members.");
    expect(region).toHaveTextContent('Failed to load more banned members.');
    expect(region).not.toHaveTextContent(/Loaded \d+ more/);
    // Every loaded row is still there.
    expect(within(region).getAllByRole('button', { name: /^Unban / })).toHaveLength(20);

    fireEvent.click(within(region).getByRole('button', { name: 'Retry loading more banned members' }));
    await within(region).findByText('Banned 30');
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps focus on Load more while it works, and moves it to the first NEW row when the last page removes the control', async () => {
    installServer(bannedRows(25));
    renderPage();
    const region = await section();
    await within(region).findByText('Banned 1');

    const control = loadMore();
    control.focus();
    fireEvent.click(control);

    await within(region).findByText('Banned 21');
    await waitFor(() => expect(screen.queryByRole('button', { name: /^(Load more|Loading…)$/ })).not.toBeInTheDocument());
    await waitFor(() => expect(unbanButton(21)).toHaveFocus());
  });
});

describe('unbanning — the confirmation', () => {
  beforeEach(() => {
    installServer(bannedRows(3));
  });

  it('asks first, naming the person and what unbanning does NOT do; nothing is sent yet', async () => {
    renderPage();
    await within(await section()).findByText('Banned 2');

    fireEvent.click(unbanButton(2));

    const group = await confirmation('Banned 2');
    expect(group).toHaveTextContent('Unban Banned 2?');
    expect(group).toHaveTextContent(
      'They will not automatically rejoin the group. They may request to join again or receive a new invitation.'
    );
    expect(within(group).getByRole('button', { name: 'Confirm unban' })).toBeInTheDocument();
    expect(mocked.unbanGroupMember).not.toHaveBeenCalled();
  });

  it('names the row that was activated, not the first', async () => {
    renderPage();
    await within(await section()).findByText('Banned 3');

    fireEvent.click(unbanButton(3));
    expect(await confirmation('Banned 3')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Unban Banned 1?' })).not.toBeInTheDocument();

    // Choosing another row while it is open switches the target.
    fireEvent.click(unbanButton(1));
    expect(await confirmation('Banned 1')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Unban Banned 3?' })).not.toBeInTheDocument();
  });

  it('falls back to the username for a member with no display name', async () => {
    mocked.listBannedMembers.mockResolvedValue({
      success: true,
      data: [{ id: 'bm-x', groupId: 'g-1', user: { id: 'u-x', username: 'plainuser', displayName: null, avatarUrl: null } }],
      meta: pageMeta(1, 20, 1),
    });
    renderPage();
    await within(await section()).findByText('plainuser');

    fireEvent.click(screen.getByRole('button', { name: 'Unban plainuser' }));
    expect(await confirmation('plainuser')).toBeInTheDocument();
  });

  it('moves focus into the confirmation when it opens', async () => {
    renderPage();
    await within(await section()).findByText('Banned 2');

    fireEvent.click(unbanButton(2));

    await confirmation('Banned 2');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm unban' })).toHaveFocus());
  });

  it('Cancel sends nothing, closes the confirmation, and puts focus back on the Unban button that opened it', async () => {
    renderPage();
    await within(await section()).findByText('Banned 2');
    const trigger = unbanButton(2);
    fireEvent.click(trigger);
    await confirmation('Banned 2');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('group', { name: /^Unban / })).not.toBeInTheDocument();
    expect(mocked.unbanGroupMember).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
    // All three are still listed.
    expect(screen.getAllByRole('button', { name: /^Unban / })).toHaveLength(3);
  });
});

describe('unbanning — the request', () => {
  it('Confirm sends exactly one request, for that group and that user', async () => {
    installServer(bannedRows(3));
    renderPage();
    await within(await section()).findByText('Banned 2');

    fireEvent.click(unbanButton(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));

    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    expect(mocked.unbanGroupMember).toHaveBeenCalledWith('g-1', 'u-b2');
  });

  describe('while it is pending', () => {
    async function openPending() {
      installServer(bannedRows(3));
      const request = deferred();
      mocked.unbanGroupMember.mockReturnValue(request.promise);
      renderPage();
      const region = await section();
      await within(region).findByText('Banned 2');
      const trigger = unbanButton(2);
      fireEvent.click(trigger);
      const confirm = await screen.findByRole('button', { name: 'Confirm unban' });
      fireEvent.click(confirm);
      await screen.findByRole('button', { name: 'Unbanning…' });
      return { request, region, trigger, confirm };
    }

    it('shows a reachable "Unbanning…" state that keeps focus, announces it, and stays mounted', async () => {
      const { request, region, confirm } = await openPending();

      expect(confirm).toHaveTextContent('Unbanning…');
      expect(confirm).toHaveAttribute('aria-busy', 'true');
      expect(confirm).toHaveFocus();
      expect(screen.getByRole('group', { name: 'Unban Banned 2?' })).toBeInTheDocument();
      expect(region).toHaveTextContent('Unbanning Banned 2…');

      request.resolve({ success: true, data: { message: 'Member unbanned' } });
      await waitFor(() => expect(screen.queryByRole('group', { name: /^Unban / })).not.toBeInTheDocument());
    });

    it('is aria-disabled, never natively disabled (so focus is not dropped), and clicks on it, Cancel and other rows do nothing', async () => {
      const { request, confirm } = await openPending();
      const cancel = screen.getByRole('button', { name: 'Cancel' });

      expect(confirm).toHaveAttribute('aria-disabled', 'true');
      expect(confirm).not.toBeDisabled();
      expect(cancel).toHaveAttribute('aria-disabled', 'true');
      expect(cancel).not.toBeDisabled();
      expect(unbanButton(1)).toHaveAttribute('aria-disabled', 'true');

      fireEvent.click(confirm);
      fireEvent.click(cancel);
      fireEvent.click(unbanButton(1));

      // Still the same confirmation for the same person, and still ONE request.
      expect(screen.getByRole('group', { name: 'Unban Banned 2?' })).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Unban Banned 1?' })).not.toBeInTheDocument();
      expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1);

      request.resolve({ success: true, data: { message: 'Member unbanned' } });
      await waitFor(() => expect(screen.queryByRole('group', { name: /^Unban / })).not.toBeInTheDocument());
    });
  });

  it('two same-tick activations of Confirm send ONE request', async () => {
    installServer(bannedRows(3));
    const request = deferred();
    mocked.unbanGroupMember.mockReturnValue(request.promise);
    renderPage();
    await within(await section()).findByText('Banned 2');
    fireEvent.click(unbanButton(2));
    const confirm = await screen.findByRole('button', { name: 'Confirm unban' });

    fireEvent.click(confirm);
    fireEvent.click(confirm);

    // (The mutation calls the API a microtask after `mutate`, hence the wait.)
    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    request.resolve({ success: true, data: { message: 'Member unbanned' } });
    await waitFor(() => expect(screen.queryByRole('group', { name: /^Unban / })).not.toBeInTheDocument());
    expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1);
  });

  it('a second unban works after the first one completes', async () => {
    installServer(bannedRows(3));
    renderPage();
    const region = await section();
    await within(region).findByText('Banned 2');

    fireEvent.click(unbanButton(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(screen.queryByText('Banned 2')).not.toBeInTheDocument());

    fireEvent.click(unbanButton(3));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(screen.queryByText('Banned 3')).not.toBeInTheDocument());

    expect(mocked.unbanGroupMember.mock.calls.map((c: unknown[]) => c[1])).toEqual(['u-b2', 'u-b3']);
    expect(within(region).getByText('Banned 1')).toBeInTheDocument();
  });
});

describe('unbanning — success', () => {
  it('removes ONLY that user, at once — before the refetch that follows has answered', async () => {
    const server = installServer(bannedRows(3));
    renderPage();
    const region = await section();
    await within(region).findByText('Banned 2');
    // Hold the refetch that the invalidation triggers, so what is on screen
    // is what the page itself did.
    const refetch = deferred();
    const answer = mocked.listBannedMembers.getMockImplementation()!;
    mocked.listBannedMembers.mockImplementationOnce(() => refetch.promise);

    fireEvent.click(unbanButton(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));

    await waitFor(() => expect(within(region).queryByText('Banned 2')).not.toBeInTheDocument());
    expect(within(region).getByText('Banned 1')).toBeInTheDocument();
    expect(within(region).getByText('Banned 3')).toBeInTheDocument();
    expect(mocked.listBannedMembers).toHaveBeenCalledTimes(2);

    refetch.resolve(await answer('g-1', { page: 1, limit: 20 }));
    await waitFor(() => expect(within(region).getAllByRole('button', { name: /^Unban / })).toHaveLength(2));
    expect(server.rows.map((r) => r.user.id)).toEqual(['u-b1', 'u-b3']);
  });

  it('removes only that user from EVERY loaded page', async () => {
    installServer(bannedRows(30));
    renderPage();
    const region = await section();
    await within(region).findByText('Banned 1');
    fireEvent.click(loadMore());
    await within(region).findByText('Banned 25');
    const refetch = deferred();
    mocked.listBannedMembers.mockImplementation(() => refetch.promise);

    fireEvent.click(unbanButton(25));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));

    await waitFor(() => expect(within(region).queryByText('Banned 25')).not.toBeInTheDocument());
    expect(within(region).getAllByRole('button', { name: /^Unban / })).toHaveLength(29);
    expect(within(region).getByText('Banned 24')).toBeInTheDocument();
    expect(within(region).getByText('Banned 26')).toBeInTheDocument();
    refetch.resolve({ success: true, data: [], meta: pageMeta(1, 20, 0) });
    await within(region).findByText('No banned members.');
  });

  it('tells the manager, and lands focus on the section heading — not on <body>', async () => {
    installServer(bannedRows(2));
    renderPage();
    const region = await section();
    await within(region).findByText('Banned 1');

    fireEvent.click(unbanButton(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Member unbanned',
        description: 'Banned 1 may request to join again or receive a new invitation.',
      })
    );
    await waitFor(() => expect(within(region).getByRole('heading', { name: 'Banned members' })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.queryByRole('group', { name: /^Unban / })).not.toBeInTheDocument();
  });

  it('refreshes the group, its members, its join requests and the banned list itself', async () => {
    installServer(bannedRows(2));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);
    await within(await section()).findByText('Banned 1');
    const listCallsBefore = mocked.listBannedMembers.mock.calls.length;
    const groupCallsBefore = mocked.getGroup.mock.calls.length;
    const membersCallsBefore = mocked.getGroupMembers.mock.calls.length;
    const requestsCallsBefore = mocked.listJoinRequests.mock.calls.length;

    fireEvent.click(unbanButton(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));

    await waitFor(() => expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(1));
    for (const queryKey of [
      ['group-banned-members', 'g-1'],
      ['group', 'g-1'],
      ['group-members', 'g-1'],
      ['group-requests', 'g-1'],
    ]) {
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey }));
    }
    // ...and each active one actually went back to the server.
    await waitFor(() => expect(mocked.listBannedMembers.mock.calls.length).toBeGreaterThan(listCallsBefore));
    await waitFor(() => expect(mocked.getGroup.mock.calls.length).toBeGreaterThan(groupCallsBefore));
    await waitFor(() => expect(mocked.getGroupMembers.mock.calls.length).toBeGreaterThan(membersCallsBefore));
    await waitFor(() => expect(mocked.listJoinRequests.mock.calls.length).toBeGreaterThan(requestsCallsBefore));
  });
});

describe('unbanning — failure', () => {
  it('keeps the row, says why through the toast, and puts focus back on the Unban button that is still there', async () => {
    installServer(bannedRows(3));
    // The server did NOT change anything: the refetch still lists everyone.
    mocked.unbanGroupMember.mockRejectedValue(new Error(JSON.stringify({ status: 403, message: 'Insufficient permissions' })));
    renderPage();
    const region = await section();
    await within(region).findByText('Banned 2');
    const trigger = unbanButton(2);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Error',
        description: 'Insufficient permissions',
        variant: 'destructive',
      })
    );
    await waitFor(() => expect(screen.queryByRole('group', { name: /^Unban / })).not.toBeInTheDocument());
    // Nobody left the list.
    expect(within(region).getAllByRole('button', { name: /^Unban / })).toHaveLength(3);
    expect(within(region).getByText('Banned 2')).toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Member unbanned' }));
  });

  it('falls back to a generic message when the error carries none', async () => {
    installServer(bannedRows(1));
    mocked.unbanGroupMember.mockRejectedValue(new Error('network down'));
    renderPage();
    await within(await section()).findByText('Banned 1');

    fireEvent.click(unbanButton(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Error',
        description: 'Failed to unban Banned 1',
        variant: 'destructive',
      })
    );
  });

  it('a stale row (someone else already unbanned it): the refusal refreshes the list, and focus lands on the heading, not <body>', async () => {
    const server = installServer(bannedRows(3));
    mocked.unbanGroupMember.mockImplementation(async (_g: string, userId: string) => {
      // Another manager got there first.
      server.rows = server.rows.filter((r) => r.user.id !== userId);
      throw new Error(JSON.stringify({ status: 409, message: 'This member is not banned' }));
    });
    renderPage();
    const region = await section();
    await within(region).findByText('Banned 2');
    fireEvent.click(unbanButton(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({ title: 'Error', description: 'This member is not banned', variant: 'destructive' })
    );
    await waitFor(() => expect(within(region).queryByText('Banned 2')).not.toBeInTheDocument());
    await waitFor(() => expect(within(region).getByRole('heading', { name: 'Banned members' })).toHaveFocus());
    expect(within(region).getAllByRole('button', { name: /^Unban / })).toHaveLength(2);
  });

  it('after a failure the same member can be tried again', async () => {
    installServer(bannedRows(2));
    mocked.unbanGroupMember.mockRejectedValueOnce(new Error(JSON.stringify({ status: 500, message: 'Try later' })));
    renderPage();
    const region = await section();
    await within(region).findByText('Banned 1');

    fireEvent.click(unbanButton(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: /^Unban / })).not.toBeInTheDocument());

    fireEvent.click(unbanButton(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm unban' }));

    await waitFor(() => expect(within(region).queryByText('Banned 1')).not.toBeInTheDocument());
    expect(mocked.unbanGroupMember).toHaveBeenCalledTimes(2);
  });
});

describe('the rest of the page is unchanged', () => {
  const members = [
    { id: 'm1', groupId: 'g-1', user: { id: 'u-owner', username: 'owner', displayName: 'Owner' }, role: 'OWNER', status: 'ACTIVE', joinedAt: '' },
    { id: 'm2', groupId: 'g-1', user: { id: 'u-mem', username: 'member', displayName: 'Member' }, role: 'MEMBER', status: 'ACTIVE', joinedAt: '' },
  ];

  it('the members list still offers Remove, Ban and Transfer, and its Ban still confirms and bans', async () => {
    installServer(bannedRows(1));
    mocked.getGroupMembers.mockResolvedValue({ data: members });
    mocked.banGroupMember.mockResolvedValue({ data: { message: 'Member banned' } });
    renderPage();

    await screen.findByText('Member');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }));
    await waitFor(() => expect(mocked.banGroupMember).toHaveBeenCalledWith('g-1', 'u-mem'));
    // The Unban confirmation is a separate thing and was never opened.
    expect(screen.queryByRole('group', { name: /^Unban / })).not.toBeInTheDocument();
  });

  it('a successful ban refreshes the banned list, so the new ban shows up in it', async () => {
    const server = installServer(bannedRows(1));
    mocked.getGroupMembers.mockResolvedValue({ data: members });
    mocked.banGroupMember.mockImplementation(async () => {
      server.rows = [...server.rows, banned(2)];
      return { data: { message: 'Member banned' } };
    });
    renderPage();
    const region = await section();
    await within(region).findByText('Banned 1');

    fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }));

    expect(await within(region).findByText('Banned 2')).toBeInTheDocument();
  });

  it('pending join requests and the invite form are still there for the manager', async () => {
    installServer(bannedRows(1));
    mocked.listJoinRequests.mockResolvedValue({
      data: [{ id: 'r1', groupId: 'g-1', user: { id: 'u-req', username: 'requester', displayName: 'Requester' }, role: 'MEMBER', status: 'PENDING', joinedAt: '' }],
    });
    renderPage();

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('user@example.com')).toBeInTheDocument();
    expect(await section()).toBeInTheDocument();
  });
});
