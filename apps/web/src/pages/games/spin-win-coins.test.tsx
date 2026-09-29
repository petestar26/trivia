import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Api from '@/lib/api';
import { SpinWinCoinsPage } from './spin-win-coins';
import { pendingPlayStorageKey } from '@/hooks/use-durable-play';
const mocks = vi.hoisted(() => ({ play: vi.fn(), available: true }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'spin-user' } }) }));
vi.mock('@/components/casino/CasinoProvider', () => ({
  useCasino: () => ({
    coinsBalance: 1000,
    refetchBalance: vi.fn(),
    toggleFullscreen: vi.fn(),
    setSoundEnabled: vi.fn(),
  }),
}));
vi.mock('@/lib/api', async () => {
  const real = await vi.importActual<typeof Api>('@/lib/api');
  return {
    ...real,
    playGame: mocks.play,
    api: {
      get: vi.fn(async () => ({
        success: true,
        data: [
          {
            key: 'spin_win',
            catalogStatus: mocks.available ? 'AVAILABLE' : 'COMING_SOON',
            isActive: true,
            mode: 'WAGER',
            wagerCurrency: 'COINS',
            rewardCurrency: 'COINS',
            currentRulesVersion: 1,
            minBet: 10,
            maxBet: 500,
          },
        ],
      })),
    },
  };
});
const body = { betAmount: 10, bets: [{ marketId: 'red', amount: 10 }] };
const result = {
  success: true,
  data: {
    gameKey: 'spin_win',
    sessionId: 's1',
    newBalance: 1010,
    rewardAmount: 20,
    rulesVersion: 1,
    result: { number: 1, colour: 'red', stake: 10, payout: 20, net: 10, lines: [] },
    isReplay: true,
  },
};
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  mocks.play.mockReset();
  mocks.available = true;
});
async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <SpinWinCoinsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await screen.findByRole('button', { name: 'Place Coin bets' });
  return view;
}
describe('Spin Win Coin requests', () => {
  it('sends a ticket once and confirms a lost response with its original key and body', async () => {
    mocks.play.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(result);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Bet on Red' }));
    fireEvent.click(screen.getByRole('button', { name: 'Place Coin bets' }));
    await screen.findByRole('button', { name: 'Confirm pending round' });
    expect(screen.getByRole('button', { name: 'Bet on Black' })).toBeDisabled();
    expect(mocks.play.mock.calls[0][1]).toEqual(body);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pending round' }));
    await screen.findByText(/Replayed round/);
    expect(mocks.play.mock.calls[1]).toEqual(mocks.play.mock.calls[0]);
    expect(screen.getByText(/Settled balance: 1010/)).toBeInTheDocument();
    expect(sessionStorage.getItem(pendingPlayStorageKey('spin-user', 'spin_win'))).toBeNull();
  });
  it('recovers a stored request even when new Coin play is unavailable', async () => {
    mocks.available = false;
    mocks.play.mockResolvedValue(result);
    sessionStorage.setItem(
      pendingPlayStorageKey('spin-user', 'spin_win'),
      JSON.stringify({ key: 'saved-key', body })
    );
    await mount();
    expect(mocks.play).not.toHaveBeenCalled();
    expect(screen.getByText(/Coin play is not available/)).toHaveTextContent(/confirm a previously submitted round/);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pending round' }));
    await waitFor(() => expect(mocks.play).toHaveBeenCalledWith('spin_win', body, 'saved-key'));
  });
  it('blocks new wagers when catalog is coming soon', async () => {
    mocks.available = false;
    await mount();
    expect(screen.getByRole('button', { name: 'Place Coin bets' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Bet on Red' }));
    expect(mocks.play).not.toHaveBeenCalled();
    // Nothing is stored, so there is no round to confirm and the copy must not offer one.
    expect(screen.getByText(/Coin play is not available/)).not.toHaveTextContent(/confirm/i);
    expect(screen.queryByRole('button', { name: 'Confirm pending round' })).not.toBeInTheDocument();
  });
  it('sends nothing when request storage is unavailable', async () => {
    await mount();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Bet on Red' }));
      fireEvent.click(screen.getByRole('button', { name: 'Place Coin bets' }));
      await screen.findByText(/Nothing was sent/);
      expect(mocks.play).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
