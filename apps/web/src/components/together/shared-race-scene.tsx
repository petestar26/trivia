import { useState, type ReactNode } from 'react';
import DerbyRaceScene, { type DerbyCameraMode } from '@/components/derby/race-scene';
import DogRaceScene, { type DogCamera } from '@/components/dog-racing/race-scene';
import { useTogetherText } from '@/lib/i18n/together-text';
import '@/pages/games/thunder-derby.css';
import '@/pages/games/dog-racing.css';

/** The three broadcast views both courses offer under the same labels. */
export type RaceCamera = DogCamera & DerbyCameraMode;

/** Render the original racecourse and cameras with already disclosed group positions. */
export default function SharedRaceScene({
  roundId,
  positions,
  dogs,
  running,
  reduced,
  quality,
  fallback,
  complete,
  adaptive = false,
  onSlow,
  camera: chosen,
  onCamera,
}: {
  roundId: string;
  positions: number[];
  elapsed: number;
  duration: number;
  dogs: boolean;
  running: boolean;
  reduced: boolean;
  quality: 'high' | 'balanced' | 'low';
  fallback: ReactNode;
  complete: boolean;
  /** Automatic quality: either race scene adapts resolution and reports sustained overload. */
  adaptive?: boolean;
  onSlow?: () => void;
  /** Optional: the view held by the page, so it survives a quality-tier remount. */
  camera?: RaceCamera;
  onCamera?: (camera: RaceCamera) => void;
}) {
  const { t } = useTogetherText();
  const [own, setOwn] = useState<RaceCamera>('trackside');
  const camera = chosen ?? own;
  const setCamera = (mode: RaceCamera) => {
    setOwn(mode);
    onCamera?.(mode);
  };
  const round = {
    id: roundId,
    positions,
    field: 8 as const,
    order: complete
      ? positions
          .map((p, i) => ({ p, i }))
          .sort((a, b) => b.p - a.p)
          .map((p) => p.i + 1)
      : null,
  };
  return (
    <div
      className={dogs ? 'hounds-page original-race' : 'derby-page original-race'}
      data-original-scene={dogs ? 'dog-racing' : 'thunder-derby'}
    >
      <div className="original-camera-controls" role="group" aria-label={t('Camera view')}>
        {(['trackside', 'chase', 'aerial'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={camera === mode}
            onClick={() => setCamera(mode)}
          >
            {t(mode === 'trackside' ? 'Trackside' : mode === 'chase' ? 'Follow race' : 'Aerial')}
          </button>
        ))}
      </div>
      <div className="derby-scene-shell">
        {dogs ? (
          <DogRaceScene
            round={round}
            running={running}
            reduced={reduced}
            synchronized
            progressMode="shared"
            quality={quality}
            adaptive={adaptive}
            onSlow={onSlow}
            cameraMode={camera}
          />
        ) : (
          <DerbyRaceScene
            round={round}
            running={running}
            reduced={reduced}
            synchronized
            quality={quality}
            adaptive={adaptive}
            onSlow={onSlow}
            cameraMode={camera}
            fallback={fallback}
          />
        )}
      </div>
    </div>
  );
}
