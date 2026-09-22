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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(async (path: string) => {
        if (path === '/wallet') {
          return { success: true, data: { coinsBalance: 1000, gamePointsBalance: 0 } };
        }
        if (path === '/games') {
          return { success: true, data: [{ key: 'trivia', currentRulesVersion: 1 }] };
        }
        if (path === '/games/questions') {
          return { success: true, data: [QUESTION] };
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

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'me-uuid', username: 'me', displayName: 'Me' } }),
}));

import { TriviaGamePage } from './trivia';
import { CasinoProvider } from '@/components/casino/CasinoProvider';

afterEach(() => {
  cleanup();
  playGameMock.mockReset();
  newIdempotencyKeySpy.mockReset();
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
  },
  meta: { isReplay: false },
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

    await waitFor(() => expect(screen.getByText(/\+30 Coins/i)).toBeInTheDocument());
  });

  it('a successful submission settles with the reward shown', async () => {
    playGameMock.mockResolvedValue(successResponse);
    renderPage();
    await screen.findByText(QUESTION.question);
    fireEvent.click(screen.getByText('4'));
    fireEvent.click(screen.getByRole('button', { name: /Submit Answer/i }));
    await waitFor(() => expect(screen.getByText(/\+30 Coins/i)).toBeInTheDocument());
    expect(playGameMock).toHaveBeenCalledTimes(1);
  });
});
