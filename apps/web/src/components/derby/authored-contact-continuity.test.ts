import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HOOF_NAMES, measureHoofWindows, type HoofWindow } from './authored-contact';
import { CONTACT_FRACTION, STRIDE_SECONDS } from './gallop';
import { createRiggedHorse, raceGallop, type HorseAssets, type RaceHorse } from './rigged-horse';
import { createStrideClock } from './stride-clock';

async function asset(name: string) {
  const bytes = readFileSync(`public/models/derby/${name}.glb`);
  const loader = new GLTFLoader();
  loader.register(() => ({
    name: 'TEST_TEXTURE',
    loadTexture: () => Promise.resolve(new THREE.Texture()),
  }));
  return loader.parseAsync(Uint8Array.from(bytes).buffer, '');
}

// Locate the sign crossings of the measured profile. This is deliberately test
// side: assertions below inspect the shipped skin/rig, not a clearance helper's output.
function soleProfile(values: Float32Array, time: number, duration: number) {
  const phase = ((((time % duration) + duration) % duration) / duration) * values.length;
  const whole = Math.floor(phase),
    i = whole % values.length,
    u = phase - whole;
  const a = values[i],
    b = values[(i + 1) % values.length];
  const da = (b - values[(i + values.length - 1) % values.length]) / 2;
  const db = (values[(i + 2) % values.length] - a) / 2;
  return (
    (2 * u ** 3 - 3 * u ** 2 + 1) * a +
    (u ** 3 - 2 * u ** 2 + u) * da +
    (-2 * u ** 3 + 3 * u ** 2) * b +
    (u ** 3 - u ** 2) * db
  );
}

function zeroCrossings(window: HoofWindow, duration: number) {
  const result: number[] = [];
  const count = window.soleHeights.length * 16;
  for (let i = 0; i < count; i++) {
    let left = (i * duration) / count,
      right = ((i + 1) * duration) / count;
    const leftSign = Math.sign(soleProfile(window.soleHeights, left, duration));
    if (leftSign === Math.sign(soleProfile(window.soleHeights, right, duration))) continue;
    for (let j = 0; j < 48; j++) {
      const mid = (left + right) / 2;
      if (Math.sign(soleProfile(window.soleHeights, mid, duration)) === leftSign) left = mid;
      else right = mid;
    }
    result.push((left + right) / 2);
  }
  return result;
}

const legacySeconds = (clipSeconds: number) =>
  ((clipSeconds * 15) / (1.04 / CONTACT_FRACTION)) * STRIDE_SECONDS;

describe('authored hoof release at internal sole-zero crossings', () => {
  let a: HorseAssets;
  let windows: HoofWindow[];
  let horses: RaceHorse[];
  let crossings: { name: string; time: number }[];
  beforeAll(async () => {
    const [horse, rider] = await Promise.all([asset('horse'), asset('jockey')]);
    a = {
      horse: horse.scene,
      rider: rider.scene,
      run: horse.animations.find((c) => c.name === 'Run')!,
      idle: horse.animations.find((c) => c.name === 'Idle')!,
      dispose() {},
    };
    windows = measureHoofWindows(a.horse, raceGallop(a.run));
    horses = Array.from({ length: 8 }, (_, index) =>
      createRiggedHorse(a, '#774532', '#aa2244', index)
    );
    crossings = windows.flatMap((w) =>
      zeroCrossings(w, a.run.duration).map((time) => ({ name: w.name, time }))
    );
  });
  afterAll(() => horses.forEach((h) => h.dispose?.()));

  const pose = (index: number, clipSeconds: number, name: string, moving = true) => {
    const horse = horses[index];
    // Same published root and lane for both sides of a crossing; no authoritative
    // target/root adjustment can conceal a jump in the local visual articulation.
    horse.root.position.set(90 + index * 2, 0.035, index * 2.15);
    horse.root.quaternion.identity();
    horse.root.updateMatrixWorld(true);
    const before = horse.root.position.clone();
    horse.animate(legacySeconds(clipSeconds - index * a.run.duration * 0.137), moving);
    horse.root.updateMatrixWorld(true);
    expect(horse.root.position.toArray()).toEqual(before.toArray());
    const family = name.startsWith('front') ? 'front' : 'back',
      side = name.endsWith('_l') ? 'l' : 'r';
    return {
      position: horse.root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3()),
      rotations: ['upper', 'lower', 'ankle', 'foot'].map((part) =>
        horse.root
          .getObjectByName(`${family}_leg_${part}_${side}`)!
          .getWorldQuaternion(new THREE.Quaternion())
          .normalize()
      ),
    };
  };

  it('has no hoof jump across any sole-zero crossing on all eight runner offsets', () => {
    // The original reviewed jump (18.7 mm at front-right 0.341166 s of the old linear
    // loop) came from switching on a finite clearance offset at a sign crossing. The
    // velocity-continuous loop moves the crossings, so check every one of them.
    expect(crossings.length).toBeGreaterThan(3);
    const jumps = crossings.flatMap((c) =>
      horses.map((_, index) => {
        const left = pose(index, c.time - 1e-8, c.name);
        const right = pose(index, c.time + 1e-8, c.name);
        return left.position.distanceTo(right.position);
      })
    );
    console.info('maximum zero-crossing jump (metres)', Math.max(...jumps));
    expect(Math.max(...jumps)).toBeLessThan(0.00001);
  });

  it('converges to the same position and limb pose at every hoof-profile sign crossing', () => {
    expect(new Set(crossings.map((c) => c.name))).toEqual(new Set(HOOF_NAMES));
    const records = crossings.map((c) => {
      const position: number[] = [],
        rotation: number[] = [];
      for (const epsilon of [1e-4, 1e-5, 1e-6, 1e-7, 1e-8]) {
        let p = 0,
          q = 0;
        horses.forEach((_, index) => {
          const left = pose(index, c.time - epsilon, c.name);
          const right = pose(index, c.time + epsilon, c.name);
          p = Math.max(p, left.position.distanceTo(right.position));
          q = Math.max(q, ...left.rotations.map((r, i) => r.angleTo(right.rotations[i])));
        });
        position.push(p);
        rotation.push(q);
      }
      return { ...c, position, rotation };
    });
    console.info('all internal sole-zero crossing convergence', JSON.stringify(records));
    for (const row of records) {
      // A discontinuity has a nonzero limit as epsilon shrinks. Permit ordinary
      // authored swing velocity and floating-point noise, not a centimetre impulse.
      expect(row.position[4], `${row.name}@${row.time}`).toBeLessThan(0.00001);
      expect(row.position[4]).toBeLessThan(row.position[0] * 0.01 + 1e-7);
      expect(row.rotation[4]).toBeLessThan(0.0001);
    }
  });

  it('retains ordinary-frame distance ownership and direct/sequential poses through the crossings', () => {
    for (const c of crossings)
      for (const frame of [1 / 60, 1 / 30, 1 / 15]) {
        for (let index = 0; index < horses.length; index++) {
          const clock = createStrideClock();
          // Add whole cycles so every runner's offset maps to positive published travel.
          const start = c.time + a.run.duration * 2 - index * a.run.duration * 0.137 - frame;
          let displayed = start * 15;
          const owner = clock;
          const initial = clock(displayed, true);
          expect(initial).toBeCloseTo(legacySeconds(start), 10);
          horses[index].root.position.set(displayed, 0.035, index * 2.15);
          horses[index].animate(initial, true);
          for (let step = 0; step < 2; step++) {
            const distance = frame * 15;
            displayed += distance;
            const seconds = clock(distance, true);
            const protectedRoot = new THREE.Vector3(displayed, 0.035, index * 2.15);
            horses[index].root.position.copy(protectedRoot);
            horses[index].animate(seconds, true);
            expect(horses[index].root.position.toArray()).toEqual(protectedRoot.toArray());
            expect(clock).toBe(owner);
            expect(clock(0, false)).toBe(seconds);
          }
          horses[index].root.updateMatrixWorld(true);
          const sequential = horses[index].root
            .getObjectByName(c.name)!
            .getWorldPosition(new THREE.Vector3());
          const seconds = clock(0, false);
          const direct = createRiggedHorse(a, '#774532', '#aa2244', index);
          direct.root.position.copy(horses[index].root.position);
          direct.root.updateMatrixWorld(true);
          direct.animate(seconds, true);
          direct.root.updateMatrixWorld(true);
          expect(
            direct.root
              .getObjectByName(c.name)!
              .getWorldPosition(new THREE.Vector3())
              .distanceTo(sequential)
          ).toBeLessThan(1e-7);
          direct.dispose?.();
        }
      }
  }, 15000);

  it('holds the same stopped/reduced-motion Idle pose after any crossing and resumes without history', () => {
    for (let index = 0; index < horses.length; index++) {
      for (const c of crossings) {
        pose(index, c.time - 1e-6, c.name);
        // RaceScene passes moving=false for stopped and reduced-motion rendering.
        const stopped = pose(index, c.time + 1e-6, c.name, false);
        const reduced = pose(index, c.time + 100, c.name, false);
        expect(stopped.position.distanceTo(reduced.position)).toBeLessThan(1e-7);
        const resumed = pose(index, c.time + 1e-6, c.name);
        const direct = createRiggedHorse(a, '#774532', '#aa2244', index);
        direct.root.position.copy(horses[index].root.position);
        direct.root.updateMatrixWorld(true);
        direct.animate(legacySeconds(c.time + 1e-6 - index * a.run.duration * 0.137), true);
        direct.root.updateMatrixWorld(true);
        const directFoot = direct.root
          .getObjectByName(c.name)!
          .getWorldPosition(new THREE.Vector3());
        expect(resumed.position.distanceTo(directFoot)).toBeLessThan(1e-7);
        direct.dispose?.();
      }
    }
  });
});
