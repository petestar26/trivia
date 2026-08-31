import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, Competition } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useSocket } from '@/providers/socket-provider';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface LeaderboardEntry {
  userId: string;
  score: number;
  gamesPlayed: number;
}

interface TriviaQuestion {
  id: string;
  question: string;
  choices: string[];
  category: string | null;
  difficulty: number;
}

interface PlayCompetitionResult {
  phase?: 'question' | 'answer';
  score?: number;
  result?: {
    questionId: string;
    answerIndex: number;
    correct: boolean;
  };
  accumulatedScore?: number;
  gamesPlayed?: number;
  question?: TriviaQuestion;
}

export function CompetitionDetailPage() {
  const { groupId, competitionId } = useParams<{ groupId: string; competitionId: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();     // ← declared before any conditional
  const { toast } = useToast();

  // ── Fetch competition (membership enforced server-side) ─────────────
  const { data: competition, isLoading: compLoading, isError: compError } = useQuery<Competition>({
    queryKey: ['competition', groupId, competitionId],
    queryFn: async () => {
      const res = await api.getCompetitionForGroup(groupId!, competitionId!);
      return res.data!;
    },
    enabled: !!groupId && !!competitionId,
    refetchOnWindowFocus: true,
  });

  // ── Fetch group info for UX role display (not for security) ────────
  // Security is enforced server-side; this is display-only.
  const { data: groupInfo, isLoading: groupLoading } = useQuery<{
    isMember: boolean;
    memberRole?: string;
  }>({
    queryKey: ['group', groupId],
    queryFn: async () => {
      const res = await api.get<{ isMember: boolean; memberRole?: string }>(`/groups/${groupId}`);
      return res.data ?? { isMember: false };
    },
    enabled: !!groupId && !!user?.id,
  });

  // ── Derived participant / leaderboard state ─────────────────────────
  // Always initialised here so hooks are never called conditionally.
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

  useEffect(() => {
    if (!competition?.participants) return;
    const sorted = [...competition.participants].sort(
      (a, b) => b.score - a.score || b.gamesPlayed - a.gamesPlayed,
    );
    setLeaderboard(sorted);
  }, [competition?.participants]);

  // ── Socket: refresh on competition events (payload is NOT authoritative) ──
  const { socket } = useSocket();
  useEffect(() => {
    if (!socket || !competitionId) return;

    const refresh = (payload: { competitionId?: string }) => {
      if (!payload.competitionId || payload.competitionId === competitionId) {
        queryClient.invalidateQueries({ queryKey: ['competition', groupId, competitionId] });
        queryClient.invalidateQueries({ queryKey: ['wallet'] });
      }
    };

    socket.on('competition:ended', refresh);
    return () => { socket.off('competition:ended', refresh); };
  }, [socket, competitionId, groupId, queryClient]);

  // ── Mutations ─────────────────────────────────────────────────────
  const joinMutation = useMutation({
    mutationFn: () => api.joinCompetition(groupId!, competitionId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['competition', groupId, competitionId] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      toast({ title: 'Joined competition' });
    },
    onError: (err) => {
      let msg = 'Failed to join';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const playMutation = useMutation({
    mutationFn: (clientData?: Record<string, unknown>) => api.playCompetition(groupId!, competitionId!, clientData),
    onSuccess: (data) => {
      // Handle two-phase trivia flow
      if (isTriviaCompetition && data.phase === 'question' && data.question) {
        // Phase 1: question served - show it to the user
        setTriviaQuestion(data.question);
        setShowTriviaQuestion(true);
        setSelectedAnswer(null);
        return;
      }
      
      // Phase 2 or normal game: show result
      const score = data.score ?? 0;
      if (data.result?.correct === false) {
        toast({ title: 'Incorrect', description: `Better luck next round!` });
      } else if (data.result?.correct === true) {
        toast({ title: 'Correct!', description: `+${score} points` });
      } else if (score !== 0) {
        toast({ title: 'Turn complete', description: `Score this round: ${score}` });
      }
      
      // Reset trivia state
      setTriviaQuestion(null);
      setShowTriviaQuestion(false);
      setSelectedAnswer(null);
      
      queryClient.invalidateQueries({ queryKey: ['competition', groupId, competitionId] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
    },
    onError: (err) => {
      let msg = 'Failed to play';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: () => api.finalizeCompetition(groupId!, competitionId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['competition', groupId, competitionId] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      toast({ title: 'Competition finalized' });
    },
    onError: (err) => {
      let msg = 'Failed to finalize';
      try { msg = JSON.parse((err as Error).message)?.message ?? msg; } catch { /* noop */ }
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  // ── Trivia competition state ───────────────────────────────────────
  const [triviaQuestion, setTriviaQuestion] = useState<TriviaQuestion | null>(null);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [showTriviaQuestion, setShowTriviaQuestion] = useState(false);
  const [isTriviaCompetition, setIsTriviaCompetition] = useState(false);

  // Track if this is a trivia competition
  useEffect(() => {
    if (competition?.game?.key === 'trivia') {
      setIsTriviaCompetition(true);
    } else {
      setIsTriviaCompetition(false);
    }
  }, [competition?.game?.key]);

  // ── Loading / error guards — AFTER all hooks ───────────────────────
  const isLoading = compLoading || groupLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (compError || !competition) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <Card>
          <CardContent className="py-8 text-center text-gray-500 dark:text-gray-400">
            Competition not found, or you are not an active member of this group.
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Derived display values ────────────────────────────────────────
  const gameName = competition.game?.name ?? '—';
  const iAmParticipant = competition.participants?.some((p) => p.userId === user?.id) ?? false;
  // Role is for UX display only — backend re-validates on every mutating request.
  const isManager = groupInfo?.memberRole === 'OWNER' || groupInfo?.memberRole === 'ADMIN';
  const canFinalize = isManager;

  const isScheduled  = competition.status === 'SCHEDULED';
  const isActive     = competition.status === 'ACTIVE';
  const isCompleted  = competition.status === 'COMPLETED';
  const isCancelled  = competition.status === 'CANCELLED';

  const mutBusy = joinMutation.isPending || playMutation.isPending || finalizeMutation.isPending;

  // ── Finalized / completed view ────────────────────────────────────
  if (isCompleted && competition.finalizedAt) {
    const myEntry = leaderboard.find((p) => p.userId === user?.id);
    const myRank  = myEntry ? leaderboard.indexOf(myEntry) + 1 : null;
    const iWon    = myRank === 1;

    return (
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{competition.title} — Final Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Finalized {new Date(competition.finalizedAt!).toLocaleString()}
            </p>

            {myRank && (
              <p className={`text-lg font-bold ${iWon ? 'text-green-600 dark:text-green-400' : ''}`}>
                {iWon ? `You won! 🎉` : `Your rank: #${myRank}`}
              </p>
            )}

            {(competition.rewardGamePoints > 0 || competition.rewardCoins > 0) && (
              <div className="text-sm text-gray-600 dark:text-gray-400">
                <p className="font-medium">Rewards (winner):</p>
                {competition.rewardGamePoints > 0 && <p>{competition.rewardGamePoints} GP</p>}
                {competition.rewardCoins > 0 && <p>{competition.rewardCoins} Coins</p>}
              </div>
            )}
          </CardContent>
        </Card>

        <LeaderboardTable entries={leaderboard} currentUserId={user?.id} />
      </div>
    );
  }

  // ── Active / scheduled / pre-finalize view ─────────────────────────
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{competition.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Competition metadata */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500 dark:text-gray-400">Game</p>
              <p className="font-semibold">{gameName}</p>
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400">Status</p>
              <p className={`font-semibold ${
                isScheduled ? 'text-yellow-600 dark:text-yellow-400' :
                isActive    ? 'text-green-600 dark:text-green-400'  :
                isCompleted ? 'text-blue-600 dark:text-blue-400'    :
                'text-gray-500'
              }`}>
                {competition.status}
              </p>
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400">Entry</p>
              <p className="font-semibold">{competition.entryAmount > 0 ? `${competition.entryAmount} GP` : 'Free'}</p>
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400">Max players</p>
              <p className="font-semibold">{competition.maxParticipants ?? 'Unlimited'}</p>
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400">Starts</p>
              <p className="font-semibold">{new Date(competition.startsAt).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400">Ends</p>
              <p className="font-semibold">{new Date(competition.endsAt).toLocaleString()}</p>
            </div>
          </div>

          {/* Rewards */}
          {(competition.rewardGamePoints > 0 || competition.rewardCoins > 0) && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg text-sm">
              <p className="font-medium text-amber-800 dark:text-amber-300">Winner rewards:</p>
              {competition.rewardGamePoints > 0 && (
                <p className="text-amber-700 dark:text-amber-400">{competition.rewardGamePoints} GP</p>
              )}
              {competition.rewardCoins > 0 && (
                <p className="text-amber-700 dark:text-amber-400">{competition.rewardCoins} Coins</p>
              )}
            </div>
          )}

          {/* Join — SCHEDULED competitions open for joining */}
          {isScheduled && !iAmParticipant && (
            <Button
              onClick={() => joinMutation.mutate()}
              disabled={mutBusy}
              className="w-full"
            >
              {joinMutation.isPending ? 'Joining…' : `Join Competition${competition.entryAmount > 0 ? ` (${competition.entryAmount} GP)` : ''}`}
            </Button>
          )}

          {isScheduled && iAmParticipant && (
            <p className="text-sm text-green-600 dark:text-green-400 font-medium">
              ✓ You are registered — the competition will start soon.
            </p>
          )}

          {/* Play — ACTIVE competitions */}
          {isActive && iAmParticipant && (
            <div className="space-y-3">
              {/* Trivia Competition - Two Phase */}
              {isTriviaCompetition && (
                <div className="space-y-4">
                  {showTriviaQuestion && triviaQuestion && (
                    <Card className="border-primary-500">
                      <CardHeader>
                        <CardTitle className="text-primary-600 dark:text-primary-400">
                          {triviaQuestion.category && (
                            <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mr-2">
                              {triviaQuestion.category}
                            </span>
                          )}
                          Trivia Question
                        </CardTitle>
                        <CardDescription>
                          {triviaQuestion.difficulty && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              Difficulty: {triviaQuestion.difficulty}/5
                            </span>
                          )}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                          {triviaQuestion.question}
                        </h3>
                        <div className="space-y-2">
                          {triviaQuestion.choices.map((choice, i) => (
                            <button
                              key={i}
                              onClick={() => setSelectedAnswer(i)}
                              disabled={playMutation.isPending}
                              className={`w-full text-left px-4 py-3 rounded-lg border text-sm font-medium transition-colors ${
                                selectedAnswer === i
                                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                                  : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
                              }`}
                            >
                              {choice}
                            </button>
                          ))}
                        </div>
                        <Button
                          onClick={() => {
                            if (selectedAnswer === null) return;
                            playMutation.mutate({
                              questionId: triviaQuestion!.id,
                              answerIndex: selectedAnswer,
                            });
                          }}
                          disabled={playMutation.isPending || selectedAnswer === null}
                          className="w-full"
                        >
                          {playMutation.isPending ? 'Checking…' : 'Submit Answer'}
                        </Button>
                      </CardContent>
                    </Card>
                  )}
                  {!showTriviaQuestion && (
                    <Button
                      onClick={() => playMutation.mutate({})}
                      disabled={mutBusy}
                      className="w-full"
                    >
                      {playMutation.isPending ? 'Playing…' : 'Play a round'}
                    </Button>
                  )}
                </div>
              )}
              {!isTriviaCompetition && (
                <Button
                  onClick={() => playMutation.mutate({})}
                  disabled={mutBusy}
                  className="w-full"
                >
                  {playMutation.isPending ? 'Playing…' : 'Play a round'}
                </Button>
              )}
            </div>
          )}

          {isActive && !iAmParticipant && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              You did not join this competition before it started.
            </p>
          )}

          {/* Cancelled */}
          {isCancelled && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              This competition was cancelled.
            </p>
          )}

          {/* Completed but not yet finalized */}
          {isCompleted && !competition.finalizedAt && (
            <div className="space-y-2">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Competition has ended — awaiting finalization.
              </p>
              {canFinalize && (
                <Button
                  onClick={() => finalizeMutation.mutate()}
                  disabled={mutBusy}
                  className="w-full"
                >
                  {finalizeMutation.isPending ? 'Finalizing…' : 'Finalize & distribute rewards'}
                </Button>
              )}
            </div>
          )}

          {/* Manager panel (UX only — authorization enforced server-side) */}
          {isManager && (isScheduled || isActive) && (
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg text-sm space-y-2">
              <p className="font-medium text-blue-800 dark:text-blue-300">Manager actions</p>
              <Button
                size="sm"
                onClick={() => finalizeMutation.mutate()}
                disabled={mutBusy}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                {finalizeMutation.isPending ? 'Finalizing…' : 'Finalize now'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Leaderboard */}
      <LeaderboardTable entries={leaderboard} currentUserId={user?.id} />
    </div>
  );
}

// ── Sub-component: leaderboard ────────────────────────────────────────
function LeaderboardTable({
  entries,
  currentUserId,
}: {
  entries: LeaderboardEntry[];
  currentUserId?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Leaderboard</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
            No participants yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 pr-4 text-left font-medium text-gray-500 dark:text-gray-400">Rank</th>
                  <th className="py-2 pr-4 text-left font-medium text-gray-500 dark:text-gray-400">Player</th>
                  <th className="py-2 pr-4 text-right font-medium text-gray-500 dark:text-gray-400">Score</th>
                  <th className="py-2 text-right font-medium text-gray-500 dark:text-gray-400">Rounds</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, idx) => {
                  const isMe = entry.userId === currentUserId;
                  // Tie detection: same score as the row before → same rank
                  const prevScore = entries[idx - 1]?.score;
                  const rank = prevScore === entry.score ? '—' : idx + 1;

                  return (
                    <tr
                      key={entry.userId}
                      className={`border-b border-gray-100 dark:border-gray-800 ${
                        isMe ? 'bg-primary-50 dark:bg-primary-900/20' : ''
                      }`}
                    >
                      <td className="py-2 pr-4 font-semibold">
                        {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : rank}
                      </td>
                      <td className="py-2 pr-4">
                        <span className={isMe ? 'font-semibold text-primary-600 dark:text-primary-400' : ''}>
                          {isMe ? 'You' : `${entry.userId.slice(0, 8)}…`}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-right font-semibold">
                        {entry.score}
                      </td>
                      <td className="py-2 text-right text-gray-500 dark:text-gray-400">
                        {entry.gamesPlayed}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
