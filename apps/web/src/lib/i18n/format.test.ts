import { describe, expect, it } from 'vitest';
import { catalogue, mergeCatalogues, validateCatalogue } from './catalogue';
import {
  formatCurrency,
  formatMinorCurrency,
  formatDate,
  formatNumber,
  localeFor,
  translate,
} from './format';
import { LANGUAGES, type TranslationCatalog, type TranslationEntry } from './types';

const all = (text: string): TranslationEntry => ({
  am: text,
  om: text,
  ti: text,
  so: text,
  ar: text,
  sw: text,
  fr: text,
});
describe('static multilingual interface contract', () => {
  it('localizes exact minor-unit amounts without rounding large integer DTOs', () => {
    expect(formatMinorCurrency('en', '900719925474099399')).toBe(
      'ETB\u00a09,007,199,254,740,993.99'
    );
    expect(formatMinorCurrency('fr', '900719925474099399')).toBe(
      '9\u202f007\u202f199\u202f254\u202f740\u202f993,99\u00a0ETB'
    );
    expect(formatMinorCurrency('ar', '900719925474099399')).toContain('٩٬٠٠٧٬١٩٩٬٢٥٤٬٧٤٠٬٩٩٣٫٩٩');
    expect(formatMinorCurrency('en', -1)).toBe('-ETB\u00a00.01');
    expect(formatMinorCurrency('fr', -1)).toBe('-0,01\u00a0ETB');
    expect(formatMinorCurrency('en', 123, 'JPY')).toBe('JPY\u00a0123');
    expect(formatMinorCurrency('en', 1234, 'BHD')).toBe('BHD\u00a01.234');
    expect(formatMinorCurrency('en', Number.MAX_SAFE_INTEGER + 1)).toBe('—');
    expect(formatMinorCurrency('en', '12.5')).toBe('—');
  });
  it('contains complete locale entries and identical named values in every message', () => {
    expect(validateCatalogue(catalogue)).toEqual([]);
  });
  it('rejects missing translations and missing, additional or mistyped placeholders', () => {
    expect(
      validateCatalogue({ 'Hello {name}': { ...all('Hi {name}'), fr: 'Bonjour {user}' } })
    ).toEqual(['fr: placeholders differ for Hello {name} (other)']);
    const missing = { Label: { ...all('Label'), ti: '' } };
    expect(validateCatalogue(missing).some((error) => error.startsWith('ti:'))).toBe(true);
  });
  it('merges identical shared labels but rejects conflicting definitions', () => {
    const first = all('Translated');
    const reordered = Object.fromEntries(Object.entries(first).reverse()) as TranslationEntry;
    expect(mergeCatalogues({ a: { Label: first }, b: { Label: reordered } }).Label).toEqual(first);
    expect(() => mergeCatalogues({ a: { Label: first }, b: { Label: all('Other') } })).toThrow(
      'Conflicting translation'
    );
  });
  it('interpolates exact supplied values and never translates usernames or renders markup', () => {
    const source: TranslationCatalog = {
      'Hello {name}, {amount} points': {
        ...all('Hello {name}, {amount} points'),
        fr: 'Bonjour {name}, {amount} points',
      },
    };
    expect(
      translate(
        'fr',
        'Hello {name}, {amount} points',
        { name: '<b>Home</b>', amount: 1234.5 },
        source
      )
    ).toBe('Bonjour <b>Home</b>, ' + new Intl.NumberFormat('fr-FR').format(1234.5) + ' points');
    expect(translate('am', 'Member-supplied text')).toBe('Member-supplied text');
    expect(translate('am', 'Home {name}')).toBe('Home {name}');
  });
  it('selects all Arabic plural categories and permits natural singular or dual wording', () => {
    const source: TranslationCatalog = {
      '{count} players': {
        ...all('{count} players'),
        en: { one: '{count} player', other: '{count} players' },
        ar: {
          zero: 'لا لاعبون',
          one: 'لاعب واحد',
          two: 'لاعبان',
          few: '{count} لاعبين',
          many: '{count} لاعباً',
          other: '{count} لاعب',
        },
      },
    };
    expect(validateCatalogue(source)).toEqual([]);
    expect(translate('ar', '{count} players', { count: 0 }, source)).toBe('لا لاعبون');
    expect(translate('ar', '{count} players', { count: 1 }, source)).toBe('لاعب واحد');
    expect(translate('ar', '{count} players', { count: 2 }, source)).toBe('لاعبان');
    expect(translate('ar', '{count} players', { count: 3 }, source)).toBe('٣ لاعبين');
    expect(translate('ar', '{count} players', { count: 11 }, source)).toBe('١١ لاعباً');
    expect(translate('ar', '{count} players', { count: 100 }, source)).toBe('١٠٠ لاعب');
    expect(translate('en', '{count} players', { count: 1 }, source)).toBe('1 player');
  });
  it('can pluralize a sole numeric named variable without renaming application data', () => {
    const source: TranslationCatalog = {
      '{days} days': { ...all('{days} days'), fr: { one: '{days} jour', other: '{days} jours' } },
    };
    expect(translate('fr', '{days} days', { days: 1 }, source)).toBe('1 jour');
    expect(translate('fr', '{days} days', { days: 4 }, source)).toBe('4 jours');
  });
  it('pluralizes agent totals while preserving the independent page parameter', () => {
    expect(translate('en', 'Page {page} · {count} agents', { page: 5, count: 1 })).toBe(
      'Page 5 · 1 agent'
    );
    expect(translate('en', 'Page {page} · {count} agents', { page: 5, count: 2 })).toBe(
      'Page 5 · 2 agents'
    );
    expect(translate('ar', 'Page {page} · {count} agents', { page: 5, count: 2 })).toBe(
      'الصفحة ٥ · وكيلان'
    );
  });
  it('formats each locale through Intl and treats currency values as major units', () => {
    for (const { code } of LANGUAGES) {
      expect(formatNumber(code, 1234.5)).toBe(
        new Intl.NumberFormat(localeFor(code)).format(1234.5)
      );
      expect(formatCurrency(code, 12.5)).toBe(
        new Intl.NumberFormat(localeFor(code), { style: 'currency', currency: 'ETB' }).format(12.5)
      );
      expect(formatDate(code, '2026-11-06T12:00:00Z', { timeZone: 'UTC' })).toBe(
        new Intl.DateTimeFormat(localeFor(code), { timeZone: 'UTC' }).format(
          new Date('2026-11-06T12:00:00Z')
        )
      );
    }
    expect(formatDate('en', 'invalid')).toBe('—');
  });
});
