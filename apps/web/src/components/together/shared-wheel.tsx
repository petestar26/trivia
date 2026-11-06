import { useTogetherText } from '@/lib/i18n/together-text';
import type { TogetherEntryView } from '@socialplay/shared';
export function SharedWheel({
  entries,
  winner,
  progress,
}: {
  entries: TogetherEntryView[];
  winner: number | null;
  progress: number;
}) {
  const { t, num } = useTogetherText();

  const segment = 360 / entries.length;
  const rotation =
    winner === null
      ? progress * 2160
      : (1440 - (winner + 0.5) * segment) * (1 - (1 - progress) ** 3);
  const point = (angle: number, radius: number) => [
    120 + radius * Math.sin((angle * Math.PI) / 180),
    120 - radius * Math.cos((angle * Math.PI) / 180),
  ];
  return (
    <svg
      className="tg-result-wheel"
      viewBox="0 0 240 240"
      role="img"
      aria-label={
        progress === 1 && winner !== null
          ? t('Shared wheel, winning segment {number}', { number: winner + 1 })
          : t('Shared wheel reveal')
      }
    >
      <g transform={'rotate(' + rotation + ' 120 120)'}>
        {entries.map((entry, i) => {
          const from = point(i * segment, 100),
            to = point((i + 1) * segment, 100),
            label = point((i + 0.5) * segment, 76);
          return (
            <g key={entry.id}>
              <path
                d={`M120 120 L${from.join(' ')} A100 100 0 ${segment > 180 ? 1 : 0} 1 ${to.join(' ')} Z`}
                fill={i % 2 ? 'var(--tg-soft)' : 'var(--tg-bg)'}
                stroke="var(--tg-line)"
              />
              <text
                x={label[0]}
                y={label[1]}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="var(--tg-ink)"
                fontSize="13"
                fontWeight="700"
              >
                {num(i + 1)}
              </text>
            </g>
          );
        })}
      </g>
      <circle cx="120" cy="120" r="24" fill="var(--tg-panel)" stroke="var(--tg-line)" />
      <path d="M110 9 L130 9 L120 30 Z" fill="var(--tg-accent)" />
    </svg>
  );
}
