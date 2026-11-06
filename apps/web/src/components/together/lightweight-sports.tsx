import { useId } from 'react';
import { useTogetherText } from '@/lib/i18n/together-text';
const runnerColors = [
  '#f3e8d5',
  '#373f49',
  '#cb3d49',
  '#3f8fda',
  '#dc9e30',
  '#38877b',
  '#a06bc4',
  '#e296ba',
];

/** Lightweight authored vector broadcast. Positions are only released server checkpoints. */
export function RaceBroadcast2D({
  positions,
  dogs,
  elapsed,
  reduced,
}: {
  positions: number[];
  dogs: boolean;
  elapsed: number;
  reduced: boolean;
}) {
  const { t, num } = useTogetherText(),
    id = useId().replace(/:/g, '');
  return (
    <svg className="tg-race-map" viewBox="0 0 1000 570" role="img" aria-label={t('Race progress')}>
      <defs>
        <linearGradient id={id + 'sky'} x2="0" y2="1">
          <stop stopColor={dogs ? '#101d35' : '#6994aa'} />
          <stop offset="1" stopColor={dogs ? '#435874' : '#d8e1cc'} />
        </linearGradient>
        <linearGradient id={id + 'track'} x2="0" y2="1">
          <stop stopColor={dogs ? '#a89070' : '#43815b'} />
          <stop offset="1" stopColor={dogs ? '#6e5c43' : '#244d37'} />
        </linearGradient>
      </defs>
      <rect width="1000" height="570" fill={'url(#' + id + 'sky)'} />
      <path
        d="M0 122L90 65L180 110L260 80L430 132L610 60L790 115L910 58L1000 90V190H0Z"
        fill={dogs ? '#1d343e' : '#5c7c6b'}
      />
      <g fill={dogs ? '#263542' : '#d2c8b4'}>
        {Array.from({ length: 12 }, (_, i) => (
          <path key={i} d={`M${i * 85} 150v-45h65l15 45z`} />
        ))}
      </g>
      <rect y="163" width="1000" height="407" fill={'url(#' + id + 'track)'} />
      {Array.from({ length: 9 }, (_, i) => (
        <path
          key={i}
          d={`M0 ${183 + i * 43}H1000`}
          stroke={dogs ? '#d1ba93' : '#b4caa2'}
          opacity=".3"
        />
      ))}
      <g stroke="#ece7d4" fill="none">
        <path d="M0 165H1000M0 175H1000" strokeWidth="5" />
        {Array.from({ length: 24 }, (_, i) => (
          <path key={i} d={`M${i * 44} 164v26`} strokeWidth="3" />
        ))}
      </g>
      {Array.from({ length: 24 }, (_, i) => (
        <rect
          key={i}
          x={925 + (i % 2) * 10}
          y={176 + Math.floor(i / 2) * 32}
          width="10"
          height="32"
          fill={(i + Math.floor(i / 2)) % 2 ? '#eee9d8' : '#26332e'}
        />
      ))}
      {positions.map((p, i) => {
        const x = 65 + Math.min(1, p) * 860,
          y = 206 + i * 43,
          step = reduced ? 0 : Math.sin(elapsed / 75 + i) * 10;
        return (
          <g key={i} transform={`translate(${x} ${y})`}>
            <ellipse cx="-9" cy="16" rx={dogs ? 26 : 30} ry="5" fill="#000" opacity=".25" />
            {dogs ? (
              <g fill={i % 3 === 0 ? '#cfbfaa' : i % 2 ? '#3f322b' : '#906843'}>
                <path d="M-28-2Q-17-15 5-7L22-19L32-16L34-11L20-7L7 3L-12 3L-29 10L-32 4Z" />
                <path
                  d={`M-19 1L${-27 - step} 17H${-20 - step}L-8 0M3 1L${16 + step} 16H${23 + step}L11-3`}
                  stroke="currentColor"
                  strokeWidth="3"
                  fill="none"
                />
                <path d="M-28 0L-45-7" stroke="#584437" strokeWidth="3" />
                <path d="M-14-10H3L9 2H-16Z" fill={runnerColors[i]} />
              </g>
            ) : (
              <g fill={i % 3 === 0 ? '#d3c1a2' : i % 2 ? '#463026' : '#916041'}>
                <path d="M-30-6Q-24-20 5-16L16-37L29-36L34-24L26-19L19-23L15-3Q0 6-25 1Z" />
                <path
                  d={`M-23-2L${-27 - step} 17H${-20 - step}L-10-4M7-5L${15 + step} 17H${23 + step}L17-9`}
                  stroke="#432c22"
                  strokeWidth="4"
                  fill="none"
                />
                <path d="M-29-8L-40 1L-45-7" stroke="#382e28" strokeWidth="5" fill="none" />
                <path d="M-20-17L-14-31L2-30L10-18" fill={runnerColors[i]} />
                <circle cx="-3" cy="-35" r="6" fill="#e9c8a4" />
                <path d="M-10-38Q-3-45 4-38" fill={runnerColors[i]} />
              </g>
            )}
            <rect
              x="-13"
              y={dogs ? -17 : -18}
              width="18"
              height="15"
              rx="3"
              fill={runnerColors[i]}
              stroke="#fff8"
            />
            <text
              x="-4"
              y={dogs ? -6 : -7}
              fill={i === 1 ? 'white' : '#162223'}
              fontSize="11"
              fontWeight="800"
              textAnchor="middle"
            >
              {num(i + 1)}
            </text>
          </g>
        );
      })}
      <rect y="533" width="1000" height="37" fill="#0b1620dd" />
      <text x="24" y="557" fill="#e3e5d8" fontSize="14">
        {t('Race progress')}
      </text>
    </svg>
  );
}
export function PitchBroadcast2D({ elapsed, reduced }: { elapsed: number; reduced: boolean }) {
  const { t } = useTogetherText();
  return (
    <svg
      className="tg-pitch-map"
      viewBox="0 0 1000 570"
      role="img"
      aria-label={t('Football Predictions')}
    >
      <rect width="1000" height="570" fill="#142339" />
      <path d="M0 100L110 45H890L1000 100V525H0Z" fill="#293b50" />
      {Array.from({ length: 18 }, (_, i) => (
        <path
          key={i}
          d={`M${40 + i * 54} 65v35M${40 + i * 54} 500v35`}
          stroke="#697e90"
          strokeWidth="23"
          opacity=".35"
        />
      ))}
      <rect x="85" y="115" width="830" height="355" rx="3" fill="#316e52" />
      {Array.from({ length: 10 }, (_, i) => (
        <rect key={i} x={85 + i * 83} y="115" width="41.5" height="355" fill="#367957" />
      ))}
      <g fill="none" stroke="#e3efdfaa" strokeWidth="2">
        <rect x="100" y="130" width="800" height="325" />
        <path d="M500 130V455M100 200H220V385H100M900 200H780V385H900M100 245H145V340H100M900 245H855V340H900" />
        <circle cx="500" cy="292.5" r="55" />
        <path d="M100 267H77V318H100M900 267H923V318H900" />
      </g>
      {[0, 1].flatMap((side) =>
        Array.from({ length: 11 }, (_, i) => {
          const motion = reduced ? 0 : Math.sin(elapsed / 2300 + i) * 10;
          const x = side === 0 ? 145 + (i % 4) * 83 + motion : 855 - (i % 4) * 83 - motion,
            y = 190 + Math.floor(i / 4) * 100 + Math.cos(i) * 17;
          return (
            <g key={side + ':' + i} transform={`translate(${x} ${y})`}>
              <ellipse cy="10" rx="11" ry="5" fill="#0005" />
              <path d="M-9 0L-5-10H5L9 0L5 7H-5Z" fill={side ? '#ec9b4a' : '#e7f3f9'} />
              <circle cy="-10" r="4" fill="#cfb492" />
            </g>
          );
        })
      )}
      <circle
        cx={500 + (reduced ? 0 : Math.sin(elapsed / 2300) * 42)}
        cy={293 + (reduced ? 0 : Math.cos(elapsed / 3100) * 40)}
        r="4"
        fill="#fff"
        stroke="#122128"
      />
      <g fill="#bfe6ff" opacity=".8">
        {[80, 920].map((x) => (
          <g key={x}>
            <path d={`M${x} 110V28`} stroke="#62768d" strokeWidth="4" />
            <rect x={x - 30} y="22" width="60" height="14" rx="2" />
          </g>
        ))}
      </g>
    </svg>
  );
}
