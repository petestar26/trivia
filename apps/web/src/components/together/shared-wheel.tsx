import { useRef } from 'react';
import { SpinWinWheel } from '@/components/spin/spin-wheel';
import { useTogetherText } from '@/lib/i18n/together-text';
import type { TogetherEntryView } from '@socialplay/shared';
import { stepWheel, type WheelMotion } from './wheel-motion';

/** Original roulette artwork; equal participant pockets retain the group rules. */
export function SharedWheel({
  entries,
  winner,
  progress,
  motion,
}: {
  entries: TogetherEntryView[];
  winner: number | null;
  progress: number;
  motion?: { clock: number; duration: number; reduced: boolean };
}) {
  const { t, num } = useTogetherText();
  const state = useRef<WheelMotion | null>(null);
  const segment = 360 / Math.max(1, entries.length);
  if (motion)
    state.current = stepWheel(state.current, {
      ...motion,
      winner,
      progress,
      count: entries.length,
    });
  const rotation = motion
    ? state.current!.angle
    : (1440 - ((winner ?? 0) + 0.5) * segment) * (1 - (1 - progress) ** 3);
  return (
    <SpinWinWheel
      rotation={rotation}
      number={winner === null ? null : winner + 1}
      spinning={winner === null && progress > 0 && progress < 1}
      continuous
      segments={entries.map((_, i) => ({
        label: num(i + 1),
        color: i % 2 ? '#111918' : '#b91f32',
      }))}
      caption={t('Official result')}
      label={
        winner === null
          ? t('Shared wheel reveal')
          : t('Shared wheel, winning segment {number}', { number: num(winner + 1) })
      }
    />
  );
}
