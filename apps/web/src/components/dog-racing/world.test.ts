import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createRaceWorld, laneOffset } from './world';
import { trackPoint, TRACK_LENGTH } from './track';

beforeEach(() => {
  const context = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'createRadialGradient' || key === 'createLinearGradient'
          ? () => ({ addColorStop() {} })
          : () => {},
      set: () => true,
    }
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function world() {
  const scene = new THREE.Scene();
  const w = createRaceWorld(scene, { quality: 'low' });
  const updates = w.dogs.map((dog) => vi.spyOn(dog, 'update'));
  return { scene, w, updates };
}
const frame = (
  laps: number[],
  over: Partial<Parameters<ReturnType<typeof createRaceWorld>['update']>[0]> = {}
) => ({
  laps,
  field: 8,
  running: true,
  reduced: false,
  dt: 1 / 30,
  time: 0,
  ...over,
});
const field = (lap: number) => Array.from({ length: 8 }, (_, i) => lap - i * 0.002);

it('places every runner exactly at its published lap position and heading', () => {
  const { w } = world();
  for (const lap of [0, 0.31, 0.62, 0.999, 1]) {
    const laps = field(lap);
    w.update(frame(laps));
    w.dogs.forEach((dog, i) => {
      const at = trackPoint(laps[i], laneOffset(i, 8));
      expect(dog.root.position.x).toBeCloseTo(at.x, 9);
      expect(dog.root.position.z).toBeCloseTo(at.z, 9);
      expect(dog.root.rotation.y).toBeCloseTo(at.heading, 9);
    });
  }
  w.dispose();
});

it('advances the stride only with published travel, never on its own clock', () => {
  const { w, updates } = world();
  let lap = 0.2;
  for (let i = 0; i < 30; i++) {
    lap += 10.5 / 30 / TRACK_LENGTH;
    w.update(frame(field(lap), { time: i / 30 }));
  }
  const phase = () => updates[0].mock.calls.at(-1)![0].phase;
  const moving = phase();
  // A held checkpoint (no new published distance): the legs stop cycling.
  for (let i = 0; i < 20; i++) w.update(frame(field(lap), { time: 1 + i / 30 }));
  expect(phase()).toBe(moving);
  // Phase gained equals distance over stride length, a little over three strides a second.
  const before = phase();
  for (let i = 0; i < 30; i++) {
    lap += 10.5 / 30 / TRACK_LENGTH;
    w.update(frame(field(lap), { time: 2 + i / 30 }));
  }
  expect(phase() - before).toBeGreaterThan(2.4);
  expect(phase() - before).toBeLessThan(3.6);
  w.dispose();
});

it('stands the field at the traps and after the finish, and freezes legs for reduced motion', () => {
  const { w, updates } = world();
  w.update(
    frame(
      field(0).map(() => 0),
      { running: false }
    )
  );
  expect(updates.every((u) => u.mock.calls.at(-1)![0].run === 0)).toBe(true);
  for (let i = 0; i < 20; i++) w.update(frame(field(0.4 + i * 0.001), { reduced: true }));
  const reduced = updates[0].mock.calls.slice(-5).map((c) => c[0]);
  expect(new Set(reduced.map((c) => c.phase)).size).toBe(1);
  expect(reduced.every((c) => c.run === 1 && c.lean === 0)).toBe(true);
  w.dispose();
});

it('re-anchors after a rewind instead of sprinting through the gap', () => {
  const { w, updates } = world();
  let lap = 0.6;
  for (let i = 0; i < 10; i++) w.update(frame(field((lap += 0.001))));
  const before = updates[0].mock.calls.at(-1)![0].phase;
  w.update(frame(field(0.1)));
  expect(Math.abs(updates[0].mock.calls.at(-1)![0].phase - before)).toBeLessThan(0.5);
  w.dispose();
});

it('leans into the left-hand bends and not on the straights', () => {
  const { w, updates } = world();
  const run = (start: number) => {
    let lap = start;
    for (let i = 0; i < 40; i++) w.update(frame(field((lap += 10.5 / 30 / TRACK_LENGTH))));
    return updates[3].mock.calls.at(-1)![0].lean!;
  };
  expect(Math.abs(run(0.1))).toBeLessThan(0.01);
  expect(run(96 / TRACK_LENGTH + 0.05)).toBeGreaterThan(0.08);
  w.dispose();
});

it('hides runners outside a six-dog field and releases everything on dispose', () => {
  const { w, scene } = world();
  w.update(frame(field(0.3), { field: 6 }));
  expect(w.dogs.map((d) => d.root.visible)).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
    false,
    false,
  ]);
  const geometries: THREE.BufferGeometry[] = [];
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh && o.name !== 'sky') geometries.push(o.geometry);
  });
  const spies = [...new Set(geometries)].map((g) => vi.spyOn(g, 'dispose'));
  w.dispose();
  expect(spies.every((s) => s.mock.calls.length > 0)).toBe(true);
});

it('pushes the haze back for distant overviews but keeps it for close views', () => {
  const { w, scene } = world();
  w.update(frame(field(0.3)));
  const camera = new THREE.PerspectiveCamera(34, 1.5, 0.4, 600);
  const at = trackPoint(0.3, 0);
  camera.position.set(at.x, 6, at.z + 14);
  w.view(camera, 600);
  expect((scene.fog as THREE.Fog).near).toBe(70);
  camera.position.set(0, 150, 95);
  w.view(camera, 600);
  expect((scene.fog as THREE.Fog).near).toBeGreaterThan(150);
  w.dispose();
});
