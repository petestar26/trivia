import { useId } from 'react';
import { rkColor } from '@socialplay/shared';

/** Original resolution-independent wheel. It only displays server-released balls. */
export function RouletteKenoWheel({
  latest,
  drawing,
}: {
  latest: number | null;
  drawing: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const at = (r: number, a: number) =>
    `${200 + r * Math.sin((a * Math.PI) / 180)},${200 - r * Math.cos((a * Math.PI) / 180)}`;
  return (
    <div className={`rk-wheel ${drawing ? 'is-drawing' : ''}`}>
      <svg
        viewBox="0 0 400 400"
        role="img"
        aria-label={
          latest ? `Latest released ball ${latest}` : 'Roulette Keno wheel waiting for the draw'
        }
      >
        <defs>
          <radialGradient id={`${id}-wood`}>
            <stop stopColor="#623228" />
            <stop offset=".7" stopColor="#261b1a" />
            <stop offset="1" stopColor="#0b1010" />
          </radialGradient>
          <linearGradient id={`${id}-gold`} x1="0" x2=".9" y2="1">
            <stop stopColor="#fff0c2" />
            <stop offset=".24" stopColor="#967144" />
            <stop offset=".48" stopColor="#e4c38a" />
            <stop offset=".73" stopColor="#664d31" />
            <stop offset="1" stopColor="#e6c99b" />
          </linearGradient>
          <radialGradient id={`${id}-bowl`} cx="42%" cy="35%">
            <stop stopColor="#405d50" />
            <stop offset=".6" stopColor="#142d24" />
            <stop offset="1" stopColor="#071611" />
          </radialGradient>
          <radialGradient id={`${id}-ball`} cx="30%" cy="23%">
            <stop stopColor="#fffdf4" />
            <stop offset=".65" stopColor="#e9dfc8" />
            <stop offset="1" stopColor="#8d7c5d" />
          </radialGradient>
          <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="170%">
            <feDropShadow dx="0" dy="10" stdDeviation="8" floodOpacity=".65" />
          </filter>
        </defs>
        <circle cx="200" cy="205" r="190" fill="#030807" opacity=".8" />
        <circle
          cx="200"
          cy="200"
          r="187"
          fill={`url(#${id}-wood)`}
          stroke="#6d5540"
          strokeWidth="2"
        />
        <circle cx="200" cy="200" r="177" fill="none" stroke={`url(#${id}-gold)`} strokeWidth="7" />
        <circle cx="200" cy="200" r="169" fill="#0b1110" stroke="#493c2a" strokeWidth="2" />
        <g
          className="rk-wheel-pockets"
          style={{
            transform: `rotate(${latest ? -(latest - 1) * 5 : 0}deg)`,
            transformOrigin: '200px 200px',
          }}
        >
          {Array.from({ length: 72 }, (_, i) => {
            const a = i * 5,
              red = rkColor(i + 1) === 'RED';
            return (
              <g key={i}>
                <path
                  d={`M${at(165, a - 2.5)} A165,165 0 0 1 ${at(165, a + 2.5)} L${at(124, a + 2.5)} A124,124 0 0 0 ${at(124, a - 2.5)} Z`}
                  fill={red ? '#9b343e' : '#171e1c'}
                  stroke="#b5a074"
                  strokeWidth=".55"
                />
                <text
                  x="200"
                  y="51"
                  transform={`rotate(${a} 200 200)`}
                  textAnchor="middle"
                  fill="#fff2d9"
                  fontSize="8.4"
                  fontWeight="650"
                >
                  {i + 1}
                </text>
                <path
                  d={`M${at(123, a)} L${at(110, a)}`}
                  stroke="#d3b67b"
                  strokeWidth=".65"
                  opacity=".6"
                />
              </g>
            );
          })}
        </g>
        <circle
          cx="200"
          cy="200"
          r="119"
          fill={`url(#${id}-bowl)`}
          stroke={`url(#${id}-gold)`}
          strokeWidth="4"
        />
        <circle cx="200" cy="200" r="102" fill="none" stroke="#a88d59" opacity=".25" />
        <circle
          className="rk-wheel-orbit"
          cx="200"
          cy="200"
          r="109"
          fill="none"
          stroke="#fff2c8"
          strokeWidth="2.5"
          strokeDasharray="8 677"
          opacity={drawing ? 1 : 0.2}
        />
        <path
          d="M188 9 L212 9 L200 35 Z"
          fill={`url(#${id}-gold)`}
          stroke="#f3d9aa"
          strokeWidth="1"
        />
        <circle cx="200" cy="198" r="70" fill={`url(#${id}-ball)`} filter={`url(#${id}-shadow)`} />
        <circle cx="200" cy="198" r="57" fill="none" stroke="#c2b394" strokeWidth=".8" />
        <text x="200" y="177" textAnchor="middle" fill="#66543a" fontSize="8.5" letterSpacing="1.4">
          {latest ? 'RELEASED BALL' : 'SALEM ORIGINALS'}
        </text>
        <text
          x="200"
          y="221"
          textAnchor="middle"
          fill={latest && rkColor(latest) === 'RED' ? '#8b2633' : '#14271e'}
          fontSize={latest ? '49' : '38'}
          fontWeight="750"
        >
          {latest ?? 'RK'}
        </text>
        <text x="200" y="240" textAnchor="middle" fill="#66543a" fontSize="8.5" letterSpacing="1.1">
          {latest ? rkColor(latest) : 'ROULETTE KENO'}
        </text>
      </svg>
    </div>
  );
}
