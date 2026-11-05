import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  user: { id: 'member' } as { id: string } | null,
}));
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<any>('@/lib/api')),
  api: { get: f.get, post: f.post },
}));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: f.user }) }));
import { SportsPage } from './sports';
const baseline = {
  balanceMinor: 0,
  rewardBalanceMinor: 100000,
  currency: 'ETB',
  mode: 'real-wallet',
  browseReady: true,
  liveEnabled: false,
  canBet: false,
  reason: 'not-live',
};
function mount(patch = {}) {
  f.get.mockImplementation(async (path: string) => ({
    success: true,
    data: path.endsWith('/status') ? { ...baseline, ...patch } : [],
  }));
  f.post.mockResolvedValue({
    success: true,
    data: { mode: 'real-wallet', url: 'https://sports.example.com/session' },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SportsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(tree), tree, client };
}
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  f.user = { id: 'member' };
});
it('shows zero real Birr without adding practice or reward money', async () => {
  mount();
  expect(await screen.findByText('0.00 ETB')).toBeInTheDocument();
  expect(screen.getByText(/Betting opens when real-money play/)).toBeInTheDocument();
  expect(screen.queryByText(/1,000.00/)).toBeNull();
  expect(screen.getByRole('link', { name: /Open wallet/ })).toHaveAttribute('href', '/wallet');
  expect(f.post).not.toHaveBeenCalled();
});
it('opens a real-wallet browsing session only after the member clicks', async () => {
  const { container } = mount();
  const button = await screen.findByRole('button', { name: 'Browse sports' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() =>
    expect(container.querySelector('iframe')).toHaveAttribute(
      'src',
      'https://sports.example.com/session'
    )
  );
  expect(f.post).toHaveBeenCalledWith('/sportsbook/launch', { mobile: false });
  expect(container.querySelector('iframe')).toHaveAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-popups'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Back to sports' }));
  expect(container.querySelector('iframe')).toBeNull();
});
it.each([
  'http://sports.example.com',
  'https://name:password@sports.example.com',
  'javascript:alert(1)',
])('rejects unsafe launch URL %s', async (url) => {
  const { container } = mount();
  f.post.mockResolvedValue({ success: true, data: { mode: 'real-wallet', url } });
  const button = await screen.findByRole('button', { name: 'Browse sports' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('Sports could not be opened');
  expect(container.querySelector('iframe')).toBeNull();
});
it('rejects a practice-wallet response', async () => {
  const { container } = mount();
  f.post.mockResolvedValue({
    success: true,
    data: { mode: 'virtual-test', url: 'https://sports.example.com' },
  });
  const button = await screen.findByRole('button', { name: 'Browse sports' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByRole('alert');
  expect(container.querySelector('iframe')).toBeNull();
});
it('shows the funded balance and betting readiness only from the server', async () => {
  mount({ balanceMinor: 12345, liveEnabled: true, canBet: true, reason: null });
  expect(await screen.findByText('123.45 ETB')).toBeInTheDocument();
  expect(screen.getByText(/Each bet is checked/)).toBeInTheDocument();
});
it('keeps an empty wallet browseable after live launch but explains funding', async () => {
  mount({ liveEnabled: true, reason: 'empty-wallet' });
  expect(await screen.findByText(/Your real wallet is empty/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Browse sports' })).toBeEnabled();
});
it('does not present a failed balance read as zero', async () => {
  mount();
  await screen.findByText('0.00 ETB');
  f.get.mockRejectedValue(Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sports balance' }));
  expect(await screen.findByText('Unavailable')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Browse sports' })).toBeDisabled();
});
it('does not open sessions before provider configuration is ready', async () => {
  mount({ browseReady: false });
  await screen.findByText(/Sports is getting ready/);
  expect(screen.getByRole('button', { name: 'Browse sports' })).toBeDisabled();
  expect(f.post).not.toHaveBeenCalled();
});
it('removes the embedded session when the signed-in account changes', async () => {
  const view = mount();
  const button = await screen.findByRole('button', { name: 'Browse sports' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull());
  f.user = { id: 'different-member' };
  view.rerender(
    <QueryClientProvider client={view.client}>
      <MemoryRouter>
        <SportsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  expect(view.container.querySelector('iframe')).toBeNull();
});
