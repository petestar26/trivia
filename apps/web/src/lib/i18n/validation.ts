import { LANGUAGES, type TranslationCatalog, type MessageValue } from './types';

export function mergeCatalogues(chunks: Record<string, TranslationCatalog>): TranslationCatalog {
  const result: TranslationCatalog = Object.create(null);
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item
    );
  for (const [filename, catalogue] of Object.entries(chunks).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    for (const [message, value] of Object.entries(catalogue)) {
      if (
        Object.prototype.hasOwnProperty.call(result, message) &&
        canonical(result[message]) !== canonical(value)
      )
        throw new Error(`Conflicting translation for ${JSON.stringify(message)} in ${filename}`);
      result[message] = value;
    }
  }
  return result;
}
const placeholders = (message: string) =>
  [
    ...new Set([...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1])),
  ].sort();
export function validateCatalogue(source: TranslationCatalog): string[] {
  const issues: string[] = [];
  for (const [message, entries] of Object.entries(source)) {
    if (!message.trim()) issues.push('Empty English message key');
    const expected = placeholders(message);
    for (const language of LANGUAGES) {
      const value: MessageValue | undefined =
        language.code === 'en' ? (entries.en ?? message) : entries[language.code];
      if (
        !value ||
        (typeof value !== 'string' && (!value.other || typeof value.other !== 'string'))
      ) {
        issues.push(`${language.code}: missing translation for ${message}`);
        continue;
      }
      const variants = typeof value === 'string' ? [['other', value]] : Object.entries(value);
      for (const [category, text] of variants) {
        if (!['zero', 'one', 'two', 'few', 'many', 'other'].includes(category))
          issues.push(`${language.code}: unknown plural category ${category} for ${message}`);
        if (typeof text !== 'string' || !text.trim()) {
          issues.push(`${language.code}: empty translation for ${message}`);
          continue;
        }
        const actual = placeholders(text);
        const required =
          typeof value !== 'string' && ['zero', 'one', 'two'].includes(category)
            ? expected.filter((name) => name !== 'count')
            : expected;
        if (
          required.some((name) => !actual.includes(name)) ||
          actual.some((name) => !expected.includes(name))
        )
          issues.push(`${language.code}: placeholders differ for ${message} (${category})`);
      }
    }
  }
  return issues;
}
