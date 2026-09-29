import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type * as ApiModule from '@/lib/api';

const playGameMock = vi.fn();
const newIdempotencyKeySpy = vi.fn();

const QUESTION = {
  id: 'q1',
  question: 'What is 2 + 2?',
  choices: ['3', '4', '5', '6'],
  category: 'math',
  difficulty: 1,
};
const NEXT_QUESTION = {
  id: 'q2',
  question: 'What is 2 + 3?',
  choices: ['3', '4', '5', '6'],
  category: 'math',
  difficulty: 1,
};
let questionFetchCount = 0;
let retiredQuestion = false;

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(async (path: string, params?: Record<string, unknown>) => {
        if (path === '/wallet') {
          return { success: true, data: { coinsBalance: 1000, gamePointsBalance: 0 } };
        }
        if (path === '/games') {
          return { success: true, data: [{ key: 'trivia', currentRulesVersion: 1 }] };
        }
        if (path === '/games/questions') {
          if (retiredQuestion) return { success: true, data: [NEXT_QUESTION] };
          if (params?.resumeQuestionId) return { success: true, data: [QUESTION] };
          questionFetchCount += 1;
          return { success: true, data: [questionFetchCount === 1 ? QUESTION : NEXT_QUESTION] };
        }
        throw new Error(`Unexpected GET ${path}`);
      }),
    },
    newIdempotencyKey: (...a: unknown[]) => {
      newIdempotencyKeySpy(...a);
      return actual.newIdempotencyKey(...(a as []));
    },
    playGame: (...a: unknown[]) => playGameMock(...a),
  };
});

let currentUser: { id: string; username: string; displayName: string } | null = { id: 'me-uuid', username: 'me', displayName: 'Me' };
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: currentUser }),
}));

import { TriviaGamePage } from './trivia';
import { CasinoProvider } from '@/components/casino/CasinoProvider';
import { pendingPlayStorageKey } from '@/hooks/use-durable-play';
import { durablePlayContract } from '@/test/durable-play-contract';

afterEach(() => {
  cleanup();
  playGameMock.mockReset();
  newIdempotencyKeySpy.mockReset();
  window.sessionStorage.clear();
  currentUser = { id: 'me-uuid', username: 'me', displayName: 'Me' };
  questionFetchCount = 0;
  retiredQuestion = false;
});

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
}

function renderPage() {
  const client = createClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CasinoProvider>{children}</CasinoProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(<TriviaGamePage />, { wrapper });
}

const successResponse = {
  success: true,
  data: {
    sessionId: 's1',
    gameKey: 'trivia',
    betAmount: 0,
    rewardAmount: 30,
    isWin: true,
    result: { questionId: 'q1', submittedAnswer: 1, correctIndex: 1, correct: true },
    completedAt: new Date().toISOString(),
    newBalance: 1030,
    mode: 'BONUS',
    family: 'INSTANT',
    wagerCurrency: null,
    rewardCurrency: 'COINS',
    rulesVersion: 1,
    resultSchemaVersion: 1,
    playContext: 'BONUS',
    isReplay: false,
  },
};

describe('TriviaGamePage', () => {
  it('a retry after a failed submission reuses the EXACT SAME idempotency key', async () => {
    playGameMock.mockRejectedValueOnce(new Error('network error'));
    playGameMock.mockResolvedValueOnce(successResponse);

    renderPage();
    await screen.findByText(QUESTION.question);
    fireEvent.click(screen.getByText('4'));
    const submitButton = screen.getByRole('button', { name: /Submit Answer/i });

    fireEvent.click(submitButton);
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Submit Answer/i })).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /Submit Answer/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(2));

    const firstKey = playGameMock.mock.calls[0][2];
    const secondKey = playGameMock.mock.calls[1][2];
    expect(typeof firstKey).toBe('string');
    expect(secondKey).toBe(firstKey);
    // Only ONE key minted across both attempts of the SAME round.
    expect(newIdempotencyKeySpy).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(screen.getByText(/\+30 bonus Coins/i)).toBeInTheDocument());
  });

  it('a successful submission settles with the reward shown', async () => {
    playGameMock.mockResolvedValue(successResponse);
    renderPage();
    await screen.findByText(QUESTION.question);
    fireEvent.click(screen.getByText('4'));
    fireEvent.click(screen.getByRole('button', { name: /Submit Answer/i }));
    await waitFor(() => expect(screen.getByText(/\+30 bonus Coins/i)).toBeInTheDocument());
    expect(playGameMock).toHaveBeenCalledTimes(1);
  });

  it('moves to a fresh server-provided question after an answer and never offers the same question twice', async () => {
    playGameMock.mockResolvedValueOnce(successResponse);
    playGameMock.mockResolvedValueOnce({
      ...successResponse,
      data: { ...successResponse.data, result: { ...successResponse.data.result, questionId: NEXT_QUESTION.id } },
    });
    renderPage();
    await screen.findByText(QUESTION.question);
    fireEvent.click(screen.getByRole('button', { name: '4' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit Answer/i }));
    await screen.findByText(/bonus Coins/i);
    const nextQuestion = await screen.findByRole('button', { name: /^Next Question$/i });
    await waitFor(() => expect(nextQuestion).toBeEnabled());

    fireEvent.click(nextQuestion);
    expect(await screen.findByText(NEXT_QUESTION.question)).toBeInTheDocument();
    expect(screen.queryByText(QUESTION.question)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '4' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit Answer/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(2));
    expect(playGameMock.mock.calls[1][1]).toEqual({ questionId: NEXT_QUESTION.id, answerIndex: 1 });
  });

  it('shows the replay notice from the real API response shape (data.isReplay)', async () => {
    playGameMock.mockResolvedValue({ ...successResponse, data: { ...successResponse.data, isReplay: true } });
    renderPage();
    await screen.findByText(QUESTION.question);
    fireEvent.click(screen.getByText('4'));
    fireEvent.click(screen.getByRole('button', { name: /Submit Answer/i }));
    expect(await screen.findByText('Replayed answer — no additional reward.')).toBeInTheDocument();
  });

  it('an answer whose response was lost after the server settled it is resumed after a reload and credited once', async () => {
    const settled = new Map<string, unknown>();
    let loseResponse = true;
    playGameMock.mockImplementation(async (_game: string, body: unknown, key: string) => {
      if (settled.has(key)) return { success: true, data: { ...successResponse.data, isReplay: true } };
      settled.set(key, body);
      if (loseResponse) { loseResponse = false; throw new TypeError('Failed to fetch'); }
      return successResponse;
    });
    renderPage();
    await screen.findByText(QUESTION.question);
    fireEvent.click(screen.getByText('4'));
    fireEvent.click(screen.getByRole('button', { name: /Submit Answer/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Submit Answer/i })).not.toBeDisabled());

    cleanup(); // reload
    renderPage();
    expect(await screen.findByText('Replayed answer — no additional reward.')).toBeInTheDocument();
    expect(screen.getByText(/\+30 bonus Coins/i)).toBeInTheDocument();
    expect(playGameMock).toHaveBeenCalledTimes(2);
    expect(playGameMock.mock.calls[1].slice(1)).toEqual(playGameMock.mock.calls[0].slice(1));
    expect(settled.size).toBe(1);
    expect(window.sessionStorage.getItem(pendingPlayStorageKey('me-uuid', 'trivia'))).toBeNull();
  });
});

describe('TriviaGamePage — durable play', () => {
  const submitButton = () => screen.queryByRole('button', { name: /^Submit Answer$/ }) as HTMLButtonElement | null;
  durablePlayContract({
    gameKey: 'trivia',
    userId: 'me-uuid',
    playGameMock,
    newIdempotencyKeySpy,
    renderPage: () => { renderPage(); },
    ready: async () => { await screen.findByText(QUESTION.question); },
    // Chooses the default answer only when none is chosen yet.
    play: () => {
      if (submitButton()?.disabled) fireEvent.click(screen.getByRole('button', { name: '4' }));
      fireEvent.click(screen.getByRole('button', { name: /Submit Answer|Checking/i }));
    },
    playEnabled: () => !!submitButton() && !submitButton()!.disabled,
    firstBody: { questionId: 'q1', answerIndex: 1 },
    nextRound: async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Next Question/i }));
      if (playGameMock.mock.calls.length > 0) await screen.findByText(NEXT_QUESTION.question);
    },
    response: (body, isReplay) => ({ success: true, data: { ...successResponse.data,
      result: { ...successResponse.data.result, questionId: body.questionId, submittedAnswer: body.answerIndex }, isReplay } }),
    firstBodyAfterNext: { questionId: NEXT_QUESTION.id, answerIndex: 1 },
    editedBodyAfterNext: { questionId: NEXT_QUESTION.id, answerIndex: 2 },
    replayNotice: 'Replayed answer — no additional reward.',
    edit: () => {
      fireEvent.click(screen.getByRole('button', { name: '5' }));
      return {
        questionId: screen.queryByText(NEXT_QUESTION.question) ? NEXT_QUESTION.id : QUESTION.id,
        answerIndex: 2,
      };
    },
    setUser: (user) => { currentUser = user; },
  });
});


it('manually confirms a retired question after recovery fails, then allows the next question', async () => {
  retiredQuestion = true;
  const key = 'retired-question-recovery';
  const body = { questionId: QUESTION.id, answerIndex: 1 };
  window.sessionStorage.setItem(pendingPlayStorageKey('me-uuid', 'trivia'), JSON.stringify({ key, body }));
  playGameMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  playGameMock.mockResolvedValueOnce({ success: true, data: { ...successResponse.data, isReplay: true } });
  renderPage();
  await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
  const confirm = await screen.findByRole('button', { name: 'Confirm pending answer' });
  await waitFor(() => expect(confirm).not.toBeDisabled());
  fireEvent.click(confirm);
  await screen.findByText('Replayed answer — no additional reward.');
  expect(playGameMock).toHaveBeenCalledTimes(2);
  expect(playGameMock.mock.calls[0]).toEqual(['trivia', body, key]);
  expect(playGameMock.mock.calls[1]).toEqual(playGameMock.mock.calls[0]);
  expect(newIdempotencyKeySpy).not.toHaveBeenCalled();
  expect(window.sessionStorage.getItem(pendingPlayStorageKey('me-uuid', 'trivia'))).toBeNull();
  const next = await screen.findByRole('button', { name: 'Next Question' });
  await waitFor(() => expect(next).not.toBeDisabled());
  fireEvent.click(next);
  await screen.findByText(NEXT_QUESTION.question);
});
