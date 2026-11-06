import { useRef, useState } from 'react';
import { useReducedMotion } from '@/lib/football/motion';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

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
  const { t: translateUi } = useInterfaceLanguage();

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
              <g data-testid="sky-aircraft-fallback" strokeLinejoin="round">
                {/* Swept wings and twin rear engines retain the jet silhouette offline. */}
                <path d="M-13-3L-39-32L-25-35L30-6Z" fill="#b8c5d0" stroke="#647788" />
                <path d="M-49-4L-61-31L-46-28L-25-4Z" fill="#702b42" stroke="#e5bd9c" />
                <path d="M-40-13Q-47-13-47-7L-21-4Q-14-9-21-13Z" fill="#d6dce0" stroke="#c5967a" />
                <path
                  d="M-63-3Q-30-12 34-6Q51-3 65 3Q44 11-6 9L-58 5Z"
                  fill="#eee8dd"
                  stroke="#758391"
                />
                <path d="M-53 3Q0 0 51 6" fill="none" stroke="#7b3249" strokeWidth="3" />
                <path d="M-5 5L-36 34L-21 37L34 7Z" fill="#d0d9e0" stroke="#8d776a" />
                <path d="M-43 3Q-51 3-51 10Q-49 16-24 15L-19 6Z" fill="#d1d8dd" stroke="#c5967a" />
                <ellipse
                  cx="-21"
                  cy="10"
                  rx="4"
                  ry="6"
                  fill="#213847"
                  stroke="#e5bd9c"
                  strokeWidth="2"
                />
                <path d="M29-4L40-2L48 2L31 1Z" fill="#284659" />
                <path d="M-12-3H19" stroke="#284659" strokeWidth="3" strokeDasharray="3 4" />
              </g>
            ) : (
              <image
                href="/images/sky-crash/jet-v1.webp"
                x="-74"
                y="-37"
                width="148"
                height="74"
                onError={() => setAssetFailed(true)}
              />
            )}
          </g>
        </g>
      </svg>
      <span className="sky-flight-location">
        {departed
          ? translateUi('FLIGHT COMPLETE')
          : lift > 0.6
            ? translateUi('ABOVE THE CLOUDS')
            : lift > 0
              ? translateUi('CLIMBING OUT')
              : translateUi('RUNWAY 09 · SALEM BET')}
      </span>
    </div>
  );
}
