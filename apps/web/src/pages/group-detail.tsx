import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { GROUP_LIST_QUERY_KEYS } from '@/lib/groups-query-keys';
import { useToast } from '@/hooks/use-toast';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type GroupMember = {
  id: string;
  groupId: string;
  user: { id: string; username: string; displayName?: string | null; avatarUrl?: string | null };
  role: string;
  status: string;
  joinedAt: string;
};

type GroupInvite = {
  id: string;
  email: string;
  role: string;
  status: string;
  token: string;
  expiresAt: string;
  invitedBy: string;
  createdAt: string;
};

type GroupDetail = {
  id: string;
  name: string;
  description?: string | null;
  isPrivate: boolean;
  status: string;
  memberCount: number;
  isMember: boolean;
  memberRole?: string | null;
  requestStatus?: string | null;
  owner?: { id: string; username: string; displayName?: string | null } | null;
};

const ROLE_OPTIONS = ['ADMIN', 'MODERATOR', 'MEMBER'] as const;

function roleBadge(role: string) {
  const colours: Record<string, string> = {
    OWNER: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
    ADMIN: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
    MODERATOR: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200',
    MEMBER: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colours[role] ?? colours.MEMBER}`}>
      {role}
    </span>
  );
}

export function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const groupId = id!;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const groupQuery = useQuery<GroupDetail>({
    queryKey: ['group', groupId],
    queryFn: async () => (await api.getGroup(groupId)).data,
    enabled: !!groupId,
  });

  const membersQuery = useQuery<GroupMember[]>({
    queryKey: ['group-members', groupId],
    queryFn: async () => (await api.getGroupMembers(groupId)).data ?? [],
    enabled: !!groupId && !!groupQuery.data?.isMember,
  });

  const invitesQuery = useQuery<GroupInvite[]>({
    queryKey: ['group-invites', groupId],
    queryFn: async () => (await api.listGroupInvites(groupId)).data ?? [],
    enabled: !!groupId && !!groupQuery.data?.isMember && ['OWNER', 'ADMIN'].includes(groupQuery.data?.memberRole ?? '') && groupQuery.data?.isPrivate,
  });

  const requestsQuery = useQuery<GroupMember[]>({
    queryKey: ['group-requests', groupId],
    queryFn: async () => (await api.listJoinRequests(groupId)).data ?? [],
    enabled: !!groupId && !!groupQuery.data?.isMember && ['OWNER', 'ADMIN'].includes(groupQuery.data?.memberRole ?? ''),
  });

  const isManager = ['OWNER', 'ADMIN'].includes(groupQuery.data?.memberRole ?? '');
  const isOwner = groupQuery.data?.memberRole === 'OWNER';

  // ─── Mutations ──────────────────────────────────────────────────

  const joinMutation = useMutation({
    mutationFn: async () => {
      if (groupQuery.data?.isPrivate) return api.requestJoinGroup(groupId);
      return api.joinGroup(groupId);
    },
    onSuccess: () => {
      for (const key of GROUP_LIST_QUERY_KEYS) queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ['group', groupId] });
      queryClient.invalidateQueries({ queryKey: ['group-members', groupId] });
      toast({ title: groupQuery.data?.isPrivate ? 'Join request submitted' : 'Joined group' });
    },
    onError: (err) => {
      let msg = 'Failed to join';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => api.leaveGroup(groupId),
    onSuccess: () => {
      for (const key of GROUP_LIST_QUERY_KEYS) queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ['group', groupId] });
      toast({ title: 'Left group' });
    },
    onError: (err) => {
      let msg = 'Failed to leave';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const approveMutation = useMutation({
    mutationFn: (userId: string) => api.approveJoinRequest(groupId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group-requests', groupId] });
      queryClient.invalidateQueries({ queryKey: ['group-members', groupId] });
      queryClient.invalidateQueries({ queryKey: ['group', groupId] });
      toast({ title: 'Request approved' });
    },
    onError: (err) => {
      let msg = 'Failed to approve';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (userId: string) => api.rejectJoinRequest(groupId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group-requests', groupId] });
      queryClient.invalidateQueries({ queryKey: ['group-members', groupId] });
      queryClient.invalidateQueries({ queryKey: ['group', groupId] });
      toast({ title: 'Request rejected' });
    },
    onError: (err) => {
      let msg = 'Failed to reject';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.removeGroupMember(groupId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group-members', groupId] });
      queryClient.invalidateQueries({ queryKey: ['group', groupId] });
      toast({ title: 'Member removed' });
    },
    onError: (err) => {
      let msg = 'Failed to remove member';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) => api.changeMemberRole(groupId, userId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group-members', groupId] });
      toast({ title: 'Role updated' });
    },
    onError: (err) => {
      let msg = 'Failed to update role';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: ({ email, role }: { email: string; role?: string }) => api.createGroupInvite(groupId, email, role),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['group-invites', groupId] });
      const token = res?.data?.token;
      if (token) {
        const link = `${window.location.origin}/groups/invite/${token}`;
        navigator.clipboard.writeText(link).catch(() => {});
        toast({ title: 'Invite sent', description: 'Invite link copied to clipboard.' });
      } else {
        toast({ title: 'Invite sent' });
      }
    },
    onError: (err) => {
      let msg = 'Failed to send invite';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => api.revokeGroupInvite(groupId, inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group-invites', groupId] });
      toast({ title: 'Invite revoked' });
    },
    onError: (err) => {
      let msg = 'Failed to revoke invite';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const transferMutation = useMutation({
    mutationFn: (targetUserId: string) => api.transferOwnership(groupId, targetUserId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group', groupId] });
      queryClient.invalidateQueries({ queryKey: ['group-members', groupId] });
      for (const key of GROUP_LIST_QUERY_KEYS) queryClient.invalidateQueries({ queryKey: key });
      toast({ title: 'Ownership transferred' });
    },
    onError: (err) => {
      let msg = 'Failed to transfer ownership';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  // ─── Invite form ────────────────────────────────────────────────

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('MEMBER');
  const inviteInputRef = useRef<HTMLInputElement>(null);

  function handleInvite(e: FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    inviteMutation.mutate({ email, role: inviteRole });
    setInviteEmail('');
  }

  // ─── Transfer confirmation ──────────────────────────────────────

  const [transferTarget, setTransferTarget] = useState('');
  const [showTransferConfirm, setShowTransferConfirm] = useState(false);

  const transferTargetMember = membersQuery.data?.find(
    (m) => m.user.id === transferTarget && m.status === 'ACTIVE'
  );

  function handleTransfer(e: FormEvent) {
    e.preventDefault();
    if (!transferTargetMember) return;
    transferMutation.mutate(transferTarget);
    setShowTransferConfirm(false);
    setTransferTarget('');
  }

  // ─── Loading / error ────────────────────────────────────────────

  if (groupQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (groupQuery.isError || !groupQuery.data) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <Card>
          <CardContent className="py-8 text-center text-red-600 dark:text-red-400">
            Failed to load group details.
          </CardContent>
        </Card>
      </div>
    );
  }

  const group = groupQuery.data;

  if (!group.isMember) {
    return (
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/groups')}>
          ← Back to groups
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>{group.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {group.description && <p className="text-sm text-gray-600 dark:text-gray-400">{group.description}</p>}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {group.memberCount} member{group.memberCount !== 1 ? 's' : ''}
              {group.isPrivate && ' · Private'}
            </p>
            {group.isPrivate ? (
              <Button onClick={() => joinMutation.mutate()} disabled={joinMutation.isPending || group.requestStatus === 'PENDING'}>
                {joinMutation.isPending
                  ? 'Requesting…'
                  : group.requestStatus === 'PENDING'
                    ? 'Request pending'
                    : 'Request to join'}
              </Button>
            ) : (
              <Button onClick={() => joinMutation.mutate()} disabled={joinMutation.isPending}>
                {joinMutation.isPending ? 'Joining…' : 'Join'}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const pendingMembers = requestsQuery.data?.filter((m) => m.status === 'PENDING') ?? [];
  const activeMembers = membersQuery.data?.filter((m) => m.status === 'ACTIVE') ?? [];

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <Button variant="ghost" size="sm" onClick={() => navigate('/groups')}>
        ← Back to groups
      </Button>

      {/* Group info */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">{group.name}</CardTitle>
              {group.description && <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{group.description}</p>}
            </div>
            {group.owner && (
              <p className="text-xs text-gray-500 whitespace-nowrap">
                Owned by {group.owner.displayName || group.owner.username}
              </p>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>{group.memberCount} member{group.memberCount !== 1 ? 's' : ''}</span>
            {group.isPrivate && <span className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5">Private</span>}
            {roleBadge(group.memberRole ?? 'MEMBER')}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => leaveMutation.mutate()} disabled={leaveMutation.isPending}>
              Leave
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Pending requests (managers only) */}
      {isManager && pendingMembers.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Pending requests ({pendingMembers.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendingMembers.map((m) => (
              <div key={m.user.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                <span className="text-sm font-medium">{m.user.displayName || m.user.username}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="default" disabled={approveMutation.isPending} onClick={() => approveMutation.mutate(m.user.id)}>
                    Approve
                  </Button>
                  <Button size="sm" variant="destructive" disabled={rejectMutation.isPending} onClick={() => rejectMutation.mutate(m.user.id)}>
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Members */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Members ({activeMembers.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {membersQuery.isLoading ? (
            <p className="text-xs text-gray-500">Loading members…</p>
          ) : activeMembers.length === 0 ? (
            <p className="text-xs text-gray-500">No members yet.</p>
          ) : (
            activeMembers.map((m) => (
              <div key={m.user.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{m.user.displayName || m.user.username}</span>
                  {roleBadge(m.role)}
                </div>
                {isManager && m.user.id !== group.owner?.id && (
                  <div className="flex items-center gap-1">
                    <select
                      className="text-xs border rounded px-1.5 py-0.5"
                      value={m.role}
                      onChange={(e) => roleMutation.mutate({ userId: m.user.id, role: e.target.value })}
                      disabled={roleMutation.isPending}
                    >
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="text-xs h-6"
                      disabled={removeMemberMutation.isPending}
                      onClick={() => removeMemberMutation.mutate(m.user.id)}
                    >
                      Remove
                    </Button>
                    {isOwner && m.user.id !== group.owner?.id && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs h-6"
                        onClick={() => { setTransferTarget(m.user.id); setShowTransferConfirm(true); }}
                      >
                        Transfer
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Invite form (managers + private groups) */}
      {isManager && group.isPrivate && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Invite by email</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInvite} className="flex gap-2 items-end">
              <div className="flex-1">
                <label htmlFor="invite-email" className="sr-only">Email</label>
                <Input
                  id="invite-email"
                  ref={inviteInputRef}
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="user@example.com"
                  disabled={inviteMutation.isPending}
                />
              </div>
              <select
                className="text-sm border rounded px-2 py-2"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                disabled={inviteMutation.isPending}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <Button type="submit" size="sm" disabled={inviteMutation.isPending || !inviteEmail.trim()}>
                {inviteMutation.isPending ? 'Sending…' : 'Invite'}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Active invites (managers, private groups) */}
      {isManager && group.isPrivate && invitesQuery.data && invitesQuery.data.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Active invites ({invitesQuery.data.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {invitesQuery.data.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div>
                  <span className="text-sm font-medium">{inv.email}</span>
                  <span className="ml-2 text-xs text-gray-500">{roleBadge(inv.role)}</span>
                </div>
                <Button size="sm" variant="destructive" disabled={revokeMutation.isPending} onClick={() => revokeMutation.mutate(inv.id)}>
                  Revoke
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Transfer ownership confirmation */}
      {showTransferConfirm && (
        <Card className="border-amber-300 dark:border-amber-600">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-amber-700 dark:text-amber-300">Confirm ownership transfer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {transferTargetMember && (
              <p className="text-sm">
                Transfer ownership to <strong>{transferTargetMember.user.displayName || transferTargetMember.user.username}</strong>?
                You will be demoted to Admin.
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" disabled={transferMutation.isPending} onClick={handleTransfer}>
                {transferMutation.isPending ? 'Transferring…' : 'Confirm transfer'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setShowTransferConfirm(false); setTransferTarget(''); }}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
