import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEffect } from 'react';

interface TriviaQuestion {
  id: string;
  question: string;
  choices: string[];
  category: string | null;
  difficulty: number;
}

interface TriviaResult {
  questionId: string;
  submittedAnswer: number;
  correctIndex: number;
  correct: boolean;
}

interface TriviaPlayResult {
  rewardAmount: number;
  isWin: boolean;
  result: TriviaResult;
  newBalance: number;
}

export function TriviaGamePage() {
  const [bet, setBet] = useState(20);
  const [selected, setSelected] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<TriviaResult | null>(null);
  const [serverBalance, setServerBalance] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const { data: games } = useQuery<{ data: { minBet: number; maxBet: number }[] }>({
    queryKey: ['games'],
    queryFn: async () => api.get('/games'),
  });
  const game = games?.data?.find((g) => g.key === 'trivia');

  const { data: questionData, refetch: refetchQuestion, isFetching } = useQuery<
    { data: TriviaQuestion[] }
  >({
    queryKey: ['trivia-questions'],
    queryFn: async () => api.get('/games/questions'),
    enabled: false,
  });

  useEffect(() => {
    refetchQuestion();
  }, [refetchQuestion]);

  const questions = questionData?.data ?? [];
  const [current, setCurrent] = useState<TriviaQuestion | null>(null);

  useEffect(() => {
    if (questions.length > 0 && !current) {
      setCurrent(questions[Math.floor(Math.random() * questions.length)]);
    }
  }, [questions, current]);

  const playMutation = useMutation({
    mutationFn: async (payload: { betAmount: number; questionId: string; answerIndex: number }) => {
      const res = await api.post<TriviaPlayResult>('/games/trivia/play', payload);
      return res.data;
    },
    onSuccess: (data) => {
      setLastResult(data.result);
      setServerBalance(data.newBalance);
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
    },
  });

  const minBet = game?.minBet ?? 5;
  const maxBet = game?.maxBet ?? 100;

  const submit = () => {
    if (selected === null || !current) return;
    playMutation.mutate({
      betAmount: bet,
      questionId: current.id,
      answerIndex: selected,
    });
  };

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Trivia</h1>
        <p className="text-gray-600 dark:text-gray-400">Answer correctly to win 3x your bet!</p>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Bet amount</label>
        <input
          type="number"
          min={minBet}
          max={maxBet}
          value={bet}
          onChange={(e) => setBet(parseInt(e.target.value, 10) || 0)}
          className="w-full mt-1 rounded-lg border border-gray-300 dark:border-gray-600 p-3"
        />
        <div className="mt-2 text-xs text-gray-500">Min {minBet} · Max {maxBet} GP</div>
      </div>

      {current ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {current.category || 'General'}
            </span>
            {lastResult && (
              <span
                className={`text-xs font-semibold ${
                  lastResult.correct ? 'text-green-600' : 'text-red-600'
                }`}
              >
                {lastResult.correct ? 'Correct!' : 'Incorrect'}
              </span>
            )}
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{current.question}</h3>
          <div className="space-y-2">
            {current.choices.map((choice, i) => (
              <button
                key={i}
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
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 text-center text-gray-500">
          {isFetching ? 'Loading question…' : 'No questions available.'}
        </div>
      )}

      <button
        onClick={submit}
        disabled={selected === null || playMutation.isPending || !!lastResult}
        className="w-full px-6 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 disabled:opacity-50"
      >
        {playMutation.isPending ? 'Checking…' : 'Submit Answer'}
      </button>

      {playMutation.isError && (
        <div className="text-sm text-red-600 dark:text-red-400">
          {(playMutation.error as Error)?.message || 'Something went wrong'}
        </div>
      )}

      {lastResult && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 text-center">
          {lastResult.correct ? (
            <div className="text-green-600 dark:text-green-400 font-semibold">
              Correct! +{playMutation.data?.rewardAmount ?? 0} GP
            </div>
          ) : (
            <div className="text-red-600 dark:text-red-400 font-semibold">
              Incorrect — better luck on the next one
            </div>
          )}
          {serverBalance !== null && (
            <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Balance: <span className="font-semibold text-primary-600 dark:text-primary-400">{serverBalance} GP</span>
            </div>
          )}
        </div>
      )}

      {lastResult && (
        <button
          onClick={() => {
            setCurrent(questions[Math.floor(Math.random() * questions.length)] ?? null);
            setLastResult(null);
            setSelected(null);
            playMutation.reset();
          }}
          className="w-full px-6 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700"
        >
          Next Question
        </button>
      )}
    </div>
  );
}
