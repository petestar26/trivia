import { catalogue } from './catalogue';
import {
  LANGUAGES,
  type Language,
  type MessageValue,
  type MessageValues,
  type TranslationCatalog,
} from './types';
export const localeFor = (language: Language) =>
  LANGUAGES.find((item) => item.code === language)!.locale;
const numbers = new Map<string, Intl.NumberFormat>();
const plurals = new Map<Language, Intl.PluralRules>();
function numberFormatter(language: Language, options?: Intl.NumberFormatOptions) {
  const key = language + JSON.stringify(options ?? {});
  let formatter = numbers.get(key);
  if (!formatter) {
    if (numbers.size > 100) numbers.clear();
    formatter = new Intl.NumberFormat(localeFor(language), options);
    numbers.set(key, formatter);
  }
  return formatter;
}
export function formatNumber(
  language: Language,
  value: number,
  options?: Intl.NumberFormatOptions
) {
  return numberFormatter(language, options).format(value);
}
/** Amount is in major currency units, e.g. 12.50 Birr, not 1250 minor units. */
export function formatCurrency(
  language: Language,
  value: number,
  currency = 'ETB',
  options?: Intl.NumberFormatOptions
) {
  return formatNumber(language, value, { style: 'currency', currency, ...options });
}
/** Exact display of integer minor units, including DTOs beyond safe JS integers. */
export function formatMinorCurrency(
  language: Language,
  value: string | number | bigint | null | undefined,
  currency = 'ETB',
  digits?: number
) {
  if (
    value == null ||
    (typeof value === 'number' && !Number.isSafeInteger(value)) ||
    (typeof value === 'string' && !/^-?\d+$/.test(value))
  )
    return '—';
  const places =
    digits ??
    new Intl.NumberFormat(localeFor(language), {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits ??
    2;
  if (!Number.isInteger(places) || places < 0 || places > 20) return '—';
  const signed = BigInt(value),
    absolute = signed < 0n ? -signed : signed;
  const scale = 10n ** BigInt(places),
    whole = absolute / scale;
  // The whole portion stays a BigInt. Only signed zero uses a Number so that
  // negative amounts smaller than one major unit retain their minus sign.
  const number = signed < 0n ? (whole === 0n ? -0 : -whole) : whole;
  const parts = new Intl.NumberFormat(localeFor(language), {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).formatToParts(number);
  const fraction = places
    ? new Intl.NumberFormat(localeFor(language), {
        useGrouping: false,
        minimumIntegerDigits: places,
      }).format(absolute % scale)
    : '';
  return parts.map((part) => (part.type === 'fraction' ? fraction : part.value)).join('');
}
export function formatDate(
  language: Language,
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions
) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(localeFor(language), options).format(date)
    : '—';
}
export function translate(
  language: Language,
  message: string,
  values?: MessageValues,
  source: TranslationCatalog = catalogue
): string {
  const entry = Object.prototype.hasOwnProperty.call(source, message) ? source[message] : undefined;
  const value: MessageValue =
    (language === 'en' ? entry?.en : entry?.[language]) ?? entry?.en ?? message;
  let template: string;
  if (typeof value === 'string') template = value;
  else {
    let rules = plurals.get(language);
    if (!rules) {
      rules = new Intl.PluralRules(localeFor(language));
      plurals.set(language, rules);
    }
    const numericValues = Object.values(values ?? {}).filter(
      (value): value is number => typeof value === 'number'
    );
    const count =
      typeof values?.count === 'number'
        ? values.count
        : numericValues.length === 1
          ? numericValues[0]
          : null;
    const category = count === null ? 'other' : rules.select(count);
    template = value[category] ?? value.other;
  }
  // React renders the returned string as text. Variables are never translated
  // or interpreted as markup, preserving names, messages, IDs and receipts.
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
    if (!values || !Object.prototype.hasOwnProperty.call(values, name)) return placeholder;
    const replacement = values[name];
    return typeof replacement === 'number' ? formatNumber(language, replacement) : replacement;
  });
}
export function languageTools(language: Language) {
  return {
    language,
    locale: localeFor(language),
    direction: language === 'ar' ? ('rtl' as const) : ('ltr' as const),
    t: (message: string, values?: MessageValues) => translate(language, message, values),
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
      formatNumber(language, value, options),
    formatCurrency: (value: number, currency = 'ETB', options?: Intl.NumberFormatOptions) =>
      formatCurrency(language, value, currency, options),
    formatMinorCurrency: (
      value: string | number | bigint | null | undefined,
      currency = 'ETB',
      digits?: number
    ) => formatMinorCurrency(language, value, currency, digits),
    formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) =>
      formatDate(language, value, options),
  };
}
