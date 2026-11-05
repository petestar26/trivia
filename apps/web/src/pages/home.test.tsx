import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './home';
import { GamesPage } from './games';
import {
  PRACTICE_ROUTES,
  COMING_SOON_GAME_KEYS,
  memberGameName,
  type MemberGame,
} from '@/lib/member-game-catalog';
const { get, listGroups } = vi.hoisted(() => ({ get: vi.fn(), listGroups: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'Member' } }),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: { get, listGroups },
}));
const game = (key: string, available = true): MemberGame => ({
  id: key,
  key,
  name: key,
  practiceAvailable: available,
  catalogStatus: 'COMING_SOON',
  isActive: false,
  description: null,
  type: key,
  mode: 'WAGER',
  family: 'INSTANT',
  wagerCurrency: 'COINS',
  rewardCurrency: 'COINS',
  currentRulesVersion: null,
  minBet: 0,
  maxBet: 0,
});
const ok = (data: unknown) => ({ success: true, data });
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
  get.mockImplementation(async (path: string) =>
    ok(
      path === '/games'
        ? [...Object.keys(PRACTICE_ROUTES), ...COMING_SOON_GAME_KEYS].map((k) => game(k))
        : path === '/provider-test/status'
          ? { enabled: false, launchReady: false }
          : []
    )
  );
  listGroups.mockResolvedValue(ok([]));
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, _options: unknown, fn: () => unknown) => Promise.resolve(fn()),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe.each([
  ['home', HomePage],
  ['games', GamesPage],
] as const)('%s discovery', (_name, Page) => {
  it('shows all 12 implemented games in order without future cards, even when an old catalogue says coming soon', async () => {
    setup(Page);
    await screen.findByRole('link', { name: 'Play spin_win' });
    const grid = document.querySelector('.salem-own-grid')!;
    expect(within(grid as HTMLElement).getAllByRole('heading')).toHaveLength(12);
    expect(
      within(grid as HTMLElement)
        .getAllByRole('heading')
        .slice(0, 3)
        .map((h) => h.textContent)
    ).toEqual(['spin_win', 'turbo_keno', 'sky_crash']);
    for (const key of COMING_SOON_GAME_KEYS)
      expect(within(grid as HTMLElement).queryByRole('heading', { name: key })).toBeNull();
    expect(screen.queryByText('Coming soon')).toBeNull();
    expect(screen.queryByText('More to discover')).toBeNull();
    for (const key of Object.keys(PRACTICE_ROUTES))
      expect(
        within(grid as HTMLElement).getByRole('link', { name: `Play ${memberGameName(game(key))}` })
      ).toHaveAttribute('href', '/play-together?game=' + key);
  });
  it('routes old solo maintenance cards to group rules without placing a bet', async () => {
    get.mockImplementation(async (path) =>
      ok(path === '/games' ? [game('sky_crash', false)] : { enabled: false })
    );
    setup(Page);
    const link = await screen.findByRole('link', { name: 'Play sky_crash' });
    expect(link).toHaveAttribute('href', '/play-together?game=sky_crash');
    expect(screen.getByText('Group play')).toBeInTheDocument();
  });
  it('searches case insensitively and restores focus when clearing empty results', async () => {
    setup(Page);
    await screen.findByRole('link', { name: 'Play spin_win' });
    const search = screen.getByRole('searchbox', { name: 'Search games' });
    fireEvent.change(search, { target: { value: '  FOOTBALL  ' } });
    expect(document.querySelectorAll('.salem-own-tile')).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('No games found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(document.querySelectorAll('.salem-own-tile')).toHaveLength(12);
  });
});
it('shows actual casino art on Home and links to a selected game without launching any session', async () => {
  get.mockImplementation(async (path) =>
    ok(
      path === '/games'
        ? [game('dice')]
        : path === '/provider-test/status'
          ? { enabled: true, launchReady: true }
          : [
              {
                id: 'studio/slot',
                name: 'Orbite',
                provider: 'Studio',
                category: 'table',
                image: 'https://cdn.example.com/portrait.jpg',
              },
            ]
    )
  );
  setup();
  const link = await screen.findByRole('link', { name: 'Play Orbite' });
  expect(link).toHaveAttribute('href', '/casino?game=studio%2Fslot');
  expect(link.querySelector('img')).toHaveAttribute('src', 'https://cdn.example.com/portrait.jpg');
  expect(get.mock.calls.some(([p]) => p.includes('/launch'))).toBe(false);
});
it('does not fetch provider titles for accounts without test access', async () => {
  setup();
  await screen.findByRole('link', { name: 'Play spin_win' });
  expect(get.mock.calls.some(([p]) => p === '/provider-test/games')).toBe(false);
});
it('hides private groups that the viewer has not joined', async () => {
  listGroups.mockResolvedValue(
    ok([
      {
        id: 'secret',
        name: 'Secret room',
        isPrivate: true,
        isMember: false,
        status: 'ACTIVE',
        memberCount: 3,
      },
      {
        id: 'ours',
        name: 'Our room',
        isPrivate: true,
        isMember: true,
        status: 'ACTIVE',
        memberCount: 2,
      },
    ])
  );
  setup();
  expect(await screen.findByRole('link', { name: /Our room/ })).toHaveAttribute(
    'href',
    '/groups/ours'
  );
  expect(screen.queryByText('Secret room')).toBeNull();
});
it('favorites stay independent of game links and removal keeps focus', async () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
    },
  });
  try {
    setup(GamesPage);
    const add = await screen.findByRole('button', { name: 'Add dice to favorites' });
    expect(add.closest('a')).toBeNull();
    fireEvent.click(add);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove dice from favorites' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(document.querySelectorAll('.salem-own-tile')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove dice from favorites' }));
    await waitFor(() => expect(screen.getByText('No games found')).toBeInTheDocument());
    expect(screen.getByRole('searchbox', { name: 'Search games' })).toHaveFocus();
  } finally {
    Object.defineProperty(window, 'localStorage', previous);
  }
});
