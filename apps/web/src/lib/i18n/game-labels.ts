import type { Selection, TeamNames, LuckySixMarket, RouletteKenoMarket } from '@socialplay/shared';
import { lsSelectionLabel, rkSelectionLabel } from '@socialplay/shared';
import type { MessageValues } from './types';
export type InterfaceTranslate = (message: string, values?: MessageValues) => string;

/** Presentation only: identifiers, prices and settlement predicates remain canonical. */
export function footballSelectionLabel(s: Selection, names: TeamNames, t: InterfaceTranslate) {
  const parts = s.id.split(':');
  const outcome = (code: string) =>
    code === 'X' ? t('Draw') : t('{team} win', { team: code === '1' ? names.home : names.away });
  const side = (code: string) =>
    code === 'X' ? t('Draw') : code === '1' ? names.home : names.away;
  const team = parts[1] === 'H' ? names.home : names.away;
  switch (s.market) {
    case 'FT':
      return t('Full time: {result}', { result: outcome(parts[1]) });
    case 'HT':
      return t('Half time: {result}', { result: outcome(parts[1]) });
    case 'HTFT': {
      const [half, full] = parts[1].split('/');
      return t('Half time {half} / full time {full}', { half: side(half), full: side(full) });
    }
    case 'DC':
      return parts[1] === '12'
        ? t('Double chance: {home} or {away}', { ...names })
        : t('Double chance: {team} or draw', { team: parts[1] === '1X' ? names.home : names.away });
    case 'OU':
      return t(parts[2] === 'O' ? 'Match goals over {line}' : 'Match goals under {line}', {
        line: parts[1],
      });
    case 'BTTS_FT':
      return t('Both teams to score: {choice}', {
        choice: t(parts[2] === 'Y' ? 'Goal' : 'No goal'),
      });
    case 'BTTS_HT':
      return t('Both teams to score in first half: {choice}', {
        choice: t(parts[2] === 'Y' ? 'Goal' : 'No goal'),
      });
    case 'TG_H':
    case 'TG_A':
      return t(parts[2] === 'Y' ? '{team} to score' : '{team} not to score', { team });
    case 'TOU_H':
    case 'TOU_A':
      return t(parts[3] === 'O' ? '{team} goals over {line}' : '{team} goals under {line}', {
        team,
        line: parts[2],
      });
    case 'OE':
      return t(parts[1] === 'O' ? 'Total goals odd' : 'Total goals even');
    case 'TOT':
      return t('Exactly {count} goals', { count: Number(parts[1]) });
    case 'SCORE':
      return t('Final score {home} {score} {away}', { ...names, score: parts[1] });
    case 'FIRST':
      return parts[1] === 'N' ? t('No goal (0-0)') : t('{team} score first', { team });
    case 'FT_BTTS':
      return t(
        parts[2] === 'Y' ? '{result} and both teams score' : '{result} and not both teams score',
        { result: outcome(parts[1]) }
      );
    case 'FT_OU':
      return t(
        parts[3] === 'O' ? '{result} and over {line} goals' : '{result} and under {line} goals',
        { result: outcome(parts[1]), line: parts[2] }
      );
    case 'EH_M1':
    case 'EH_P1':
      return t('{home} ({line}) handicap: {result}', {
        ...names,
        line: parts[1],
        result:
          parts[2] === 'X'
            ? t('Handicap draw')
            : t('{team} cover', { team: parts[2] === '1' ? names.home : names.away }),
      });
    default:
      return s.label(names);
  }
}
export function footballSelectionShort(s: Selection, t: InterfaceTranslate) {
  const match = /^(Over|Under) (.+)$/.exec(s.short);
  if (match) return t(match[1] === 'Over' ? 'Over {line}' : 'Under {line}', { line: match[2] });
  const combined = /^(1|X|2) & (Goal|No goal|Over|Under)$/.exec(s.short);
  if (combined) return `${combined[1]} · ${t(combined[2])}`;
  return t(s.short);
}
export function luckySixSelectionLabel(
  market: LuckySixMarket,
  picks: number[],
  t: InterfaceTranslate
) {
  if (market === 'PRE_NUMBER' && picks[0])
    return t('Number {number} in the first five', { number: picks[0] });
  return t(lsSelectionLabel(market, picks));
}
export function rouletteKenoSelectionLabel(
  market: RouletteKenoMarket,
  picks: number[],
  t: InterfaceTranslate
) {
  const n = picks[0];
  if (n && market === 'ROW')
    return t('Row {row} · {low}–{high}', {
      row: 'ABCDEF'[n - 1],
      low: (n - 1) * 12 + 1,
      high: n * 12,
    });
  if (n && market === 'COLUMN')
    return t('Column {column} · {low}–{high}', { column: n, low: (n - 1) * 18 + 1, high: n * 18 });
  return t(rkSelectionLabel(market, picks));
}
