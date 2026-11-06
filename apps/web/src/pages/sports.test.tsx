import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
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
import { LanguageProvider, type Language } from '@/providers/language-provider';
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
function mount(patch = {}, language: Language = 'en') {
  vi.mocked(localStorage.getItem).mockImplementation((key) =>
    key === 'salem-language' ? language : null
  );
  f.get.mockImplementation(async (path: string) => ({
    success: true,
    data: path.endsWith('/status') ? { ...baseline, ...patch } : [],
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <LanguageProvider>
          <MemoryRouter>
            <SportsPage />
          </MemoryRouter>
        </LanguageProvider>
      </QueryClientProvider>
    ),
    client,
  };
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  f.user = { id: 'member' };
});
it('shows zero real Birr without adding practice or reward money', async () => {
  mount();
  expect(await screen.findByText('ETB 0.00')).toBeInTheDocument();
  expect(screen.getByText(/Betting opens when real-money play/)).toBeInTheDocument();
  expect(screen.queryByText(/1,000.00/)).toBeNull();
  expect(screen.getByRole('link', { name: /Open wallet/ })).toHaveAttribute('href', '/wallet');
  expect(f.post).not.toHaveBeenCalled();
});
it('opens a protected launch page in a separate tab without embedding the provider', async () => {
  const { container } = mount();
  const link = await screen.findByRole('link', { name: 'Browse sports' });
  expect(link).toHaveAttribute('href', '/sports/open');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText(/Opens in a new tab/)).toBeInTheDocument();
  expect(container.querySelector('iframe')).toBeNull();
  expect(f.post).not.toHaveBeenCalled();
});
it('shows the funded balance and betting readiness only from the server', async () => {
  mount({ balanceMinor: 12345, liveEnabled: true, canBet: true, reason: null });
  expect(await screen.findByText('ETB 123.45')).toBeInTheDocument();
  expect(screen.getByText(/Each bet is checked/)).toBeInTheDocument();
});
it('keeps an empty wallet browseable after live launch but explains funding', async () => {
  mount({ liveEnabled: true, reason: 'empty-wallet' });
  expect(await screen.findByText(/Your real wallet is empty/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Browse sports' })).toBeInTheDocument();
});
it('does not present a failed balance read as zero or leave a launch link', async () => {
  mount();
  await screen.findByText('ETB 0.00');
  f.get.mockRejectedValue(Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sports balance' }));
  expect(await screen.findByText('Unavailable')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Browse sports' })).toBeDisabled();
  expect(screen.queryByRole('link', { name: 'Browse sports' })).toBeNull();
});
it('does not open sessions before provider configuration is ready', async () => {
  mount({ browseReady: false });
  await screen.findByText(/Sports is getting ready/);
  expect(screen.getByRole('button', { name: 'Browse sports' })).toBeDisabled();
  expect(f.post).not.toHaveBeenCalled();
});
it('removes the old balance and launch link when the signed-in account changes', async () => {
  const view = mount({ balanceMinor: 12345 });
  await screen.findByText('ETB 123.45');
  f.get.mockImplementation(() => new Promise(() => {}));
  f.user = { id: 'different-member' };
  view.rerender(
    <QueryClientProvider client={view.client}>
      <MemoryRouter>
        <SportsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  expect(screen.queryByText('ETB 123.45')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Browse sports' })).toBeNull();
});

it.each([
  { language: 'fr' as const, amount: /123,45\sETB/ },
  { language: 'ar' as const, amount: /١٢٣٫٤٥\sETB/ },
])(
  'localizes the exact real balance in $language without spending or adding bonus credits',
  async ({ language, amount }) => {
    mount({ balanceMinor: 12345, liveEnabled: true, canBet: true, reason: null }, language);
    expect(await screen.findByText(amount)).toBeVisible();
    expect(screen.queryByText(/1[,. ]?000|١٬٠٠٠/)).toBeNull();
    expect(f.post).not.toHaveBeenCalled();
  }
);
