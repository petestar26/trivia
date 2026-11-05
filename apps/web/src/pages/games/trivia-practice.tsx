import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';

interface PracticeQuestion {
  id: string;
  question: string;
  choices: string[];
  category: string | null;
  difficulty: number;
}
interface PracticeAnswer {
  questionId: string;
  answerIndex: number;
  correctIndex: number;
  correct: boolean;
  mode: 'practice';
  rewards: false;
}
const endpoint = '/games/trivia-practice';

export function TriviaPracticePage() {
  const { user } = useAuth();
  return user ? (
    <TriviaPracticeSession key={user.id} userId={user.id} />
  ) : (
    <p>Sign in to practise Trivia.</p>
  );
}

function TriviaPracticeSession({ userId }: { userId: string }) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const questions = useQuery({
    queryKey: ['trivia-practice-questions', userId],
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      const data = unwrapData(
        await api.get<{ questions: PracticeQuestion[]; mode: string; rewards: boolean }>(
          `${endpoint}/questions`
        )
      );
      if (data.mode !== 'practice' || data.rewards !== false || !Array.isArray(data.questions))
        throw new Error('Practice questions are unavailable.');
      return data.questions;
    },
  });
  const answer = useMutation({
    mutationFn: async ({
      question,
      answerIndex,
    }: {
      question: PracticeQuestion;
      answerIndex: number;
    }) => {
      const result = unwrapData(
        await api.post<PracticeAnswer>(`${endpoint}/answers`, {
          questionId: question.id,
          answerIndex,
        })
      );
      if (
        result.mode !== 'practice' ||
        result.rewards !== false ||
        result.questionId !== question.id ||
        result.answerIndex !== answerIndex ||
        !Number.isInteger(result.correctIndex) ||
        result.correctIndex < 0 ||
        result.correctIndex >= question.choices.length ||
        result.correct !== (answerIndex === result.correctIndex)
      )
        throw new Error('The practice answer could not be confirmed.');
      return result;
    },
  });
  const question = questions.data?.[questionIndex];
  function nextQuestion() {
    if (answer.isPending || !questions.data?.length) return;
    setQuestionIndex((value) => (value + 1) % questions.data!.length);
    setSelected(null);
    answer.reset();
  }

  return (
    <div className="space-y-6 text-slate-100">
      <Link to="/games" className="text-sm text-rose-200">
        ← Games
      </Link>
      <header className="rounded-2xl border border-rose-300/20 bg-slate-900 p-6">
        <p className="text-xs uppercase tracking-widest text-rose-300">
          Salem Bet originals · Free practice
        </p>
        <h1 className="mt-2 text-3xl font-bold">Trivia practice</h1>
        <p className="mt-3 text-slate-300">
          Answer questions and learn at your own pace. No Coins, Game Points, rewards or cash prizes
          are awarded.
        </p>
        <p className="mt-2 text-sm text-slate-400">
          Answers are checked by the server. Practice questions may repeat; scores and answers are
          not saved after leaving or reloading.
        </p>
      </header>
      {questions.isPending ? (
        <p role="status">Loading practice questions…</p>
      ) : questions.isError ? (
        <div role="alert" className="rounded-xl border border-amber-500/40 bg-slate-900 p-5">
          Practice questions could not be loaded.{' '}
          <button onClick={() => void questions.refetch()} className="underline">
            Retry
          </button>
        </div>
      ) : !question ? (
        <p role="status">No practice questions are available right now.</p>
      ) : (
        <section className="rounded-2xl border border-white/10 bg-slate-900 p-6">
          <p className="text-sm text-slate-400">
            Question {questionIndex + 1} of {questions.data?.length} ·{' '}
            {question.category || 'General'}
          </p>
          <h2 className="mt-3 text-xl font-semibold">{question.question}</h2>
          <fieldset disabled={answer.isPending || !!answer.data} className="mt-5 space-y-3">
            <legend className="sr-only">Choose your answer</legend>
            {question.choices.map((choice, index) => (
              <label
                key={index}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 ${selected === index ? 'border-rose-300 bg-rose-950/30' : 'border-white/20'}`}
              >
                <input
                  type="radio"
                  name="trivia-practice-answer"
                  value={index}
                  checked={selected === index}
                  onChange={() => setSelected(index)}
                />
                <span>{choice}</span>
              </label>
            ))}
          </fieldset>
          {answer.isError && (
            <p role="alert" className="mt-4 text-amber-200">
              Your answer could not be confirmed. Try again, or choose the next practice question.
            </p>
          )}
          {answer.data && (
            <div role="status" className="mt-5 rounded-xl bg-slate-800 p-4">
              <p className="font-semibold">{answer.data.correct ? 'Correct!' : 'Not quite.'}</p>
              <p className="mt-1">Correct answer: {question.choices[answer.data.correctIndex]}</p>
              <p className="mt-2 text-sm text-slate-300">
                Practice only · no rewards or balance changes.
              </p>
            </div>
          )}
          <div className="mt-5 flex flex-wrap gap-3">
            {!answer.data && (
              <button
                disabled={selected === null || answer.isPending}
                onClick={() =>
                  selected !== null && answer.mutate({ question, answerIndex: selected })
                }
                className="rounded-lg bg-rose-700 px-5 py-3 font-semibold disabled:opacity-40"
              >
                {answer.isPending ? 'Checking answer…' : 'Check answer'}
              </button>
            )}
            <button
              disabled={answer.isPending}
              onClick={nextQuestion}
              className="rounded-lg border border-white/30 px-5 py-3 disabled:opacity-40"
            >
              {questionIndex + 1 === questions.data?.length ? 'Start again' : 'Next question'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
