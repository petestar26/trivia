import { Globe2 } from 'lucide-react';
import { LANGUAGES, useLanguage, type Language } from '@/providers/language-provider';
export function LanguageSelect() {
  const { language, setLanguage, t } = useLanguage();
  return (
    <label className="salem-language">
      <Globe2 size={17} aria-hidden="true" />
      <span className="sr-only">{t('Language')}</span>
      <select
        aria-label={t('Language')}
        value={language}
        onChange={(e) => setLanguage(e.target.value as Language)}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}
