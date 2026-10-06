import { useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GroupInvitePreview } from '@socialplay/shared';
import { api } from '@/lib/api';
import { getErrorMessage, getErrorStatus } from '@/lib/error-message';
import { GROUP_LIST_QUERY_KEYS } from '@/lib/groups-query-keys';
import { useToast } from '@/hooks/use-toast';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const STATUS_MESSAGE: Record<string, { message: string; hint?: string }> = {
  ACCEPTED: { message: 'This invite has already been accepted.' },
  REVOKED: { message: 'This invite has been revoked.', hint: 'Ask a group owner or admin to send you a new one.' },
  EXPIRED: { message: 'This invite has expired.', hint: 'Ask a group owner or admin to send you a new one.' },
};

type LoadFailure = 'invalid' | 'unavailable';

const normalize = (text: string) => text.trim().replace(/[.\s]+$/, '').toLowerCase();

export function GroupInviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const failureRef = useRef<LoadFailure>('unavailable');
  const [retrying, setRetrying] = useState(false);
  // Flips synchronously, unlike `isPending`: a second activation in the same
  // tick (before React re-renders) would otherwise start a second accept
  // request, and the loser would surface a spurious "already accepted" error.
  const acceptInFlightRef = useRef(false);

  const inviteQuery = useQuery<GroupInvitePreview>({
    queryKey: ['group-invite-info', token],
    queryFn: async () => {
      const res = await api.resolveGroupInvite(token!);
      if (!res.data) throw new Error('Invite response carried no data');
      return res.data;
    },
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
      // The reason stays on the page (below) — a toast disappears, and this is
      // the message the user has to act on ("verify your email", "this invite
      // is for another address", "you are banned"). The toast is only an echo.
      toast({ title: 'Error', description: getErrorMessage(err, 'Failed to accept invite'), variant: 'destructive' });
      // The failure may mean the invite itself just changed state (revoked,
      // expired, taken): bring the page in line with what the server now says.
      queryClient.invalidateQueries({ queryKey: ['group-invite-info', token] });
    },
    onSettled: () => {
      acceptInFlightRef.current = false;
    },
  });

  if (inviteQuery.isError) {
    // 404 is a genuinely unknown link; anything else is worth trying again.
    failureRef.current = getErrorStatus(inviteQuery.error) === 404 ? 'invalid' : 'unavailable';
  }

  // Retry keeps the failure view mounted while it runs, so the button the
  // user just activated is not swapped for a spinner (which would drop
  // keyboard focus onto <body>).
  async function retry(trigger: HTMLElement) {
    const hadFocus = document.activeElement === trigger;
    setRetrying(true);
    try {
      const result = await inviteQuery.refetch();
      // Success replaces the failure view — and the focused button with it.
      if (hadFocus && result.isSuccess) {
        requestAnimationFrame(() => headingRef.current?.focus());
      }
    } finally {
      setRetrying(false);
    }
  }

  // Initial load. An announced status, not a bare spinner: a screen-reader
  // user otherwise hears nothing at all until the page is ready.
  if (inviteQuery.isLoading && !retrying) {
    return (
      <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col items-center justify-center gap-3 py-20">
        <div aria-hidden="true" className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
        <p className="text-sm text-gray-600 dark:text-gray-400">Loading invitation…</p>
      </div>
    );
  }

  if (!inviteQuery.data) {
    const invalid = failureRef.current === 'invalid';
    return (
      <div className="max-w-lg mx-auto p-4">
        <Card>
          <CardContent className="py-8 space-y-4 text-center">
            <p role="alert" className="text-red-600 dark:text-red-400">
              {invalid ? 'Invalid or unrecognized invite link.' : "Couldn't load this invitation."}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {invalid
                ? 'Check that you copied the whole link, or ask the person who invited you to send it again.'
                : 'Check your connection, then try again.'}
            </p>
            <div className="flex items-center justify-center gap-2">
              {!invalid && (
                <Button
                  size="sm"
                  aria-disabled={retrying || undefined}
                  aria-busy={retrying}
                  className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                  onClick={(e) => {
                    if (retrying) return;
                    void retry(e.currentTarget);
                  }}
                >
                  {retrying ? 'Retrying…' : 'Try again'}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => navigate('/groups')}>
                Back to groups
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const invite = inviteQuery.data;
  const isTerminal = invite.status !== 'PENDING';
  const terminal = STATUS_MESSAGE[invite.status] ?? { message: 'Invite is no longer active.' };
  const acceptFailure = acceptMutation.isError ? getErrorMessage(acceptMutation.error, 'Failed to accept invite') : null;
  // A failed accept can be exactly what revealed the invite is no longer live;
  // then the alert already says it, and repeating it as a paragraph adds noise.
  const alertSaysIt = acceptFailure !== null && normalize(acceptFailure) === normalize(terminal.message);

  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg" ref={headingRef} tabIndex={-1}>
            Group invitation
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            You have been invited to join <strong>{invite.group.name}</strong>
            {invite.group.isPrivate && ' (Private group)'}.
          </p>
          {isTerminal ? (
            <div className="space-y-1">
              {!alertSaysIt && <p className="text-sm text-gray-500">{terminal.message}</p>}
              {terminal.hint && <p className="text-sm text-gray-500">{terminal.hint}</p>}
            </div>
          ) : (
            /* aria-disabled, not `disabled`: this is the control the user just
               activated, and a natively disabled focused button is dropped from
               focus by Chromium. The handler refuses while a request runs. */
            <Button
              aria-disabled={acceptMutation.isPending || undefined}
              aria-busy={acceptMutation.isPending}
              className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
              onClick={() => {
                if (acceptInFlightRef.current) return;
                acceptInFlightRef.current = true;
                acceptMutation.mutate();
              }}
            >
              {acceptMutation.isPending ? 'Accepting…' : 'Accept invite'}
            </Button>
          )}
          {/* Outside the branch above on purpose: it must survive the page
              switching to a terminal state, which is often what a failed
              accept means. */}
          {acceptFailure && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {acceptFailure}
            </p>
          )}
          <Button variant="outline" size="sm" onClick={() => navigate('/groups')}>
            Back to groups
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
