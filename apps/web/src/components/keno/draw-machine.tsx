import { useId } from 'react';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function KenoMachine({ number, running }: { number: number | null; running: boolean }) {
  const { t: translateUi } = useInterfaceLanguage();

  const id = useId().replaceAll(':', '');
  const paint = (name: string) => `url(#${id}-${name})`;
  return (
    <div className={`keno-machine ${running ? 'keno-machine-running' : ''}`}>
      <svg
        viewBox="0 0 380 360"
        role="img"
        aria-label={
          number === null
            ? translateUi('Keno ball machine ready')
            : translateUi('Latest drawn ball {number}', { number: number })
        }
      >
        <defs>
          <linearGradient id={`${id}-metal`}>
            <stop stopColor="#3d2632" />
            <stop offset=".23" stopColor="#f4d3ae" />
            <stop offset=".43" stopColor="#8c6559" />
            <stop offset=".62" stopColor="#fff1d9" />
            <stop offset="1" stopColor="#503440" />
          </linearGradient>
          <radialGradient id={`${id}-glass`} cx=".35" cy=".2">
            <stop stopColor="#b4dfed" stopOpacity=".3" />
            <stop offset=".6" stopColor="#24495b" stopOpacity=".25" />
            <stop offset="1" stopColor="#07111b" stopOpacity=".9" />
          </radialGradient>
          <radialGradient id={`${id}-ball`} cx=".3" cy=".24" r=".8">
            <stop stopColor="#fff9dd" />
            <stop offset=".25" stopColor="#ffe5a0" />
            <stop offset=".65" stopColor="#d39b49" />
            <stop offset="1" stopColor="#593121" />
          </radialGradient>
          <radialGradient id={`${id}-ruby`} cx=".3" cy=".2">
            <stop stopColor="#e7b5c2" />
            <stop offset=".35" stopColor="#b34e6b" />
            <stop offset="1" stopColor="#3c1126" />
          </radialGradient>
          <radialGradient id={`${id}-base`}>
            <stop stopColor="#543442" />
            <stop offset="1" stopColor="#160d18" />
          </radialGradient>
          <clipPath id={`${id}-chamber`}>
            <circle cx="190" cy="129" r="103" />
          </clipPath>
        </defs>
        <ellipse cx="190" cy="340" rx="144" ry="15" fill="#000" opacity=".35" />
        <path d="M90 285L112 205H268L290 285Z" fill={paint('metal')} stroke="#d8ab86" />
        <path d="M108 285L125 216H255L272 285Z" fill="#1a1220" />
        <ellipse cx="190" cy="279" rx="137" ry="27" fill={paint('metal')} />
        <path
          d="M53 279V307C53 345 327 345 327 307V279C318 316 62 316 53 279Z"
          fill={paint('base')}
          stroke="#a27a65"
        />
        <ellipse cx="190" cy="129" rx="113" ry="115" fill={paint('metal')} />
        <circle cx="190" cy="129" r="106" fill="#081824" />
        <g clipPath={paint('chamber')} aria-hidden="true">
          <circle cx="190" cy="129" r="104" fill={paint('glass')} />
          {Array.from({ length: 18 }, (_, i) => {
            const x = 116 + (i % 5) * 35 + (Math.floor(i / 5) % 2) * 13;
            const y = 78 + Math.floor(i / 5) * 37;
            return (
              <g
                key={i}
                className="keno-tumble"
                style={{
                  animationDelay: `${-i * 0.17}s`,
                  animationDuration: `${1.15 + (i % 4) * 0.23}s`,
                }}
              >
                <circle cx={x + 3} cy={y + 4} r={16 + (i % 3)} fill="#000" opacity=".28" />
                <circle
                  cx={x}
                  cy={y}
                  r={16 + (i % 3)}
                  fill={paint(i % 3 === 0 ? 'ruby' : 'ball')}
                />
                <ellipse cx={x - 5} cy={y - 7} rx="5" ry="3" fill="#fff" opacity=".32" />
              </g>
            );
          })}
          <ellipse
            cx="165"
            cy="64"
            rx="60"
            ry="24"
            fill="#e4f6ff"
            opacity=".12"
            transform="rotate(-25 165 64)"
          />
        </g>
        <circle
          cx="190"
          cy="129"
          r="104"
          fill="none"
          stroke="#cbebf1"
          strokeOpacity=".35"
          strokeWidth="2"
        />
        <path
          d="M100 116Q109 56 160 38"
          fill="none"
          stroke="#fff6e5"
          strokeWidth="5"
          strokeLinecap="round"
          opacity=".6"
        />
        <path
          d="M276 149Q263 201 227 215"
          fill="none"
          stroke="#9ec7d9"
          strokeWidth="3"
          opacity=".35"
        />
        <rect x="165" y="228" width="50" height="35" rx="9" fill={paint('metal')} />
        <ellipse
          cx="190"
          cy="277"
          rx="65"
          ry="24"
          fill="#060e16"
          stroke="#e3b48a"
          strokeWidth="3"
        />
        <g className="keno-reveal-ball" key={number ?? 'ready'}>
          <circle cx="190" cy="277" r="48" fill={paint('ball')} />
          <circle cx="190" cy="277" r="29" fill="#fff2cb" opacity=".9" />
          <text
            x="190"
            y="290"
            textAnchor="middle"
            fontFamily="Arial, sans-serif"
            fontWeight="900"
            fontSize="38"
            fill="#382016"
          >
            {number ?? '—'}
          </text>
          <ellipse
            cx="175"
            cy="249"
            rx="14"
            ry="6"
            fill="#fff"
            opacity=".5"
            transform="rotate(-25 175 249)"
          />
        </g>
        {[95, 116, 137, 243, 264, 285].map((x) => (
          <circle key={x} cx={x} cy="310" r="3" fill="#f9d8a1" />
        ))}
        <text x="190" y="349" textAnchor="middle" fontSize="10" letterSpacing="3" fill="#e9c5a9">
          {number === null ? translateUi('READY TO DRAW') : translateUi('LATEST DRAWN BALL')}
        </text>
      </svg>
      <p>{running ? translateUi('MIXING & REVEALING') : translateUi('LIVE DRAW CHAMBER')}</p>
    </div>
  );
}
