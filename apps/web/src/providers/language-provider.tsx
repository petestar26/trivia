import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { catalogue } from '@/lib/i18n/catalogue';
import { languageTools, translate } from '@/lib/i18n/format';
import { LANGUAGES, isLanguage, type Language } from '@/lib/i18n/types';
export { LANGUAGES, translate, type Language };
// Preserve the existing read-only translation-table export for callers.
export const translations = Object.fromEntries(
  LANGUAGES.filter((language) => language.code !== 'en').map(({ code }) => [
    code,
    Object.fromEntries(
      Object.entries(catalogue).map(([message, entry]) => {
        const value = entry[code];
        return [message, typeof value === 'string' ? value : (value?.other ?? message)];
      })
    ),
  ])
) as Record<string, Record<string, string>>;
const Context = createContext({ ...languageTools('en'), setLanguage: (_: Language) => {} });
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, updateLanguage] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem('salem-language');
      return isLanguage(saved) ? saved : 'en';
    } catch {
      return 'en';
    }
  });
  const setLanguage = useCallback((next: Language) => {
    if (isLanguage(next)) updateLanguage(next);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    try {
      localStorage.setItem('salem-language', language);
    } catch {
      /* The current session still uses the selected language. */
    }
  }, [language]);
  const value = useMemo(
    () => ({ ...languageTools(language), setLanguage }),
    [language, setLanguage]
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useLanguage = () => useContext(Context);
