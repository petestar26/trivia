import { useState } from 'react';
import {
  TOGETHER_FOOTBALL_CHANCES,
  type TogetherCurrency,
  type TogetherGame,
} from '@socialplay/shared';
import { useLanguage } from '@/providers/language-provider';
import { getErrorMessage } from '@/lib/error-message';

export type GroupNotice =
  string | { message: string; values?: Record<string, string | number>; fallback?: string };

/** Store source templates, so changing language also updates an existing notice. */
export function useTogetherNotice() {
  const { t, language } = useLanguage();
  const [notice, setNotice] = useState<GroupNotice>('');
  const item = typeof notice === 'string' ? { message: notice } : notice;
  let shown = t(item.message, item.values);
  if (language !== 'en' && item.fallback && shown === item.message) shown = t(item.fallback);
  return [shown, setNotice] as const;
}
export function groupErrorNotice(error: unknown, fallback: string): GroupNotice {
  return { message: getErrorMessage(error, fallback), fallback };
}

/** Locale input normalization affects only the entered text, never saved stakes. */
export function groupNumericInput(text: string) {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replaceAll('٫', '.')
    .replaceAll(',', '.');
}

export function useTogetherText() {
  const language = useLanguage();
  const { t, formatNumber: n, formatDate: date } = language;
  const money = (amount: number, currency: TogetherCurrency) =>
    currency === 'ETB'
      ? t('{amount} Birr', {
          amount: n(amount / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        })
      : t('{amount} points', { amount });
  const target = (amount: number) =>
    n(amount / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '×';
  const guideNotes = (game: TogetherGame) =>
    game !== 'virtual_football_3d'
      ? []
      : TOGETHER_FOOTBALL_CHANCES.map((p) =>
          t(
            'Match {match}: home {home}% · draw {draw}% · away {away}%. Rounded model probabilities.',
            {
              match: p.match,
              home: n(p.home, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
              draw: n(p.draw, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
              away: n(p.away, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
            }
          )
        );
  // Translate presentation of signed ranking data without editing the receipt.
  const rankDetail = (detail: string) => {
    let m: RegExpExecArray | null;
    if ((m = /^Segment (\d+)$/.exec(detail)))
      return t('Segment {number}', { number: Number(m[1]) });
    if ((m = /^Distance (\d+)$/.exec(detail)))
      return t('Distance {number}', { number: Number(m[1]) });
    if ((m = /^Runner (\d+) finished #(\d+)$/.exec(detail)))
      return t('Runner {number} finished #{place}', { number: Number(m[1]), place: Number(m[2]) });
    if ((m = /^(\d+(?:\.\d+)?)× reached$/.exec(detail)))
      return t('{target} reached', { target: target(Math.round(Number(m[1]) * 100)) });
    if ((m = /^(\d+) correct$/.exec(detail))) return t('{count} correct', { count: Number(m[1]) });
    if ((m = /^(\d+) matches$/.exec(detail))) return t('{count} matches', { count: Number(m[1]) });
    if ((m = /^Six complete on ball (\d+)$/.exec(detail)))
      return t('Six complete on ball {number}', { number: Number(m[1]) });
    if ((m = /^(\d+) \+ (\d+) = (\d+)$/.exec(detail)))
      return t('{first} + {second} = {total}', {
        first: Number(m[1]),
        second: Number(m[2]),
        total: Number(m[3]),
      });
    return t(detail);
  };
  const errorText = (error: unknown, fallback: string) => {
    const message = getErrorMessage(error, fallback),
      translated = t(message);
    return language.language !== 'en' && translated === message ? t(fallback) : translated;
  };
  return { ...language, num: n, date, money, target, guideNotes, rankDetail, errorText };
}
