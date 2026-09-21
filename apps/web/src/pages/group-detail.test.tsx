import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { GroupDetailPage } from './group-detail';

// Controllable authenticated identity for the self-management suppression
// tests. Set `.current` per test; a null value simulates an unresolved
// identity so the fail-closed branch can be exercised.
const authState = vi.hoisted(() => ({
  current: { id: 'u-viewer', username: 'viewer', displayName: 'Viewer' } as {
    id: string;
    username: string;
    displayName: string;
  } | null,
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
    joinGroup: vi.fn(),
    requestJoinGroup: vi.fn(),
    acceptGroupInvite: vi.fn(),
    leaveGroup: vi.fn(),
    approveJoinRequest: vi.fn(),
    rejectJoinRequest: vi.fn(),
    removeGroupMember: vi.fn(),
    changeMemberRole: vi.fn(),
    createGroupInvite: vi.fn(),
    revokeGroupInvite: vi.fn(),
    transferOwnership: vi.fn(),
    banGroupMember: vi.fn(),
    listBannedMembers: vi.fn(),
    unbanGroupMember: vi.fn(),
  },
}));

// A single shared reference (not a fresh vi.fn() per useToast() call) so
// tests can assert on what was actually shown to the user — required to
// verify errors are surfaced accessibly, not just silently swallowed.
const toastMock = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: (...args: unknown[]) => toastMock(...args) }),
}));

import { api } from '@/lib/api';

const mocked = api as unknown as {
  getGroup: ReturnType<typeof vi.fn>;
  getGroupMembers: ReturnType<typeof vi.fn>;
  listGroupInvites: ReturnType<typeof vi.fn>;
  listJoinRequests: ReturnType<typeof vi.fn>;
  joinGroup: ReturnType<typeof vi.fn>;
  requestJoinGroup: ReturnType<typeof vi.fn>;
  acceptGroupInvite: ReturnType<typeof vi.fn>;
  leaveGroup: ReturnType<typeof vi.fn>;
  approveJoinRequest: ReturnType<typeof vi.fn>;
  rejectJoinRequest: ReturnType<typeof vi.fn>;
  removeGroupMember: ReturnType<typeof vi.fn>;
  changeMemberRole: ReturnType<typeof vi.fn>;
  createGroupInvite: ReturnType<typeof vi.fn>;
  revokeGroupInvite: ReturnType<typeof vi.fn>;
  transferOwnership: ReturnType<typeof vi.fn>;
  banGroupMember: ReturnType<typeof vi.fn>;
  listBannedMembers: ReturnType<typeof vi.fn>;
  unbanGroupMember: ReturnType<typeof vi.fn>;
};

const baseGroup = {
  id: 'g-1',
  name: 'Test Group',
  description: 'A test group',
  isPrivate: false,
  status: 'ACTIVE',
  memberCount: 3,
  isMember: true,
  memberRole: 'MEMBER',
  viewerMembershipStatus: 'ACTIVE',
  owner: { id: 'u-owner', username: 'owner', displayName: 'Owner' },
};

function renderPage(
  groupId = 'g-1',
  client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/groups/${groupId}`]}>
        <Routes>
          <Route path="/groups/:id" element={<GroupDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  authState.current = { id: 'u-viewer', username: 'viewer', displayName: 'Viewer' };
  mocked.getGroup.mockResolvedValue({ data: baseGroup });
  mocked.getGroupMembers.mockResolvedValue({ data: [] });
  mocked.listGroupInvites.mockResolvedValue({
    success: true,
    data: [],
    meta: { total: 0, page: 1, limit: 50, totalPages: 0, hasNextPage: false, hasPrevPage: false },
  });
  mocked.listJoinRequests.mockResolvedValue({ data: [] });
  // A manager's page also loads the banned list; nothing here is about it.
  mocked.listBannedMembers.mockResolvedValue({
    success: true,
    data: [],
    meta: { total: 0, page: 1, limit: 20, totalPages: 0, hasNextPage: false, hasPrevPage: false },
  });
});

describe('GroupDetailPage', () => {
  describe('loading state', () => {
    it('shows a spinner while loading', () => {
      mocked.getGroup.mockReturnValue(new Promise(() => {}));
      renderPage();
      expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows an error card on fetch failure', async () => {
      mocked.getGroup.mockRejectedValue(new Error('fail'));
      renderPage();
      expect(await screen.findByText(/Failed to load group details/)).toBeInTheDocument();
    });
  });

  describe('non-member view', () => {
    it('shows join button for public group', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, isMember: false, memberRole: null } });
      renderPage();
      expect(await screen.findByText('Test Group')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
    });

    it('shows request-to-join button for private group', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, isPrivate: true, isMember: false, memberRole: null } });
      renderPage();
      expect(await screen.findByText('Request to join')).toBeInTheDocument();
    });

    it('shows request pending when requestStatus is PENDING', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, isPrivate: true, isMember: false, memberRole: null, requestStatus: 'PENDING' } });
      renderPage();
      expect(await screen.findByText('Request pending')).toBeInTheDocument();
    });

    it('renders the persistent banned message and no Request to join when viewerMembershipStatus is BANNED', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, isPrivate: true, isMember: false, memberRole: null, viewerMembershipStatus: 'BANNED', requestStatus: null } });
      renderPage();
      expect(await screen.findByText('You have been banned from this group.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Request to join' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
    });

    it('does not call the join-request API for a banned caller', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, isPrivate: true, isMember: false, memberRole: null, viewerMembershipStatus: 'BANNED', requestStatus: null } });
      renderPage();
      await screen.findByText('You have been banned from this group.');
      expect(mocked.requestJoinGroup).not.toHaveBeenCalled();
      expect(mocked.joinGroup).not.toHaveBeenCalled();
    });

    it('shows Request to join for an eligible non-member with viewerMembershipStatus null', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, isPrivate: true, isMember: false, memberRole: null, viewerMembershipStatus: null, requestStatus: null } });
      renderPage();
      const card = await screen.findByText('Test Group');
      const joinButton = card.closest('.border')!.querySelector('button');
      expect(screen.getByRole('button', { name: 'Request to join' })).toBeInTheDocument();
      expect(joinButton?.textContent).toContain('Request to join');
      expect(screen.queryByText('You have been banned from this group.')).not.toBeInTheDocument();
    });

    it('PENDING renders the existing pending state and not the banned message', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, isPrivate: true, isMember: false, memberRole: null, viewerMembershipStatus: 'PENDING', requestStatus: 'PENDING' } });
      renderPage();
      expect(await screen.findByText('Request pending')).toBeInTheDocument();
      expect(screen.queryByText('You have been banned from this group.')).not.toBeInTheDocument();
    });

    it('exposes the banned message through an accessible status role without CSS reliance', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, isMember: false, memberRole: null, viewerMembershipStatus: 'BANNED', requestStatus: null } });
      renderPage();
      const status = await screen.findByRole('status');
      expect(status).toBeInTheDocument();
      expect(status.textContent).toBe('You have been banned from this group.');
    });
  });

  describe('member view', () => {
    it('shows group details and member role', async () => {
      renderPage();
      expect(await screen.findByText('Test Group')).toBeInTheDocument();
      expect(screen.getByText('A test group')).toBeInTheDocument();
      expect(screen.getByText('MEMBER')).toBeInTheDocument();
    });

    it('shows Leave button', async () => {
      renderPage();
      await screen.findByText('Test Group');
      expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
    });

    it('loads and displays members', async () => {
      mocked.getGroupMembers.mockResolvedValue({
        data: [
          { id: 'm1', groupId: 'g-1', user: { id: 'u1', username: 'alice', displayName: 'Alice' }, role: 'OWNER', status: 'ACTIVE', joinedAt: '' },
          { id: 'm2', groupId: 'g-1', user: { id: 'u2', username: 'bob', displayName: 'Bob' }, role: 'MEMBER', status: 'ACTIVE', joinedAt: '' },
        ],
      });
      renderPage();
      await screen.findByText('Alice');
      expect(screen.getByText('Bob')).toBeInTheDocument();
      expect(screen.getByText('Members (2)')).toBeInTheDocument();
    });
  });

  describe('manager view (OWNER)', () => {
    beforeEach(() => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
    });

    it('does not show role/change controls for the owner themselves', async () => {
      mocked.getGroupMembers.mockResolvedValue({
        data: [
          { id: 'm1', groupId: 'g-1', user: { id: 'u-owner', username: 'owner', displayName: 'Owner' }, role: 'OWNER', status: 'ACTIVE', joinedAt: '' },
          { id: 'm2', groupId: 'g-1', user: { id: 'u2', username: 'bob', displayName: 'Bob' }, role: 'MEMBER', status: 'ACTIVE', joinedAt: '' },
        ],
      });
      renderPage();
      await screen.findByText('Owner');
      // Owner's row has no role select, Remove, or Transfer controls; the non-owner
      // row (Bob) does. Find each member's row container and assert inside it only.
      const findRow = (name: string) =>
        screen.getByText(name).closest('.border')!.closest('.border') as HTMLElement;
      const ownerRow = findRow('Owner');
      const bobRow = findRow('Bob');
      expect(ownerRow.querySelector('select')).toBeNull();
      expect(ownerRow.querySelector('button')).toBeNull();
      expect(bobRow.querySelector('select')).not.toBeNull();
      expect(bobRow.querySelectorAll('button').length).toBeGreaterThan(0);
    });

    it('shows pending requests when they exist', async () => {
      mocked.getGroupMembers.mockResolvedValue({
        data: [
          { id: 'm1', groupId: 'g-1', user: { id: 'u-owner', username: 'owner', displayName: 'Owner' }, role: 'OWNER', status: 'ACTIVE', joinedAt: '' },
        ],
      });
      mocked.listJoinRequests.mockResolvedValue({
        data: [
          { id: 'm2', groupId: 'g-1', user: { id: 'u-pending', username: 'pending', displayName: 'Pending User' }, role: 'MEMBER', status: 'PENDING', joinedAt: '' },
        ],
      });
      renderPage();
      await screen.findByText('Pending requests (1)');
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    });
  });

  describe('invite form (private group, manager)', () => {
    beforeEach(() => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, isPrivate: true, memberRole: 'OWNER' } });
      mocked.listGroupInvites.mockResolvedValue({
        success: true,
        data: [{ id: 'inv-1', email: 'alice@test.com', role: 'MEMBER', status: 'PENDING', token: 'tok-alice', expiresAt: '', invitedBy: '', createdAt: '' }],
        meta: { total: 1, page: 1, limit: 50, totalPages: 1, hasNextPage: false, hasPrevPage: false },
      });
    });

    it('renders the invite email form and active invite list', async () => {
      renderPage();
      expect(await screen.findByText('Invite by email')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
      expect(screen.getByPlaceholderText('user@example.com')).toBeInTheDocument();
      expect(await screen.findByText('Active invites (1)')).toBeInTheDocument();
      expect(screen.getByText('alice@test.com')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    });

    it('sends an invite when form is submitted', async () => {
      mocked.createGroupInvite.mockResolvedValue({ data: { id: 'inv-2' } });
      renderPage();
      await screen.findByPlaceholderText('user@example.com');
      fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'new@test.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
      await waitFor(() => expect(mocked.createGroupInvite).toHaveBeenCalledWith('g-1', 'new@test.com', 'MEMBER'));
    });

    it('copies the invite link after creation', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      const clipboardSpy = vi.spyOn(navigator.clipboard, 'writeText');
      mocked.createGroupInvite.mockResolvedValue({ data: { id: 'inv-2', token: 'tok-abc' } });
      renderPage();
      await screen.findByPlaceholderText('user@example.com');
      fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'new@test.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
      await waitFor(() => expect(mocked.createGroupInvite).toHaveBeenCalledWith('g-1', 'new@test.com', 'MEMBER'));
      expect(clipboardSpy).toHaveBeenCalledWith(expect.stringContaining('/groups/invite/tok-abc'));
      clipboardSpy.mockRestore();
    });
  });

  describe('pending invite pagination', () => {
    const inv = (n: number) => ({
      id: `inv-${n}`,
      email: `invite-${n}@test.com`,
      role: 'MEMBER' as const,
      status: 'PENDING' as const,
      token: `tok-${n}`,
      expiresAt: '',
      invitedBy: '',
      createdAt: '',
    });
    // The page size the component actually requests.
    const PAGE = 50;

    beforeEach(() => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, isPrivate: true, memberRole: 'OWNER' } });
    });

    // Pages of `count` invites starting at `start`, following the backend's
    // real response contract so `fetchNextPage` only advances while the
    // server claims another page exists.
    const pageOf = (start: number, count: number, total: number, page: number) => ({
      success: true,
      data: Array.from({ length: count }, (_, i) => inv(start + i)),
      meta: { total, page, limit: PAGE, totalPages: Math.ceil(total / PAGE), hasNextPage: start + count - 1 < total, hasPrevPage: page > 1 },
    });

    const mockPages = (total: number) => {
      mocked.listGroupInvites.mockImplementation((_g, params) => {
        const page = params?.page ?? 1;
        const start = (page - 1) * PAGE + 1;
        const remaining = total - (start - 1);
        const count = Math.min(PAGE, Math.max(0, remaining));
        return Promise.resolve(pageOf(start, count, total, page));
      });
    };

    it('makes every pending invite — including the 101st — reachable across pages', async () => {
      mockPages(120);
      renderPage();
      expect(await screen.findByRole('button', { name: 'Load more' })).toBeInTheDocument();
      expect(screen.getByText('invite-1@test.com')).toBeInTheDocument();
      expect(screen.queryByText('invite-150@test.com')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByText('invite-51@test.com')).toBeInTheDocument();
      // invite-101 is on page 3 (row 101): page1 [1..50], page2 [51..100].
      expect(screen.queryByText('invite-101@test.com')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByText('invite-101@test.com')).toBeInTheDocument();
      // Past the last page the control disappears.
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    it('appends the second page instead of replacing page 1', async () => {
      mockPages(120);
      renderPage();
      await screen.findByText('invite-1@test.com');
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await screen.findByText('invite-51@test.com');
      expect(screen.getByText('invite-1@test.com')).toBeInTheDocument();
      expect(screen.getByText('Active invites (100)')).toBeInTheDocument();
      expect(mocked.listGroupInvites).toHaveBeenCalledWith('g-1', expect.objectContaining({ page: 1 }));
      expect(mocked.listGroupInvites).toHaveBeenCalledWith('g-1', expect.objectContaining({ page: 2 }));
    });

    it('copies an invite loaded from a later page', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      const clipboardSpy = vi.spyOn(navigator.clipboard, 'writeText');
      mockPages(120);
      renderPage();
      await screen.findByText('invite-1@test.com');
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await screen.findByText('invite-51@test.com');
      fireEvent.click(screen.getByRole('button', { name: `Copy link for invite-51@test.com` }));
      await waitFor(() => expect(clipboardSpy).toHaveBeenCalledWith(expect.stringContaining('/groups/invite/tok-51')));
      clipboardSpy.mockRestore();
    });

    it('revokes an invite loaded from a later page', async () => {
      mocked.revokeGroupInvite.mockResolvedValue({ success: true, data: { message: 'revoked' } });
      mockPages(120);
      renderPage();
      await screen.findByText('invite-1@test.com');
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await screen.findByText('invite-51@test.com');
      const row = screen.getByText('invite-51@test.com').closest('div[class*="rounded-md"]') as HTMLElement;
      fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
      await waitFor(() => expect(mocked.revokeGroupInvite).toHaveBeenCalledWith('g-1', 'inv-51'));
    });

    it('renders a duplicate invite id only once', async () => {
      // invite-50 appears at the tail of page 1 and the head of page 2 —
      // mirroring an invite created between two offset page fetches. The
      // deduped total is 70 (50 on page 1 + 20 new on page 2).
      mocked.listGroupInvites.mockImplementation((_g, params) => {
        const page = params?.page ?? 1;
        if (page === 1) return Promise.resolve(pageOf(1, 50, 70, 1));
        return Promise.resolve({
          success: true,
          data: [inv(50), ...Array.from({ length: 20 }, (_, i) => inv(51 + i))],
          meta: { total: 70, page: 2, limit: PAGE, totalPages: 2, hasNextPage: false, hasPrevPage: true },
        });
      });
      renderPage();
      await screen.findByText('invite-1@test.com');
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await screen.findByText('invite-51@test.com');
      // Raw page sums would give 71; dedup must report 70 and show the
      // duplicate email exactly once.
      expect(screen.getAllByText('invite-50@test.com')).toHaveLength(1);
      expect(screen.getByText('Active invites (70)')).toBeInTheDocument();
    });

    it('sends exactly one next-page request on rapid Load-more activation', async () => {
      let resolvePageTwo: (v: unknown) => void;
      const gate = new Promise((r) => { resolvePageTwo = r as (v: unknown) => void; });
      const seenPages: number[] = [];
      mocked.listGroupInvites.mockImplementation((_g, params) => {
        const page = params?.page ?? 1;
        if (page === 2) {
          seenPages.push(2);
          return gate.then(() => pageOf(51, 50, 120, 2));
        }
        if (page === 3) return Promise.resolve(pageOf(101, 20, 120, 3));
        return Promise.resolve(pageOf(1, 50, 120, 1));
      });
      renderPage();
      await screen.findByText('invite-1@test.com');
      const loadMore = screen.getByRole('button', { name: 'Load more' });
      // Two activations land in the same tick, before any request resolves.
      fireEvent.click(loadMore);
      fireEvent.click(loadMore);
      await waitFor(() => expect(seenPages).toContain(2));
      // Only one request reached the server for page 2 despite two clicks.
      expect(seenPages.filter((p) => p === 2)).toHaveLength(1);
      await act(async () => { resolvePageTwo(null); });
      await screen.findByText('invite-51@test.com');
    });

    it('keeps focus on the paging control, and moves it to the first newly appended invite when the last page removes the control', async () => {
      mockPages(120);
      renderPage();
      const loadMore = await screen.findByRole('button', { name: 'Load more' });
      loadMore.focus();
      expect(document.activeElement).toBe(loadMore);

      fireEvent.click(loadMore);
      await screen.findByText('invite-51@test.com');
      // Page 2 of 3: the control is still mounted, so focus stays on it.
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Load more' }));

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await screen.findByText('invite-101@test.com');
      // Final page: the control unmounts, so focus must not drop to <body> — it
      // goes to the first invite the user has not seen yet that they can act on.
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy link for invite-101@test.com' }))
      );
    });

    it('keeps every loaded page and newly created links when a refresh fails', async () => {
      // The mock server learns about the newly created invite exactly as the
      // real backend would, so the mutation's own invalidation refetch finds
      // it on page 1 instead of dropping the optimistic row.
      let created: ReturnType<typeof inv> | null = null;
      const firstPage = () => created ? [created, ...Array.from({ length: 50 }, (_, i) => inv(i + 1))] : Array.from({ length: 50 }, (_, i) => inv(i + 1));
      mocked.listGroupInvites.mockImplementation((_g, params) => {
        const page = params?.page ?? 1;
        if (page === 1) return Promise.resolve({ success: true, data: firstPage(), meta: { total: created ? 121 : 120, page: 1, limit: PAGE, totalPages: 3, hasNextPage: true, hasPrevPage: false } });
        if (page === 2) return Promise.resolve(pageOf(51, 50, created ? 121 : 120, 2));
        return Promise.resolve(pageOf(101, 20, created ? 121 : 120, 3));
      });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      renderPage('g-1', client);
      await screen.findByText('invite-1@test.com');
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await screen.findByText('invite-51@test.com');
      expect(screen.getByText('invite-100@test.com')).toBeInTheDocument();

      // A newly created invite lands in the list optimistically, then the
      // mutation's invalidation refetch reconciles it from the server.
      mocked.createGroupInvite.mockResolvedValue({
        success: true,
        data: { ...inv(999), groupId: 'g-1' },
      });
      created = inv(999);
      fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'fresh@test.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
      await waitFor(() => expect(screen.getByText('invite-999@test.com')).toBeInTheDocument());

      // Now every refetch (page 1, 2, 3) fails.
      mocked.listGroupInvites.mockRejectedValue(new Error('network down'));
      client.invalidateQueries({ queryKey: ['group-invites', 'g-1'] });
      await screen.findByText(/Couldn't refresh invites\./);
      // Every previously loaded page is still rendered, and so is the new invite
      // with its durable recoverable link.
      expect(screen.getByText('invite-1@test.com')).toBeInTheDocument();
      expect(screen.getByText('invite-51@test.com')).toBeInTheDocument();
      expect(screen.getByText('invite-100@test.com')).toBeInTheDocument();
      expect(screen.getByText('invite-999@test.com')).toBeInTheDocument();
      expect((screen.getByLabelText('Invitation link for invite-999@test.com') as HTMLInputElement).value)
        .toContain('/groups/invite/tok-999');
    });

    // ─── failure, single flight, state ───────────────────────────────────────

    const rowOf = (email: string) => screen.getByText(email).closest('div[data-invite-id]') as HTMLElement;
    const pageFor = (page: number, total: number) => {
      const start = (page - 1) * PAGE + 1;
      return pageOf(start, Math.min(PAGE, Math.max(0, total - (start - 1))), total, page);
    };

    it('a failed next page keeps every loaded invite, is announced as a FAILURE (never as success), and Retry — the same control — loads it', async () => {
      let failPage2 = true;
      mocked.listGroupInvites.mockImplementation((_g, params) => {
        const page = params?.page ?? 1;
        if (page === 2 && failPage2) return Promise.reject(new Error('boom'));
        return Promise.resolve(pageFor(page, 120));
      });
      renderPage();
      const control = await screen.findByRole('button', { name: 'Load more' });
      control.focus();
      fireEvent.click(control);

      expect(await screen.findByText("Couldn't load more invites.")).toBeInTheDocument();
      expect(screen.getByText('invite-1@test.com')).toBeInTheDocument(); // loaded content is kept
      expect(screen.getByText(/Failed to load more invites\./)).toBeInTheDocument();
      // The announcement does not claim success while the alert reports failure.
      expect(screen.queryByText(/More invites loaded|Loaded \d+ more/)).not.toBeInTheDocument();
      // The same element, now labelled Retry, and still focused.
      const retry = screen.getByRole('button', { name: 'Retry loading more invites' });
      expect(retry).toBe(control);
      expect(retry).toHaveFocus();

      failPage2 = false;
      fireEvent.click(retry);
      expect(await screen.findByText('invite-51@test.com')).toBeInTheDocument();
      expect(screen.getByText(/Loaded 50 more invites\./)).toBeInTheDocument();
      expect(screen.queryByText("Couldn't load more invites.")).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Load more' })).toBe(control);
      expect(control).toHaveFocus();
    });

    it('two same-tick activations of the failed-page Retry send ONE request', async () => {
      let failPage2 = true;
      const seen: number[] = [];
      mocked.listGroupInvites.mockImplementation((_g, params) => {
        const page = params?.page ?? 1;
        if (page === 2) {
          seen.push(2);
          if (failPage2) return Promise.reject(new Error('boom'));
        }
        return Promise.resolve(pageFor(page, 120));
      });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
      const retry = await screen.findByRole('button', { name: 'Retry loading more invites' });
      expect(seen).toHaveLength(1);

      failPage2 = false;
      act(() => {
        retry.click();
        retry.click();
      });
      await screen.findByText('invite-51@test.com');
      expect(seen).toHaveLength(2); // the failure + ONE retry
    });

    it('while a page is pending the control is aria-disabled — never native disabled — and keeps focus', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      mocked.listGroupInvites.mockImplementation((_g, params) => {
        const page = params?.page ?? 1;
        return page === 2 ? gate.then(() => pageFor(2, 120)) : Promise.resolve(pageFor(page, 120));
      });
      renderPage();
      const control = await screen.findByRole('button', { name: 'Load more' });
      control.focus();
      fireEvent.click(control);

      await waitFor(() => expect(control).toHaveAttribute('aria-disabled', 'true'));
      expect(control).not.toBeDisabled();
      expect(control).toHaveFocus();
      expect(control).toHaveTextContent('Loading…');
      expect(screen.getByText(/Loading more invites…/)).toBeInTheDocument();

      await act(async () => release());
      await screen.findByText('invite-51@test.com');
      expect(control).not.toHaveAttribute('aria-disabled');
      expect(control).toHaveFocus();
    });

    it('Load more is unavailable during a background refresh — the click sends nothing — and works once it settles', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      let holdRefresh = false;
      let releaseRefresh!: () => void;
      const gate = new Promise<void>((resolve) => (releaseRefresh = resolve));
      mocked.listGroupInvites.mockImplementation((_g, params) => {
        const page = params?.page ?? 1;
        if (holdRefresh && page === 1) return gate.then(() => pageFor(1, 120));
        return Promise.resolve(pageFor(page, 120));
      });
      renderPage('g-1', client);
      const control = await screen.findByRole('button', { name: 'Load more' });

      holdRefresh = true;
      act(() => {
        void client.invalidateQueries({ queryKey: ['group-invites', 'g-1'] });
      });
      await waitFor(() => expect(control).toHaveAttribute('aria-disabled', 'true'));
      const before = mocked.listGroupInvites.mock.calls.length;
      fireEvent.click(control);
      expect(mocked.listGroupInvites.mock.calls.length).toBe(before);
      expect(screen.getByText('invite-50@test.com')).toBeInTheDocument(); // loaded rows stay throughout

      holdRefresh = false;
      await act(async () => releaseRefresh());
      await waitFor(() => expect(control).not.toHaveAttribute('aria-disabled'));
      fireEvent.click(control);
      expect(await screen.findByText('invite-51@test.com')).toBeInTheDocument();
    });

    it('a page response that is STALE by the time it arrives does not overwrite newer state (a create lands while page 2 is in flight)', async () => {
      let created: ReturnType<typeof inv> | null = null;
      let releasePage2!: () => void;
      const gate = new Promise<void>((resolve) => (releasePage2 = resolve));
      mocked.listGroupInvites.mockImplementation((_g, params) => {
        const page = params?.page ?? 1;
        if (page === 2) return gate.then(() => pageFor(2, 120)); // the answer that will be stale
        const rows = created
          ? [created, ...Array.from({ length: 49 }, (_, i) => inv(i + 1))]
          : Array.from({ length: 50 }, (_, i) => inv(i + 1));
        return Promise.resolve({
          success: true,
          data: rows,
          meta: { total: created ? 121 : 120, page: 1, limit: PAGE, totalPages: 3, hasNextPage: true, hasPrevPage: false },
        });
      });
      renderPage();
      await screen.findByText('invite-1@test.com');
      fireEvent.click(screen.getByRole('button', { name: 'Load more' })); // page 2 is now in flight
      await waitFor(() => expect(mocked.listGroupInvites).toHaveBeenCalledWith('g-1', expect.objectContaining({ page: 2 })));

      mocked.createGroupInvite.mockResolvedValue({ success: true, data: { ...inv(999), groupId: 'g-1' } });
      created = inv(999);
      fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'fresh@test.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
      await screen.findByText('invite-999@test.com');

      // The old page-2 answer finally arrives — from a list that predates the new invite.
      await act(async () => {
        releasePage2();
        await new Promise((r) => setTimeout(r, 40));
      });

      expect(screen.getByText('invite-999@test.com')).toBeInTheDocument(); // not overwritten
      expect(screen.queryByText('invite-51@test.com')).not.toBeInTheDocument(); // stale rows not applied
      expect(screen.queryByText(/Loaded \d+ more|More invites loaded/)).not.toBeInTheDocument(); // nothing claims success
      // The list is coherent and can still be paged.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).not.toHaveAttribute('aria-disabled'));
    });

    it('a created invite is shown even when NOTHING was cached because the first load failed — and stays when the refetch fails too', async () => {
      mocked.listGroupInvites.mockRejectedValue(new Error('down'));
      renderPage();
      expect(await screen.findByText("Couldn't load invites.")).toBeInTheDocument();

      mocked.createGroupInvite.mockResolvedValue({ success: true, data: { ...inv(7), groupId: 'g-1' } });
      fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'fresh@test.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Invite' }));

      expect(await screen.findByText('invite-7@test.com')).toBeInTheDocument();
      expect((screen.getByLabelText('Invitation link for invite-7@test.com') as HTMLInputElement).value).toContain('/groups/invite/tok-7');
      // Every refetch is still failing; the new link stays put.
      await screen.findByText(/Couldn't refresh invites\./);
      expect(screen.getByText('invite-7@test.com')).toBeInTheDocument();
    });

    it('a failed FIRST load is an alert with a Retry that stays mounted and focused while it runs, then lands focus on the first invite', async () => {
      mocked.listGroupInvites.mockRejectedValue(new Error('down'));
      renderPage();
      expect(await screen.findByText("Couldn't load invites.")).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load invites.");

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      mocked.listGroupInvites.mockImplementation(() => gate.then(() => pageFor(1, 3)));
      const retry = screen.getByRole('button', { name: 'Retry loading invites' });
      retry.focus();
      fireEvent.click(retry);

      await waitFor(() => expect(retry).toHaveAttribute('aria-disabled', 'true'));
      expect(retry).toBeInTheDocument();
      expect(retry).toHaveFocus();
      expect(retry).not.toBeDisabled();
      expect(retry).toHaveTextContent('Retrying…');

      await act(async () => release());
      await screen.findByText('invite-1@test.com');
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy link for invite-1@test.com' }))
      );
      expect(screen.queryByText("Couldn't load invites.")).not.toBeInTheDocument();
    });

    it('a failed refresh keeps every loaded invite and its Retry mounted and focused while retrying; success dismisses the banner and lands focus on the list', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      mocked.listGroupInvites.mockResolvedValue(pageFor(1, 3));
      renderPage('g-1', client);
      await screen.findByText('invite-3@test.com');

      mocked.listGroupInvites.mockRejectedValue(new Error('down'));
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['group-invites', 'g-1'] });
      });
      const retry = await screen.findByRole('button', { name: 'Retry refreshing invites' });
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't refresh invites.");
      expect(screen.getByText('invite-2@test.com')).toBeInTheDocument();

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      mocked.listGroupInvites.mockImplementation(() => gate.then(() => pageFor(1, 3)));
      retry.focus();
      fireEvent.click(retry);
      await waitFor(() => expect(retry).toHaveAttribute('aria-disabled', 'true'));
      expect(retry).toBeInTheDocument();
      expect(retry).toHaveFocus();
      expect(retry).toHaveTextContent('Retrying…');
      expect(screen.getByText('invite-1@test.com')).toBeInTheDocument(); // rows stay throughout

      await act(async () => release());
      await waitFor(() => expect(screen.queryByText(/Couldn't refresh invites\./)).not.toBeInTheDocument());
      await waitFor(() => expect(document.activeElement).toBe(screen.getByText(/^Active invites/)));
    });

    it('the first load is announced as a status', async () => {
      mocked.listGroupInvites.mockReturnValue(new Promise(() => {}));
      renderPage();
      expect(await screen.findByText('Loading invites…')).toBeInTheDocument();
      expect(screen.getByText('Loading invites…').closest('[role="status"]')).not.toBeNull();
    });

    it("invite state is scoped to its GROUP: one group's loaded pages are never shown for another, and each keeps its own cache entry", async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } } });
      let releaseB!: () => void;
      const gateB = new Promise<void>((resolve) => (releaseB = resolve));
      mocked.getGroup.mockImplementation(async (groupId: string) => ({ data: { ...baseGroup, id: groupId, isPrivate: true, memberRole: 'OWNER' } }));
      mocked.listGroupInvites.mockImplementation((groupId: string) =>
        groupId === 'g-1'
          ? Promise.resolve(pageOf(1, 3, 3, 1))
          : gateB.then(() => ({
              success: true,
              data: [{ ...inv(900), email: 'only-in-g2@test.com' }],
              meta: { total: 1, page: 1, limit: PAGE, totalPages: 1, hasNextPage: false, hasPrevPage: false },
            }))
      );

      const first = renderPage('g-1', client);
      await screen.findByText('invite-1@test.com');
      first.unmount();

      renderPage('g-2', client);
      await screen.findByPlaceholderText('user@example.com'); // g-2 is on screen, its invites still loading
      expect(screen.queryByText('invite-1@test.com')).not.toBeInTheDocument(); // g-1's pages do not leak into g-2

      await act(async () => releaseB());
      expect(await screen.findByText('only-in-g2@test.com')).toBeInTheDocument();
      expect(screen.queryByText('invite-1@test.com')).not.toBeInTheDocument();
      // Two group-scoped entries, each holding only its own group's invites.
      const a = client.getQueryData<{ pages: { invites: { id: string }[] }[] }>(['group-invites', 'g-1']);
      const b = client.getQueryData<{ pages: { invites: { id: string }[] }[] }>(['group-invites', 'g-2']);
      expect(a?.pages.flatMap((pg) => pg.invites).map((i) => i.id)).toEqual(['inv-1', 'inv-2', 'inv-3']);
      expect(b?.pages.flatMap((pg) => pg.invites).map((i) => i.id)).toEqual(['inv-900']);
    });

    it('revoking an invite from a later page removes it AT ONCE and it stays gone when the refresh that follows fails', async () => {
      mocked.revokeGroupInvite.mockResolvedValue({ success: true, data: { message: 'revoked' } });
      mockPages(120);
      renderPage();
      await screen.findByText('invite-1@test.com');
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await screen.findByText('invite-51@test.com');

      mocked.listGroupInvites.mockRejectedValue(new Error('down'));
      fireEvent.click(within(rowOf('invite-51@test.com')).getByRole('button', { name: 'Revoke' }));
      await waitFor(() => expect(screen.queryByText('invite-51@test.com')).not.toBeInTheDocument());
      await screen.findByText(/Couldn't refresh invites\./);
      expect(screen.queryByText('invite-51@test.com')).not.toBeInTheDocument(); // still gone
      expect(screen.getByText('invite-1@test.com')).toBeInTheDocument();
      expect(screen.getByText('invite-52@test.com')).toBeInTheDocument(); // page 2's other rows stay
    });
  });

  describe('ownership transfer', () => {
    beforeEach(() => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      mocked.getGroupMembers.mockResolvedValue({
        data: [
          { id: 'm1', groupId: 'g-1', user: { id: 'u-owner', username: 'owner', displayName: 'Owner' }, role: 'OWNER', status: 'ACTIVE', joinedAt: '' },
          { id: 'm2', groupId: 'g-1', user: { id: 'u-bob', username: 'bob', displayName: 'Bob' }, role: 'MEMBER', status: 'ACTIVE', joinedAt: '' },
        ],
      });
    });

    it('shows a Transfer button for non-owner members', async () => {
      renderPage();
      await screen.findByText('Bob');
      expect(screen.getByRole('button', { name: 'Transfer' })).toBeInTheDocument();
    });

    it('shows a confirmation card when Transfer is clicked', async () => {
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Transfer' }));
      expect(await screen.findByText(/Confirm ownership transfer/)).toBeInTheDocument();
      expect(screen.getAllByText(/Bob/).length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: 'Confirm transfer' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('calls transferOwnership on confirm', async () => {
      mocked.transferOwnership.mockResolvedValue({ data: { message: 'Ownership transferred' } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Transfer' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Confirm transfer' }));
      await waitFor(() => expect(mocked.transferOwnership).toHaveBeenCalledWith('g-1', 'u-bob'));
    });

    it('cancels transfer on Cancel', async () => {
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Transfer' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      expect(screen.queryByText(/Confirm ownership transfer/)).not.toBeInTheDocument();
    });
  });

  describe('approve / reject requests', () => {
    beforeEach(() => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'ADMIN' } });
      mocked.getGroupMembers.mockResolvedValue({
        data: [
          { id: 'm1', groupId: 'g-1', user: { id: 'u-admin', username: 'admin', displayName: 'Admin' }, role: 'ADMIN', status: 'ACTIVE', joinedAt: '' },
        ],
      });
      mocked.listJoinRequests.mockResolvedValue({
        data: [
          { id: 'm2', groupId: 'g-1', user: { id: 'u-pending', username: 'requester', displayName: 'Requester' }, role: 'MEMBER', status: 'PENDING', joinedAt: '' },
        ],
      });
    });

    it('approve calls the API', async () => {
      mocked.approveJoinRequest.mockResolvedValue({ data: { message: 'approved' } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(mocked.approveJoinRequest).toHaveBeenCalledWith('g-1', 'u-pending'));
    });

    it('reject calls the API', async () => {
      mocked.rejectJoinRequest.mockResolvedValue({ data: { message: 'rejected' } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
      await waitFor(() => expect(mocked.rejectJoinRequest).toHaveBeenCalledWith('g-1', 'u-pending'));
    });
  });

  describe('remove member', () => {
    beforeEach(() => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      mocked.getGroupMembers.mockResolvedValue({
        data: [
          { id: 'm1', groupId: 'g-1', user: { id: 'u-owner', username: 'owner', displayName: 'Owner' }, role: 'OWNER', status: 'ACTIVE', joinedAt: '' },
          { id: 'm2', groupId: 'g-1', user: { id: 'u-mem', username: 'member', displayName: 'Member' }, role: 'MEMBER', status: 'ACTIVE', joinedAt: '' },
        ],
      });
    });

    it('calls removeGroupMember', async () => {
      mocked.removeGroupMember.mockResolvedValue({ data: { message: 'removed' } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(mocked.removeGroupMember).toHaveBeenCalledWith('g-1', 'u-mem'));
    });
  });

  describe('ban member', () => {
    beforeEach(() => {
      mocked.getGroupMembers.mockResolvedValue({
        data: [
          { id: 'm1', groupId: 'g-1', user: { id: 'u-owner', username: 'owner', displayName: 'Owner' }, role: 'OWNER', status: 'ACTIVE', joinedAt: '' },
          { id: 'm2', groupId: 'g-1', user: { id: 'u-mem', username: 'member', displayName: 'Member' }, role: 'MEMBER', status: 'ACTIVE', joinedAt: '' },
        ],
      });
    });

    it('shows a Ban action for an active, non-owner member when the viewer is a manager (OWNER)', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      renderPage();
      await screen.findByText('Member');
      expect(screen.getByRole('button', { name: 'Ban' })).toBeInTheDocument();
    });

    it('shows Ban for an ADMIN manager too', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'ADMIN' } });
      renderPage();
      await screen.findByText('Member');
      expect(screen.getByRole('button', { name: 'Ban' })).toBeInTheDocument();
    });

    it('never shows a Ban action on the owner\'s own row', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      renderPage();
      await screen.findByText('Owner');
      const ownerRow = screen.getByText('Owner').closest('.border')!.closest('.border') as HTMLElement;
      expect(ownerRow.querySelector('button')).toBeNull();
    });

    it('hides the Ban action entirely for a non-manager (MEMBER) viewer', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'MEMBER' } });
      renderPage();
      await screen.findByText('Member');
      expect(screen.queryByRole('button', { name: 'Ban' })).not.toBeInTheDocument();
    });

    it('does not call the API until the ban is confirmed', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
      expect(mocked.banGroupMember).not.toHaveBeenCalled();
    });

    it('shows a confirmation naming the target when Ban is clicked', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
      expect(await screen.findByRole('heading', { name: 'Confirm ban' })).toBeInTheDocument();
      expect(screen.getAllByText(/Member/).length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: 'Confirm ban' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('cancels without calling the API', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      expect(screen.queryByText(/Confirm ban/)).not.toBeInTheDocument();
      expect(mocked.banGroupMember).not.toHaveBeenCalled();
    });

    it('calls banGroupMember with the group and target user id on confirm', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      mocked.banGroupMember.mockResolvedValue({ data: { message: 'Member banned' } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }));
      await waitFor(() => expect(mocked.banGroupMember).toHaveBeenCalledWith('g-1', 'u-mem'));
    });

    it('refreshes members, pending requests, invites, and notifications after a successful ban', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      mocked.banGroupMember.mockResolvedValue({ data: { message: 'Member banned' } });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
      renderPage('g-1', client);

      fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }));

      await waitFor(() => expect(mocked.banGroupMember).toHaveBeenCalledTimes(1));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['group-members', 'g-1'] }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['group-requests', 'g-1'] }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['group-invites', 'g-1'] }));
      // Scoped to the signed-in account: the inbox cache is keyed by identity,
      // so there is no identity-free ['notifications'] key to invalidate.
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['notifications', 'u-viewer'] }));
      expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['notifications'] }));
    });

    describe('confirmation focus and pending state', () => {
      /** A ban request the test controls the timing of. */
      function deferredBan() {
        let resolve!: (v: unknown) => void;
        let reject!: (e: unknown) => void;
        mocked.banGroupMember.mockReturnValue(
          new Promise((res, rej) => {
            resolve = res;
            reject = rej;
          })
        );
        return { resolve, reject };
      }

      it('moves focus into the confirmation when it opens', async () => {
        mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));

        const confirm = await screen.findByRole('button', { name: 'Confirm ban' });
        await waitFor(() => expect(confirm).toHaveFocus());
      });

      it('keeps the confirmation mounted and shows reachable "Banning…" while pending', async () => {
        mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
        const deferred = deferredBan();
        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }));

        // The request is still in flight: the card must still be on screen
        // and the pending label must be genuinely reachable, not dead code.
        const pendingButton = await screen.findByRole('button', { name: 'Banning…' });
        expect(pendingButton).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Confirm ban' })).toBeInTheDocument();

        deferred.resolve({ data: { message: 'Member banned' } });
        await waitFor(() =>
          expect(screen.queryByRole('heading', { name: 'Confirm ban' })).not.toBeInTheDocument()
        );
      });

      it('disables both confirm and cancel while pending, so the ban cannot be double-sent', async () => {
        mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
        const deferred = deferredBan();
        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }));

        const pendingButton = await screen.findByRole('button', { name: 'Banning…' });
        expect(pendingButton).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

        // Clicking again while pending must not fire a second request.
        fireEvent.click(pendingButton);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(mocked.banGroupMember).toHaveBeenCalledTimes(1);

        deferred.resolve({ data: { message: 'Member banned' } });
        await waitFor(() => expect(mocked.banGroupMember).toHaveBeenCalledTimes(1));
      });

      it('a same-tick double click sends only one ban request', async () => {
        mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
        deferredBan();
        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
        const confirm = await screen.findByRole('button', { name: 'Confirm ban' });

        // Both clicks land before React can re-render the button as
        // disabled, so the `disabled` attribute alone cannot stop the
        // second one — only the synchronous in-flight ref can.
        fireEvent.click(confirm);
        fireEvent.click(confirm);

        await waitFor(() => expect(mocked.banGroupMember).toHaveBeenCalledTimes(1));
        await new Promise((r) => setTimeout(r, 30));
        expect(mocked.banGroupMember).toHaveBeenCalledTimes(1);
      });

      it('a second ban still works after the first one completes', async () => {
        mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
        // Two bannable members, so the second ban is a fresh flow rather
        // than a replay of the first.
        mocked.getGroupMembers.mockResolvedValue({
          data: [
            { id: 'm1', groupId: 'g-1', user: { id: 'u-owner', username: 'owner', displayName: 'Owner' }, role: 'OWNER', status: 'ACTIVE', joinedAt: '' },
            { id: 'm2', groupId: 'g-1', user: { id: 'u-mem', username: 'member', displayName: 'Member' }, role: 'MEMBER', status: 'ACTIVE', joinedAt: '' },
            { id: 'm3', groupId: 'g-1', user: { id: 'u-mem2', username: 'member2', displayName: 'Member Two' }, role: 'MEMBER', status: 'ACTIVE', joinedAt: '' },
          ],
        });
        mocked.banGroupMember.mockResolvedValue({ data: { message: 'Member banned' } });
        renderPage();

        const banButtons = await screen.findAllByRole('button', { name: 'Ban' });
        fireEvent.click(banButtons[0]);
        fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }));
        await waitFor(() => expect(mocked.banGroupMember).toHaveBeenCalledTimes(1));
        await waitFor(() =>
          expect(screen.queryByRole('heading', { name: 'Confirm ban' })).not.toBeInTheDocument()
        );

        // The in-flight guard must have been released, or this second ban
        // would be dropped on the floor with no feedback at all.
        const banButtonsAgain = await screen.findAllByRole('button', { name: 'Ban' });
        fireEvent.click(banButtonsAgain[1]);
        fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }));
        await waitFor(() => expect(mocked.banGroupMember).toHaveBeenCalledTimes(2));
        expect(mocked.banGroupMember).toHaveBeenLastCalledWith('g-1', 'u-mem2');
      });

      it('cancel restores focus to the originating Ban button', async () => {
        mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
        renderPage();
        const banButton = await screen.findByRole('button', { name: 'Ban' });
        fireEvent.click(banButton);

        fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

        expect(screen.queryByRole('heading', { name: 'Confirm ban' })).not.toBeInTheDocument();
        await waitFor(() => expect(banButton).toHaveFocus());
      });

      it('a successful ban restores focus to a surviving control, not the body', async () => {
        mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
        const deferred = deferredBan();
        renderPage();
        fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }));
        await screen.findByRole('button', { name: 'Banning…' });

        deferred.resolve({ data: { message: 'Member banned' } });

        await waitFor(() =>
          expect(screen.queryByRole('heading', { name: 'Confirm ban' })).not.toBeInTheDocument()
        );
        // The banned row's Ban button is gone, so focus lands on the
        // Members heading rather than being dropped to <body>.
        const heading = screen.getByRole('heading', { name: /^Members \(/ });
        await waitFor(() => expect(heading).toHaveFocus());
        expect(document.activeElement).not.toBe(document.body);
      });

      it('a failed ban restores focus to the Ban button that is still there', async () => {
        mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
        const deferred = deferredBan();
        renderPage();
        const banButton = await screen.findByRole('button', { name: 'Ban' });
        fireEvent.click(banButton);
        fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }));
        await screen.findByRole('button', { name: 'Banning…' });

        deferred.reject(new Error(JSON.stringify({ status: 403, message: 'Insufficient permissions' })));

        await waitFor(() =>
          expect(screen.queryByRole('heading', { name: 'Confirm ban' })).not.toBeInTheDocument()
        );
        await waitFor(() => expect(banButton).toHaveFocus());
      });
    });

    it('surfaces a ban failure accessibly, without silently swallowing it', async () => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      mocked.banGroupMember.mockRejectedValue(new Error(JSON.stringify({ status: 403, message: 'Insufficient permissions' })));
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }));

      await waitFor(() =>
        expect(toastMock).toHaveBeenCalledWith({
          title: 'Error',
          description: 'Insufficient permissions',
          variant: 'destructive',
        })
      );
    });
  });

  describe('role change', () => {
    beforeEach(() => {
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      mocked.getGroupMembers.mockResolvedValue({
        data: [
          { id: 'm1', groupId: 'g-1', user: { id: 'u-owner', username: 'owner', displayName: 'Owner' }, role: 'OWNER', status: 'ACTIVE', joinedAt: '' },
          { id: 'm2', groupId: 'g-1', user: { id: 'u-mem', username: 'member', displayName: 'Member' }, role: 'MEMBER', status: 'ACTIVE', joinedAt: '' },
        ],
      });
    });

    it('calls changeMemberRole on select change', async () => {
      mocked.changeMemberRole.mockResolvedValue({ data: { message: 'updated' } });
      renderPage();
      await screen.findByText('Member');
      const selects = screen.getAllByRole('combobox');
      fireEvent.change(selects[0], { target: { value: 'ADMIN' } });
      await waitFor(() => expect(mocked.changeMemberRole).toHaveBeenCalledWith('g-1', 'u-mem', 'ADMIN'));
    });
  });

  describe('empty state', () => {
    it('shows "No members yet" when members list is empty', async () => {
      renderPage();
      expect(await screen.findByText('No members yet.')).toBeInTheDocument();
    });
  });

  describe('self-management controls (current user row)', () => {
    function memberRow(userId: string, name: string, role: string) {
      return {
        id: `m-${userId}`,
        groupId: 'g-1',
        user: { id: userId, username: name.toLowerCase(), displayName: name },
        role,
        status: 'ACTIVE' as const,
        joinedAt: '',
      };
    }

    /** The bordered row container for a given member display name. */
    function rowFor(name: string): HTMLElement {
      return screen.getByText(name).closest('.rounded-md.border.p-3') as HTMLElement;
    }

    it('ADMIN: no role selector, Remove, or Ban on own row; Leave stays; other member still manageable', async () => {
      authState.current = { id: 'u-admin', username: 'admin', displayName: 'Admin' };
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'ADMIN' } });
      mocked.getGroupMembers.mockResolvedValue({
        data: [
          memberRow('u-owner', 'Owner', 'OWNER'),
          memberRow('u-admin', 'Admin', 'ADMIN'),
          memberRow('u-bob', 'Bob', 'MEMBER'),
        ],
      });
      renderPage();
      await screen.findByText('Admin');

      const ownRow = within(rowFor('Admin'));
      expect(ownRow.queryByRole('combobox')).toBeNull();
      expect(ownRow.queryByRole('button', { name: 'Remove' })).toBeNull();
      expect(ownRow.queryByRole('button', { name: 'Ban' })).toBeNull();

      expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();

      const bobRow = within(rowFor('Bob'));
      expect(bobRow.getByRole('combobox')).toBeInTheDocument();
      expect(bobRow.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
      expect(bobRow.getByRole('button', { name: 'Ban' })).toBeInTheDocument();
    });

    it('OWNER: no management controls on own OWNER row; non-owner member still manageable', async () => {
      authState.current = { id: 'u-owner', username: 'owner', displayName: 'Owner' };
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      mocked.getGroupMembers.mockResolvedValue({
        data: [
          memberRow('u-owner', 'Owner', 'OWNER'),
          memberRow('u-bob', 'Bob', 'MEMBER'),
        ],
      });
      renderPage();
      await screen.findByText('Owner');

      const ownRow = within(rowFor('Owner'));
      expect(ownRow.queryByRole('combobox')).toBeNull();
      expect(ownRow.queryByRole('button', { name: 'Remove' })).toBeNull();
      expect(ownRow.queryByRole('button', { name: 'Ban' })).toBeNull();

      const bobRow = within(rowFor('Bob'));
      expect(bobRow.getByRole('combobox')).toBeInTheDocument();
      expect(bobRow.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
      expect(bobRow.getByRole('button', { name: 'Ban' })).toBeInTheDocument();
    });

    it('does not flash management controls while the user identity is unresolved', async () => {
      authState.current = null;
      mocked.getGroup.mockResolvedValue({ data: { ...baseGroup, memberRole: 'OWNER' } });
      mocked.getGroupMembers.mockResolvedValue({
        data: [
          memberRow('u-owner', 'Owner', 'OWNER'),
          memberRow('u-bob', 'Bob', 'MEMBER'),
        ],
      });
      renderPage();
      await screen.findByText('Bob');

      // Fail closed: with no resolved identity the manager controls must not
      // render for any row, including rows the OWNER would otherwise manage.
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Ban' })).toBeNull();
    });
  });
});
