import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type * as ApiModule from '@/lib/api';

// Real newIdempotencyKey (imported via importActual) so the test proves the
// PAGE's own key handling, not a fake key generator's behavior.
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

let currentUser: { id: string; username: string; displayName: string } | null = { id: 'me-uuid', username: 'me', displayName: 'Me' };
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: currentUser }),
}));

import { DiceGamePage } from './dice';
import { CasinoProvider } from '@/components/casino/CasinoProvider';
import { pendingPlayStorageKey } from '@/hooks/use-durable-play';

afterEach(() => {
  cleanup();
  playGameMock.mockReset();
  newIdempotencyKeySpy.mockReset();
  window.sessionStorage.clear();
  currentUser = { id: 'me-uuid', username: 'me', displayName: 'Me' };
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

function roundFor(betAmount: number, sessionId = 's1') {
  return {
    sessionId,
    gameKey: 'dice',
    betAmount,
    rewardAmount: 0,
    isWin: false,
    result: { die1: 1, die2: 1, sum: 2, threshold: 7 },
    completedAt: new Date().toISOString(),
    newBalance: 1000 - betAmount,
    mode: 'WAGER',
    family: 'INSTANT',
    wagerCurrency: 'COINS',
    rewardCurrency: 'COINS',
    rulesVersion: 1,
    resultSchemaVersion: 1,
    playContext: 'SOLO_WAGER',
  };
}

// Exactly what POST /games/:key/play answers: { success, data }, with the
// replay flag INSIDE data (apps/api/src/routes/games.ts). There is no meta.
const successResponse = { success: true, data: { ...roundFor(50), isReplay: false } };
const lostResponse = () => new TypeError('Failed to fetch');
const httpError = (status: number, message: string) =>
  new Error(JSON.stringify({ status, code: 'CONFLICT', message }));

/** A fake server with the API's idempotency semantics: the first request with
 * a key settles a round; an exact retry with the same key replays it. */
function fakeServer() {
  const settled = new Map<string, { body: unknown; round: ReturnType<typeof roundFor> }>();
  let loseNextResponse = false;
  playGameMock.mockImplementation(async (_game: string, body: { betAmount: number }, key: string) => {
    const prior = settled.get(key);
    if (prior) return { success: true, data: { ...prior.round, isReplay: true } };
    const round = roundFor(body.betAmount, `s-${settled.size + 1}`);
    settled.set(key, { body, round });
    if (loseNextResponse) {
      loseNextResponse = false;
      throw lostResponse();
    }
    return { success: true, data: { ...round, isReplay: false } };
  });
  return { settled, loseNextResponse: () => { loseNextResponse = true; } };
}

const rollButton = () => screen.findByRole('button', { name: /Roll/i });

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
    fireEvent.click(await rollButton());
    await waitFor(() => expect(screen.getByText(/Sum: 2/i)).toBeInTheDocument());
    expect(playGameMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Replayed round/i)).not.toBeInTheDocument();
  });

  it('shows the replay notice from the real API response shape (data.isReplay)', async () => {
    playGameMock.mockResolvedValue({ success: true, data: { ...roundFor(50), isReplay: true } });
    renderPage();
    fireEvent.click(await rollButton());
    expect(await screen.findByText('Replayed round — no new wager.')).toBeInTheDocument();
  });

  it('a retry after a failed play reuses the EXACT SAME idempotency key — not a fresh one', async () => {
    playGameMock.mockRejectedValueOnce(lostResponse());
    playGameMock.mockResolvedValueOnce(successResponse);

    renderPage();
    fireEvent.click(await rollButton());
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Roll/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Roll/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(2));

    const [, firstBody, firstKey] = playGameMock.mock.calls[0];
    const [, secondBody, secondKey] = playGameMock.mock.calls[1];
    expect(typeof firstKey).toBe('string');
    expect(secondKey).toBe(firstKey);
    expect(secondBody).toEqual(firstBody);
    expect(newIdempotencyKeySpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText(/Sum: 2/i)).toBeInTheDocument());
  });

  it('stores the key and exact request before the first send', async () => {
    playGameMock.mockImplementation(async (_game: string, body: unknown, key: string) => {
      const stored = JSON.parse(window.sessionStorage.getItem(pendingPlayStorageKey('me-uuid', 'dice'))!);
      expect(stored).toEqual({ key, body });
      return successResponse;
    });
    renderPage();
    fireEvent.click(await rollButton());
    await waitFor(() => expect(screen.getByText(/Sum: 2/i)).toBeInTheDocument());
    expect(window.sessionStorage.getItem(pendingPlayStorageKey('me-uuid', 'dice'))).toBeNull();
  });

  it('a response lost after the server settled the round is resumed after a reload and settles exactly once', async () => {
    const server = fakeServer();
    server.loseNextResponse();
    renderPage();
    fireEvent.click(await rollButton());
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Roll/i })).not.toBeDisabled());
    expect(server.settled.size).toBe(1); // the server DID settle it; the client never heard

    cleanup(); // the player reloads the page
    renderPage();
    expect(await screen.findByText('Replayed round — no new wager.')).toBeInTheDocument();
    expect(screen.getByText(/Sum: 2/i)).toBeInTheDocument();

    expect(playGameMock).toHaveBeenCalledTimes(2);
    const [, firstBody, firstKey] = playGameMock.mock.calls[0];
    const [, resumedBody, resumedKey] = playGameMock.mock.calls[1];
    expect(resumedKey).toBe(firstKey);
    expect(resumedBody).toEqual(firstBody);
    expect(server.settled.size).toBe(1); // settled once, replayed once
    expect(window.sessionStorage.getItem(pendingPlayStorageKey('me-uuid', 'dice'))).toBeNull();
  });

  it('an edited bet never reuses the key of an unconfirmed round', async () => {
    playGameMock.mockRejectedValueOnce(lostResponse());
    renderPage();
    fireEvent.click(await rollButton());
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Roll/i })).not.toBeDisabled());
    const [, , firstKey] = playGameMock.mock.calls[0];

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '70' } });
    expect(await screen.findByText(/previous roll has not been confirmed yet/i)).toBeInTheDocument();

    playGameMock.mockResolvedValue(successResponse);
    fireEvent.click(screen.getByRole('button', { name: /Roll/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(2));
    expect(playGameMock.mock.calls[1].slice(1)).toEqual([{ betAmount: 50 }, firstKey]); // the unconfirmed request, unchanged

    await waitFor(() => expect(screen.getByRole('button', { name: /Roll/i })).not.toBeDisabled());
    playGameMock.mockResolvedValue({ success: true, data: { ...roundFor(70, 's2'), isReplay: false } });
    fireEvent.click(screen.getByRole('button', { name: /Roll/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(3));
    const [, editedBody, editedKey] = playGameMock.mock.calls[2];
    expect(editedBody).toEqual({ betAmount: 70 });
    expect(editedKey).not.toBe(firstKey);
    for (const [, body, key] of playGameMock.mock.calls) {
      if (key === firstKey) expect(body).toEqual({ betAmount: 50 });
    }
  });

  it('a NEW round (after a successful play) gets a FRESH idempotency key, different from the previous round\'s', async () => {
    playGameMock.mockResolvedValue(successResponse);
    renderPage();
    fireEvent.click(await rollButton());
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Roll/i })).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /Roll/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(2));

    expect(playGameMock.mock.calls[1][2]).not.toBe(playGameMock.mock.calls[0][2]);
    expect(newIdempotencyKeySpy).toHaveBeenCalledTimes(2);
  });

  it('another user never inherits a pending request, and a signed-out page never plays', async () => {
    window.sessionStorage.setItem(pendingPlayStorageKey('other-user', 'dice'),
      JSON.stringify({ key: 'their-key', body: { betAmount: 999 } }));
    playGameMock.mockResolvedValue(successResponse);
    renderPage();
    await rollButton();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(playGameMock).not.toHaveBeenCalled(); // nothing resumed for me

    fireEvent.click(screen.getByRole('button', { name: /Roll/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    const [, body, key] = playGameMock.mock.calls[0];
    expect(key).not.toBe('their-key');
    expect(body).toEqual({ betAmount: 50 });
    expect(JSON.parse(window.sessionStorage.getItem(pendingPlayStorageKey('other-user', 'dice'))!).key).toBe('their-key');

    cleanup();
    currentUser = null;
    renderPage();
    fireEvent.click(await rollButton());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(playGameMock).toHaveBeenCalledTimes(1);
  });

  it('a terminal 4xx ends the pending request; the next round uses a new key', async () => {
    playGameMock.mockRejectedValueOnce(httpError(409, 'This idempotency key was already used for a different play request'));
    renderPage();
    fireEvent.click(await rollButton());
    expect(await screen.findByText('This idempotency key was already used for a different play request')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(pendingPlayStorageKey('me-uuid', 'dice'))).toBeNull();

    playGameMock.mockResolvedValue(successResponse);
    fireEvent.click(screen.getByRole('button', { name: /Roll/i }));
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(2));
    expect(playGameMock.mock.calls[1][2]).not.toBe(playGameMock.mock.calls[0][2]);
  });

  it('a server error keeps the pending request for an exact retry', async () => {
    playGameMock.mockRejectedValueOnce(httpError(503, 'Service unavailable'));
    renderPage();
    fireEvent.click(await rollButton());
    await waitFor(() => expect(playGameMock).toHaveBeenCalledTimes(1));
    const stored = JSON.parse(window.sessionStorage.getItem(pendingPlayStorageKey('me-uuid', 'dice'))!);
    expect(stored).toEqual({ key: playGameMock.mock.calls[0][2], body: { betAmount: 50 } });
  });
});
