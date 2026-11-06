import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppInstallProvider, InstallAppButton, installationGuide } from '@/components/app-install';
import { PaymentNavigation, PaymentSteps } from '@/pages/wallet-navigation';
import { LanguageProvider, useLanguage } from '@/providers/language-provider';
import { LANGUAGES } from './types';
import { translate } from './format';

function ChooseLanguage() {
  const { setLanguage } = useLanguage();
  return <button onClick={() => setLanguage('ar')}>change test language</button>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(LANGUAGES)(
  'shows installation and payment metadata in $code without altering payment destinations',
  ({ code }) => {
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
      key === 'salem-language' ? code : null
    );
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={['/wallet/crypto?direction=withdraw']}>
          <PaymentNavigation method="crypto" />
          <PaymentSteps method="crypto" direction="withdraw" />
          <AppInstallProvider>
            <InstallAppButton />
          </AppInstallProvider>
        </MemoryRouter>
      </LanguageProvider>
    );
    const withdraw = screen.getByRole('link', { name: translate(code, 'Withdraw') });
    expect(withdraw).toHaveAttribute('href', '/wallet/crypto?direction=withdraw');
    expect(withdraw).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText(translate(code, 'Enter amount & address'))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: translate(code, 'Install app') }));
    const dialog = screen.getByRole('dialog', { name: translate(code, 'Install Salem Bet') });
    const guide = installationGuide(
      navigator.userAgent,
      navigator.platform,
      navigator.maxTouchPoints
    );
    for (const step of guide.steps)
      expect(within(dialog).getByText(translate(code, step))).toBeVisible();
    expect(document.documentElement.dir).toBe(code === 'ar' ? 'rtl' : 'ltr');
  }
);

it('updates an already open installation guide and payment steps after changing language', () => {
  vi.spyOn(localStorage, 'getItem').mockReturnValue(null);
  vi.stubGlobal(
    'matchMedia',
    vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  );
  render(
    <LanguageProvider>
      <MemoryRouter>
        <ChooseLanguage />
        <input aria-label="saved user draft" defaultValue="User-entered text" />
        <PaymentSteps method="agent" direction="deposit" />
        <AppInstallProvider>
          <InstallAppButton />
        </AppInstallProvider>
      </MemoryRouter>
    </LanguageProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Install app' }));
  fireEvent.click(screen.getByRole('button', { name: 'change test language', hidden: true }));
  expect(screen.getByRole('dialog', { name: 'تثبيت Salem Bet' })).toBeVisible();
  expect(screen.getByText('اختر المبلغ والوكيل')).toBeInTheDocument();
  expect(screen.queryByText('Choose amount & agent')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'saved user draft', hidden: true })).toHaveValue(
    'User-entered text'
  );
});
