import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, Challenge, CreateChallengeBody } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useToast } from '@/hooks/use-toast';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

const challengeSchema = z.object({
  challengedId: z.string().min(1, 'User ID required'),
  gameKey: z.string().min(1, 'Game key required'),
  // react-hook-form valueAsNumber coerces string → number
  entryAmount: z.coerce.number().int().min(0, 'Must be non-negative'),
});

type ChallengeFormValues = z.infer<typeof challengeSchema>;

const STATUS_LABEL: Record<string, string> = {
  PENDING:   'Pending',
  ACTIVE:    'Active',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const STATUS_COLOR: Record<string, string> = {
  PENDING:   'text-yellow-600 dark:text-yellow-400',
  ACTIVE:    'text-green-600 dark:text-green-400',
  COMPLETED: 'text-blue-600 dark:text-blue-400',
  CANCELLED: 'text-gray-500 dark:text-gray-400',
};

export function ChallengesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // ── List challenges ────────────────────────────────────────────────
  const { data: challenges = [], isLoading } = useQuery<Challenge[]>({
    queryKey: ['challenges'],
    queryFn: async () => {
      const res = await api.getUserChallenges();
      return res.data ?? [];
    },
  });

  // ── Create challenge form ─────────────────────────────────────────
  const { register, handleSubmit, formState: { errors }, reset } =
    useForm<ChallengeFormValues>({
      resolver: zodResolver(challengeSchema),
      defaultValues: { challengedId: '', gameKey: '', entryAmount: 0 },
    });

  const createMutation = useMutation({
    mutationFn: (body: ChallengeFormValues) => api.createChallenge(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      toast({ title: 'Challenge sent', description: 'Your challenge has been sent.' });
      reset();
    },
    onError: (err) => {
      let msg = 'Failed to send challenge';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Challenge failed', description: msg, variant: 'destructive' });
    },
  });

  // ── Accept/Decline/Cancel mutations ──────────────────────────────
  const acceptMutation = useMutation({
    mutationFn: (id: string) => api.acceptChallenge(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      toast({ title: 'Challenge accepted' });
      navigate(`/challenges/${id}`);
    },
    onError: (err) => {
      let msg = 'Failed to accept challenge';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const declineMutation = useMutation({
    mutationFn: (id: string) => api.declineChallenge(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      toast({ title: 'Challenge declined' });
    },
    onError: (err) => {
      let msg = 'Failed to decline challenge';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelChallenge(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      toast({ title: 'Challenge cancelled' });
    },
    onError: (err) => {
      let msg = 'Failed to cancel challenge';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const isBusy =
    acceptMutation.isPending || declineMutation.isPending || cancelMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-8">
      {/* ── Challenge list ── */}
      <section>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Challenges</h1>

        {challenges.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 py-8 text-center">
            No challenges yet. Send one below!
          </p>
        ) : (
          <div className="grid gap-3">
            {challenges.map((challenge) => {
              // List endpoint returns challenger.id / challenged.id, not top-level IDs.
              const iAmChallenged = challenge.challenged.id === user?.id;
              const iAmChallenger = challenge.challenger.id === user?.id;
              const gameName = challenge.gameName ?? challenge.game?.name ?? '—';

              return (
                <Card key={challenge.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-base">{gameName}</CardTitle>
                      <span className={`text-xs font-semibold ${STATUS_COLOR[challenge.status] ?? ''}`}>
                        {STATUS_LABEL[challenge.status] ?? challenge.status}
                      </span>
                    </div>
                    <CardDescription>
                      {iAmChallenger
                        ? `You challenged ${challenge.challenged.displayName ?? challenge.challenged.username}`
                        : `${challenge.challenger.displayName ?? challenge.challenger.username} challenged you`}
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="pb-2 flex flex-wrap gap-4 text-sm text-gray-600 dark:text-gray-400">
                    {challenge.entryAmount > 0 && (
                      <span>Entry: <strong>{challenge.entryAmount} GP</strong></span>
                    )}
                    {challenge.expiresAt && (
                      <span>Expires: {new Date(challenge.expiresAt).toLocaleDateString()}</span>
                    )}
                    {challenge.status === 'COMPLETED' && challenge.winnerId && (
                      <span className="font-medium text-green-600 dark:text-green-400">
                        {challenge.winnerId === user?.id ? 'You won!' : 'Opponent won'}
                      </span>
                    )}
                    {challenge.status === 'COMPLETED' && challenge.winnerId === null && (
                      <span className="font-medium text-gray-500">Tie</span>
                    )}
                  </CardContent>

                  <CardFooter className="flex flex-wrap gap-2 pt-2">
                    {/* Challenged party sees Accept / Decline on PENDING challenges */}
                    {challenge.status === 'PENDING' && iAmChallenged && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => acceptMutation.mutate(challenge.id)}
                          disabled={isBusy}
                        >
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => declineMutation.mutate(challenge.id)}
                          disabled={isBusy}
                        >
                          Decline
                        </Button>
                      </>
                    )}

                    {/* Challenger can cancel PENDING or ACTIVE */}
                    {(challenge.status === 'PENDING' || challenge.status === 'ACTIVE') && iAmChallenger && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => cancelMutation.mutate(challenge.id)}
                        disabled={isBusy}
                      >
                        Cancel
                      </Button>
                    )}

                    {/* Both parties can view / play ACTIVE challenges */}
                    {challenge.status === 'ACTIVE' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => navigate(`/challenges/${challenge.id}`)}
                      >
                        Play
                      </Button>
                    )}

                    {/* View completed challenges */}
                    {challenge.status === 'COMPLETED' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => navigate(`/challenges/${challenge.id}`)}
                      >
                        View result
                      </Button>
                    )}
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ── New challenge form ── */}
      <section className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Challenge a Friend</h2>
        <form
          onSubmit={handleSubmit((data) => createMutation.mutate(data))}
          className="space-y-4"
        >
          <div>
            <label htmlFor="challengedId" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Friend's User ID
            </label>
            <Input
              id="challengedId"
              placeholder="paste-their-uuid-here"
              {...register('challengedId')}
              disabled={createMutation.isPending}
              className="mt-1"
            />
            {errors.challengedId && (
              <p className="mt-1 text-sm text-red-600 dark:text-red-400" role="alert">
                {errors.challengedId.message}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="gameKey" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Game
            </label>
            <Input
              id="gameKey"
              placeholder="dice · lucky_spin · number_challenge · trivia"
              {...register('gameKey')}
              disabled={createMutation.isPending}
              className="mt-1"
            />
            {errors.gameKey && (
              <p className="mt-1 text-sm text-red-600 dark:text-red-400" role="alert">
                {errors.gameKey.message}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="entryAmount" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Entry Amount (GP)
            </label>
            <Input
              id="entryAmount"
              type="number"
              min={0}
              step={1}
              {...register('entryAmount', { valueAsNumber: true })}
              disabled={createMutation.isPending}
              className="mt-1"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              0 = free challenge. Both players pay entry; winner takes the pot.
            </p>
            {errors.entryAmount && (
              <p className="mt-1 text-sm text-red-600 dark:text-red-400" role="alert">
                {errors.entryAmount.message}
              </p>
            )}
          </div>

          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Sending…' : 'Send Challenge'}
          </Button>

          {createMutation.isError && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {(createMutation.error as Error)?.message ?? 'Something went wrong'}
            </p>
          )}
        </form>
      </section>
    </div>
  );
}
