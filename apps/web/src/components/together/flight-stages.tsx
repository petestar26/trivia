import { useId } from 'react';
import { FlightScene } from '@/components/sky-crash/flight-scene';
import { useTogetherText } from '@/lib/i18n/together-text';
import '@/pages/games/sky-crash.css';

export function FlightStage({
  sky,
  elapsed,
  duration,
  running,
  complete,
  result,
  target,
  reduced,
  connected,
}: {
  sky: boolean;
  elapsed: number;
  duration: number;
  running: boolean;
  complete: boolean;
  result: number | null;
  target: number | null;
  reduced: boolean;
  connected: boolean;
}) {
  const { t, num } = useTogetherText(),
    id = useId().replace(/:/g, '');
  const progress = Math.min(1, elapsed / duration),
    x = 110 + progress * 620,
    y = 340 - progress ** 2 * 250;
  return (
    <div className={sky ? 'tg-sky-stage' : 'tg-mission-stage'}>
      {sky ? (
        <FlightScene
          elapsed={progress * 12000}
          flying={running && !reduced}
          connected={connected}
          departed={complete}
        />
      ) : (
        <svg className="tg-mission-world" viewBox="0 0 850 430" aria-hidden="true">
          <defs>
            <linearGradient id={id + 'trail'} x2="1" y2="0">
              <stop stopColor="#62733c" stopOpacity="0" />
              <stop offset="1" stopColor="#d6ec8e" />
            </linearGradient>
            <linearGradient id={id + 'rocket'} x2="1" y2="0">
              <stop stopColor="#798c9e" />
              <stop offset=".5" stopColor="#f3f4e9" />
              <stop offset="1" stopColor="#8099a3" />
            </linearGradient>
          </defs>
          <rect width="850" height="430" fill="#0b1522" />
          <g stroke="#7da2b8" opacity=".1">
            {Array.from({ length: 11 }, (_, i) => (
              <path key={'x' + i} d={`M${50 + i * 75} 35V390`} />
            ))}
            {Array.from({ length: 6 }, (_, i) => (
              <path key={'y' + i} d={`M50 ${40 + i * 65}H810`} />
            ))}
          </g>
          {Array.from({ length: 40 }, (_, i) => (
            <circle
              key={i}
              cx={(i * 197 + 31) % 840}
              cy={(i * 61 + 29) % 370}
              r={i % 5 === 0 ? 1.5 : 0.7}
              fill="#e4eadc"
              opacity={0.15 + (i % 4) * 0.12}
            />
          ))}
          <path d="M50 390H810M50 390V35" stroke="#587483" strokeWidth="1.5" />
          <path
            d={`M110 340Q${110 + progress * 310} 340 ${x} ${y}`}
            fill="none"
            stroke={'url(#' + id + 'trail)'}
            strokeWidth="4"
          />
          <path d={`M110 340Q${110 + progress * 310} 340 ${x} ${y}V390H110Z`} fill="#b8dc7110" />
          <g transform={`translate(${x} ${y}) rotate(${complete ? -35 : -45 - progress * 28})`}>
            {!complete && (
              <path
                d={`M-9 27Q0 ${reduced ? 53 : 61 + Math.sin(elapsed / 80) * 9} 9 27Z`}
                fill="#e9e79b"
                opacity=".9"
              />
            )}
            <path
              d="M-11 17L-23 34L-21 7L-10-4M11 17L23 34L21 7L10-4"
              fill="#799b98"
              stroke="#c1d7d3"
            />
            <path
              d="M0-43Q16-25 13 23H-13Q-16-25 0-43Z"
              fill={'url(#' + id + 'rocket)'}
              stroke="#cddfdf"
            />
            <path d="M0-43Q8-32 11-19H-11Q-8-32 0-43Z" fill="#bada79" />
            <circle cy="-7" r="7" fill="#183448" stroke="#dde7df" strokeWidth="3" />
            <rect x="-10" y="22" width="20" height="6" rx="2" fill="#567578" />
          </g>
          {complete && (
            <g stroke="#e3b367" fill="none">
              <circle cx={x} cy={y} r="38" />
              <circle cx={x} cy={y} r="49" opacity=".35" />
            </g>
          )}
        </svg>
      )}
      <div className="tg-flight-readout">
        <span>
          {complete ? t('Official result') : t('Flight in progress · targets are locked')}
        </span>
        <strong>{complete && result !== null ? num(result / 100) + '×' : '— —'}</strong>
      </div>
      <div className="tg-flight-instruments">
        <div>
          <span>{t('Shared game progress')}</span>
          <b>{num(Math.floor(progress * 100))}%</b>
          <i style={{ width: progress * 100 + '%' }} />
        </div>
        <div>
          <span>{t('Your choice')}</span>
          <b>{target === null ? t('Watching is free') : num(target / 100) + '×'}</b>
        </div>
        <div>
          <span>{t('seconds')}</span>
          <b>
            {num(Math.floor(elapsed / 1000))} / {num(duration / 1000)}
          </b>
        </div>
      </div>
    </div>
  );
}
