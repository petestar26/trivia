import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, it, expect } from 'vitest';
import { LanguageProvider, useLanguage, LANGUAGES, translations } from './language-provider';
import { LanguageSelect } from '@/components/layout/language-select';
function Sample() {
  const { t } = useLanguage();
  return (
    <>
      <LanguageSelect />
      <h1>{t('Home')}</h1>
      <p>{t('Game rules remain in English')}</p>
    </>
  );
}
afterEach(() => {
  cleanup();
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
  expect(screen.getByText('Game rules remain in English')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
  expect(document.documentElement.dir).toBe('ltr');
});
