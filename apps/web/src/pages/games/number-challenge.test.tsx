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
import { pendingPlayStorageKey } from '@/hooks/use-durable-play';

afterEach(() => {
  cleanup();
  playGameMock.mockReset();
  newIdempotencyKeySpy.mockReset();
  window.sessionStorage.clear();
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
    isReplay: false,
  },
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

  it('shows the replay notice from the real API response shape (data.isReplay)', async () => {
    playGameMock.mockResolvedValue({ ...successResponse, data: { ...successResponse.data, isReplay: true } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Submit Guess/i }));
    expect(await screen.findByText('Replayed round — no new wager.')).toBeInTheDocument();
  });

  it('an edited guess never reuses the key of an unconfirmed round', async () => {
    playGameMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Submit Guess/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Submit Guess/i })).not.toBeDisabled());
    const [, firstBody, firstKey] = playGameMock.mock.calls[0];

    fireEvent.change(screen.getAllByRole('spinbutton')[1], { target: { value: '77' } });
    expect(await screen.findByText(/previous guess has not been confirmed yet/i)).toBeInTheDocument();
    playGameMock.mockResolvedValue(successResponse);
    fireEvent.click(screen.getByRole('button', { name: /Submit Guess/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(2));
    expect(playGameMock.mock.calls[1].slice(1)).toEqual([firstBody, firstKey]);

    await waitFor(() => expect(screen.getByRole('button', { name: /Submit Guess/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Submit Guess/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(3));
    const [, editedBody, editedKey] = playGameMock.mock.calls[2];
    expect(editedBody).toEqual({ betAmount: 50, guess: 77 });
    expect(editedKey).not.toBe(firstKey);
  });

  it('a reload resumes exactly the stored unconfirmed request', async () => {
    window.sessionStorage.setItem(pendingPlayStorageKey('me-uuid', 'number_challenge'),
      JSON.stringify({ key: 'stored-key', body: { betAmount: 20, guess: 7 } }));
    playGameMock.mockResolvedValue({ ...successResponse, data: { ...successResponse.data, isReplay: true } });
    renderPage();
    expect(await screen.findByText('Replayed round — no new wager.')).toBeInTheDocument();
    expect(playGameMock).toHaveBeenCalledTimes(1);
    expect(playGameMock.mock.calls[0]).toEqual(['number_challenge', { betAmount: 20, guess: 7 }, 'stored-key']);
    expect(window.sessionStorage.getItem(pendingPlayStorageKey('me-uuid', 'number_challenge'))).toBeNull();
  });
});
