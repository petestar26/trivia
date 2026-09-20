import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { copyText, type CopyOutcome } from '@/lib/clipboard';
import { GROUP_LIST_QUERY_KEYS } from '@/lib/groups-query-keys';
import { inviteLink } from '@/lib/invite-link';
import { notificationsScopeKey } from '@/lib/notifications-query-keys';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/providers/auth-provider';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { GroupDetailInfo, GroupInviteInfo, GroupMemberInfo } from '@socialplay/shared';

const ROLE_OPTIONS = ['ADMIN', 'MODERATOR', 'MEMBER'] as const;

const inviteLinkFieldId = (inviteId: string) => `invite-link-${inviteId}`;

const COPY_MESSAGES: Record<CopyOutcome, string> = {
  copied: 'Invite link copied.',
  failed: "Couldn't copy the link. It is selected above — copy it manually.",
  unavailable: "This browser can't copy for you. The link is selected above — copy it manually.",
};

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

  const groupQuery = useQuery<GroupDetailInfo>({
    queryKey: ['group', groupId],
    queryFn: async () => {
      const res = await api.getGroup(groupId);
      if (!res.data) throw new Error('Group response carried no data');
      return res.data;
    },
    enabled: !!groupId,
  });

  const membersQuery = useQuery<GroupMemberInfo[]>({
    queryKey: ['group-members', groupId],
    queryFn: async () => (await api.getGroupMembers(groupId)).data ?? [],
    enabled: !!groupId && !!groupQuery.data?.isMember,
  });

  const invitesQuery = useQuery<GroupInviteInfo[]>({
    queryKey: ['group-invites', groupId],
    // The API's largest page: every live invite a manager is likely to have,
    // each with its recoverable link, rather than only the first twenty.
    queryFn: async () => (await api.listGroupInvites(groupId, { limit: 100 })).data ?? [],
    enabled: !!groupId && !!groupQuery.data?.isMember && ['OWNER', 'ADMIN'].includes(groupQuery.data?.memberRole ?? '') && groupQuery.data?.isPrivate,
  });

  const requestsQuery = useQuery<GroupMemberInfo[]>({
    queryKey: ['group-requests', groupId],
    queryFn: async () => (await api.listJoinRequests(groupId)).data ?? [],
    enabled: !!groupId && !!groupQuery.data?.isMember && ['OWNER', 'ADMIN'].includes(groupQuery.data?.memberRole ?? ''),
  });

  const isManager = ['OWNER', 'ADMIN'].includes(groupQuery.data?.memberRole ?? '');
  const isOwner = groupQuery.data?.memberRole === 'OWNER';

  // Authenticated actor, keyed by stable user id. Required for row-level
  // self-management suppression below.
  const { user: currentUser } = useAuth();
  const currentUserId = currentUser?.id;

  // Shared visibility predicate for member-management controls (role
  // selector, Remove, Ban, Transfer). Fails closed while the actor's
  // identity is unresolved so destructive controls are never flashed;
  // never surfaces on the actor's own row or the group owner's row.
  const canShowMemberManagementControls = (member: GroupMemberInfo): boolean =>
    !!currentUserId &&
    isManager &&
    member.user.id !== currentUserId &&
    member.user.id !== groupQuery.data?.owner?.id;

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

  const banMutation = useMutation({
    mutationFn: (userId: string) => api.banGroupMember(groupId, userId),
    onSuccess: () => {
      // The backend is the sole authority on whether a ban is permitted —
      // this refresh just brings the UI in line with what it decided.
      queryClient.invalidateQueries({ queryKey: ['group-members', groupId] });
      queryClient.invalidateQueries({ queryKey: ['group-requests', groupId] });
      queryClient.invalidateQueries({ queryKey: ['group-invites', groupId] });
      queryClient.invalidateQueries({ queryKey: ['group', groupId] });
      // Scoped to the signed-in account: the notification cache is keyed by
      // identity, so there is no shared inbox key to invalidate.
      if (currentUserId) queryClient.invalidateQueries({ queryKey: notificationsScopeKey(currentUserId) });
      toast({ title: 'Member banned' });
      // The banned row — and the Ban button that opened this — is about to
      // disappear from the list, so focus goes to the Members heading, a
      // control that survives the refresh. Without this, dismissing the
      // confirmation would drop focus to <body> and a keyboard or screen
      // reader user would lose their place entirely.
      closeBanConfirm({ restoreTo: 'members-heading' });
    },
    onError: (err) => {
      let msg = 'Failed to ban member';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
      // The ban failed, so the member row and its Ban button are still
      // there — send focus back to where the flow started.
      closeBanConfirm({ restoreTo: 'trigger' });
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
    onSuccess: async (res) => {
      const created = res?.data;
      if (created?.token) {
        // The invite exists now, and it must be reachable from the page no
        // matter what the clipboard, the toast or the refetch below do: put it
        // in the list straight from the response. The refetch then reconciles
        // it with the server; if that refetch fails, the row is still here.
        queryClient.setQueryData<GroupInviteInfo[]>(['group-invites', groupId], (current) => [
          created,
          ...(current ?? []).filter((inv) => inv.id !== created.id),
        ]);
      }
      queryClient.invalidateQueries({ queryKey: ['group-invites', groupId] });

      // Copying on creation is a convenience, never the only way to get the
      // link. Whatever it does, the row's own "Copy link" stays available.
      const outcome = created?.token ? await copyText(inviteLink(created.token)) : null;
      toast({
        title: 'Invite created',
        description:
          outcome === 'copied'
            ? 'The invite link was copied to your clipboard. It stays listed under Active invites.'
            : created?.token
              ? 'The invite link is listed under Active invites, where you can copy it whenever you need it.'
              : undefined,
      });
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

  // The outcome of the most recent "Copy link" press, shown on that row. The
  // nonce makes a repeated identical outcome a real DOM change, so a screen
  // reader announces the second copy too (a live region whose text does not
  // change is never re-announced).
  const [copyFeedback, setCopyFeedback] = useState<{ inviteId: string; outcome: CopyOutcome; nonce: number } | null>(null);

  async function copyInviteLink(invite: GroupInviteInfo) {
    const outcome = await copyText(inviteLink(invite.token));
    setCopyFeedback((prev) => ({ inviteId: invite.id, outcome, nonce: (prev?.nonce ?? 0) + 1 }));
    if (outcome !== 'copied') {
      // Recovery: put the link itself in front of the user, already selected,
      // so copying it by hand is one keystroke.
      const field = document.getElementById(inviteLinkFieldId(invite.id));
      if (field instanceof HTMLInputElement) {
        field.focus();
        field.select();
      }
    }
  }

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

  // ─── Ban confirmation ─────────────────────────────────────────

  const [banTarget, setBanTarget] = useState('');
  const [showBanConfirm, setShowBanConfirm] = useState(false);
  // The Ban button that opened the confirmation, so Cancel (and a failed
  // ban) can put focus back exactly where the user left it.
  const banTriggerRef = useRef<HTMLButtonElement | null>(null);
  const banConfirmRef = useRef<HTMLButtonElement | null>(null);
  const membersHeadingRef = useRef<HTMLHeadingElement | null>(null);
  // Guards against a double-click sending two bans. `banMutation.isPending`
  // cannot do this on its own: neither it nor the button's `disabled`
  // attribute has updated yet when a second click arrives in the SAME tick,
  // so both clicks get through (measured: two requests). A ref flips
  // synchronously, so the second click is dropped.
  const banInFlightRef = useRef(false);

  const banTargetMember = membersQuery.data?.find(
    (m) => m.user.id === banTarget && m.status === 'ACTIVE'
  );

  // Moving focus into the confirmation is what makes it a real confirmation
  // step: it is rendered below the member list, so without this a keyboard
  // or screen reader user gets no indication anything happened.
  useEffect(() => {
    if (showBanConfirm) banConfirmRef.current?.focus();
  }, [showBanConfirm]);

  function closeBanConfirm({ restoreTo }: { restoreTo: 'trigger' | 'members-heading' }) {
    setShowBanConfirm(false);
    setBanTarget('');
    banInFlightRef.current = false;
    const trigger = banTriggerRef.current;
    const fallback = membersHeadingRef.current;
    // A trigger that was removed from the DOM can't take focus, so fall
    // back to the heading in that case too.
    const destination =
      restoreTo === 'trigger' && trigger && trigger.isConnected ? trigger : fallback;
    destination?.focus();
    banTriggerRef.current = null;
  }

  function handleBanConfirm() {
    if (!banTargetMember || banInFlightRef.current) return;
    banInFlightRef.current = true;
    // Deliberately does NOT close the confirmation here: the card stays
    // mounted for the whole request so its "Banning…" state is actually
    // reachable, and closing is left to the mutation's settled callbacks.
    banMutation.mutate(banTarget);
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
            {group.viewerMembershipStatus === 'BANNED' ? (
              <p role="status" className="text-sm text-red-600 dark:text-red-400" data-testid="banned-message">
                You have been banned from this group.
              </p>
            ) : group.isPrivate ? (
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
          <CardTitle className="text-sm" ref={membersHeadingRef} tabIndex={-1}>
            Members ({activeMembers.length})
          </CardTitle>
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
                {canShowMemberManagementControls(m) && (
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
                    <Button
                      size="sm"
                      variant="destructive"
                      className="text-xs h-6"
                      onClick={(e) => {
                        banTriggerRef.current = e.currentTarget;
                        setBanTarget(m.user.id);
                        setShowBanConfirm(true);
                      }}
                    >
                      Ban
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
            {invitesQuery.data.map((inv) => {
              const feedback = copyFeedback?.inviteId === inv.id ? copyFeedback : null;
              return (
                <div key={inv.id} className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <span className="text-sm font-medium">{inv.email}</span>
                      <span className="ml-2 text-xs text-gray-500">{roleBadge(inv.role)}</span>
                    </div>
                    <Button size="sm" variant="destructive" disabled={revokeMutation.isPending} onClick={() => revokeMutation.mutate(inv.id)}>
                      Revoke
                    </Button>
                  </div>
                  {/* The recoverable link. It is part of the row for as long as the
                      invite is live — not something a toast carries and then takes
                      away — so it can always be selected by hand or copied again. */}
                  {inv.token && (
                    <>
                      <div className="flex items-center gap-2">
                        <Input
                          id={inviteLinkFieldId(inv.id)}
                          readOnly
                          value={inviteLink(inv.token)}
                          aria-label={`Invitation link for ${inv.email}`}
                          onFocus={(e) => e.currentTarget.select()}
                          className="h-9 font-mono text-xs"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Copy link for ${inv.email}`}
                          onClick={() => void copyInviteLink(inv)}
                        >
                          Copy link
                        </Button>
                      </div>
                      <p
                        role="status"
                        aria-live="polite"
                        className={`text-xs min-h-[1rem] ${
                          feedback && feedback.outcome !== 'copied'
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-gray-500 dark:text-gray-400'
                        }`}
                      >
                        {feedback ? `${COPY_MESSAGES[feedback.outcome]}${feedback.nonce % 2 ? '\u200B' : ''}` : ''}
                      </p>
                    </>
                  )}
                </div>
              );
            })}
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

      {/* Ban confirmation */}
      {showBanConfirm && (
        <Card className="border-red-300 dark:border-red-600">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-red-700 dark:text-red-300">Confirm ban</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {banTargetMember && (
              <p className="text-sm">
                Ban <strong>{banTargetMember.user.displayName || banTargetMember.user.username}</strong> from this group?
                They will lose access immediately and won&apos;t be able to rejoin or redeem invites.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                ref={banConfirmRef}
                size="sm"
                variant="destructive"
                disabled={banMutation.isPending}
                onClick={handleBanConfirm}
              >
                {banMutation.isPending ? 'Banning…' : 'Confirm ban'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={banMutation.isPending}
                onClick={() => closeBanConfirm({ restoreTo: 'trigger' })}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
