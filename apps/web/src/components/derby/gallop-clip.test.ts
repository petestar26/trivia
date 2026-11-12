import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { continuousGallop, GALLOP_RESAMPLE, seamIrregularity, seamlessGallop } from './gallop-clip';

let run: THREE.AnimationClip;
beforeAll(async () => {
  const loader = new GLTFLoader();
  loader.register(() => ({
    name: 'TEST_TEXTURE',
    loadTexture: () => Promise.resolve(new THREE.Texture()),
  }));
  const gltf = await loader.parseAsync(
    Uint8Array.from(readFileSync('public/models/derby/horse.glb')).buffer,
    ''
  );
  run = gltf.animations.find((c) => c.name === 'Run')!;
});

it('keeps the authored duration, bones and every authored frame except the inconsistent last one', () => {
  const linear = continuousGallop(run),
    smooth = seamlessGallop(run);
  expect(smooth.duration).toBe(linear.duration);
  expect(smooth.tracks.map((t) => t.name)).toEqual(linear.tracks.map((t) => t.name));
  for (let i = 0; i < smooth.tracks.length; i++) {
    const a = linear.tracks[i],
      b = smooth.tracks[i];
    const size = a.getValueSize();
    if (a.times.length < 5) {
      expect(Array.from(b.values)).toEqual(Array.from(a.values));
      continue;
    }
    // Closed loop.
    expect(Array.from(b.values.slice(-size))).toEqual(Array.from(b.values.slice(0, size)));
    // Authored frames 0..n-2 survive exactly (up to hemisphere sign for quaternions).
    const frames = a.times.length - 2;
    for (let f = 0; f < frames; f++) {
      const k = f * GALLOP_RESAMPLE;
      expect(b.times[k]).toBeCloseTo(a.times[f], 6);
      const authored = Array.from(a.values.slice(f * size, f * size + size));
      const resampled = Array.from(b.values.slice(k * size, k * size + size));
      const sign = size === 4 && authored.reduce((s, v, j) => s + v * resampled[j], 0) < 0 ? -1 : 1;
      resampled.forEach((v, j) => expect(v * sign).toBeCloseTo(authored[j], 5));
    }
  }
});

it('removes the per-stride seam hitch without overshooting authored poses', () => {
  const before = seamIrregularity(continuousGallop(run)),
    after = seamIrregularity(seamlessGallop(run));
  const worst = (rows: typeof before) => Math.max(...rows.map((r) => r.seam));
  console.info('largest seam change of speed (rad/s per sample)', worst(before), worst(after));
  expect(worst(after)).toBeLessThan(worst(before) * 0.5);
  // The worst-affected joints drop at least two-fold at the seam.
  for (const name of ['front_leg_ankle_r.quaternion', 'back_leg_ankle_r.quaternion']) {
    const a = before.find((r) => r.name === name)!,
      b = after.find((r) => r.name === name)!;
    expect(b.seam).toBeLessThan(a.seam * 0.5);
  }
  // Monotone cubic: no resampled component leaves the range of its bracketing keys.
  const smooth = seamlessGallop(run),
    linear = continuousGallop(run);
  smooth.tracks.forEach((track, t) => {
    const source = linear.tracks[t];
    if (source.times.length < 5 || track.getValueSize() !== 3) return;
    const size = 3;
    for (let k = 0; k < track.times.length - 1; k++) {
      const f = Math.floor(k / GALLOP_RESAMPLE);
      for (let j = 0; j < size; j++) {
        const lo = Math.min(source.values[f * size + j], source.values[(f + 1) * size + j]),
          hi = Math.max(source.values[f * size + j], source.values[(f + 1) * size + j]);
        const v = track.values[k * size + j];
        if (f < source.times.length - 3) {
          expect(v).toBeGreaterThanOrEqual(lo - 1e-6);
          expect(v).toBeLessThanOrEqual(hi + 1e-6);
        }
      }
    }
  });
});
