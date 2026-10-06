import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import type { GameCatalogEntry, GamePlayResult } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useDurablePlay } from '@/hooks/use-durable-play';
import { useCasino } from '@/components/casino/CasinoProvider';
import { CasinoShell } from '@/components/casino/CasinoShell';
import { CasinoRendererSlot } from '@/components/casino/CasinoRendererSlot';

interface TriviaQuestion {
  id: string;
  question: string;
  choices: string[];
  category: string | null;
  difficulty: number;
}

type TriviaResult = {
  questionId: string;
  submittedAnswer: number;
  correctIndex: number;
  correct: boolean;
};

interface TriviaPlayResult extends GamePlayResult {
  result: TriviaResult;
}

function parsePlayError(error: unknown): string {
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as { message?: string };
      if (parsed?.message) return parsed.message;
    } catch {
      // not JSON
    }
    return error.message;
  }
  return 'Something went wrong';
}

export function TriviaGamePage() {
  const { user } = useAuth();
  const { phase, setPhase, refetchBalance } = useCasino();
  const [selected, setSelected] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<TriviaResult | null>(null);
  const [serverBalance, setServerBalance] = useState<number | null>(null);
  const [isReplay, setIsReplay] = useState(false);
  const queryClient = useQueryClient();

  const { data: games } = useQuery<GameCatalogEntry[]>({
    queryKey: ['games'],
    queryFn: async () => unwrapData(await api.get<GameCatalogEntry[]>('/games'), 'Games response'),
  });
  const game = games?.find((g) => g.key === 'trivia');

  const { play, pending, needsResume, pendingDiffersFrom, storageError, mutation: playMutation } = useDurablePlay<TriviaPlayResult>('trivia', {
    onStart: () => setPhase('RUNNING'),
    onSettled: (round, replayed) => {
      setLastResult(round.result);
      setServerBalance(round.newBalance);
      setIsReplay(replayed);
      setPhase(round.isWin ? 'RESULT' : 'SETTLED');
      refetchBalance();
      queryClient.invalidateQueries({ queryKey: ['game-history'] });
      queryClient.invalidateQueries({ queryKey: ['trivia-questions', user?.id] });
    },
    onFailed: () => setPhase('BETTING_OPEN'),
  }, { autoResume: false });

  const resumeQuestionId = typeof pending?.body.questionId === 'string'
    ? pending.body.questionId
    : undefined;
  const {
    data: questionData,
    refetch: refetchQuestion,
    isFetching,
    isError: questionLoadError,
  } = useQuery<TriviaQuestion[]>({
    queryKey: ['trivia-questions', user?.id ?? null, resumeQuestionId ?? null],
    queryFn: async () => unwrapData(
      await api.get<TriviaQuestion[]>('/games/questions', { resumeQuestionId }),
      'Trivia questions response',
    ),
    enabled: !!user?.id,
  });

  const questions = useMemo(() => questionData ?? [], [questionData]);
  const [current, setCurrent] = useState<TriviaQuestion | null>(null);
  const availableNextQuestions = questions.filter((question) => question.id !== lastResult?.questionId);
  const resumedKey = useRef<string | null>(null);

  useEffect(() => {
    // If a saved answer is being replayed after reload, wait for the
    // resumeQuestionId response rather than showing a different question.
    if (pending) return;
    if (questions.length > 0 && !current && !lastResult) {
      setCurrent(questions[Math.floor(Math.random() * questions.length)]);
    }
  }, [questions, current, lastResult, pending]);

  // An unconfirmed answer (a lost response, a reload) is the question on
  // screen until the server confirms it.
  useEffect(() => {
    if (!pending) return;
    const question = questions.find((q) => q.id === pending.body.questionId);
    if (question && current?.id !== question.id) setCurrent(question);
    if (typeof pending.body.answerIndex === 'number') setSelected(pending.body.answerIndex);
  }, [pending, questions, current]);

  useEffect(() => {
    if (!pending || !needsResume || isFetching || resumedKey.current === pending.key) return;
    // Let the authenticated question feed restore this exact prompt first;
    // then replay the stored request byte-for-byte, even if the prompt has
    // since been retired and the feed can no longer return it.
    resumedKey.current = pending.key;
    play(pending.body);
  }, [pending, needsResume, isFetching, play]);

  const submit = () => {
    if (selected === null || !current) return;
    play({ questionId: current.id, answerIndex: selected });
  };
  const confirmingEarlierRound = selected !== null && current !== null
    && pendingDiffersFrom({ questionId: current.id, answerIndex: selected });

  return (
    <CasinoShell
      gameKey="trivia"
      gameName="Trivia"
      rulesVersion={game?.currentRulesVersion}
      phase={phase}
    >
      <CasinoRendererSlot gameKey="trivia" gameName="Trivia" className="space-y-4">
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-950 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-100">
          <span className="font-semibold">Free to play.</span> No Coins are wagered. Correct answers award restricted bonus Coins; playthrough rules apply.
        </div>

        {current ? (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {current.category || 'General'}
              </span>
              {lastResult && (
                <span className={`text-xs font-semibold ${lastResult.correct ? 'text-green-600' : 'text-red-600'}`}>
                  {lastResult.correct ? 'Correct!' : 'Incorrect'}
                </span>
              )}
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{current.question}</h3>
            <div className="space-y-2">
              {current.choices.map((choice, i) => (
                <button
                  key={`${current.id}-${i}`}
                  type="button"
                  onClick={() => setSelected(i)}
                  disabled={playMutation.isPending || !!lastResult}
                  className={`w-full text-left px-4 py-3 rounded-lg border text-sm font-medium transition-colors ${
                    selected === i
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                      : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  {choice}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 text-center text-gray-500 dark:text-gray-400" role={questionLoadError ? 'alert' : 'status'}>
            {questionLoadError
              ? 'Questions could not be loaded.'
              : isFetching || pending
                ? 'Loading question…'
                : lastResult
                  ? 'That question is no longer available.'
                  : 'No unanswered questions available right now.'}
            {questionLoadError && (
              <button type="button" onClick={() => refetchQuestion()} className="ml-2 font-semibold text-primary-600 hover:underline">
                Try again
              </button>
            )}
          </div>
        )}

        {current && !lastResult && (
          <button
            type="button"
            onClick={submit}
            disabled={selected === null || playMutation.isPending}
            className="w-full px-6 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {playMutation.isPending ? 'Checking…' : 'Submit Answer'}
          </button>
        )}

        {pending && (
          <button
            type="button"
            disabled={playMutation.isPending}
            onClick={() => play(pending.body)}
            className="w-full rounded-lg border border-amber-400 px-6 py-3 font-semibold disabled:opacity-50"
          >
            {playMutation.isPending ? 'Confirming answer…' : 'Confirm pending answer'}
          </button>
        )}

        {confirmingEarlierRound && (
          <div className="text-sm text-amber-700 dark:text-amber-400">
            Your previous answer has not been confirmed yet. Submitting confirms that answer first.
          </div>
        )}

        {storageError && <div role="alert" className="text-sm text-red-600 dark:text-red-400">{storageError}</div>}

        {playMutation.isError && (
          <div role="alert" className="text-sm text-red-600 dark:text-red-400">
            {parsePlayError(playMutation.error)}
          </div>
        )}

        {lastResult && (
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 text-center">
            {lastResult.correct ? (
              <div className="text-green-600 dark:text-green-400 font-semibold">
                Correct! +{playMutation.data?.data.rewardAmount ?? 0} bonus Coins
              </div>
            ) : (
              <div className="text-red-600 dark:text-red-400 font-semibold">
                Incorrect — better luck on the next one
              </div>
            )}
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Bonus Coins remain restricted until qualifying playthrough is complete.</p>
            {serverBalance !== null && (
              <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Balance: <span className="font-semibold text-primary-600 dark:text-primary-400">{serverBalance} Coins</span>
              </div>
            )}
            {isReplay && (
              <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Replayed answer — no additional reward.
              </div>
            )}
          </div>
        )}

        {lastResult && (
          <button
            type="button"
            onClick={() => {
              const next = availableNextQuestions[Math.floor(Math.random() * availableNextQuestions.length)] ?? null;
              setCurrent(next);
              setLastResult(null);
              setSelected(null);
              playMutation.reset();
            }}
            disabled={isFetching || availableNextQuestions.length === 0}
            className="w-full px-6 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {isFetching ? 'Loading…' : availableNextQuestions.length ? 'Next Question' : 'No more questions right now'}
          </button>
        )}
      </CasinoRendererSlot>
    </CasinoShell>
  );
}
