import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { GroupDetailPage } from './group-detail';

vi.mock('@/lib/api', () => ({
  api: {
    getGroup: vi.fn(),
    getGroupMembers: vi.fn(),
    listGroupInvites: vi.fn(),
    joinGroup: vi.fn(),
    requestJoinGroup: vi.fn(),
    leaveGroup: vi.fn(),
    approveJoinRequest: vi.fn(),
    rejectJoinRequest: vi.fn(),
    removeGroupMember: vi.fn(),
    changeMemberRole: vi.fn(),
    createGroupInvite: vi.fn(),
    revokeGroupInvite: vi.fn(),
    transferOwnership: vi.fn(),
  },
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { api } from '@/lib/api';

const mocked = api as unknown as {
  getGroup: ReturnType<typeof vi.fn>;
  getGroupMembers: ReturnType<typeof vi.fn>;
  listGroupInvites: ReturnType<typeof vi.fn>;
  joinGroup: ReturnType<typeof vi.fn>;
  requestJoinGroup: ReturnType<typeof vi.fn>;
  leaveGroup: ReturnType<typeof vi.fn>;
  approveJoinRequest: ReturnType<typeof vi.fn>;
  rejectJoinRequest: ReturnType<typeof vi.fn>;
  removeGroupMember: ReturnType<typeof vi.fn>;
  changeMemberRole: ReturnType<typeof vi.fn>;
  createGroupInvite: ReturnType<typeof vi.fn>;
  revokeGroupInvite: ReturnType<typeof vi.fn>;
  transferOwnership: ReturnType<typeof vi.fn>;
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
  owner: { id: 'u-owner', username: 'owner', displayName: 'Owner' },
};

function renderPage(groupId = 'g-1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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
  mocked.getGroup.mockResolvedValue({ data: baseGroup });
  mocked.getGroupMembers.mockResolvedValue({ data: [] });
  mocked.listGroupInvites.mockResolvedValue({ data: [] });
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
        data: [{ id: 'inv-1', email: 'alice@test.com', role: 'MEMBER', status: 'PENDING', expiresAt: '', invitedBy: '', createdAt: '' }],
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
});
