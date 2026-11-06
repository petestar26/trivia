import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { LanguageProvider, useLanguage, LANGUAGES, translations } from './language-provider';
import { LanguageSelect } from '@/components/layout/language-select';
import { LocalizedText } from '@/lib/i18n/text';
const saved = new Map<string, string>();
beforeEach(() => {
  saved.clear();
  vi.spyOn(localStorage, 'getItem').mockImplementation((key) => saved.get(key) ?? null);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    saved.set(key, value);
  });
  vi.spyOn(localStorage, 'clear').mockImplementation(() => {
    saved.clear();
  });
});
function Sample() {
  const { t, formatNumber } = useLanguage();
  const [name, setName] = useState('');
  return (
    <>
      <LanguageSelect />
      <h1>{t('Home')}</h1>
      <p>{t('Member-supplied text')}</p>
      <label>
        Member name
        <input
          aria-label="Member name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <output>{formatNumber(1234.5)}</output>
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.dir = 'ltr';
  document.documentElement.lang = 'en';
});
it('translates navigation in each listed language without missing core labels', () => {
  for (const language of LANGUAGES.filter((l) => l.code !== 'en')) {
    expect(Object.values(translations[language.code]).every(Boolean)).toBe(true);
    expect(translations[language.code].Home).toBeTruthy();
    expect(translations[language.code].Withdraw).toBeTruthy();
  }
});
it('changes language, sets reading direction, and keeps unknown strings readable', () => {
  render(
    <LanguageProvider>
      <Sample />
    </LanguageProvider>
  );
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'am' } });
  expect(screen.getByRole('heading')).toHaveTextContent('መነሻ');
  expect(document.documentElement.lang).toBe('am');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ar' } });
  expect(document.documentElement.dir).toBe('rtl');
  expect(screen.getByText('Member-supplied text')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
  expect(document.documentElement.dir).toBe('ltr');
});
it('preserves an unfinished form while changing language, saves the preference, and localizes numbers', () => {
  const first = render(
    <LanguageProvider>
      <Sample />
    </LanguageProvider>
  );
  fireEvent.change(screen.getByLabelText('Member name'), { target: { value: '<b>Home</b>' } });
  const originalInput = screen.getByLabelText('Member name');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ar' } });
  expect(screen.getByLabelText('Member name')).toBe(originalInput);
  expect(screen.getByLabelText('Member name')).toHaveValue('<b>Home</b>');
  expect(screen.getByRole('status')).toHaveTextContent(
    new Intl.NumberFormat('ar-EG').format(1234.5)
  );
  expect(localStorage.getItem('salem-language')).toBe('ar');
  first.unmount();
  render(
    <LanguageProvider>
      <Sample />
    </LanguageProvider>
  );
  expect(screen.getByRole('combobox')).toHaveValue('ar');
  expect(document.documentElement.dir).toBe('rtl');
});
it('falls back safely for an invalid saved code and remains usable when storage is unavailable', () => {
  localStorage.setItem('salem-language', 'invalid');
  const first = render(
    <LanguageProvider>
      <Sample />
    </LanguageProvider>
  );
  expect(screen.getByRole('combobox')).toHaveValue('en');
  first.unmount();
  vi.mocked(localStorage.getItem).mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  vi.mocked(localStorage.setItem).mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  render(
    <LanguageProvider>
      <Sample />
    </LanguageProvider>
  );
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'fr' } });
  expect(screen.getByRole('heading')).toHaveTextContent('Accueil');
  expect(document.documentElement.lang).toBe('fr');
  expect(document.documentElement.dir).toBe('ltr');
});
it('retranslates explicit source labels in saved notices while preserving member-supplied values', () => {
  render(
    <LanguageProvider>
      <LanguageSelect />
      <p data-testid="notice">
        <LocalizedText
          message="{name} · {role} · {content}"
          values={{ name: 'Home', role: 'Home', content: '<b>Home</b>' }}
          translateValues={['role']}
        />
      </p>
    </LanguageProvider>
  );
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'am' } });
  expect(screen.getByTestId('notice')).toHaveTextContent('Home · መነሻ · <b>Home</b>');
  expect(screen.getByTestId('notice').querySelector('b')).toBeNull();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'fr' } });
  expect(screen.getByTestId('notice')).toHaveTextContent('Home · Accueil · <b>Home</b>');
});
