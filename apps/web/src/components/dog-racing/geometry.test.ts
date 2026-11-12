import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGreyhound, createGreyhoundKit } from './greyhound';
import { createTrack, laneOffset, trackPoint, TRACK_LENGTH } from './track';
import { boneEnd, poseGreyhound } from './gait';

afterEach(() => {
  vi.restoreAllMocks();
});
/** A permissive 2D context: every method is a no-op, gradients accept colour stops. */
function canvas() {
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

it('builds one continuous skinned greyhound and a numbered jacket on a shared skeleton', () => {
  canvas();
  const kit = createGreyhoundKit('balanced');
  const dog = createGreyhound(2, kit);
  expect(dog.mesh).toBeInstanceOf(THREE.SkinnedMesh);
  expect(dog.jacket.skeleton).toBe(dog.mesh.skeleton);
  expect(dog.bones.length).toBe(31);
  const geometry = dog.mesh.geometry;
  const weights = geometry.getAttribute('skinWeight');
  for (let i = 0; i < weights.count; i += 37) {
    const sum = weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i);
    expect(sum).toBeCloseTo(1, 5);
  }
  // Phone budget: a few thousand triangles per runner.
  expect(geometry.index!.count / 3).toBeLessThan(16000);
  expect(dog.root.userData.runner).toBe(3);
  // Texture memory: half-resolution jackets below High (256x192 RGBA, ~0.26 MB with mips).
  const map = (dog.jacket.material as THREE.MeshStandardMaterial).map!;
  expect([map.image.width, map.image.height]).toEqual([256, 192]);
  const highKit = createGreyhoundKit('high'),
    high = createGreyhound(2, highKit);
  const highMap = (high.jacket.material as THREE.MeshStandardMaterial).map!;
  expect([highMap.image.width, highMap.image.height]).toEqual([512, 384]);
  high.dispose();
  highKit.dispose();
  const spies = [geometry, dog.jacket.geometry].map((g) => vi.spyOn(g, 'dispose'));
  dog.dispose();
  kit.dispose();
  expect(spies.every((s) => s.mock.calls.length === 1)).toBe(true);
});

it('keeps all bones finite through the stride and leaves other runners untouched', () => {
  canvas();
  const kit = createGreyhoundKit('low');
  const a = createGreyhound(0, kit),
    b = createGreyhound(1, kit);
  const before = b.bones.map((bone) => bone.position.clone());
  for (let p = 0; p < 1; p += 0.03) {
    a.update({ phase: p, speed: 10.5, run: 1, time: p, lean: 0.2 });
    a.root.updateMatrixWorld(true);
    a.root.traverse((o) => expect(o.matrixWorld.elements.every(Number.isFinite)).toBe(true));
  }
  expect(b.bones.map((bone) => bone.position)).toEqual(before);
  a.dispose();
  b.dispose();
  kit.dispose();
});

it('moves a planted paw backward under the body at exactly the travelled distance', () => {
  // Over 1% of a stride the body travels 1% of the stride length; the planted toe
  // moves back by the same amount in the body frame, so it is fixed on the ground.
  const speed = 8.4,
    phase = 0.53;
  const a = boneEnd(poseGreyhound({ phase, speed, run: 1, time: 0 }), 'r_forepaw');
  const b = boneEnd(poseGreyhound({ phase: phase + 0.01, speed, run: 1, time: 0 }), 'r_forepaw');
  expect(a.y).toBeLessThan(0.012);
  expect(b.y).toBeLessThan(0.012);
  expect(b.x).toBeLessThan(a.x);
});

it('batches static stadium geometry, clears the traps after the break and disposes', () => {
  canvas();
  const scene = new THREE.Scene(),
    track = createTrack(scene, 'balanced');
  const meshes = scene.children.filter((o) => o instanceof THREE.Mesh) as THREE.Mesh[];
  expect(meshes.length).toBeLessThan(35);
  expect(track.gates).toHaveLength(8);
  track.setStart(false, 0);
  const closed = track.gates[0].position.y;
  expect(track.traps.visible).toBe(true);
  track.setStart(true, 0);
  expect(track.gates[0].position.y).toBeGreaterThan(closed + 0.5);
  // Gone from the finish once the field is well clear; back for a replay from the start.
  track.setStart(true, 40 / TRACK_LENGTH);
  expect(track.traps.visible).toBe(false);
  track.setStart(false, 0);
  expect(track.traps.visible).toBe(true);
  // Box n always holds runner n, for eight- and six-dog fields.
  for (const field of [8, 6]) {
    track.setStart(false, 0, field);
    track.bays.forEach((bay, i) => {
      expect(bay.visible).toBe(i < field);
      if (i < field) expect(bay.position.z).toBeCloseTo(trackPoint(0, laneOffset(i, field)).z, 9);
    });
  }
  const spies = meshes.map((o) => vi.spyOn(o.geometry, 'dispose'));
  track.dispose();
  expect(spies.every((s) => s.mock.calls.length > 0)).toBe(true);
});
