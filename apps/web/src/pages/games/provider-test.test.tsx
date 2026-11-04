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
it('uses a separate ETB balance and requires the actual test country before launch', async () => {
  mount();
  const button = await screen.findByRole('button', { name: 'Open test game' });
  expect(button).toBeDisabled();
  expect(screen.getByText('1,000.00 ETB')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'LA' } });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith('/provider-test/launch', {
      gameId: game.id,
      country: 'LA',
      mobile: false,
    })
  );
  expect(mocks.get.mock.calls.every(([p]) => p.startsWith('/provider-test/'))).toBe(true);
});
it('opens a restricted virtual test frame and closes it', async () => {
  const v = mount();
  await screen.findByRole('button', { name: 'Open test game' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ET' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open test game' }));
  await waitFor(() => expect(v.container.querySelector('iframe')).not.toBeNull());
  const frame = v.container.querySelector('iframe')!;
  expect(frame.getAttribute('sandbox')).toBe(
    'allow-scripts allow-same-origin allow-forms allow-pointer-lock'
  );
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  fireEvent.click(screen.getByRole('button', { name: 'Close game' }));
  expect(v.container.querySelector('iframe')).toBeNull();
});
it.each([
  { mode: 'demo', url: 'https://games.example.com/x' },
  { mode: 'virtual-test', url: 'javascript:alert(1)' },
  { mode: 'virtual-test', url: 'https://user:pass@games.example.com/x' },
])('rejects incompatible or unsafe launch responses', async (result) => {
  mocks.post.mockResolvedValue(ok(result));
  const v = mount();
  await screen.findByRole('button', { name: 'Open test game' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'LA' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open test game' }));
  await screen.findByText(/This test game could not be opened/);
  expect(v.container.querySelector('iframe')).toBeNull();
});
it('removes an open frame and cached titles when test access is revoked', async () => {
  const v = mount();
  await screen.findByRole('button', { name: 'Open test game' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'LA' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open test game' }));
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
  await screen.findByRole('button', { name: 'Open test game' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'LA' } });
  expect(screen.getByRole('button', { name: 'Open test game' })).toBeDisabled();
  expect(mocks.post).not.toHaveBeenCalled();
});
