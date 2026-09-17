import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { GROUP_LIST_QUERY_KEYS } from '@/lib/groups-query-keys';
import { useToast } from '@/hooks/use-toast';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function GroupInviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const inviteQuery = useQuery({
    queryKey: ['group-invite-info', token],
    queryFn: async () => (await api.resolveGroupInvite(token!)).data,
    enabled: !!token,
    retry: false,
  });

  const acceptMutation = useMutation({
    mutationFn: () => api.acceptGroupInvite(token!),
    onSuccess: () => {
      for (const key of GROUP_LIST_QUERY_KEYS) queryClient.invalidateQueries({ queryKey: key });
      toast({ title: 'Invite accepted', description: 'You have joined the group.' });
      navigate('/groups', { replace: true });
    },
    onError: (err) => {
      let msg = 'Failed to accept invite';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  if (inviteQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (inviteQuery.isError || !inviteQuery.data) {
    return (
      <div className="max-w-lg mx-auto p-4">
        <Card>
          <CardContent className="py-8 text-center text-red-600 dark:text-red-400">
            Invalid or unrecognized invite link.
          </CardContent>
        </Card>
      </div>
    );
  }

  const invite = inviteQuery.data;
  const isTerminal = invite.status !== 'PENDING';
  const statusLabel: Record<string, string> = {
    ACCEPTED: 'This invite has already been accepted.',
    REVOKED: 'This invite has been revoked.',
    EXPIRED: 'This invite has expired.',
  };

  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Group invitation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            You have been invited to join <strong>{invite.group.name}</strong>
            {invite.group.isPrivate && ' (Private group)'}.
          </p>
          {isTerminal ? (
            <p className="text-sm text-gray-500">{statusLabel[invite.status] ?? 'Invite is no longer active.'}</p>
          ) : (
            <Button onClick={() => acceptMutation.mutate()} disabled={acceptMutation.isPending}>
              {acceptMutation.isPending ? 'Accepting…' : 'Accept invite'}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => navigate('/groups')}>
            Back to groups
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
