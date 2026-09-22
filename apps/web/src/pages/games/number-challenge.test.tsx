import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type * as ApiModule from '@/lib/api';

const playGameMock = vi.fn();
const newIdempotencyKeySpy = vi.fn();

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
          return {
            success: true,
            data: [{ key: 'number_challenge', minBet: 10, maxBet: 200, currentRulesVersion: 1 }],
          };
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

import { NumberChallengePage } from './number-challenge';
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
  return render(<NumberChallengePage />, { wrapper });
}

const successResponse = {
  success: true,
  data: {
    sessionId: 's1',
    gameKey: 'number_challenge',
    betAmount: 50,
    rewardAmount: 0,
    isWin: false,
    result: { guess: 50, target: 12, away: 38, correct: false },
    completedAt: new Date().toISOString(),
    newBalance: 950,
    mode: 'WAGER',
    family: 'INSTANT',
    wagerCurrency: 'COINS',
    rewardCurrency: 'COINS',
    rulesVersion: 1,
    resultSchemaVersion: 1,
    playContext: 'SOLO_WAGER',
  },
  meta: { isReplay: false },
};

describe('NumberChallengePage', () => {
  it('a retry after a failed submission reuses the EXACT SAME idempotency key', async () => {
    playGameMock.mockRejectedValueOnce(new Error('network error'));
    playGameMock.mockResolvedValueOnce(successResponse);

    renderPage();
    const submitButton = await screen.findByRole('button', { name: /Submit Guess/i });

    fireEvent.click(submitButton);
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Submit Guess/i })).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /Submit Guess/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(2));

    const firstKey = playGameMock.mock.calls[0][2];
    const secondKey = playGameMock.mock.calls[1][2];
    expect(typeof firstKey).toBe('string');
    expect(secondKey).toBe(firstKey);
    expect(newIdempotencyKeySpy).toHaveBeenCalledTimes(1);
  });

  it('a NEW round after a successful submission gets a fresh idempotency key', async () => {
    playGameMock.mockResolvedValue(successResponse);
    renderPage();
    const submitButton = await screen.findByRole('button', { name: /Submit Guess/i });

    fireEvent.click(submitButton);
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Submit Guess/i })).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /Submit Guess/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(2));

    const firstKey = playGameMock.mock.calls[0][2];
    const secondKey = playGameMock.mock.calls[1][2];
    expect(secondKey).not.toBe(firstKey);
    expect(newIdempotencyKeySpy).toHaveBeenCalledTimes(2);
  });
});
