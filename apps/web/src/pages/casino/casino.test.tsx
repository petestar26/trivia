import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type * as ApiModule from '@/lib/api';

const apiGet = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: (...args: unknown[]) => apiGet(...args) } };
});

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1', username: 'player', displayName: 'Player' } }),
}));

import { Sidebar } from '@/components/layout/sidebar';
import { CasinoPage } from './index';

afterEach(() => {
  cleanup();
  apiGet.mockReset();
});

function renderWithProviders(ui: ReactNode, initialEntry = '/casino') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const catalog = [
  {
    id: 'dice-id',
    key: 'dice',
    name: 'Dice',
    description: 'Roll the dice.',
    mode: 'WAGER',
    catalogStatus: 'AVAILABLE',
    minBet: 5,
    maxBet: 1000,
  },
  {
    id: 'trivia-id',
    key: 'trivia',
    name: 'Trivia',
    description: 'Answer questions.',
    mode: 'BONUS',
    catalogStatus: 'AVAILABLE',
    minBet: 0,
    maxBet: 0,
  },
  {
    id: 'soon-id',
    key: 'spin_win',
    name: 'Spin Win',
    description: 'Spin the wheel.',
    mode: 'WAGER',
    catalogStatus: 'COMING_SOON',
    minBet: 10,
    maxBet: 500,
  },
  {
    id: 'retired-id',
    key: 'lucky_spin',
    name: 'Legacy Lucky Spin',
    description: 'Retired game.',
    mode: 'WAGER',
    catalogStatus: 'RETIRED',
    minBet: 10,
    maxBet: 500,
  },
];

describe('Casino entry and catalog', () => {
  it('shows session recovery rather than an empty catalog after a 401', async () => {
    apiGet.mockRejectedValue(new Error(JSON.stringify({ status: 401, message: 'Invalid token' })));
    renderWithProviders(<CasinoPage />);
    expect(await screen.findByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/login'
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Your session is unavailable');
    expect(screen.queryByText('No casino games available right now.')).not.toBeInTheDocument();
  });
  it('recovers a failed catalog request through Retry', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === '/wallet') return { success: true, data: { coinsBalance: 125 } };
      throw new Error(JSON.stringify({ status: 503 }));
    });
    renderWithProviders(<CasinoPage />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    apiGet.mockResolvedValue({ success: true, data: catalog });
    fireEvent.click(retry);
    expect(await screen.findByRole('heading', { name: 'Spin Win' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('shows a dedicated Casino navigation link that is active at /casino', () => {
    renderWithProviders(<Sidebar />);

    const casinoLink = screen.getByRole('link', { name: 'Casino' });
    expect(casinoLink).toHaveAttribute('href', '/casino');
    expect(casinoLink).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Games' })).not.toHaveAttribute('aria-current', 'page');
  });

  it('shows only non-retired WAGER games and keeps bonus Trivia under Games', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === '/games') return { success: true, data: catalog };
      if (path === '/wallet')
        return { success: true, data: { coinsBalance: 125, gamePointsBalance: 0 } };
      throw new Error(`Unexpected GET ${path}`);
    });

    renderWithProviders(<CasinoPage />);

    expect(await screen.findByRole('heading', { name: 'Casino' })).toBeInTheDocument();
    expect(screen.getByText('System tables run every minute. Try Spin and Keno with free practice credits. Find player-versus-player games inside your groups.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Dice' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Spin Win' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Trivia' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Legacy Lucky Spin' })).not.toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/games'));
  });
});