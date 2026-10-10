import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { continuousGallop, createRiggedHorse, type HorseAssets } from './rigged-horse';

async function asset(name: string) {
  const bytes = readFileSync(`public/models/derby/${name}.glb`);
  const loader = new GLTFLoader();
  // Load the shipped skeleton, geometry and animation, replacing only browser image decoding.
  loader.register(() => ({
    name: 'TEST_TEXTURE',
    loadTexture: () => Promise.resolve(new THREE.Texture()),
  }));
  return loader.parseAsync(Uint8Array.from(bytes).buffer, '');
}
async function assets(): Promise<HorseAssets> {
  const [horse, rider] = await Promise.all([asset('horse'), asset('jockey')]);
  return {
    horse: horse.scene,
    rider: rider.scene,
    run: horse.animations.find((c) => c.name === 'Run')!,
    idle: horse.animations.find((c) => c.name === 'Idle')!,
    dispose: () => {},
  };
}
function skeleton(root: THREE.Object3D) {
  let result: THREE.Skeleton | undefined;
  root.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh && !result) result = o.skeleton;
  });
  return result!;
}
describe('shipped horse and jockey rigs', () => {
  it('loads compact local assets with a genuine gallop and an anatomical human', async () => {
    const a = await assets();
    expect(a.run.duration).toBeGreaterThan(0.3);
    expect(a.run.tracks.length).toBeGreaterThan(20);
    expect(a.rider.getObjectByName('hand_l')).toBeDefined();
    expect(a.horse.getObjectByName('front_leg_foot_l')).toBeDefined();
    expect(readFileSync('public/models/derby/horse.glb').length).toBeLessThan(400000);
    expect(readFileSync('public/models/derby/jockey.glb').length).toBeLessThan(600000);
  });
  it('keeps independent skeletons, updates actual joints and releases only owned resources', async () => {
    const a = await assets(),
      one = createRiggedHorse(a, '#794531', '#e22354', 0),
      two = createRiggedHorse(a, '#292323', '#3188ee', 1);
    const sourceBone = a.horse.getObjectByName('front_leg_foot_l')!;
    const bone = one.root.getObjectByName('front_leg_foot_l')!;
    const other = two.root.getObjectByName('front_leg_foot_l')!;
    expect(bone).not.toBe(sourceBone);
    expect(bone).not.toBe(other);
    const before = bone.quaternion.clone(),
      otherBefore = other.quaternion.clone();
    one.animate(0.22, true);
    expect(bone.quaternion.equals(before)).toBe(false);
    expect(other.quaternion.equals(otherBefore)).toBe(true);
    const pose = bone.quaternion.clone();
    one.animate(0.22, true);
    expect(bone.quaternion.equals(pose)).toBe(true);
    const ownedDispose = vi.spyOn(skeleton(one.root), 'dispose'),
      otherDispose = vi.spyOn(skeleton(two.root), 'dispose');
    one.dispose!();
    expect(ownedDispose).toHaveBeenCalledOnce();
    expect(otherDispose).not.toHaveBeenCalled();
    two.animate(0.4, true);
    two.dispose!();
  });
  it('uses a finite still pose on pause and resumes the independently sampled gallop', async () => {
    const a = await assets(),
      horse = createRiggedHorse(a, '#774532', '#aa2244', 2);
    for (const [seconds, moving] of [
      [0, false],
      [0.1, true],
      [0.8, true],
      [0.8, false],
      [0.8, true],
    ] as const) {
      horse.animate(seconds, moving);
      horse.root.updateMatrixWorld(true);
      horse.root.traverse((o) => expect(o.matrixWorld.elements.every(Number.isFinite)).toBe(true));
    }
    horse.animate(0, false);
    const first = horse.root.getObjectByName('head')!.quaternion.clone();
    horse.animate(100, false);
    expect(horse.root.getObjectByName('head')!.quaternion.equals(first)).toBe(true);
    horse.dispose!();
  });
});

it('matches forward travel to the authored hoof contact instead of the procedural cadence', async () => {
  const a = await assets(),
    horse = createRiggedHorse(a, '#774532', '#aa2244', 0);
  const foot = horse.root.getObjectByName('front_leg_foot_l')!;
  const samples: THREE.Vector3[] = [];
  for (let i = 0; i < 100; i++) {
    const travel = (i / 100) * a.run.duration * 10 * 1.5;
    horse.root.position.x = travel;
    horse.animate((travel * 0.74) / (1.04 / 0.22), true);
    horse.root.updateMatrixWorld(true);
    samples.push(foot.getWorldPosition(new THREE.Vector3()));
  }
  const lowest = Math.min(...samples.map((p) => p.y));
  const groups: THREE.Vector3[][] = [[]];
  for (const sample of samples) {
    if (sample.y < lowest + 0.035) groups.at(-1)!.push(sample);
    else if (groups.at(-1)!.length) groups.push([]);
  }
  // The cycle starts in the planted fore-hoof contact. The later low
  // approach is the next landing, not a planted segment.
  const contacts = groups[0];
  expect(contacts.length).toBeGreaterThan(5);
  expect(
    Math.max(...contacts.map((p) => p.x)) - Math.min(...contacts.map((p) => p.x))
  ).toBeLessThan(0.15);
  horse.dispose!();
});

it('removes the leading frame hold and closes every gallop track at the loop seam', async () => {
  const a = await assets(),
    run = continuousGallop(a.run);
  expect(a.run.tracks[0].times[0]).toBeGreaterThan(0);
  for (const track of run.tracks) {
    expect(track.times[0]).toBe(0);
    const size = track.getValueSize();
    expect(Array.from(track.values.slice(-size))).toEqual(Array.from(track.values.slice(0, size)));
    expect(track.times.at(-1)).toBeCloseTo(run.duration);
  }
});
