import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function CrashPointFlight({
  elapsed,
  flying,
  connected,
  decorative = false,
  growthMs = 10000,
}: {
  elapsed: number;
  flying: boolean;
  connected: boolean;
  decorative?: boolean;
  growthMs?: number;
}) {
  const { t: translateUi } = useInterfaceLanguage();
  const timeRange = Math.max(10000, elapsed * 1.2);
  const valueRange =
    [2, 5, 10, 20, 25].find((value) => value >= Math.exp(elapsed / 10000) * 1.15) ?? 25;
  const progress = Math.min(1, elapsed / timeRange);
  const points = Array.from({ length: 61 }, (_, i) => {
    const t = (elapsed * i) / 60;
    return `${72 + (t / timeRange) * 650},${330 - ((Math.exp(t / 10000) - 1) / (valueRange - 1)) * 260}`;
  }).join(' ');
  const x = 72 + progress * 650,
    y = 330 - ((Math.exp(elapsed / 10000) - 1) / (valueRange - 1)) * 260;
  const arrowAngle =
    (-Math.atan2(
      (Math.exp(elapsed / growthMs) * 260) / (growthMs * (valueRange - 1)),
      650 / timeRange
    ) *
      180) /
    Math.PI;
  return (
    <div className="crash-graph-shell" aria-hidden="true">
      <div className="crash-floor" />
      <svg className="crash-graph" viewBox="0 0 800 390">
        <defs>
          <linearGradient id="crash-line">
            <stop stopColor="#8370ff" />
            <stop offset="0.55" stopColor="#3c94ff" />
            <stop offset="1" stopColor="#59e8dd" />
          </linearGradient>
          <linearGradient id="crash-area" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#39dcc9" stopOpacity=".28" />
            <stop offset="1" stopColor="#39dcc9" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="crash-arrow-face" x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#b6fff8" />
            <stop offset="1" stopColor="#28baca" />
          </linearGradient>
          <filter id="crash-glow">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>
        {[4, 3, 2, 1, 0].map((index) => {
          const value = 1 + ((valueRange - 1) * index) / 4;
          const v = 330 - (index / 4) * 260;
          return (
            <g key={v}>
              <path d={`M72 ${v}H745`} className="grid" />
              <text x="790" y={v + 5} textAnchor="end">
                {decorative ? `${index * 25}%` : `${Number(value.toFixed(2))}×`}
              </text>
            </g>
          );
        })}
        {[72, 235, 397, 560, 722].map((v, i) => (
          <g key={v}>
            <path d={`M${v} 60V330`} className="grid" />
            <text x={v - 8} y="365">
              {decorative
                ? `${i * 25}%`
                : translateUi('{value}s', { value: Math.round((i * timeRange) / 4000) })}
            </text>
          </g>
        ))}
        <polygon points={`72,330 ${points} ${x},330`} fill="url(#crash-area)" />
        <polyline points={points} className="curve depth" transform="translate(0 9)" />
        <polyline points={points} className="curve glow" filter="url(#crash-glow)" />
        <polyline points={points} className="curve" />
        <g transform={`translate(${x} ${y}) rotate(${arrowAngle}) scale(1.25)`}>
          <ellipse cx="-8" cy="18" rx="27" ry="8" fill="#020b1b" opacity=".65" />
          <path d="M30 0L-23 -17L-12 0L-23 17Z" fill="#0d4775" transform="translate(0 6)" />
          <g className={flying && connected ? 'crash-arrow flying' : 'crash-arrow'}>
            <path className="crash-arrow-trail" d="M-18 0H-60" />
            <path
              d="M30 0L-23 -17L-12 0L-23 17Z"
              fill="url(#crash-arrow-face)"
              stroke="#d4fff7"
              strokeWidth="1.5"
            />
            <path d="M30 0L-12 0L-23 17Z" fill="#158aaf" />
            <path d="M-12 0L30 0" stroke="#bafff4" strokeWidth="1.2" />
            <path d="M-23 -17L-12 0L30 0" fill="none" stroke="white" strokeWidth="2" />
          </g>
        </g>
      </svg>
    </div>
  );
}
