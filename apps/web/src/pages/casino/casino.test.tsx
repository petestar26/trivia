import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type * as ApiModule from '@/lib/api';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: (...args: unknown[]) => apiGet(...args) } };
});
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1', username: 'player', displayName: 'Player' } }),
}));
import { Sidebar } from '@/components/layout/sidebar';
import { GamesPage } from '@/pages/games';
import { CasinoPage } from './index';

afterEach(() => {
  cleanup();
  apiGet.mockReset();
});
function mount(ui: ReactNode, initialEntry = '/casino') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter initialEntries={[initialEntry]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}
const catalog: Partial<ApiModule.GameCatalogEntry>[] = [
  {
    id: 'dice-id',
    key: 'dice',
    practiceAvailable: true,
    isActive: true,
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
    isActive: true,
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
    practiceAvailable: true,
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
function ownGames(data = catalog) {
  apiGet.mockImplementation(async (path: string) => {
    if (path === '/games') return { success: true, data };
    if (path === '/wallet')
      return { success: true, data: { coinsBalance: 125, gamePointsBalance: 0 } };
    throw new Error(`Unexpected GET ${path}`);
  });
}
function providerGames(enabled = true) {
  apiGet.mockImplementation(async (path: string) => {
    if (path === '/provider-test/status') return { success: true, data: { enabled, launchReady: true } };
    if (path === '/provider-test/wallet') return {success:true,data:{balanceCents:100000,created:false,movements:[]}};
    if (path === '/provider-test/games')
      return {
        success: true,
        data: [
          {
            id: 'studio/slot',
            name: 'Provider Slot',
            provider: 'External Studio',
            category: 'slots',
          },
        ],
      };
    throw new Error(`Unexpected GET ${path}`);
  });
}

describe('Games owns the platform catalogue', () => {
  it('lists WAGER and BONUS games, excludes retired titles and preserves destinations', async () => {
    ownGames();
    mount(<GamesPage />, '/games');
    expect(await screen.findByRole('heading', { name: 'Games' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dice' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Trivia' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Spin Win' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Legacy Lucky Spin' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dice/ })).toHaveAttribute('href', '/games/dice');
    expect(screen.queryByRole('link', { name: /Trivia/ })).not.toBeInTheDocument();
    const trivia = screen.getByRole('heading', { name: 'Trivia' }).closest('.qube-catalog-card') as HTMLElement;
    expect(within(trivia).getByText('Coming soon')).toBeInTheDocument();
    expect(apiGet.mock.calls.map(([path]) => path).sort()).toEqual(['/games', '/wallet']);
  });
  it.each([
    ['WAGER', 'Dice', 'Trivia'],
    ['BONUS', 'Trivia', 'Dice'],
  ])('allows %s filtering inside Games', async (mode, shown, hidden) => {
    ownGames();
    mount(<GamesPage />, `/games?mode=${mode}`);
    expect(await screen.findByRole('heading', { name: shown })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: hidden })).not.toBeInTheDocument();
  });
  it('treats unknown filters as the full own-game catalogue', async () => {
    ownGames();
    mount(<GamesPage />, '/games?mode=provider');
    expect(await screen.findByRole('heading', { name: 'Dice' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Trivia' })).toBeInTheDocument();
  });
  it('keeps solo, free and group navigation under Games with a separate Casino link', async () => {
    ownGames();
    mount(<GamesPage />, '/games');
    await screen.findByRole('heading', { name: 'Dice' });
    expect(screen.getByRole('link', { name: 'All our games' })).toHaveAttribute('href', '/games');
    expect(screen.getByRole('link', { name: 'Solo practice' })).toHaveAttribute(
      'href',
      '/games?mode=WAGER'
    );
    expect(screen.getByRole('link', { name: 'Free games' })).toHaveAttribute(
      'href',
      '/games?mode=BONUS'
    );
    expect(screen.getByRole('link', { name: /Group PVP/ })).toHaveAttribute('href', '/groups');
    expect(screen.getByRole('link', { name: /Casino/ })).toHaveAttribute('href', '/casino');
  });
  it('preserves disabled practice gates', async () => {
    ownGames(
      catalog
        .filter((game) => game.key === 'dice')
        .map((game) => ({ ...game, practiceAvailable: false }))
    );
    mount(<GamesPage />, '/games');
    expect(await screen.findByRole('heading', { name: 'Dice' })).toBeInTheDocument();
    expect(screen.getByText('Temporarily unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Dice/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Bet:/)).not.toBeInTheDocument();
  });
  it('preserves sign-in recovery for an unavailable session', async () => {
    apiGet.mockRejectedValue(new Error(JSON.stringify({ status: 401, message: 'Invalid token' })));
    mount(<GamesPage />, '/games');
    expect(await screen.findByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/login'
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Your session is unavailable');
  });
  it('recovers own-game catalogue failures through Retry', async () => {
    apiGet.mockRejectedValue(new Error(JSON.stringify({ status: 503 })));
    mount(<GamesPage />, '/games');
    const retry = await screen.findByRole('button', { name: 'Retry' });
    ownGames();
    fireEvent.click(retry);
    expect(await screen.findByRole('heading', { name: 'Dice' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Casino owns provider tests', () => {
  it('loads provider titles without querying our catalogue or wallet', async () => {
    providerGames();
    mount(<CasinoPage />);
    expect(await screen.findByRole('heading', { name: 'Casino' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Provider Slot' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Trivia' })).not.toBeInTheDocument();
    expect(screen.getByText(/wallet is not connected/)).toBeInTheDocument();
    expect(apiGet.mock.calls.map(([path]) => path)).toEqual([
      '/provider-test/status',
      '/provider-test/games',
      '/provider-test/wallet',
    ]);
    expect(screen.getByRole('link', { name: /Back to our games/ })).toHaveAttribute(
      'href',
      '/games'
    );
  });
  it('keeps disabled provider access gated without replacing it with own games', async () => {
    providerGames(false);
    mount(<CasinoPage />);
    expect(await screen.findByText(/not enabled for your account yet/)).toBeInTheDocument();
    expect(apiGet.mock.calls.map(([path]) => path)).toEqual(['/provider-test/status']);
    expect(screen.queryByRole('button', { name: 'Open test game' })).not.toBeInTheDocument();
  });
  it('recovers provider status errors through Retry', async () => {
    apiGet.mockRejectedValue(new Error('Unavailable'));
    mount(<CasinoPage />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    providerGames();
    fireEvent.click(retry);
    expect(await screen.findByRole('heading', { name: 'Provider Slot' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('member navigation distinguishes own and provider games', () => {
  it.each([
    ['/games', 'Games'],
    ['/games/dice', 'Games'],
    ['/games/crash-point', 'Games'],
    ['/games/turbo-keno', 'Games'],
    ['/games/spin-win/play', 'Games'],
    ['/games/trivia', 'Games'],
    ['/games/history', 'Games'],
    ['/casino', 'Casino'],
    ['/games/provider-demos', 'Casino'],
  ])('marks %s as belonging only to %s', (path, active) => {
    mount(<Sidebar />, path);
    expect(screen.getByRole('link', { name: active })).toHaveAttribute('aria-current', 'page');
    const other = active === 'Games' ? 'Casino' : 'Games';
    expect(screen.getByRole('link', { name: other })).not.toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Games' })).toHaveAttribute('href', '/games');
    expect(screen.getByRole('link', { name: 'Casino' })).toHaveAttribute('href', '/casino');
  });
});
