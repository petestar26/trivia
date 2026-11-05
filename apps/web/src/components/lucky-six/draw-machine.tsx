import { useId, type CSSProperties } from 'react';
import { LS_COLORS, lsColor } from '@socialplay/shared';

/** The unnumbered mixing balls are decorative; only a released result receives a number. */
export function LuckySixMachine({ latest, drawing }: { latest: number | null; drawing: boolean }) {
  const id = useId().replace(/:/g, '');
  const color = latest ? LS_COLORS[lsColor(latest)] : LS_COLORS[4];
  return (
    <svg
      className={`ls-machine ${drawing ? 'is-mixing' : ''}`}
      viewBox="0 0 400 340"
      role="img"
      aria-label={
        latest ? `Latest released ball: ${latest}, ${color.name}` : 'Lucky Six glass draw machine'
      }
    >
      <defs>
        <radialGradient id={`${id}glass`} cx="33%" cy="23%" r="85%">
          <stop stopColor="#93b4c2" stopOpacity=".3" />
          <stop offset=".55" stopColor="#25363d" stopOpacity=".35" />
          <stop offset="1" stopColor="#070d14" stopOpacity=".95" />
        </radialGradient>
        <linearGradient id={`${id}metal`}>
          <stop stopColor="#77512e" />
          <stop offset=".22" stopColor="#e5c18a" />
          <stop offset=".45" stopColor="#fff1cc" />
          <stop offset=".63" stopColor="#b3844d" />
          <stop offset=".88" stopColor="#e4c994" />
          <stop offset="1" stopColor="#735237" />
        </linearGradient>
        <linearGradient id={`${id}base`} x2="0" y2="1">
          <stop stopColor="#6a3441" />
          <stop offset=".45" stopColor="#281b23" />
          <stop offset="1" stopColor="#101317" />
        </linearGradient>
        <radialGradient id={`${id}result`} cx="27%" cy="20%" r="80%">
          <stop stopColor="#fff6e9" />
          <stop offset=".18" stopColor={color.hex} />
          <stop offset=".65" stopColor={color.hex} />
          <stop offset="1" stopColor="#211620" />
        </radialGradient>
        {LS_COLORS.map((c, i) => (
          <radialGradient key={c.name} id={`${id}ball${i}`} cx="30%" cy="20%">
            <stop stopColor="#fff" />
            <stop offset=".2" stopColor={c.hex} />
            <stop offset=".7" stopColor={c.hex} />
            <stop offset="1" stopColor="#121522" />
          </radialGradient>
        ))}
        <clipPath id={`${id}clip`}>
          <circle cx="200" cy="145" r="113" />
        </clipPath>
        <radialGradient id={`${id}glow`}>
          <stop stopColor="#dfb576" stopOpacity=".24" />
          <stop offset="1" stopColor="#dfb576" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="200" cy="292" rx="173" ry="35" fill={`url(#${id}glow)`} />
      <ellipse cx="200" cy="300" rx="125" ry="15" fill="#000" opacity=".55" />
      <path
        d="M126 230L112 278Q200 310 288 278L274 230Z"
        fill={`url(#${id}base)`}
        stroke="#c2a073"
        strokeWidth="1.5"
      />
      <ellipse cx="200" cy="279" rx="88" ry="17" fill={`url(#${id}metal)`} />
      <ellipse cx="200" cy="275" rx="80" ry="11" fill="#1b1c22" />
      <path
        d="M124 79Q72 218 151 257M276 79Q328 218 249 257"
        fill="none"
        stroke={`url(#${id}metal)`}
        strokeWidth="9"
      />
      <circle
        cx="200"
        cy="145"
        r="119"
        fill={`url(#${id}glass)`}
        stroke="#c7d4dd"
        strokeOpacity=".5"
        strokeWidth="1.5"
      />
      <g clipPath={`url(#${id}clip)`}>
        {Array.from({ length: 28 }, (_, i) => {
          const angle = i * 2.39996,
            radius = 25 + ((i * 29) % 77);
          return (
            <g
              key={i}
              className="ls-tumble"
              style={
                {
                  '--dx': `${Math.cos(angle + 1) * 24}px`,
                  '--dy': `${-25 - (i % 6) * 8}px`,
                  animationDelay: `${-i * 0.19}s`,
                  animationDuration: `${1.1 + (i % 4) * 0.25}s`,
                } as CSSProperties
              }
            >
              <circle
                cx={200 + Math.cos(angle) * radius}
                cy={145 + Math.sin(angle) * radius}
                r={10 + (i % 5)}
                fill={`url(#${id}ball${i % 8})`}
                opacity=".82"
              />
            </g>
          );
        })}
        <ellipse
          cx="175"
          cy="65"
          rx="73"
          ry="27"
          fill="#edf8fa"
          opacity=".09"
          transform="rotate(-28 175 65)"
        />
        <path
          d="M108 139Q104 78 162 48"
          fill="none"
          stroke="#fff"
          strokeWidth="8"
          strokeLinecap="round"
          opacity=".28"
        />
      </g>
      <ellipse cx="200" cy="221" rx="65" ry="15" fill="#000" opacity=".4" />
      <g key={latest ?? 'waiting'} className={latest ? 'ls-official-ball' : ''}>
        <circle
          cx="200"
          cy="170"
          r="53"
          fill={`url(#${id}result)`}
          stroke="#e5d3b8"
          strokeOpacity=".5"
        />
        <circle cx="200" cy="170" r="32" fill="#fffbef" />
        <circle cx="200" cy="170" r="28" fill="none" stroke="#d5cab1" />
        <text
          x="200"
          y="181"
          textAnchor="middle"
          fill="#22262e"
          fontFamily="Inter, sans-serif"
          fontSize={latest ? 34 : 28}
          fontWeight="800"
        >
          {latest ?? '✦'}
        </text>
        <ellipse
          cx="182"
          cy="134"
          rx="17"
          ry="6"
          fill="#fff"
          opacity=".5"
          transform="rotate(-25 182 134)"
        />
      </g>
      <path d="M151 31Q200 18 249 31" fill="none" stroke={`url(#${id}metal)`} strokeWidth="5" />
      <text
        x="200"
        y="256"
        textAnchor="middle"
        fill="#e6c494"
        fontFamily="Inter, sans-serif"
        fontSize="8"
        letterSpacing="3"
      >
        SALEM ORIGINALS
      </text>
      <text
        x="200"
        y="321"
        textAnchor="middle"
        fill="#b9a58d"
        fontFamily="Inter, sans-serif"
        fontSize="8"
        letterSpacing="2"
      >
        48 BALLS · EIGHT COLORS
      </text>
    </svg>
  );
}
