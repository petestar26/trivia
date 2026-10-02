import { SPIN_WHEEL, spinColour } from '@socialplay/shared';
const SLICE = 360 / 37;
const PALETTE = { red: '#b91f32', black: '#111918', green: '#04734c' };
function wedge(start: number, end: number, outer: number, inner = 0) {
  const point = (a: number, r: number) =>
    `${250 + r * Math.cos((a * Math.PI) / 180)} ${250 + r * Math.sin((a * Math.PI) / 180)}`;
  return `M${point(start, outer)} A${outer} ${outer} 0 0 1 ${point(end, outer)} L${point(end, inner)} ${inner ? `A${inner} ${inner} 0 0 0 ${point(start, inner)}` : ''} Z`;
}
export function SpinWinWheel({
  rotation,
  number = null,
  spinning = false,
}: {
  rotation: number;
  number?: number | null;
  spinning?: boolean;
}) {
  return (
    <div className="relative mx-auto w-full max-w-[570px] py-3">
      <svg
        viewBox="0 0 500 500"
        role="img"
        aria-label="Single-zero wheel with numbers 0 to 36"
        className="w-full drop-shadow-[0_20px_32px_rgba(0,0,0,.5)]"
      >
        <defs>
          <radialGradient id="spin-wood">
            <stop stopColor="#e6b36a" />
            <stop offset=".62" stopColor="#9b511f" />
            <stop offset=".84" stopColor="#e6a65e" />
            <stop offset="1" stopColor="#5b2c13" />
          </radialGradient>
          <linearGradient id="spin-gold" x2="1" y2="1">
            <stop stopColor="#fff0b1" />
            <stop offset=".24" stopColor="#b7782a" />
            <stop offset=".5" stopColor="#ffd887" />
            <stop offset=".75" stopColor="#9b571b" />
            <stop offset="1" stopColor="#f8d58a" />
          </linearGradient>
          <radialGradient id="spin-hub">
            <stop stopColor="#ed3b47" />
            <stop offset=".7" stopColor="#bd162d" />
            <stop offset="1" stopColor="#650c20" />
          </radialGradient>
          <radialGradient id="spin-hub-black">
            <stop stopColor="#465b51" />
            <stop offset=".7" stopColor="#14231c" />
            <stop offset="1" stopColor="#07150e" />
          </radialGradient>
        </defs>
        <circle cx="250" cy="250" r="241" fill="url(#spin-wood)" stroke="#f0c180" strokeWidth="2" />
        {[235, 230, 224].map((r) => (
          <circle
            key={r}
            cx="250"
            cy="250"
            r={r}
            fill="none"
            stroke="#3f210f"
            strokeWidth="2"
            opacity=".65"
          />
        ))}
        <g
          style={{ transform: `rotate(${rotation}deg)`, transformOrigin: '250px 250px' }}
          className="transition-transform duration-[1800ms] ease-out motion-reduce:transition-none"
        >
          {SPIN_WHEEL.map((n, i) => (
            <g key={n}>
              <path
                d={wedge(i * SLICE - SLICE / 2 - 90, i * SLICE + SLICE / 2 - 90, 218, 153)}
                fill={PALETTE[spinColour(n)]}
                stroke="#dab574"
                strokeWidth=".8"
              />
              <text
                x="250"
                y="57"
                textAnchor="middle"
                fill="#fff7e3"
                fontSize="17"
                fontWeight="700"
                transform={`rotate(${i * SLICE} 250 250)`}
              >
                {n}
              </text>
            </g>
          ))}
          {Array.from({ length: 6 }, (_, i) => (
            <g key={i}>
              <path
                d={wedge(i * 60 - 90, (i + 1) * 60 - 90, 150, 82)}
                fill={i % 2 ? '#b67625' : '#d99b3f'}
                stroke="#f5cd7d"
                strokeWidth="1.5"
              />
              <text
                x="250"
                y="138"
                textAnchor="middle"
                fill="#fff3c7"
                fontSize="22"
                fontWeight="800"
                transform={`rotate(${i * 60 + 30} 250 250)`}
              >
                {String.fromCharCode(65 + i)}
              </text>
            </g>
          ))}
        </g>
        <circle cx="250" cy="250" r="84" fill="url(#spin-gold)" />
        <circle
          cx="250"
          cy="250"
          r="73"
          fill={
            number === 0
              ? '#046945'
              : number !== null && spinColour(number) === 'black'
                ? 'url(#spin-hub-black)'
                : 'url(#spin-hub)'
          }
          stroke="#682f12"
          strokeWidth="3"
        />
        <text
          x="250"
          y={number === null ? 247 : 270}
          textAnchor="middle"
          fill="#fff8e7"
          fontSize={number === null ? 22 : 72}
          fontWeight="800"
        >
          {spinning ? '…' : number === null ? 'SPIN WIN' : number}
        </text>
        <text
          x="250"
          y={number === null ? 272 : 296}
          textAnchor="middle"
          fill="#ffedc0"
          fontSize="10"
          letterSpacing="2"
        >
          {spinning ? 'DRAWING' : number === null ? 'PLAYQUBE' : spinColour(number).toUpperCase()}
        </text>
        <path
          d="M238 12 Q250 3 262 12 L257 38 Q250 49 243 38 Z"
          fill="url(#spin-gold)"
          stroke="#9b5a23"
        />
        <circle cx="250" cy="250" r="221" fill="none" stroke="url(#spin-gold)" strokeWidth="5" />
        {Array.from({ length: 24 }, (_, i) => {
          const a = (i * Math.PI) / 12;
          return (
            <circle
              key={i}
              cx={250 + 233 * Math.cos(a)}
              cy={250 + 233 * Math.sin(a)}
              r="2.2"
              fill="#ffdb94"
            />
          );
        })}
      </svg>
    </div>
  );
}
