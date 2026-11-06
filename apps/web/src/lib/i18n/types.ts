export const LANGUAGES = [
  { code: 'en', name: 'English', locale: 'en-ET', direction: 'ltr' },
  { code: 'am', name: 'አማርኛ · Amharic', locale: 'am-ET', direction: 'ltr' },
  { code: 'om', name: 'Afaan Oromoo', locale: 'om-ET', direction: 'ltr' },
  { code: 'ti', name: 'ትግርኛ · Tigrinya', locale: 'ti-ET', direction: 'ltr' },
  { code: 'so', name: 'Soomaali', locale: 'so-SO', direction: 'ltr' },
  { code: 'ar', name: 'العربية', locale: 'ar-EG', direction: 'rtl' },
  { code: 'sw', name: 'Kiswahili', locale: 'sw-KE', direction: 'ltr' },
  { code: 'fr', name: 'Français', locale: 'fr-FR', direction: 'ltr' },
] as const;
export type Language = (typeof LANGUAGES)[number]['code'];
export type NonEnglishLanguage = Exclude<Language, 'en'>;
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
export type PluralMessage = { other: string } & Partial<Record<PluralCategory, string>>;
export type MessageValue = string | PluralMessage;
export type TranslationEntry = Record<NonEnglishLanguage, MessageValue> & { en?: MessageValue };
export type TranslationCatalog = Record<string, TranslationEntry>;
export type MessageValues = Readonly<Record<string, string | number>>;
export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.code === value);
}
