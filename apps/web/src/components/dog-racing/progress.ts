export type DogProgressMode = 'solo' | 'shared';

/** Display conversion only: shared recordings finish at 1; solo publishes 1.06. */
export function dogLapProgress(progress: number, mode: DogProgressMode = 'solo') {
  return progress / (mode === 'shared' ? 1 : 1.06);
}
