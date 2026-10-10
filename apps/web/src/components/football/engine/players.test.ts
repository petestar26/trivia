import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayerPool } from './players';
import { humanGeometry } from './rig';
import type { HumanGeometry } from './rig';
import { directorFrame } from './director';
const loader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./human-model', () => ({ loadPlayerGeometry: () => loader.load() }));
beforeEach(() => {
  const context = new Proxy(
    {},
    { get: (_t, key) => (key === 'measureText' ? () => ({ width: 20 }) : () => {}) }
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as ReturnType<HTMLCanvasElement['getContext']>
  );
});
const deferred = () => {
  let resolve!: (v: HumanGeometry) => void;
  const promise = new Promise<HumanGeometry>((r) => (resolve = r));
  return { promise, resolve };
};
const asset = () => ({ ...humanGeometry(), geometry: humanGeometry().geometry.clone() });
describe('asynchronous human presentation', () => {
  it('disposes late geometry after unmount without replacing disposed players', async () => {
    const pending = deferred();
    loader.load.mockReturnValue(pending.promise);
    const pool = createPlayerPool();
    pool.setTeams(1, 6);
    pool.dispose();
    const base = asset(),
      dispose = vi.spyOn(base.geometry, 'dispose');
    pending.resolve(base);
    await pending.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('redresses the latest fixture after loading and keeps independent rigs and bounded cleanup', async () => {
    const pending = deferred();
    loader.load.mockReturnValue(pending.promise);
    const pool = createPlayerPool();
    pool.setTeams(1, 6);
    pool.setTeams(14, 15);
    const base = asset(),
      dispose = vi.spyOn(base.geometry, 'dispose');
    pending.resolve(base);
    await pending.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.rigs[0].mesh.geometry.getAttribute('position')).toBe(
      base.geometry.getAttribute('position')
    );
    expect(pool.rigs[0].skeleton).not.toBe(pool.rigs[1].skeleton);
    pool.apply(
      directorFrame({
        matchKey: 'test',
        elapsedMs: 5000,
        status: 'FIRST_HALF',
        goals: [],
        fullTime: null,
      }),
      1 / 30,
      5,
      true
    );
    expect(pool.rigs.every((r) => r.root.position.toArray().every(Number.isFinite))).toBe(true);
    pool.dispose();
    pool.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('retains complete figures when model loading fails', async () => {
    loader.load.mockRejectedValue(new Error('unavailable'));
    const pool = createPlayerPool();
    pool.setTeams(1, 6);
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.rigs).toHaveLength(23);
    expect(pool.rigs[1].mesh.geometry.getIndex()!.count).toBeGreaterThan(100);
    pool.dispose();
  });
});
