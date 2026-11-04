import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderDemoPage } from './provider-demo';

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
const game = { id: 'studio/slot', name: 'Demo slot', provider: 'Studio', category: 'slots' };
const ok = (data: unknown) => ({ success: true, data });
function mount(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProviderDemoPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  mocks.user = { id: 'tester' };
  mocks.get.mockImplementation(async (path: string) =>
    ok(path.endsWith('/status') ? { enabled: true } : [game])
  );
  mocks.post.mockResolvedValue(ok({ mode: 'demo', url: 'https://games.example.com/demo' }));
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
});

it('hides cached catalogue entries when access is disabled', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(['provider-demo-games', 'tester'], [game]);
  mocks.get.mockResolvedValue(ok({ enabled: false }));
  mount(client);
  await screen.findByText('Provider demos are not enabled for your account yet.');
  expect(screen.queryByRole('button', { name: 'Try demo' })).toBeNull();
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('removes the open iframe and clears selection when access is revoked', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const view = mount(client);
  fireEvent.click(await screen.findByRole('button', { name: 'Try demo' }));
  await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull());
  act(() => {
    client.setQueryData(['provider-demo-status', 'tester'], { enabled: false });
  });
  await screen.findByText('Provider demos are not enabled for your account yet.');
  expect(view.container.querySelector('iframe')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try demo' })).toBeNull();
  act(() => {
    client.setQueryData(['provider-demo-status', 'tester'], { enabled: true });
  });
  await screen.findByRole('button', { name: 'Try demo' });
  expect(view.container.querySelector('iframe')).toBeNull();
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('keeps disabled accounts out of provider catalogue and launch', async () => {
  mocks.get.mockResolvedValue(ok({ enabled: false }));
  mount();
  expect(
    await screen.findByText('Provider demos are not enabled for your account yet.')
  ).toBeTruthy();
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(mocks.post).not.toHaveBeenCalled();
});
it('opens only demo endpoint in a restricted iframe and closes it', async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Try demo' }));
  await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull());
  expect(mocks.post).toHaveBeenCalledWith('/provider-demo/launch', {
    gameId: game.id,
    mobile: false,
  });
  const frame = view.container.querySelector('iframe')!;
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
  expect(screen.getByText(/wallet is not connected/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close game' }));
  expect(view.container.querySelector('iframe')).toBeNull();
});
it('filters the catalogue without another provider request', async () => {
  mount();
  await screen.findByText('Demo slot');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } });
  expect(screen.getByText('No demo games available for this search.')).toBeTruthy();
  expect(mocks.get).toHaveBeenCalledTimes(2);
});
it.each([
  { mode: 'live', url: 'https://games.example.com/live' },
  { mode: 'demo', url: 'javascript:alert(1)' },
])('does not embed invalid or live launch response', async (result) => {
  mocks.post.mockResolvedValue(ok(result));
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Try demo' }));
  await screen.findByRole('alert');
  expect(view.container.querySelector('iframe')).toBeNull();
});
it('shows retry for a provider failure', async () => {
  mocks.post.mockRejectedValue(new Error('Provider unavailable'));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Try demo' }));
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
});
