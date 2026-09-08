import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, Challenge, CreateChallengeBody, UserSearchResult } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useToast } from '@/hooks/use-toast';
import { getErrorMessage, getErrorStatus } from '@/lib/error-message';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

const challengeSchema = z.object({
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

// Mirrors the backend's own username validation (POST /users/search) so the
// frontend only fires requests the server can actually match — the backend
// remains authoritative on what counts as a valid identifier.
const USERNAME_RE = /^[A-Za-z0-9_]{3,30}$/;
// Permissive on purpose: just enough to avoid firing on an obviously
// malformed address. The backend's own email schema is authoritative.
const PERMISSIVE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isSearchableQuery(q: string): boolean {
  if (!q) return false;
  return q.includes('@') ? PERMISSIVE_EMAIL_RE.test(q) : USERNAME_RE.test(q);
}

// Only the messages createChallenge actually throws today are mapped to
// friendly copy; anything else falls back to a generic message rather than
// surfacing an arbitrary server string.
const CHALLENGE_ERROR_MESSAGES: Record<string, string> = {
  'Challenged user not found': 'This user is no longer available to challenge.',
  'Cannot challenge yourself': "You can't challenge yourself.",
  'Insufficient Game Points for entry': "You don't have enough Game Points for this entry amount.",
  'Game not found': "That game isn't available right now.",
  'This game is currently unavailable': "That game isn't available right now.",
  'Entry amount must be a non-negative integer': 'Entry amount must be a non-negative integer.',
};
const GENERIC_CHALLENGE_ERROR = "Couldn't send the challenge. Please try again.";

function mapChallengeError(err: unknown): string {
  const message = getErrorMessage(err, GENERIC_CHALLENGE_ERROR);
  return CHALLENGE_ERROR_MESSAGES[message] ?? GENERIC_CHALLENGE_ERROR;
}

function RecipientAvatar({ user }: { user: Pick<UserSearchResult, 'avatarUrl' | 'displayName' | 'username'> }) {
  const initial = (user.displayName || user.username)[0]?.toUpperCase() ?? '?';
  return (
    <span className="h-8 w-8 flex-shrink-0 rounded-full bg-primary-100 dark:bg-primary-900 flex items-center justify-center overflow-hidden">
      {user.avatarUrl ? (
        // eslint-disable-next-line jsx-a11y/alt-text
        <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-sm font-medium text-primary-600 dark:text-primary-400">{initial}</span>
      )}
    </span>
  );
}

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

  // ── Recipient search (privacy-safe; never cached in React Query) ───
  const [searchText, setSearchText] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedRecipient, setSelectedRecipient] = useState<UserSearchResult | null>(null);
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [searchError, setSearchError] = useState<'RATE_LIMITED' | 'GENERIC' | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [lastCompletedQuery, setLastCompletedQuery] = useState<string | null>(null);
  const requestGenRef = useRef(0);

  const searchMutation = useMutation({
    mutationFn: (q: string) => api.searchUsers(q),
    retry: 0,
  });

  // Debounce: only update debouncedQuery ~300ms after the user stops typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchText.trim()), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  // Fire (or clear) a search whenever the debounced query changes. Keyed
  // only on debouncedQuery — searchMutation's own identity is stable but
  // re-created each render, and is deliberately excluded so this doesn't
  // re-fire on every render.
  useEffect(() => {
    const q = debouncedQuery;
    if (!isSearchableQuery(q)) {
      requestGenRef.current += 1;
      setResults([]);
      setSearchError(null);
      setIsSearching(false);
      setLastCompletedQuery(null);
      return;
    }

    const gen = ++requestGenRef.current;
    setIsSearching(true);
    setSearchError(null);

    searchMutation.mutate(q, {
      onSuccess: (res) => {
        if (gen !== requestGenRef.current) return; // superseded by a newer query
        setResults(res.data ?? []);
        setSearchError(null);
        setIsSearching(false);
        setLastCompletedQuery(q);
      },
      onError: (err) => {
        if (gen !== requestGenRef.current) return; // superseded by a newer query
        setResults([]);
        setIsSearching(false);
        setSearchError(getErrorStatus(err) === 429 ? 'RATE_LIMITED' : 'GENERIC');
        setLastCompletedQuery(q);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  const handleSearchChange = (value: string) => {
    setSearchText(value);
    if (selectedRecipient) {
      // Editing after a selection must invalidate it immediately. Stale
      // results are NOT cleared here — `resultsCurrent` (lastCompletedQuery
      // === debouncedQuery) already hides them until a genuinely different
      // query completes, and preserving them lets the picker fall straight
      // back to a still-valid result set instead of going blank.
      requestGenRef.current += 1;
      setSelectedRecipient(null);
      setSearchError(null);
    }
  };

  const handleSelectRecipient = (u: UserSearchResult) => {
    requestGenRef.current += 1;
    setSelectedRecipient(u);
    setSearchError(null);
    setIsSearching(false);
    // results/lastCompletedQuery are intentionally kept — the dropdown is
    // hidden while selectedRecipient is set, and keeping them lets Remove
    // restore the list without an unnecessary re-search.
  };

  const handleRemoveRecipient = () => {
    requestGenRef.current += 1;
    setSelectedRecipient(null);
    setSearchError(null);
    // searchText, results, and lastCompletedQuery are intentionally
    // preserved: if the debounced query hasn't changed, resultsCurrent is
    // still true and the prior result list reappears immediately with no
    // extra request, instead of leaving the picker in a dead, resultless
    // state until the user retypes something.
  };

  const searchable = isSearchableQuery(debouncedQuery);
  const resultsCurrent = lastCompletedQuery === debouncedQuery;
  const showSearching = !selectedRecipient && searchable && isSearching;
  const showRateLimited = !selectedRecipient && !isSearching && searchError === 'RATE_LIMITED';
  const showGenericError = !selectedRecipient && !isSearching && searchError === 'GENERIC';
  const showNoResults =
    !selectedRecipient && !isSearching && !searchError && searchable && resultsCurrent && results.length === 0;
  const showResults =
    !selectedRecipient && !isSearching && !searchError && resultsCurrent && results.length > 0;
  const showDropdown = showSearching || showRateLimited || showGenericError || showNoResults || showResults;

  // ── Create challenge form ─────────────────────────────────────────
  const { register, handleSubmit, formState: { errors }, reset } =
    useForm<ChallengeFormValues>({
      resolver: zodResolver(challengeSchema),
      defaultValues: { gameKey: '', entryAmount: 0 },
    });

  const createMutation = useMutation({
    mutationFn: (body: CreateChallengeBody) => api.createChallenge(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      toast({ title: 'Challenge sent', description: 'Your challenge has been sent.' });
      reset();
      requestGenRef.current += 1;
      setSelectedRecipient(null);
      setSearchText('');
      setDebouncedQuery('');
      setResults([]);
      setSearchError(null);
      setLastCompletedQuery(null);
    },
    onError: (err) => {
      // Deliberately does NOT clear selectedRecipient — e.g. a "Challenged
      // user not found" 404 (the recipient went non-ACTIVE after selection)
      // should leave the form usable so the user can intentionally Remove
      // or retry, rather than silently losing their selection.
      toast({ title: 'Challenge failed', description: mapChallengeError(err), variant: 'destructive' });
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
      toast({ title: 'Error', description: getErrorMessage(err, 'Failed to accept challenge'), variant: 'destructive' });
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
      toast({ title: 'Error', description: getErrorMessage(err, 'Failed to decline challenge'), variant: 'destructive' });
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
      toast({ title: 'Error', description: getErrorMessage(err, 'Failed to cancel challenge'), variant: 'destructive' });
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
          onSubmit={handleSubmit((values) => {
            if (!selectedRecipient) return;
            createMutation.mutate({
              challengedId: selectedRecipient.id,
              gameKey: values.gameKey,
              entryAmount: values.entryAmount,
            });
          })}
          className="space-y-4"
        >
          <div>
            <label htmlFor="recipientSearch" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Search by username or email
            </label>
            <Input
              id="recipientSearch"
              placeholder="@username or email@example.com"
              value={searchText}
              onChange={(e) => handleSearchChange(e.target.value)}
              disabled={createMutation.isPending}
              autoComplete="off"
              aria-expanded={showDropdown}
              aria-busy={showSearching}
              className="mt-1"
            />

            {!selectedRecipient && (
              <>
                <div aria-live="polite" className="mt-1">
                  {showSearching && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">Searching…</p>
                  )}
                  {showRateLimited && (
                    <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                      Too many searches. Try again shortly.
                    </p>
                  )}
                  {showGenericError && (
                    <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                      Unable to search right now.
                    </p>
                  )}
                  {showNoResults && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">No matching user found.</p>
                  )}
                </div>

                {showResults && (
                  <ul
                    role="listbox"
                    aria-label="Search results"
                    className="mt-1 max-h-72 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800"
                  >
                    {results.map((r) => (
                      <li key={r.id} role="option" aria-selected={false}>
                        <button
                          type="button"
                          onClick={() => handleSelectRecipient(r)}
                          disabled={createMutation.isPending}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                        >
                          <RecipientAvatar user={r} />
                          <span className="min-w-0 flex-1">
                            {r.displayName && (
                              <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">
                                {r.displayName}
                              </span>
                            )}
                            <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                              @{r.username}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {selectedRecipient && (
              <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 p-2">
                <RecipientAvatar user={selectedRecipient} />
                <div className="min-w-0 flex-1">
                  {selectedRecipient.displayName && (
                    <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                      {selectedRecipient.displayName}
                    </p>
                  )}
                  <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                    @{selectedRecipient.username}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Remove selected recipient"
                  onClick={handleRemoveRecipient}
                  disabled={createMutation.isPending}
                >
                  Remove
                </Button>
              </div>
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

          <Button type="submit" disabled={!selectedRecipient || createMutation.isPending}>
            {createMutation.isPending ? 'Sending…' : 'Send Challenge'}
          </Button>

          {createMutation.isError && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {mapChallengeError(createMutation.error)}
            </p>
          )}
        </form>
      </section>
    </div>
  );
}
