import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './home';
import { GamesPage } from './games';
import type { MemberGame } from '@/lib/member-game-catalog';
const { get, listGroups } = vi.hoisted(() => ({ get: vi.fn(), listGroups: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'Member' } }),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: { get, listGroups },
}));
function game(key: string, status = 'COMING_SOON', active = false): MemberGame {
  return {
    id: key,
    key,
    name: key,
    catalogStatus: status,
    isActive: active,
    description: null,
    type: key,
    mode: key === 'trivia' ? 'BONUS' : 'WAGER',
    family: 'INSTANT',
    wagerCurrency: 'COINS',
    rewardCurrency: 'COINS',
    currentRulesVersion: null,
    minBet: 0,
    maxBet: 0,
  };
}
const keys = [
  'crash_point',
  'dice',
  'spin_win',
  'turbo_keno',
  'trivia',
  'number_challenge',
  'thunder_derby_3d',
  'neon_hounds_3d',
  'turbo_circuit_3d',
  'starfall_nebula',
  'jungle_dash_3d',
  'crystal_trail',
  'heat_vault',
  'strait_rush',
];
function setup(Page = HomePage) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>
    </MemoryRouter>
  );
  return client;
}
beforeEach(() => {
  get.mockImplementation(async (path: string) => ({
    success: true,
    data:
      path === '/games'
        ? keys.map((k) => game(k, k === 'trivia' ? 'AVAILABLE' : 'COMING_SOON', k === 'trivia'))
        : { coinsBalance: 42, gamePointsBalance: 80 },
  }));
  listGroups.mockResolvedValue({ success: true, data: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('Ruby Grand member dashboard', () => {
  describe.each([
    ['home', HomePage],
    ['games', GamesPage],
  ] as const)('%s Sky Crash artwork', (_name, Page) => {
    it.each([undefined, false, true])(
      'loads optional art only with an explicit practice opt-in (%s)',
      async (practiceAvailable) => {
        get.mockImplementation(async (path: string) => ({
          success: true,
          data:
            path === '/games'
              ? [{ ...game('sky_crash'), practiceAvailable }]
              : { coinsBalance: 42, gamePointsBalance: 80 },
        }));
        setup(Page);
        await screen.findByRole('heading', { name: 'sky_crash' });
        const art = document.querySelector('img[src="/images/sky-crash/aircraft.webp"]');
        if (practiceAvailable === true) {
          expect(art).toBeInTheDocument();
          expect(art).toHaveAttribute('loading', 'lazy');
        } else {
          expect(art).toBeNull();
          expect(document.body.innerHTML).not.toContain('/images/sky-crash/');
        }
      }
    );
  });
  it('shows the entire server catalog, preserves playable destinations and reserves future space', async () => {
    setup();
    const region = await screen.findByRole('region', { name: 'Games' });
    for (const key of keys)
      expect(within(region).getByRole('heading', { name: key })).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: /dice/i })).toHaveAttribute(
      'href',
      '/games/dice'
    );
    expect(within(region).getByRole('link', { name: /trivia/i })).toHaveAttribute(
      'href',
      '/games/trivia'
    );
    expect(
      within(region).queryByRole('link', { name: /number_challenge/i })
    ).not.toBeInTheDocument();
    expect(within(region).getByRole('heading', { name: 'More to discover' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show all games/i }));
    expect(region).toHaveClass('is-grid');
    expect(screen.getByRole('button', { name: /carousel view/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
  it('never displays retired games or private groups for nonmembers, and uses real group destinations', async () => {
    get.mockImplementation(async (path: string) => ({
      success: true,
      data:
        path === '/games'
          ? [game('trivia', 'AVAILABLE', true), game('retired', 'RETIRED', true)]
          : { coinsBalance: 42, gamePointsBalance: 80 },
    }));
    listGroups.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'public',
          name: 'Public room',
          status: 'ACTIVE',
          isPrivate: false,
          isMember: false,
          memberCount: 3,
        },
        {
          id: 'mine',
          name: 'My private room',
          status: 'ACTIVE',
          isPrivate: true,
          isMember: true,
          memberCount: 2,
        },
        {
          id: 'secret',
          name: 'Hidden room',
          status: 'ACTIVE',
          isPrivate: true,
          isMember: false,
          memberCount: 4,
        },
        {
          id: 'closed',
          name: 'Closed room',
          status: 'CLOSED',
          isPrivate: false,
          isMember: true,
          memberCount: 5,
        },
      ],
    });
    setup();
    expect(await screen.findByRole('link', { name: /My private room/ })).toHaveAttribute(
      'href',
      '/groups/mine'
    );
    expect(screen.getByRole('link', { name: /Public room/ })).toHaveAttribute(
      'href',
      '/groups/public'
    );
    expect(screen.queryByText('Hidden room')).not.toBeInTheDocument();
    expect(screen.queryByText('Closed room')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'retired' })).not.toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });
  it('renders independent retry states rather than inventing games or groups after a failed request', async () => {
    get.mockRejectedValue(new Error('Offline'));
    listGroups.mockRejectedValue(new Error('Offline'));
    setup();
    expect(await screen.findByRole('button', { name: 'Retry games' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Retry groups' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Games' })).not.toBeInTheDocument();
    get.mockResolvedValue({ success: true, data: [game('trivia', 'AVAILABLE', true)] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry games' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Games' })).toBeInTheDocument());
  });
});
