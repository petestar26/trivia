import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LanguageProvider, LANGUAGES, translate } from '@/providers/language-provider';
import { clearPasswordResetLink, readPasswordResetLink } from '@/lib/password-reset-link';
import { LoginPage } from './login';
import { RegisterPage } from './register';
import { PasswordResetPage } from './password-reset';
import { WelcomePage, ExplorePage } from './welcome';

const mocks = vi.hoisted(() => ({ login: vi.fn(), register: vi.fn(), post: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: false, login: mocks.login, register: mocks.register }),
}));
vi.mock('@/components/google-sign-in-button', () => ({ GoogleSignInButton: () => null }));
vi.mock('@/lib/api', () => ({
  api: { post: mocks.post },
  unwrapData: (response: { data: unknown }) => response.data,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(localStorage.getItem).mockReturnValue(null);
  clearPasswordResetLink();
});
afterEach(() => {
  cleanup();
  clearPasswordResetLink();
  window.history.replaceState(null, '', '/');
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
});
function mount(page: ReactNode, path = '/login') {
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>
    </LanguageProvider>
  );
}
function edit(label: string, value: string) {
  const input = screen.getByLabelText(label, { exact: true });
  fireEvent.change(input, { target: { value } });
  return input;
}
function cycleLanguages(check: (code: (typeof LANGUAGES)[number]['code']) => void) {
  const selector = screen.getByRole('combobox', { name: 'Language' });
  expect(selector.closest('header')).not.toBeNull();
  expect(within(selector).getAllByRole('option')).toHaveLength(8);
  for (const { code, direction } of LANGUAGES) {
    fireEvent.change(selector, { target: { value: code } });
    expect(screen.getByRole('combobox', { name: translate(code, 'Language') })).toBe(selector);
    expect(selector).toHaveValue(code);
    expect(document.documentElement.lang).toBe(code);
    expect(document.documentElement.dir).toBe(direction);
    check(code);
  }
  expect(mocks.login).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
}

it.each(['email', 'phone', 'admin', 'agent'] as const)(
  'offers a public selector and preserves the %s sign-in form through all languages',
  (mode) => {
    const workspace = mode === 'admin' || mode === 'agent' ? mode : undefined;
    mount(<LoginPage workspace={workspace} />);
    if (mode === 'phone') fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
    const identifierLabel = mode === 'phone' ? 'Phone number' : 'Email';
    const identifierValue = mode === 'phone' ? '+251911111111' : 'member@example.invalid';
    const identifier = edit(identifierLabel, identifierValue);
    const password = edit('Password', 'Example-Only!44');
    const form = password.closest('form');
    if (!workspace) fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    const heading =
      mode === 'admin'
        ? 'Administrator sign in'
        : mode === 'agent'
          ? 'Agent sign in'
          : 'Welcome back';
    cycleLanguages((code) => {
      expect(screen.getByRole('heading', { name: translate(code, heading) })).toBeVisible();
      expect(screen.getByLabelText(translate(code, identifierLabel), { exact: true })).toBe(
        identifier
      );
      expect(identifier).toHaveValue(identifierValue);
      expect(identifier).toHaveAttribute('type', mode === 'phone' ? 'tel' : 'email');
      expect(screen.getByLabelText(translate(code, 'Password'), { exact: true })).toBe(password);
      expect(password).toHaveValue('Example-Only!44');
      expect(password).toHaveAttribute('type', workspace ? 'password' : 'text');
      expect(password.closest('form')).toBe(form);
      if (!workspace) {
        expect(
          screen.getByRole('button', {
            name: translate(code, mode === 'phone' ? 'Phone' : 'Email'),
          })
        ).toHaveAttribute('aria-pressed', 'true');
      }
    });
  }
);

it.each(['email', 'phone'] as const)(
  'preserves all %s registration drafts and referral values when the visible selector changes language',
  (mode) => {
    mount(<RegisterPage />, '/register?ref=ABCD1234');
    if (mode === 'phone') fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
    const fields = [
      ['Username', 'Home'],
      [
        mode === 'phone' ? 'Phone number' : 'Email',
        mode === 'phone' ? '+251911111111' : 'member@example.invalid',
      ],
      ['Display Name (optional)', 'Send <unchanged>'],
      ['Password', 'Example-Only!44'],
      ['Referral code (optional)', 'ABCD5678'],
    ].map(([label, value]) => ({ label, value, node: edit(label, value) }));
    const form = fields[0].node.closest('form');
    cycleLanguages((code) => {
      expect(
        screen.getByRole('heading', { name: translate(code, 'Create an account') })
      ).toBeVisible();
      for (const field of fields) {
        expect(screen.getByLabelText(translate(code, field.label), { exact: true })).toBe(
          field.node
        );
        expect(field.node).toHaveValue(field.value);
      }
      expect(fields[0].node.closest('form')).toBe(form);
      expect(
        screen.getByRole('button', {
          name: translate(code, mode === 'phone' ? 'Phone' : 'Email'),
        })
      ).toHaveAttribute('aria-pressed', 'true');
    });
  }
);

it('keeps the recovery form, unsaved passwords and private recovery credential through every language', () => {
  window.history.replaceState(null, '', '/reset-password#token=local-test-recovery-token');
  mount(<PasswordResetPage />, '/reset-password');
  const password = edit('New password', 'Example-Only!44');
  const confirmation = edit('Confirm new password', 'Example-Only!44');
  const form = password.closest('form');
  cycleLanguages((code) => {
    expect(
      screen.getByRole('heading', { name: translate(code, 'Set a new password') })
    ).toBeVisible();
    expect(screen.getByLabelText(translate(code, 'New password'), { exact: true })).toBe(password);
    expect(screen.getByLabelText(translate(code, 'Confirm new password'), { exact: true })).toBe(
      confirmation
    );
    expect(password).toHaveValue('Example-Only!44');
    expect(confirmation).toHaveValue('Example-Only!44');
    expect(password.closest('form')).toBe(form);
    expect(window.location.hash).toBe('');
    expect(document.body.textContent).not.toContain('local-test-recovery-token');
    expect(readPasswordResetLink()).toBe('local-test-recovery-token');
    expect(JSON.stringify(sessionStorage)).not.toContain('Example-Only!44');
  });
});

it.each(['welcome', 'explore'] as const)(
  'lets a new visitor choose a language in the %s header without signing in',
  (page) => {
    mount(
      page === 'welcome' ? <WelcomePage /> : <ExplorePage />,
      page === 'welcome' ? '/' : '/explore'
    );
    cycleLanguages((code) => {
      expect(screen.getByRole('link', { name: translate(code, 'Sign in') })).toHaveAttribute(
        'href',
        '/login'
      );
      expect(screen.getByRole('link', { name: translate(code, 'Create account') })).toHaveAttribute(
        'href',
        '/register'
      );
    });
  }
);
