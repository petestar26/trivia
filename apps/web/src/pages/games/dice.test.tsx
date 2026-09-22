import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type * as ApiModule from '@/lib/api';

// Real newIdempotencyKey (imported via importActual) so the test proves the
// PAGE's own hoisting behavior, not a fake key generator's behavior.
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
            data: [
              { key: 'dice', minBet: 5, maxBet: 1000, currentRulesVersion: 1 },
            ],
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

import { DiceGamePage } from './dice';
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
  return render(<DiceGamePage />, { wrapper });
}

const successResponse = {
  success: true,
  data: {
    sessionId: 's1',
    gameKey: 'dice',
    betAmount: 50,
    rewardAmount: 0,
    isWin: false,
    result: { die1: 1, die2: 1, sum: 2, threshold: 7 },
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

describe('DiceGamePage', () => {
  it('renders the bet form once the catalog loads', async () => {
    playGameMock.mockResolvedValue(successResponse);
    renderPage();
    expect(await screen.findByText(/Roll the dice/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Roll/i })).toBeInTheDocument();
  });

  it('a successful play settles the round and shows the server result', async () => {
    playGameMock.mockResolvedValue(successResponse);
    renderPage();
    await screen.findByRole('button', { name: /Roll/i });
    fireEvent.click(screen.getByRole('button', { name: /Roll/i }));
    await waitFor(() => expect(screen.getByText(/Sum: 2/i)).toBeInTheDocument());
    expect(playGameMock).toHaveBeenCalledTimes(1);
  });

  it('a retry after a failed play reuses the EXACT SAME idempotency key — not a fresh one', async () => {
    // First attempt fails (network blip); the retry (a second click, once
    // the button re-enables) must carry the identical key, never a new one.
    playGameMock.mockRejectedValueOnce(new Error('network error'));
    playGameMock.mockResolvedValueOnce(successResponse);

    renderPage();
    const rollButton = await screen.findByRole('button', { name: /Roll/i });

    fireEvent.click(rollButton);
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));

    // Button re-enables once the mutation settles into its error state.
    await waitFor(() => expect(screen.getByRole('button', { name: /Roll/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Roll/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(2));

    const firstCallKey = playGameMock.mock.calls[0][2];
    const secondCallKey = playGameMock.mock.calls[1][2];
    expect(typeof firstCallKey).toBe('string');
    expect(secondCallKey).toBe(firstCallKey);

    // The key was generated exactly ONCE across both attempts — proof that
    // key generation is hoisted out of mutationFn, not re-run per retry.
    expect(newIdempotencyKeySpy).toHaveBeenCalledTimes(1);

    // The retry succeeds and settles the round.
    await waitFor(() => expect(screen.getByText(/Sum: 2/i)).toBeInTheDocument());
  });

  it('a NEW round (after a successful play) gets a FRESH idempotency key, different from the previous round\'s', async () => {
    playGameMock.mockResolvedValue(successResponse);
    renderPage();
    const rollButton = await screen.findByRole('button', { name: /Roll/i });

    fireEvent.click(rollButton);
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Roll/i })).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /Roll/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(2));

    const firstCallKey = playGameMock.mock.calls[0][2];
    const secondCallKey = playGameMock.mock.calls[1][2];
    expect(secondCallKey).not.toBe(firstCallKey);
    expect(newIdempotencyKeySpy).toHaveBeenCalledTimes(2);
  });
});
