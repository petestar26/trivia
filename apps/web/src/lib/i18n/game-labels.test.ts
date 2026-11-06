import { describe, expect, it } from 'vitest';
import {
  VF_SELECTIONS,
  VF_MARKETS,
  parseSelection,
  LS_MARKETS,
  LS_LABELS,
  LS_DESCRIPTIONS,
  RK_MARKETS,
  RK_LABELS,
  DERBY_MARKETS,
  DERBY_LABELS,
  DERBY_HELP,
} from '@socialplay/shared';
import { catalogue } from './catalogue';
import { LANGUAGES } from './types';
import { translate } from './format';
import {
  footballSelectionLabel,
  footballSelectionShort,
  luckySixSelectionLabel,
  rouletteKenoSelectionLabel,
} from './game-labels';

// Deliberately use interface words as team names to detect accidental user/name translation.
const names = { home: 'Home', away: 'Withdraw' };
describe('game presentation translations', () => {
  it.each(LANGUAGES)('preserves teams and canonical selections in $code', ({ code }) => {
    const before = VF_SELECTIONS.map((s) => [s.id, s.short, s.label(names)]);
    const t = (key: string, values?: Readonly<Record<string, string | number>>) =>
      translate(code, key, values);
    for (const selection of VF_SELECTIONS) {
      const label = footballSelectionLabel(selection, names, t);
      expect(label).not.toMatch(/\{(?:team|home|away|result|line|count|score)\}/);
      expect(label.length).toBeGreaterThan(0);
      expect(footballSelectionShort(selection, t).length).toBeGreaterThan(0);
      if (selection.market === 'SCORE') {
        expect(label).toContain(names.home);
        expect(label).toContain(names.away);
        expect(label).toContain(selection.id.split(':')[1]);
      }
    }
    expect(footballSelectionLabel(parseSelection('FT:1')!, names, t)).toContain('Home');
    expect(footballSelectionLabel(parseSelection('FT:2')!, names, t)).toContain('Withdraw');
    expect(VF_SELECTIONS.map((s) => [s.id, s.short, s.label(names)])).toEqual(before);
    expect(luckySixSelectionLabel('SIX', [1, 2, 3, 4, 5, 6], t)).toBe('1 · 2 · 3 · 4 · 5 · 6');
    expect(rouletteKenoSelectionLabel('NUMBERS', [1, 36, 72], t)).toBe('1 · 36 · 72');
  });
  it.each([
    ['FT:2', 'Full time: Withdraw win'],
    ['HT:X', 'Half time: Draw'],
    ['HTFT:2/1', 'Half time Withdraw / full time Home'],
    ['DC:1X', 'Double chance: Home or draw'],
    ['DC:X2', 'Double chance: Withdraw or draw'],
    ['DC:12', 'Double chance: Home or Withdraw'],
    ['OU:2.5:U', 'Match goals under 2.5'],
    ['BTTS:HT:N', 'Both teams to score in first half: No goal'],
    ['BTTS:FT:Y', 'Both teams to score: Goal'],
    ['TG:A:N', 'Withdraw not to score'],
    ['TOU:H:1.5:O', 'Home goals over 1.5'],
    ['OE:E', 'Total goals even'],
    ['TOT:1', 'Exactly 1 goal'],
    ['FIRST:A', 'Withdraw score first'],
    ['FIRST:N', 'No goal (0-0)'],
    ['FTBTTS:2:N', 'Withdraw win and not both teams score'],
    ['FTOU:X:2.5:O', 'Draw and over 2.5 goals'],
    ['EH:+1:2', 'Home (+1) handicap: Withdraw cover'],
    ['EH:-1:X', 'Home (-1) handicap: Handicap draw'],
  ])('keeps the selected side, condition and line for %s', (id, expected) => {
    const selection = parseSelection(id);
    expect(selection, id).not.toBeNull();
    expect(
      footballSelectionLabel(selection!, names, (key, values) => translate('en', key, values))
    ).toBe(expected);
  });
  it('preserves boundary rows, columns and selected pre-draw numbers', () => {
    const t = (key: string, values?: Readonly<Record<string, string | number>>) =>
      translate('en', key, values);
    expect(rouletteKenoSelectionLabel('ROW', [1], t)).toBe('Row A · 1–12');
    expect(rouletteKenoSelectionLabel('ROW', [6], t)).toBe('Row F · 61–72');
    expect(rouletteKenoSelectionLabel('COLUMN', [1], t)).toBe('Column 1 · 1–18');
    expect(rouletteKenoSelectionLabel('COLUMN', [4], t)).toBe('Column 4 · 55–72');
    expect(luckySixSelectionLabel('PRE_NUMBER', [48], t)).toBe('Number 48 in the first five');
  });
  it('has all eight-language entries for selectable market names, rules and derived labels', () => {
    const keys = new Set<string>();
    const collect = (key: string) => {
      keys.add(key);
      return key;
    };
    for (const selection of VF_SELECTIONS) {
      footballSelectionLabel(selection, names, collect);
      footballSelectionShort(selection, collect);
    }
    for (const market of VF_MARKETS) {
      keys.add(market.title);
      keys.add(market.rule);
    }
    for (const market of LS_MARKETS) {
      keys.add(LS_LABELS[market]);
      keys.add(LS_DESCRIPTIONS[market]);
    }
    for (const market of RK_MARKETS) keys.add(RK_LABELS[market]);
    for (const market of DERBY_MARKETS) {
      keys.add(DERBY_LABELS[market]);
      keys.add(DERBY_HELP[market]);
    }
    for (const key of keys) {
      if (!/[A-Za-z]{2}/.test(key)) continue; // 1/X/2, scores and market symbols are canonical notation.
      expect(catalogue[key], `Missing game display message: ${key}`).toBeDefined();
      for (const { code } of LANGUAGES) {
        if (code !== 'en') expect(catalogue[key]?.[code], `${code}: ${key}`).toBeDefined();
      }
    }
  });
});
