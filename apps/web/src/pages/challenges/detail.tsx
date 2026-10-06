import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { api, Challenge } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useSocket } from '@/providers/socket-provider';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ChallengeDetailPage() {
  const { id: challengeId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Socket: refresh authoritative state when challenge events arrive.
  // Do NOT trust realtime payload as authoritative — always refetch.
  const { socket } = useSocket();
  useEffect(() => {
    if (!socket || !challengeId) return;

    const refresh = (payload: { challengeId?: string }) => {
      if (!payload.challengeId || payload.challengeId === challengeId) {
        queryClient.invalidateQueries({ queryKey: ['challenge', challengeId] });
        queryClient.invalidateQueries({ queryKey: ['challenges'] });
        queryClient.invalidateQueries({ queryKey: ['wallet'] });
      }
    };

    socket.on('challenge:accepted',  refresh);
    socket.on('challenge:declined',  refresh);
    socket.on('challenge:cancelled', (p: { challengeId: string }) => refresh({ challengeId: p.challengeId ?? p }));
    socket.on('challenge:completed', refresh);
    socket.on('challenge:started',   refresh);

    return () => {
      socket.off('challenge:accepted',  refresh);
      socket.off('challenge:declined',  refresh);
      socket.off('challenge:cancelled', refresh);
      socket.off('challenge:completed', refresh);
      socket.off('challenge:started',   refresh);
    };
  }, [socket, challengeId, queryClient]);

  // ── Fetch challenge ────────────────────────────────────────────────
  const { data: challenge, isLoading, isError } = useQuery<Challenge>({
    queryKey: ['challenge', challengeId],
    queryFn: async () => {
      const res = await api.getChallengeById(challengeId!);
      return res.data!;
    },
    enabled: !!challengeId,
    refetchOnWindowFocus: true,
  });

  // ── Guess state for NUMBER_CHALLENGE (the only game that uses clientData) ──
  const [guess, setGuess] = useState<string>('50');

  // ── Mutations ────────────────────────────────────────────────────
  const acceptMutation = useMutation({
    mutationFn: () => api.acceptChallenge(challengeId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenge', challengeId] });
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      toast({ title: 'Challenge accepted — good luck!' });
    },
    onError: (err) => {
      let msg = 'Failed to accept';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const declineMutation = useMutation({
    mutationFn: () => api.declineChallenge(challengeId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      toast({ title: 'Challenge declined' });
      navigate('/challenges');
    },
    onError: (err) => {
      let msg = 'Failed to decline';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.cancelChallenge(challengeId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      toast({ title: 'Challenge cancelled — entry refunded' });
      navigate('/challenges');
    },
    onError: (err) => {
      let msg = 'Failed to cancel';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const playMutation = useMutation({
    mutationFn: () => {
      // Build clientData for games that require a guess.
      // Backend ignores clientData for DICE/LUCKY_SPIN.
      const gameKey = challenge?.game?.key ?? challenge?.gameKey ?? '';
      const clientData: Record<string, unknown> =
        gameKey === 'number_challenge' ? { guess: parseInt(guess, 10) || 0 } : {};
      return api.playChallengeTurn(challengeId!, clientData);
    },
    onSuccess: (res) => {
      const data = res.data;
      queryClient.invalidateQueries({ queryKey: ['challenge', challengeId] });
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      if (data?.challengeComplete) {
        const msg = data.message ?? 'Challenge completed';
        toast({ title: msg });
      } else {
        toast({ title: 'Turn submitted — waiting for opponent' });
      }
    },
    onError: (err) => {
      let msg = 'Failed to play';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  // ── Loading / error guards ────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (isError || !challenge) {
    return (
      <div className="max-w-lg mx-auto p-4">
        <Card>
          <CardContent className="py-8 text-center text-gray-500 dark:text-gray-400">
            Challenge not found or you are not a participant.
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Derived values ────────────────────────────────────────────────
  // getChallengeById returns the raw Prisma record which includes
  // top-level challengerId/challengedId FK columns AND game: { key, name }.
  const challengerId  = challenge.challengerId ?? challenge.challenger.id;
  const challengedId2 = challenge.challengedId ?? challenge.challenged.id;
  const iAmChallenger = user?.id === challengerId;
  const iAmChallenged = user?.id === challengedId2;
  const gameName = challenge.game?.name ?? challenge.gameName ?? '—';
  const gameKey  = challenge.game?.key  ?? challenge.gameKey  ?? '';
  const isNumberChallenge = gameKey === 'number_challenge';
  const mutBusy = acceptMutation.isPending || declineMutation.isPending ||
                  cancelMutation.isPending || playMutation.isPending;

  // ── Completed result view ─────────────────────────────────────────
  if (challenge.status === 'COMPLETED') {
    const meta = challenge.resultMeta;
    const iWon  = challenge.winnerId === user?.id;
    const isTie = challenge.winnerId === null;

    return (
      <div className="max-w-lg mx-auto p-4">
        <Card>
          <CardHeader>
            <CardTitle>{gameName} — Result</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className={`text-xl font-bold ${iWon ? 'text-green-600 dark:text-green-400' : isTie ? 'text-gray-500' : 'text-red-600 dark:text-red-400'}`}>
              {iWon ? 'You won! 🎉' : isTie ? "It's a tie" : 'You lost'}
            </p>

            {meta && (
              <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                <p>
                  {challenge.challenger.displayName ?? challenge.challenger.username} score:{' '}
                  <strong>{meta.challengerScore ?? '—'}</strong>
                </p>
                <p>
                  {challenge.challenged.displayName ?? challenge.challenged.username} score:{' '}
                  <strong>{meta.challengedScore ?? '—'}</strong>
                </p>
              </div>
            )}

            {challenge.entryAmount > 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {iWon
                  ? `You won ${challenge.entryAmount * 2} GP!`
                  : isTie
                  ? `Your ${challenge.entryAmount} GP entry was refunded`
                  : `You lost ${challenge.entryAmount} GP`}
              </p>
            )}

            <Button variant="outline" onClick={() => navigate('/challenges')}>
              Back to challenges
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Active / pending view ─────────────────────────────────────────
  return (
    <div className="max-w-lg mx-auto p-4">
      <Card>
        <CardHeader>
          <CardTitle>{gameName}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Participants */}
          <div className="text-sm text-gray-600 dark:text-gray-400">
            <p>
              <span className="font-medium">{challenge.challenger.displayName ?? challenge.challenger.username}</span>
              {' vs '}
              <span className="font-medium">{challenge.challenged.displayName ?? challenge.challenged.username}</span>
            </p>
            {challenge.entryAmount > 0 && (
              <p className="mt-1">Entry: <strong>{challenge.entryAmount} GP</strong> each · Winner takes <strong>{challenge.entryAmount * 2} GP</strong></p>
            )}
          </div>

          {/* Status */}
          <div className="text-sm font-medium">
            Status:{' '}
            <span className={
              challenge.status === 'PENDING' ? 'text-yellow-600 dark:text-yellow-400' :
              challenge.status === 'ACTIVE'  ? 'text-green-600 dark:text-green-400'  : ''
            }>
              {challenge.status}
            </span>
          </div>

          {challenge.status === 'PENDING' && (
            <>
              {iAmChallenged && (
                <div className="space-y-2">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Waiting for your response.</p>
                  <div className="flex gap-2">
                    <Button onClick={() => acceptMutation.mutate()} disabled={mutBusy}>
                      {acceptMutation.isPending ? 'Accepting…' : 'Accept'}
                    </Button>
                    <Button variant="outline" onClick={() => declineMutation.mutate()} disabled={mutBusy}>
                      {declineMutation.isPending ? 'Declining…' : 'Decline'}
                    </Button>
                  </div>
                </div>
              )}
              {iAmChallenger && (
                <div className="space-y-2">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Waiting for opponent to respond.</p>
                  <Button variant="outline" onClick={() => cancelMutation.mutate()} disabled={mutBusy}>
                    {cancelMutation.isPending ? 'Cancelling…' : 'Cancel Challenge'}
                  </Button>
                </div>
              )}
            </>
          )}

          {challenge.status === 'ACTIVE' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {iAmChallenger || iAmChallenged
                  ? "Play your turn. The server determines the outcome."
                  : "Challenge in progress."}
              </p>

              {isNumberChallenge && (
                <div>
                  <label htmlFor="guess" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Your guess (1–100)
                  </label>
                  <Input
                    id="guess"
                    type="number"
                    min={1}
                    max={100}
                    value={guess}
                    onChange={(e) => setGuess(e.target.value)}
                    disabled={playMutation.isPending}
                    className="mt-1 max-w-[120px]"
                  />
                </div>
              )}

              {(iAmChallenger || iAmChallenged) && (
                <Button
                  onClick={() => playMutation.mutate()}
                  disabled={mutBusy}
                >
                  {playMutation.isPending ? 'Playing…' : 'Play Turn'}
                </Button>
              )}

              {(iAmChallenger || iAmChallenged) && (
                <Button
                  variant="outline"
                  onClick={() => cancelMutation.mutate()}
                  disabled={mutBusy}
                  className="ml-2"
                >
                  {cancelMutation.isPending ? 'Cancelling…' : 'Cancel'}
                </Button>
              )}
            </div>
          )}

          {challenge.status === 'CANCELLED' && (
            <div className="space-y-2">
              <p className="text-sm text-gray-500 dark:text-gray-400">This challenge was cancelled.</p>
              <Button variant="outline" onClick={() => navigate('/challenges')}>
                Back to challenges
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
