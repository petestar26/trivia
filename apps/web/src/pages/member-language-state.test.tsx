import type * as ApiModule from '@/lib/api';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HELP_ARTICLES } from '@socialplay/shared';
import { ProfilePage } from './profile';
import { SupportPage } from './support';
import { LANGUAGES, LanguageProvider, useLanguage, translate } from '@/providers/language-provider';
import { formatMinorCurrency } from '@/lib/i18n/format';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  logout: vi.fn(),
  refreshUser: vi.fn(),
}));
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'member' }, logout: mocks.logout, refreshUser: mocks.refreshUser }),
}));
vi.mock('@/components/security/authenticator-setup', () => ({ AuthenticatorSetup: () => null }));
vi.mock('@/components/security/change-password', () => ({ ChangePassword: () => null }));
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof ApiModule>('@/lib/api')),
  api: mocks,
}));
const ok = (data: unknown) => ({ success: true, data });
const profile = {
  id: 'member',
  username: 'Home',
  displayName: 'Withdraw',
  bio: 'Send',
  email: 'member@example.invalid',
  phone: '+251911111111',
  phoneVerified: true,
  isVerified: true,
  role: 'USER',
  status: 'ACTIVE',
  createdAt: '2026-10-15T12:00:00Z',
  lastLoginAt: null,
  signInMethods: ['password'],
  payoutCountry: null,
  kycVerification: null,
};
function Switcher() {
  const { setLanguage } = useLanguage();
  return (
    <>
      {LANGUAGES.map((l) => (
        <button key={l.code} data-testid={'language-' + l.code} onClick={() => setLanguage(l.code)}>
          {l.code}
        </button>
      ))}
    </>
  );
}
function mount(page: React.ReactNode) {
  return render(
    <MemoryRouter>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
          })
        }
      >
        <LanguageProvider>
          <Switcher />
          {page}
        </LanguageProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (path: string) =>
    ok(
      path === '/member-profile'
        ? profile
        : path.startsWith('/member-rewards')
          ? {
              wallet: {
                coinAvailability: {
                  spendable: 123456,
                  betOnly: 500,
                  pendingReview: 0,
                  reserved: 0,
                },
              },
            }
          : path === '/support/help'
            ? { aiEnabled: false, articles: HELP_ARTICLES }
            : { tickets: [], hasMore: false }
    )
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('preserves profile identity and unsaved input nodes across all eight languages without making a write', async () => {
  mount(<ProfilePage />);
  await screen.findByRole('heading', { name: 'Withdraw' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
  const name = screen.getByLabelText('Display name');
  const bio = screen.getByLabelText('About you');
  fireEvent.change(name, { target: { value: 'Home <unchanged>' } });
  fireEvent.change(bio, { target: { value: 'Withdraw & Send are my own words.' } });
  for (const { code, direction } of LANGUAGES) {
    fireEvent.click(screen.getByTestId('language-' + code));
    expect(screen.getByLabelText(translate(code, 'Display name'))).toBe(name);
    expect(name).toHaveValue('Home <unchanged>');
    expect(bio).toHaveValue('Withdraw & Send are my own words.');
    expect(screen.getByRole('heading', { name: 'Withdraw' })).toBeVisible();
    const handles = screen.getAllByText('@Home');
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) expect(handle.closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByText('Send', { selector: '.member-bio' })).toBeVisible();
    expect(screen.getByText(translate(code, 'Account status'))).toBeVisible();
    expect(
      await screen.findByText(
        (_text, node) =>
          node?.tagName === 'STRONG' && node.textContent === formatMinorCurrency(code, 123456)
      )
    ).toBeVisible();
    expect(document.documentElement.dir).toBe(direction);
  }
  expect(mocks.patch).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});

it('keeps support drafts intact and displays the complete shared help copy in each language without calling AI', async () => {
  mount(<SupportPage />);
  await screen.findByText(HELP_ARTICLES[2].title);
  for (const { code } of LANGUAGES) {
    fireEvent.click(screen.getByTestId('language-' + code));
    const article = screen.getByText(translate(code, HELP_ARTICLES[2].title)).closest('details');
    expect(article).not.toBeNull();
    expect(within(article!).getByText(translate(code, HELP_ARTICLES[2].body))).toBeInTheDocument();
  }
  fireEvent.click(screen.getByTestId('language-en'));
  fireEvent.click(screen.getAllByRole('button', { name: 'Contact support' })[0]);
  const subject = screen.getByLabelText('Subject');
  const message = screen.getByLabelText('Message');
  fireEvent.change(subject, { target: { value: 'Home' } });
  fireEvent.change(message, { target: { value: 'Send <only as text>' } });
  for (const { code } of LANGUAGES) {
    fireEvent.click(screen.getByTestId('language-' + code));
    expect(screen.getByLabelText(translate(code, 'Subject'))).toBe(subject);
    expect(subject).toHaveValue('Home');
    expect(message).toHaveValue('Send <only as text>');
  }
  await waitFor(() => expect(mocks.get).toHaveBeenCalled());
  expect(mocks.post).not.toHaveBeenCalled();
});
