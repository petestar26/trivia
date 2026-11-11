import type * as ApiModule from '@/lib/api';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderTestPage } from './provider-test';
import { createLaunchIntent } from '@/lib/launch-intent';
import { installMemoryStorage } from '@/test/memory-storage';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  user: { id: 'tester' } as { id: string } | null,
}));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof ApiModule>('@/lib/api')),
  api: { get: mocks.get, post: mocks.post },
}));
const game = { id: 'studio/slot', name: 'Test Slot', provider: 'Studio', category: 'slots' };
const ok = (data: unknown) => ({ success: true, data });
const favoriteKey = (id = 'tester') => `playqube.favorite-casino-games.v1:${id}`;
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
function NavigateInCasino() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/casino?game=second')}>Select second URL</button>
      <button onClick={() => navigate(-1)}>History back</button>
    </>
  );
}
function mount(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  }),
  entry = '/casino'
) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <NavigateInCasino />
          <ProviderTestPage />
        </MemoryRouter>
      </QueryClientProvider>
    ),
  };
}
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.mocked(window.localStorage.getItem).mockImplementation((key) => saved.get(key) ?? null);
  vi.mocked(window.localStorage.setItem).mockImplementation((key, value) => {
    saved.set(key, value);
  });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_key: string, _options: unknown, run: () => unknown) => Promise.resolve().then(run),
    },
  });
  mocks.user = { id: 'tester' };
  mocks.get.mockImplementation(async (path: string) =>
    ok(
      path.endsWith('/status')
        ? { enabled: true, launchReady: true }
        : path.endsWith('/wallet')
          ? { balanceCents: 100000, created: false, movements: [] }
          : [game]
    )
  );
  mocks.post.mockResolvedValue(
    ok({ mode: 'virtual-test', url: 'https://games.example.com/session' })
  );
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
  else Reflect.deleteProperty(navigator, 'locks');
});
it('places Favorites first and saves/removes a game without launching it', async () => {
  mount();
  const heart = await screen.findByRole('button', { name: 'Add Test Slot to favorites' });
  const tabs = within(screen.getByRole('group', { name: 'Game categories' })).getAllByRole(
    'button'
  );
  expect(tabs[0]).toHaveAccessibleName('Favorites');
  expect(tabs[1]).toHaveAccessibleName('All games');
  fireEvent.click(heart);
  await screen.findByRole('button', { name: 'Remove Test Slot from favorites' });
  expect(screen.getByRole('button', { name: 'Favorites' })).toHaveTextContent('1');
  fireEvent.click(tabs[0]);
  expect(screen.getByRole('button', { name: 'Play Test Slot' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Remove Test Slot from favorites' }));
  await screen.findByText('No favorites yet');
  expect(screen.getByRole('button', { name: 'Favorites' })).toHaveFocus();
  expect(screen.getByText('Tap the heart on a game to save it here.')).toBeVisible();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(JSON.parse(window.localStorage.getItem(favoriteKey())!).ids).toEqual([]);
});

it('restores casino favorites after reopening and isolates the next account', async () => {
  let v = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Add Test Slot to favorites' }));
  await screen.findByRole('button', { name: 'Remove Test Slot from favorites' });
  v.unmount();
  v = mount();
  await screen.findByRole('button', { name: 'Remove Test Slot from favorites' });
  v.unmount();
  mocks.user = { id: 'another-member' };
  mount();
  await screen.findByRole('button', { name: 'Add Test Slot to favorites' });
  fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
  expect(screen.getByText('No favorites yet')).toBeVisible();
  expect(window.localStorage.getItem(favoriteKey('another-member'))).toBeNull();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('keeps favorite filters useful and makes Spin overlap with existing categories', async () => {
  const get = mocks.get.getMockImplementation()!;
  const wheel = {
    id: 'wheel',
    name: 'Mega Wheel',
    provider: 'Live Studio',
    category: 'live',
    categories: ['live', 'spin'],
  };
  mocks.get.mockImplementation((path: string) =>
    path.endsWith('/games') ? Promise.resolve(ok([game, wheel])) : get(path)
  );
  window.localStorage.setItem(favoriteKey(), JSON.stringify({ version: 1, ids: [wheel.id] }));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Spin' }));
  expect(screen.getByRole('button', { name: 'Play Mega Wheel' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Play Test Slot' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Live casino' }));
  expect(screen.getByRole('button', { name: 'Play Mega Wheel' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Game provider' }), {
    target: { value: 'Studio' },
  });
  expect(screen.getByText('No games found')).toBeVisible();
  expect(screen.queryByText('No favorites yet')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(screen.getByRole('button', { name: 'Favorites' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Play Mega Wheel' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Play Test Slot' })).toBeNull();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('shows storage failure without pretending favorites were saved or disabling Play', async () => {
  vi.mocked(window.localStorage.getItem).mockImplementation(() => {
    throw new Error('blocked');
  });
  mount();
  expect(await screen.findByRole('button', { name: 'Add Test Slot to favorites' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Play Test Slot' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
  expect(screen.getByText('Favorites are unavailable in this browser.')).toBeVisible();
  expect(screen.queryByText('No favorites yet')).toBeNull();
});
it('uses a separate ETB balance and launches an Ethiopia game directly from its tile', async () => {
  mount();
  const button = await screen.findByRole('button', { name: 'Play Test Slot' });
  expect(screen.queryByLabelText('Country you are testing from')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Test wallet' })).toHaveTextContent('1,000.00 ETB');
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith('/provider-test/launch', {
      gameId: game.id,
      country: 'ET',
      mobile: false,
    })
  );
  expect(mocks.get.mock.calls.every(([p]) => p.startsWith('/provider-test/'))).toBe(true);
});
it('opens a restricted virtual test frame and closes it', async () => {
  const v = mount();
  await screen.findByRole('button', { name: 'Play Test Slot' });
  fireEvent.click(screen.getByRole('button', { name: 'Play Test Slot' }));
  await waitFor(() => expect(v.container.querySelector('iframe')).not.toBeNull());
  const frame = v.container.querySelector('iframe')!;
  expect(frame.getAttribute('sandbox')).toBe(
    'allow-scripts allow-same-origin allow-forms allow-pointer-lock'
  );
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  const external = screen.getByRole('link', { name: 'Open game in a new tab' });
  expect(external).toHaveAttribute('href', 'https://games.example.com/session');
  expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  expect(external).toHaveAttribute('referrerpolicy', 'no-referrer');
  fireEvent.click(screen.getByRole('button', { name: 'Back to casino' }));
  expect(v.container.querySelector('iframe')).toBeNull();
});
it.each([
  [
    'CASINO_GAME_REGION_UNAVAILABLE',
    'This provider does not offer this game in Ethiopia. Choose another game.',
  ],
  [
    'CASINO_GAME_CURRENCY_UNAVAILABLE',
    'This game does not support the ETB practice wallet. Choose another game.',
  ],
  [
    'CASINO_GAME_ADDRESS_PENDING',
    'This game is awaiting connection. Please choose another game for now.',
  ],
  ['CASINO_PROVIDER_TIMEOUT', 'The game provider took too long to respond. Please try again.'],
  ['CASINO_PROVIDER_BUSY', 'Please wait a moment before opening another game.'],
  [
    'CASINO_PROVIDER_UNAVAILABLE',
    'The game provider is temporarily unavailable. Try again later or choose another game.',
  ],
])('explains %s without displaying private provider error text', async (code, message) => {
  mocks.post.mockRejectedValue(
    new Error(JSON.stringify({ code, message: 'private provider credentials' }))
  );
  const v = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Play Test Slot' }));
  expect(await screen.findByText(message)).toBeVisible();
  expect(screen.queryByText('private provider credentials')).toBeNull();
  expect(v.container.querySelector('iframe')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Open game in a new tab' })).toBeNull();
});
it('shows every Keno result, category counts, provider filters, and overlapping live categories', async () => {
  const get = mocks.get.getMockImplementation()!;
  const games = [
    ...Array.from({ length: 42 }, (_, i) => ({
      id: `keno-${i}`,
      name: `Keno ${i}`,
      provider: i % 2 ? 'Studio B' : 'Studio A',
      category: 'keno',
    })),
    {
      id: 'live',
      name: 'Live Roulette',
      provider: 'Studio A',
      category: 'live',
      categories: ['live', 'table'],
    },
    { id: 'sports', name: 'Sports', provider: 'Sports', category: 'sportsbook' },
  ];
  mocks.get.mockImplementation((path: string) =>
    path.endsWith('/games') ? Promise.resolve(ok(games)) : get(path)
  );
  mount();
  const keno = await screen.findByRole('button', { name: 'Keno' });
  expect(keno).toHaveTextContent('42');
  fireEvent.click(keno);
  expect(screen.getAllByRole('button', { name: /^Play / })).toHaveLength(36);
  fireEvent.click(screen.getByRole('button', { name: 'Show more games' }));
  expect(screen.getAllByRole('button', { name: /^Play / })).toHaveLength(42);
  fireEvent.change(screen.getByRole('combobox', { name: 'Game provider' }), {
    target: { value: 'Studio B' },
  });
  expect(keno).toHaveTextContent('21');
  expect(screen.getAllByRole('button', { name: /^Play / })).toHaveLength(21);
  fireEvent.change(screen.getByRole('combobox', { name: 'Game provider' }), {
    target: { value: 'all' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Table games' }));
  expect(screen.getByRole('button', { name: 'Play Live Roulette' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Live casino' }));
  expect(screen.getByRole('button', { name: 'Play Live Roulette' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Play Sports' })).toBeNull();
  expect(mocks.post).not.toHaveBeenCalled();
});
it.each([
  { mode: 'demo', url: 'https://games.example.com/x' },
  { mode: 'virtual-test', url: 'javascript:alert(1)' },
  { mode: 'virtual-test', url: 'https://user:pass@games.example.com/x' },
])('rejects incompatible or unsafe launch responses', async (result) => {
  mocks.post.mockResolvedValue(ok(result));
  const v = mount();
  await screen.findByRole('button', { name: 'Play Test Slot' });
  fireEvent.click(screen.getByRole('button', { name: 'Play Test Slot' }));
  await screen.findByText(/This game could not be opened/);
  expect(v.container.querySelector('iframe')).toBeNull();
});
it('removes an open frame and cached titles when test access is revoked', async () => {
  const v = mount();
  await screen.findByRole('button', { name: 'Play Test Slot' });
  fireEvent.click(screen.getByRole('button', { name: 'Play Test Slot' }));
  await waitFor(() => expect(v.container.querySelector('iframe')).not.toBeNull());
  act(() =>
    v.client.setQueryData(['provider-test-status', 'tester'], { enabled: false, launchReady: true })
  );
  await screen.findByText('Casino practice is not available for this account.');
  expect(v.container.querySelector('iframe')).toBeNull();
  expect(screen.queryByRole('searchbox')).toBeNull();
});
it.each([
  ['paused', 'Casino practice is temporarily paused. Please try again later.'],
  ['setup-required', 'Casino practice is temporarily unavailable. Please try again shortly.'],
  ['restricted', 'Casino practice is not available for this account.'],
])(
  'explains %s without misreporting an account restriction and recovers on retry',
  async (reason, message) => {
    const get = mocks.get.getMockImplementation()!;
    let available = false;
    mocks.get.mockImplementation((path: string) =>
      path.endsWith('/status') && !available
        ? Promise.resolve(ok({ enabled: false, launchReady: true, unavailableReason: reason }))
        : get(path)
    );
    mount();
    await screen.findByText(message);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByText('Provider testing is not enabled for your account yet.')).toBeNull();
    available = true;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Play Test Slot' })).toBeEnabled();
    expect(screen.queryByText(message)).toBeNull();
  }
);
it('keeps launch disabled when its address is not configured', async () => {
  mocks.get.mockImplementation(async (path: string) =>
    ok(
      path.endsWith('/status')
        ? { enabled: true, launchReady: false }
        : path.endsWith('/wallet')
          ? { balanceCents: 100000, created: false, movements: [] }
          : [game]
    )
  );
  mount();
  await screen.findByRole('button', { name: 'Play Test Slot' });
  expect(screen.getByRole('button', { name: 'Play Test Slot' })).toBeDisabled();
  expect(mocks.post).not.toHaveBeenCalled();
});
it('shows provider artwork and retains a playable card if an image fails', async () => {
  const get = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation((path: string) =>
    path.endsWith('/games')
      ? Promise.resolve(ok([{ ...game, image: 'https://cdn.example.com/slot.webp' }]))
      : get(path)
  );
  const v = mount();
  const button = await screen.findByRole('button', { name: 'Play Test Slot' });
  const image = v.container.querySelector('img')!;
  expect(image).toHaveAttribute('src', 'https://cdn.example.com/slot.webp');
  expect(image).toHaveAttribute('loading', 'lazy');
  expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
  fireEvent.error(image);
  expect(v.container.querySelector('img')).toBeNull();
  expect(button).toBeEnabled();
  expect(screen.queryByText('Open test game')).not.toBeInTheDocument();
});
it('pauses off-screen artwork and lets users stop previews without launching a game', async () => {
  const observers: IntersectionObserverCallback[] = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    }
  );
  const get = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation((path: string) =>
    path.endsWith('/games')
      ? Promise.resolve(ok([{ ...game, image: 'https://cdn.example.com/slot.webp' }]))
      : get(path)
  );
  const v = mount();
  await screen.findByRole('button', { name: 'Play Test Slot' });
  const art = v.container.querySelector('.casino-tile-art')!;
  fireEvent.load(art.querySelector('img')!);
  expect(art).toHaveAttribute('data-motion', 'false');
  act(() =>
    observers[0](
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
  );
  expect(art).toHaveAttribute('data-motion', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Pause previews' }));
  expect(art).toHaveAttribute('data-motion', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Animate previews' }));
  expect(art).toHaveAttribute('data-motion', 'true');
  act(() =>
    observers[0](
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
  );
  expect(art).toHaveAttribute('data-motion', 'false');
  expect(mocks.post).not.toHaveBeenCalled();
  expect(v.container.querySelector('iframe')).toBeNull();
});
it('starts with still artwork for reduced-motion users', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: query.includes('reduced-motion') }))
  );
  mount();
  await screen.findByRole('button', { name: 'Play Test Slot' });
  expect(screen.getByRole('button', { name: 'Animate previews' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  expect(mocks.post).not.toHaveBeenCalled();
});
it('recovers from a broken portrait using the provider fallback before showing a placeholder', async () => {
  const get = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation((path: string) =>
    path.endsWith('/games')
      ? Promise.resolve(
          ok([
            {
              ...game,
              image: 'https://cdn.example.com/portrait.jpg',
              imageFallback: 'https://cdn.example.com/wide.jpg',
            },
          ])
        )
      : get(path)
  );
  const v = mount();
  await screen.findByRole('button', { name: 'Play Test Slot' });
  fireEvent.error(v.container.querySelector('img')!);
  expect(v.container.querySelector('img')).toHaveAttribute(
    'src',
    'https://cdn.example.com/wide.jpg'
  );
  fireEvent.load(v.container.querySelector('img')!);
  expect(v.container.querySelector('.casino-tile-art')).toHaveAttribute('data-loaded', 'true');
  fireEvent.error(v.container.querySelector('img')!);
  expect(v.container.querySelector('img')).toBeNull();
  expect(screen.getByRole('button', { name: 'Play Test Slot' })).toBeEnabled();
  expect(mocks.post).not.toHaveBeenCalled();
});
it('browses the full catalogue in batches and combines category and provider search', async () => {
  const get = mocks.get.getMockImplementation()!;
  const games = Array.from({ length: 40 }, (_, i) => ({
    ...game,
    id: `slot-${i}`,
    name: `Slot ${i}`,
  }));
  games.push({
    ...game,
    id: 'cards',
    name: 'Blackjack',
    provider: 'Card Studio',
    category: 'table',
  });
  mocks.get.mockImplementation((path: string) =>
    path.endsWith('/games') ? Promise.resolve(ok(games)) : get(path)
  );
  mount();
  await screen.findByRole('button', { name: 'Play Slot 0' });
  expect(screen.queryByRole('button', { name: 'Play Blackjack' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show more games' }));
  expect(screen.getByRole('button', { name: 'Play Blackjack' })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /^Play / })).toHaveLength(41);
  fireEvent.click(screen.getByRole('button', { name: 'Table games' }));
  expect(screen.getByRole('button', { name: 'Table games' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(screen.getAllByRole('button', { name: /^Play / })).toHaveLength(1);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } });
  expect(screen.getByText('No games found')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Card Studio' } });
  expect(screen.getByRole('button', { name: 'Play Blackjack' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Play Slot 0' })).not.toBeInTheDocument();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('opens a selected Home game once after access and wallet checks', async () => {
  // The member's plain click on the Home tile created this one-time intent.
  const storage = installMemoryStorage();
  const intent = createLaunchIntent('casino', 'tester', 'studio/slot');
  const v = mount(undefined, `/casino?game=studio%2Fslot&intent=${intent}`);
  await waitFor(() => expect(v.container.querySelector('iframe')).not.toBeNull());
  expect(mocks.post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Back to casino' }));
  await screen.findByRole('button', { name: 'Play Test Slot' });
  expect(mocks.post).toHaveBeenCalledTimes(1);
  storage.restore();
});
it.each([
  ['a pasted or bookmarked link', '/casino?game=studio%2Fslot'],
  [
    'a reused or unknown intent',
    '/casino?game=studio%2Fslot&intent=0f8b1c2e-3d4a-4b5c-8d9e-112233445566',
  ],
])('selects the game from %s but waits for Play before launching', async (_label, entry) => {
  const v = mount(undefined, entry);
  const play = await screen.findByRole('button', { name: 'Play' });
  expect(screen.getByText('Nothing starts until you choose Play.')).toBeVisible();
  await waitFor(() => expect(play).toBeEnabled());
  expect(mocks.post).not.toHaveBeenCalled();
  expect(v.container.querySelector('iframe')).toBeNull();
  fireEvent.click(play);
  await waitFor(() => expect(v.container.querySelector('iframe')).not.toBeNull());
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
it('does not launch from another member’s click intent', async () => {
  const storage = installMemoryStorage();
  const intent = createLaunchIntent('casino', 'another-member', 'studio/slot');
  mount(undefined, `/casino?game=studio%2Fslot&intent=${intent}`);
  expect(await screen.findByRole('button', { name: 'Play' })).toBeVisible();
  expect(mocks.post).not.toHaveBeenCalled();
  storage.restore();
});
it('rejects an unknown Home game id without a launch', async () => {
  mount(undefined, '/casino?game=unknown');
  await screen.findByText(/no longer in the collection/);
  expect(mocks.post).not.toHaveBeenCalled();
});

it('never reuses an arrival intent for another route or browser Back', async () => {
  const storage = installMemoryStorage();
  try {
    const get = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((path: string) =>
      path.endsWith('/games')
        ? Promise.resolve(ok([game, { ...game, id: 'second', name: 'Second Game' }]))
        : get(path)
    );
    const nonce = createLaunchIntent('casino', 'tester', game.id);
    mount(undefined, `/casino?game=${encodeURIComponent(game.id)}&intent=${nonce}`);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Select second URL' }));
    await screen.findByText('Second Game', { selector: 'h2' });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'History back' }));
    await screen.findByRole('button', { name: 'Play' });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  } finally {
    storage.restore();
  }
});

it('refuses a fresh Play from a stale session before issuing a launch request', async () => {
  const storage = installMemoryStorage();
  try {
    mount();
    const play = await screen.findByRole('button', { name: 'Play Test Slot' });
    localStorage.setItem(
      'socialplay.session-boundary',
      JSON.stringify({ revision: 'other-login', signedOut: false })
    );
    await act(async () => fireEvent.click(play));
    expect(mocks.post).not.toHaveBeenCalled();
  } finally {
    storage.restore();
  }
});

it('requires fresh Play when catalogue readiness outlives the original intent TTL', async () => {
  const storage = installMemoryStorage();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const issuedAt = Date.now();
    const nonce = createLaunchIntent('casino', 'tester', game.id);
    vi.setSystemTime(issuedAt + 59_000);
    let resolveCatalogue!: (value: unknown) => void;
    const catalogue = new Promise((resolve) => {
      resolveCatalogue = resolve;
    });
    const get = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((path: string) =>
      path.endsWith('/games') ? catalogue : get(path)
    );
    mount(undefined, `/casino?game=${encodeURIComponent(game.id)}&intent=${nonce}`);
    await waitFor(() => expect(storage.memory.has(`salem-launch-intent:${nonce}`)).toBe(false));
    vi.setSystemTime(issuedAt + 61_000);
    await act(async () => resolveCatalogue(ok([game])));
    const play = await screen.findByRole('button', { name: 'Play' });
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(play);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  } finally {
    vi.useRealTimers();
    storage.restore();
  }
});

it('allows a fresh Play after BFCache restoration without reviving the spent arrival intent', async () => {
  const storage = installMemoryStorage();
  try {
    const intent = createLaunchIntent('casino', 'tester', game.id);
    const view = mount(undefined, `/casino?game=${encodeURIComponent(game.id)}&intent=${intent}`);
    await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull());
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    const play = await screen.findByRole('button', { name: 'Play' });
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    fireEvent.click(play);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull());
  } finally {
    storage.restore();
  }
});

it('never publishes a pre-BFCache launch response after a fresh restored Play', async () => {
  let finishOld!: (value: unknown) => void;
  mocks.post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      })
  );
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Play Test Slot' }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  await act(async () => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  const play = await screen.findByRole('button', { name: 'Play Test Slot' });
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('iframe')).toBeNull();
  fireEvent.click(play);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(view.container.querySelector('iframe')).toHaveAttribute(
      'src',
      'https://games.example.com/session'
    )
  );
  await act(async () =>
    finishOld(ok({ mode: 'virtual-test', url: 'https://games.example.com/stale' }))
  );
  expect(view.container.querySelector('iframe')).toHaveAttribute(
    'src',
    'https://games.example.com/session'
  );
  expect(mocks.post).toHaveBeenCalledTimes(2);
});
