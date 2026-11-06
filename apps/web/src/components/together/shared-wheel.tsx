import { useId, useRef } from 'react';
import { useTogetherText } from '@/lib/i18n/together-text';
import type { TogetherEntryView } from '@socialplay/shared';
import { stepWheel, type WheelMotion } from './wheel-motion';

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
  const id = useId().replace(/:/g, ''),
    state = useRef<WheelMotion | null>(null);
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
  const point = (angle: number, radius: number) => [
    240 + radius * Math.sin((angle * Math.PI) / 180),
    240 - radius * Math.cos((angle * Math.PI) / 180),
  ];
  const colors = ['#244f49', '#6e3344', '#2a425e', '#6b512d', '#4a3869', '#355b63'];
  return (
    <svg
      className="tg-result-wheel"
      viewBox="0 0 480 495"
      role="img"
      data-wheel-angle={rotation}
      aria-label={
        winner !== null
          ? t('Shared wheel, winning segment {number}', { number: num(winner + 1) })
          : t('Shared wheel reveal')
      }
    >
      <defs>
        <linearGradient id={id + 'rim'} x2=".6" y2="1">
          <stop stopColor="#fff0c2" />
          <stop offset=".3" stopColor="#9c6b30" />
          <stop offset=".52" stopColor="#f7dca6" />
          <stop offset=".8" stopColor="#b48646" />
          <stop offset="1" stopColor="#5a361c" />
        </linearGradient>
        <radialGradient id={id + 'hub'} cx=".35" cy=".2">
          <stop stopColor="#f9d69a" />
          <stop offset=".5" stopColor="#c28e4b" />
          <stop offset="1" stopColor="#74481e" />
        </radialGradient>
        <radialGradient id={id + 'shine'} cx=".3" cy=".15">
          <stop stopColor="#ffffff" stopOpacity=".2" />
          <stop offset=".7" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity=".25" />
        </radialGradient>
      </defs>
      <ellipse cx="240" cy="451" rx="188" ry="25" fill="#000" opacity=".45" />
      <circle cx="240" cy="247" r="220" fill="#68431f" />
      <circle
        cx="240"
        cy="240"
        r="220"
        fill={'url(#' + id + 'rim)'}
        stroke="#f4e2b6"
        strokeWidth="2"
      />
      <circle cx="240" cy="240" r="204" fill="#171a19" stroke="#6b4828" strokeWidth="4" />
      {Array.from({ length: 48 }, (_, i) => {
        const p = point(i * 7.5, 212);
        return (
          <circle
            key={i}
            cx={p[0]}
            cy={p[1]}
            r="2"
            fill="#fff3cb"
            opacity={i % 3 === 0 ? 1 : 0.45}
          />
        );
      })}
      <g transform={'rotate(' + rotation + ' 240 240)'}>
        {entries.map((entry, i) => {
          const from = point(i * segment, 197),
            to = point((i + 1) * segment, 197),
            label = point((i + 0.5) * segment, 153),
            name = point((i + 0.5) * segment, 113);
          return (
            <g key={entry.id}>
              <path
                d={`M240 240 L${from.join(' ')} A197 197 0 ${segment > 180 ? 1 : 0} 1 ${to.join(' ')} Z`}
                fill={colors[i % colors.length]}
                stroke="#dbbc8166"
                strokeWidth="1.5"
              />
              <circle
                cx={label[0]}
                cy={label[1]}
                r={entries.length > 12 ? 11 : 17}
                fill="#0b161a99"
                stroke="#ffe3ab66"
              />
              <text
                x={label[0]}
                y={label[1] + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#fff0d3"
                fontSize={entries.length > 12 ? 12 : 18}
                fontWeight="700"
              >
                {num(i + 1)}
              </text>
              {entries.length <= 8 && (
                <text
                  x={name[0]}
                  y={name[1]}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#fff2dc"
                  fontSize="12"
                  transform={`rotate(${(i + 0.5) * segment} ${name[0]} ${name[1]})`}
                >
                  {entry.username.slice(0, 12)}
                </text>
              )}
            </g>
          );
        })}
        <circle cx="240" cy="240" r="197" fill={'url(#' + id + 'shine)'} />
      </g>
      <circle cx="240" cy="244" r="48" fill="#0008" />
      <circle
        cx="240"
        cy="240"
        r="47"
        fill={'url(#' + id + 'hub)'}
        stroke="#f1d4a0"
        strokeWidth="2"
      />
      <circle cx="240" cy="240" r="35" fill="#172c29" stroke="#99733d" />
      <path
        d="M240 217L245 233L262 234L248 244L252 261L240 251L226 261L231 244L217 234L235 233Z"
        fill="#efcf92"
      />
      <path d="M223 18Q240 10 257 18L240 56Z" fill="#f7dfaa" stroke="#6d482a" strokeWidth="2" />
      <circle cx="240" cy="20" r="5" fill="#fff2d1" />
    </svg>
  );
}
