import { FlightScene } from '@/components/sky-crash/flight-scene';
import { CrashPointFlight } from '@/components/crash-point/flight-scene';
import { useTogetherText } from '@/lib/i18n/together-text';
import '@/pages/games/sky-crash.css';
import '@/pages/games/crash-point.css';

/** Original flight arenas. Their artwork cannot manufacture a cash-out multiplier. */
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
    prefix = sky ? 'sky' : 'crash';
  const progress = Math.min(1, Math.max(0, elapsed / duration));
  return (
    <div
      className={`${prefix}-page original-flight`}
      data-original-scene={sky ? 'sky-crash' : 'crash-point'}
    >
      <section className={`${prefix}-arena ${complete ? 'crashed' : ''}`}>
        <div className={`${prefix}-arena-top`}>
          <span>
            <i />
            {t(complete ? 'Official result' : 'Flight in progress · targets are locked')}
          </span>
          <span role="timer">
            {num(Math.floor(elapsed / 1000))} / {num(duration / 1000)} {t('seconds')}
          </span>
        </div>
        <div className={`${prefix}-multiplier`}>
          <span>{t(complete ? 'Official result' : 'Shared game progress')}</span>
          <strong>
            {complete && result !== null ? num(result / 100) : num(Math.floor(progress * 100))}
            <em>{complete ? '×' : '%'}</em>
          </strong>
          <p>
            {t('Your choice')}: {target === null ? t('Watching is free') : num(target / 100) + '×'}
          </p>
        </div>
        {sky ? (
          <div className="sky-graph-shell">
            <FlightScene
              elapsed={progress * 12000}
              flying={running && !reduced}
              connected={connected}
              departed={complete}
            />
          </div>
        ) : (
          <CrashPointFlight
            elapsed={(reduced ? 0 : progress) * 12000}
            flying={running && !reduced}
            connected={connected}
            decorative
          />
        )}
      </section>
    </div>
  );
}
