import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderTestPage } from './provider-test';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  user: { id: 'tester' } as { id: string } | null,
}));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  api: { get: mocks.get, post: mocks.post },
}));
const game = { id: 'studio/slot', name: 'Test Slot', provider: 'Studio', category: 'slots' };
const ok = (data: unknown) => ({ success: true, data });
function mount(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ProviderTestPage />
        </MemoryRouter>
      </QueryClientProvider>
    ),
  };
}
beforeEach(() => {
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
  fireEvent.click(screen.getByRole('button', { name: 'Back to casino' }));
  expect(v.container.querySelector('iframe')).toBeNull();
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
  await screen.findByText('Provider testing is not enabled for your account yet.');
  expect(v.container.querySelector('iframe')).toBeNull();
  expect(screen.queryByRole('searchbox')).toBeNull();
});
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
