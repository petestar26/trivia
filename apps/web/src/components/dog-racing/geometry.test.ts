import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGreyhound } from './greyhound';
import { createTrack, trackPoint } from './track';
afterEach(() => {
  vi.restoreAllMocks();
});
function canvas() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: () => {},
    fillText: () => {},
  } as never);
}
it('joins both straights and bends without jumps, including the finish line', () => {
  for (let t = 0; t <= 1; t += 0.002) {
    const a = trackPoint(t),
      b = trackPoint(t + 0.00001);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.01);
    expect([a.x, a.z, a.heading].every(Number.isFinite)).toBe(true);
  }
  expect(trackPoint(1)).toEqual(trackPoint(0));
});
it('keeps all greyhound geometry and articulated poses finite with independent runners', () => {
  canvas();
  const a = createGreyhound(0),
    b = createGreyhound(1);
  const original = b.root.children[0].position.clone();
  for (let p = 0; p < Math.PI * 2; p += 0.12) {
    a.pose(p, true);
    a.root.updateMatrixWorld(true);
    a.root.traverse((o) => {
      expect(o.matrixWorld.elements.every(Number.isFinite)).toBe(true);
      if (o instanceof THREE.Mesh) {
        const attr = o.geometry.getAttribute('position');
        expect(Array.from(attr.array).every(Number.isFinite)).toBe(true);
      }
    });
  }
  expect(b.root.children[0].position).toEqual(original);
  a.dispose();
  b.dispose();
});
it('batches static stadium geometry and disposes owned meshes', () => {
  canvas();
  const scene = new THREE.Scene(),
    track = createTrack(scene);
  const meshes = scene.children.filter((o) => o instanceof THREE.Mesh) as THREE.Mesh[];
  expect(meshes.length).toBeLessThan(35);
  expect(track.gates).toHaveLength(8);
  const spies = meshes.map((o) => vi.spyOn(o.geometry, 'dispose'));
  track.dispose();
  expect(spies.every((s) => s.mock.calls.length > 0)).toBe(true);
});

it('keeps planted paws on the ground and moving backward relative to the running body', () => {
  canvas();
  const dog = createGreyhound(0),
    paw = dog.root.getObjectByName('front--1-paw')!;
  dog.pose(3.6, true);
  dog.root.updateMatrixWorld(true);
  const first = paw.getWorldPosition(new THREE.Vector3());
  dog.pose(4.2, true);
  dog.root.updateMatrixWorld(true);
  const next = paw.getWorldPosition(new THREE.Vector3());
  expect(first.y).toBeCloseTo(0.045, 5);
  expect(next.y).toBeCloseTo(0.045, 5);
  expect(next.x).toBeLessThan(first.x);
  dog.dispose();
});
