import { useRef, useState } from 'react';
import { useReducedMotion } from '@/lib/football/motion';

/** Decorative flight only. A released server result is the sole departure trigger. */
export function FlightScene({
  elapsed,
  flying,
  connected,
  departed,
}: {
  elapsed: number;
  flying: boolean;
  connected: boolean;
  departed: boolean;
}) {
  const [reduced] = useReducedMotion();
  const lastConnectedElapsed = useRef(elapsed);
  if (connected) lastConnectedElapsed.current = elapsed;
  const visualElapsed = connected ? elapsed : lastConnectedElapsed.current;
  const [assetFailed, setAssetFailed] = useState(false);
  const climb = Math.min(1, Math.max(0, (reduced ? 0 : visualElapsed) / 12000));
  const lift = Math.min(1, Math.max(0, ((reduced ? 0 : visualElapsed) - 1800) / 7500));
  const x = 125 + climb * 460,
    y = 303 - lift * 85;
  return (
    <div
      className={`sky-flight ${flying && connected ? 'is-moving' : ''} ${departed ? 'has-departed' : ''}`}
      aria-hidden="true"
      data-climb={lift > 0.6 ? 'clouds' : 'runway'}
    >
      <svg className="sky-flight-world" viewBox="0 0 800 390" preserveAspectRatio="none">
        <defs>
          <linearGradient id="sky-flight-dawn" x2="0" y2="1">
            <stop stopColor="#365c83" />
            <stop offset=".62" stopColor="#779bb2" />
            <stop offset="1" stopColor="#edc6a2" />
          </linearGradient>
          <linearGradient id="sky-flight-tarmac" x2="0" y2="1">
            <stop stopColor="#36434b" />
            <stop offset="1" stopColor="#15212c" />
          </linearGradient>
        </defs>
        <rect width="800" height="390" fill="url(#sky-flight-dawn)" />
        <circle cx="635" cy="118" r="44" fill="#ffe6b5" opacity=".55" />
        <g className="sky-clouds sky-clouds--far" fill="#eef6f7" opacity=".5">
          <path d="M-50 166Q-4 131 40 150Q61 105 109 128Q141 102 174 146Q216 133 240 166Z" />
          <path d="M479 111Q505 84 539 98Q568 53 605 90Q650 69 680 111Z" />
        </g>
        <g className="sky-runway" style={{ opacity: 1 - lift }}>
          <path
            d="M0 278L98 224L199 259L302 205L410 260L513 231L651 278L800 246V390H0Z"
            fill="#536f71"
          />
          <path d="M0 301H800V390H0Z" fill="#657968" />
          <path d="M0 329L800 293V379L0 413Z" fill="url(#sky-flight-tarmac)" />
          <path d="M0 355L800 319M0 391L800 355" stroke="#d5d8ca" strokeWidth="2" />
          <g
            className="sky-runway-stripes"
            stroke="#f9e9c8"
            strokeWidth="4"
            strokeDasharray="50 55"
          >
            <path d="M-160 377L960 327" />
          </g>
          <g fill="#f3c88d">
            {[80, 190, 300, 410, 520, 630, 740].map((cx) => (
              <circle key={cx} cx={cx} cy={353 - cx * 0.045} r="2" />
            ))}
          </g>
        </g>
        <g className="sky-clouds sky-clouds--near" fill="#eff5f4" opacity={0.12 + lift * 0.65}>
          <path d="M-100 372Q-34 307 27 334Q62 272 115 305Q166 289 198 348Q244 320 281 371Z" />
          <path d="M510 390Q534 320 591 343Q622 289 672 321Q729 294 772 345Q825 313 877 390Z" />
        </g>
        <path
          d={`M105 307 Q360 308 ${x} ${y}`}
          fill="none"
          stroke="#fff1d3"
          strokeWidth="2"
          opacity={flying ? 0.35 : 0}
          strokeDasharray="3 8"
        />
      </svg>
      <svg
        className="sky-flight-plane"
        viewBox="-80 -54 160 108"
        style={{ left: `${x / 8}%`, top: `${y / 3.9}%` }}
      >
        <g
          className={departed ? 'sky-flight-departure' : 'sky-flight-aircraft'}
          data-testid={departed ? 'sky-crash-impact' : undefined}
        >
          <g transform={`rotate(${-lift * 12})`}>
            {assetFailed ? (
              <g data-testid="sky-aircraft-fallback">
                <path
                  d="M-53 4L-25-4L-9-31L2-32L-1-6L48-2L59 4L4 9L-21 29L-33 28L-19 8L-44 10Z"
                  fill="#f2e5cd"
                  stroke="#6b7274"
                  strokeWidth="2"
                />
                <path d="M17 1L33 2" stroke="#365471" strokeWidth="4" />
              </g>
            ) : (
              <image
                href="/images/sky-crash/aircraft.webp"
                x="-74"
                y="-48"
                width="148"
                height="96"
                onError={() => setAssetFailed(true)}
              />
            )}
          </g>
        </g>
      </svg>
      <span className="sky-flight-location">
        {departed
          ? 'FLIGHT COMPLETE'
          : lift > 0.6
            ? 'ABOVE THE CLOUDS'
            : lift > 0
              ? 'CLIMBING OUT'
              : 'RUNWAY 09 · PLAYQUBE'}
      </span>
    </div>
  );
}
