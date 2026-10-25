import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  'sky_crash',
  'virtual_football_3d',
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
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, _options: unknown, callback: () => unknown) => {
        try {
          return Promise.resolve(callback());
        } catch (error) {
          return Promise.reject(error);
        }
      },
    },
  });
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
describe('dashboard favorites integration', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'localStorage', originalStorage);
  });

  it('saves games separately from their links, persists on reload and preserves access gates', async () => {
    setup();
    const games = await screen.findByRole('region', { name: 'Games' });
    const favorite = within(games).getByRole('button', { name: 'Add sky_crash to favorites' });
    expect(favorite.closest('a')).toBeNull();
    fireEvent.click(favorite);
    expect(
      within(games).getByRole('button', { name: 'Remove sky_crash from favorites' })
    ).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Favorites 1' }));
    expect(within(games).getAllByRole('heading')).toHaveLength(1);
    expect(within(games).queryByRole('link')).not.toBeInTheDocument();
    cleanup();
    setup();
    await screen.findByRole('button', { name: 'Favorites 1' });
    expect(screen.getByRole('button', { name: 'Remove sky_crash from favorites' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('keeps focus when removing the last favorite from its filtered view', async () => {
    setup();
    await screen.findByRole('region', { name: 'Games' });
    fireEvent.click(screen.getByRole('button', { name: 'Add dice to favorites' }));
    fireEvent.click(screen.getByRole('button', { name: 'Favorites 1' }));
    const remove = screen.getByRole('button', { name: 'Remove dice from favorites' });
    act(() => remove.focus());
    fireEvent.click(remove);
    expect(screen.getByRole('searchbox', { name: 'Search game collection' })).toHaveFocus();
    expect(screen.getByText('Your favorites start here.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Favorites 0' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('region', { name: 'Games' })).toBeInTheDocument();
  });

  it('disables hearts with explicit feedback when preference storage fails', async () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    setup();
    await screen.findByRole('region', { name: 'Games' });
    expect(
      screen.getByText(
        'Favorites are unavailable because this browser cannot safely load or save them.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add dice to favorites' })).toBeDisabled();
    expect(screen.getByRole('link', { name: /Free practice dice.*Explore game/i })).toHaveAttribute(
      'href',
      '/games/dice'
    );
  });
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
    expect(region).toHaveClass('is-grid');
    fireEvent.click(screen.getByRole('button', { name: /carousel view/i }));
    expect(region).not.toHaveClass('is-grid');
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
  it('derives availability filters and counts from real destinations without unlocking gated or unknown games', async () => {
    get.mockImplementation(async (path: string) => ({
      success: true,
      data:
        path === '/games'
          ? [
              { ...game('trivia', 'AVAILABLE', true), name: 'Trivia' },
              {
                ...game('sky_crash', 'AVAILABLE', true),
                name: 'Sky Crash',
                practiceAvailable: false,
              },
              { ...game('virtual_football_3d'), name: 'Virtual Football', practiceAvailable: true },
              { ...game('unreleased', 'AVAILABLE', true), name: 'Neon Hounds' },
              { ...game('retired', 'RETIRED', true), name: 'Retired game' },
            ]
          : { coinsBalance: 42, gamePointsBalance: 80 },
    }));
    setup();
    const region = await screen.findByRole('region', { name: 'Games' });
    expect(screen.getByText('Showing 4 of 4 games')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All games 4' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Ready to explore 2' })).toBeInTheDocument();
    expect(within(region).queryByRole('link', { name: /Sky Crash/ })).not.toBeInTheDocument();
    expect(within(region).queryByRole('link', { name: /Neon Hounds/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Retired game')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ready to explore 2' }));
    expect(screen.getByText('Showing 2 of 4 games')).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: /Virtual Football/ })).toHaveAttribute(
      'href',
      '/games/virtual-football'
    );
    expect(within(region).getByRole('link', { name: /Trivia/ })).toHaveAttribute(
      'href',
      '/games/trivia'
    );
    expect(
      within(region).queryByRole('heading', { name: 'More to discover' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Not yet available 2' }));
    expect(within(region).getByRole('heading', { name: 'Sky Crash' })).toBeInTheDocument();
    expect(within(region).getByRole('heading', { name: 'Neon Hounds' })).toBeInTheDocument();
    expect(within(region).queryAllByRole('link')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'All games 4' }));
    expect(within(region).getByRole('heading', { name: 'More to discover' })).toBeInTheDocument();
  });
  it('searches names case-insensitively and clears both search and availability after an empty result', async () => {
    setup();
    await screen.findByRole('region', { name: 'Games' });
    const search = screen.getByRole('searchbox', { name: 'Search game collection' });
    fireEvent.change(search, { target: { value: '  SKY CrAsH  ' } });
    const region = screen.getByRole('region', { name: 'Games' });
    expect(within(region).getAllByRole('heading')).toHaveLength(1);
    expect(within(region).getByRole('heading', { name: 'sky_crash' })).toBeInTheDocument();
    expect(within(region).queryByRole('link')).not.toBeInTheDocument();
    expect(
      within(region).queryByRole('heading', { name: 'More to discover' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Ready to explore/ }));
    expect(screen.getByText('No games match these filters.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Games' })).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'Clear filters' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByRole('button', { name: /^All games/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByText(`Showing ${keys.length} of ${keys.length} games`)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Games' })).toHaveClass('is-grid');

    fireEvent.change(search, { target: { value: 'no such game' } });
    screen.getByRole('button', { name: 'Clear game search' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Clear game search' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Games' })).toBeInTheDocument();
  });
  it('keeps search scoped to games and displays failed balances as unknown', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/wallet') throw new Error('Wallet offline');
      return { success: true, data: [game('trivia', 'AVAILABLE', true)] };
    });
    listGroups.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'room',
          name: 'Community room',
          memberCount: 3,
          isMember: false,
          isPrivate: false,
          status: 'ACTIVE',
        },
      ],
    });
    setup();
    await screen.findByRole('region', { name: 'Games' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search game collection' }), {
      target: { value: 'missing' },
    });
    expect(await screen.findByRole('link', { name: /Community room/ })).toHaveAttribute(
      'href',
      '/groups/room'
    );
    expect(
      await screen.findByText('Balances unavailable. Open your wallet to retry.')
    ).toBeInTheDocument();
    const balances = screen.getByRole('link', { name: /Coins.*Game Points/ });
    expect(within(balances).getAllByText('—')).toHaveLength(2);
    expect(within(balances).queryByText('0')).not.toBeInTheDocument();
  });
});
