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

it('bounds world stance slip across all four authored hooves and preserves suspension', async () => {
  const { measureHoofWindows, stanceOffset, sampledHoofSole } = await import('./authored-contact');
  const a = await assets();
  const windows = measureHoofWindows(a.horse, continuousGallop(a.run));
  const horse = createRiggedHorse(a, '#774532', '#aa2244', 0);
  const sample = (time: number) => {
    const travel = time * 15;
    horse.root.position.x = travel;
    horse.animate((travel * 0.74) / (1.04 / 0.22), true);
    horse.root.updateMatrixWorld(true);
  };
  for (const w of windows) {
    const points: THREE.Vector3[] = [];
    const soles: number[] = [];
    for (let i = 0; i <= 12; i++) {
      sample(w.center + (i / 12 - 0.5) * w.halfWidth);
      points.push(horse.root.getObjectByName(w.name)!.getWorldPosition(new THREE.Vector3()));
      soles.push(sampledHoofSole(horse.root.children[0], w.name) * 1.5);
    }
    const slip = Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x));
    const clearance = Math.max(...points.map((p) => Math.abs(p.y + w.soleOffset * 1.5)));
    const soleResidual = Math.max(...soles.map(Math.abs));
    console.log('central half stance residual', w.name, {
      slip,
      estimatedClearance: clearance,
      soleResidual,
    });
    expect(soleResidual).toBeLessThan(0.025);
    expect(slip).toBeLessThan(0.0021);
    expect(clearance).toBeLessThan(0.025);
    const fullContact: THREE.Vector3[] = [];
    const fullSoles: number[] = [];
    for (let i = 0; i <= 24; i++) {
      sample(w.center + (i / 24 - 0.5) * 2 * w.halfWidth);
      fullContact.push(horse.root.getObjectByName(w.name)!.getWorldPosition(new THREE.Vector3()));
      fullSoles.push(sampledHoofSole(horse.root.children[0], w.name) * 1.5);
    }
    const transitionSlip =
      Math.max(...fullContact.map((p) => p.x)) - Math.min(...fullContact.map((p) => p.x));
    const fullSoleResidual = Math.max(...fullSoles.map(Math.abs));
    console.log('full stance including eased transitions', w.name, {
      transitionSlip,
      fullSoleResidual,
    });
    expect(fullSoleResidual).toBeLessThan(0.025);
    expect(transitionSlip).toBeLessThan(0.004);
  }
  const airborne = Array.from({ length: 100 }, (_, i) => (i * a.run.duration) / 100).filter((t) =>
    windows.every((w) => Math.abs(stanceOffset(t, a.run.duration, w)) > w.halfWidth)
  );
  expect(airborne.length).toBeGreaterThan(12);
  const suspended = airborne.filter((time) => {
    sample(time);
    return windows.every((w) => sampledHoofSole(horse.root.children[0], w.name) * 1.5 > 0.04);
  });
  console.log('natural all-four-sole airborne samples', suspended.length);
  expect(suspended.length).toBeGreaterThan(8);
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

it('measures four real authored stance windows and visible sole clearance', async () => {
  const { measureHoofWindows } = await import('./authored-contact');
  const a = await assets();
  const started = performance.now();
  const windows = measureHoofWindows(a.horse, continuousGallop(a.run));
  console.log(
    'authored contact calibration',
    performance.now() - started,
    windows.map(
      ({
        soleHeights,
        soleOffsets,
        soleCorrections,
        solveCompensationX,
        solveCompensationZ,
        ...window
      }) => ({
        ...window,
        soleProfileSamples: soleHeights.length,
        cachedFitSamples: soleOffsets.length,
        soleCorrectionRange: [Math.min(...soleCorrections), Math.max(...soleCorrections)],
        planarCompensationMaximum: Math.max(
          ...solveCompensationX.map(Math.abs),
          ...solveCompensationZ.map(Math.abs)
        ),
      })
    )
  );
  expect(windows).toHaveLength(4);
  for (const w of windows) {
    expect(w.halfWidth).toBeGreaterThan(0.008);
    expect(w.soleOffset).toBeLessThan(0);
    expect(w.soleOffset).toBeGreaterThan(-0.3);
  }
});

it('articulates rider knees/elbows against anchored boots/hands with frame-step independence', async () => {
  const a = await assets();
  const one = createRiggedHorse(a, '#774532', '#aa2244', 0);
  const two = createRiggedHorse(a, '#774532', '#aa2244', 0);
  const riderSkeleton = (horse: ReturnType<typeof createRiggedHorse>) => {
    let result: THREE.Skeleton | undefined;
    horse.root.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh && o.skeleton.getBoneByName('pelvis')) result = o.skeleton;
    });
    return result!;
  };
  const rig = riderSkeleton(one);
  const knees: THREE.Quaternion[] = [],
    elbows: THREE.Quaternion[] = [];
  let maxBootError = 0,
    maxHandError = 0;
  for (let i = 0; i <= 60; i++) {
    const time = (i / 60) * a.run.duration;
    const travel = time * 15;
    one.root.position.x = travel;
    one.animate((travel * 0.74) / (1.04 / 0.22), true);
    one.root.updateMatrixWorld(true);
    knees.push(rig.getBoneByName('calf_l')!.quaternion.clone());
    elbows.push(rig.getBoneByName('lowerarm_l')!.quaternion.clone());
    const model = one.root.children[0];
    const spine = model.worldToLocal(
      model.getObjectByName('spine_2')!.getWorldPosition(new THREE.Vector3())
    );
    // Tack/saddle anchor height is exposed by the original saddle mesh, not a synthetic rider target.
    const saddle = model.children.find(
      (o) => o instanceof THREE.Mesh && Math.abs(o.position.z + 0.12) < 1e-8
    )!;
    const bounce = saddle.position.y - 1.52;
    const localFoot = model.worldToLocal(
      rig.getBoneByName('foot_l')!.getWorldPosition(new THREE.Vector3())
    );
    const localHand = model.worldToLocal(
      rig.getBoneByName('hand_l')!.getWorldPosition(new THREE.Vector3())
    );
    maxBootError = Math.max(
      maxBootError,
      localFoot.distanceTo(new THREE.Vector3(0.38, 1.15 + bounce, -0.26))
    );
    maxHandError = Math.max(
      maxHandError,
      localHand.distanceTo(
        new THREE.Vector3(
          0.21 * 0.79,
          1.65 - 0.917 * 0.79 + 1.14 * 0.79 + bounce * 0.85,
          -0.12 + 0.77 * 0.79
        )
      )
    );
    expect(Number.isFinite(spine.y)).toBe(true);
  }
  console.log('rider anchor residuals model units', { maxBootError, maxHandError });
  expect(Math.max(...knees.map((q) => q.angleTo(knees[0])))).toBeGreaterThan(0.02);
  expect(Math.max(...elbows.map((q) => q.angleTo(elbows[0])))).toBeGreaterThan(0.02);
  expect(maxBootError).toBeLessThan(0.015);
  expect(maxHandError).toBeLessThan(0.015);
  // Compare direct sampling against a runner with a full stride history, during fore stance.
  one.root.position.x = 0.3171006973522405 * 15;
  one.animate((one.root.position.x * 0.74) / (1.04 / 0.22), true);
  one.root.updateMatrixWorld(true);
  two.root.position.x = one.root.position.x;
  two.animate((one.root.position.x * 0.74) / (1.04 / 0.22), true);
  two.root.updateMatrixWorld(true);
  const other = riderSkeleton(two);
  for (const name of [
    'front_leg_foot_l',
    'front_leg_foot_r',
    'back_leg_foot_l',
    'back_leg_foot_r',
  ]) {
    expect(
      two.root
        .getObjectByName(name)!
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(one.root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3()))
    ).toBeLessThan(1e-7);
  }
  for (const name of ['calf_l', 'lowerarm_l', 'foot_l', 'hand_l']) {
    expect(
      other
        .getBoneByName(name)!
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(rig.getBoneByName(name)!.getWorldPosition(new THREE.Vector3()))
    ).toBeLessThan(1e-7);
  }
  one.dispose!();
  two.dispose!();
});

it('bounds visible skin penetration over the entire cycle while preserving positive authored clearance', async () => {
  const { measureHoofWindows, stanceOffset, sampledHoofSole } = await import('./authored-contact');
  const a = await assets();
  const windows = measureHoofWindows(a.horse, continuousGallop(a.run));
  const rawMixer = new THREE.AnimationMixer(a.horse);
  rawMixer.clipAction(continuousGallop(a.run)).play();
  const horse = createRiggedHorse(a, '#774532', '#aa2244', 0);
  const metrics = windows.map((w) => ({
    name: w.name,
    minimumAll: Infinity,
    minimumOutside: Infinity,
    unchangedPositiveSamples: 0,
  }));
  for (let i = 0; i < 384; i++) {
    const time = (i * a.run.duration) / 384;
    const travel = time * 15;
    rawMixer.setTime(time);
    a.horse.updateMatrixWorld(true);
    horse.root.position.x = travel;
    horse.animate((travel * 0.74) / (1.04 / 0.22), true);
    horse.root.updateMatrixWorld(true);
    const model = horse.root.children[0];
    windows.forEach((w, hoof) => {
      const sole = sampledHoofSole(model, w.name) * 1.5;
      const outside = Math.abs(stanceOffset(time, a.run.duration, w)) >= w.halfWidth;
      const m = metrics[hoof];
      m.minimumAll = Math.min(m.minimumAll, sole);
      if (outside) m.minimumOutside = Math.min(m.minimumOutside, sole);
      if (
        Math.abs(stanceOffset(time, a.run.duration, w)) >= w.halfWidth + w.transitionWidth &&
        sampledHoofSole(a.horse, w.name) > 0.005
      ) {
        const authored = a.horse.worldToLocal(
          a.horse.getObjectByName(w.name)!.getWorldPosition(new THREE.Vector3())
        );
        const final = model.worldToLocal(
          model.getObjectByName(w.name)!.getWorldPosition(new THREE.Vector3())
        );
        expect(final.distanceTo(authored)).toBeLessThan(1e-6);
        m.unchangedPositiveSamples++;
      }
    });
  }
  console.log('entire cycle actual skinned hoof minima', metrics);
  for (const m of metrics) {
    expect(m.minimumAll).toBeGreaterThan(-0.004);
    expect(m.minimumOutside).toBeGreaterThan(-0.004);
    expect(m.unchangedPositiveSamples).toBeGreaterThan(100);
  }
  rawMixer.stopAllAction();
  rawMixer.uncacheRoot(a.horse);
  horse.dispose!();
});

it('keeps recovery weights C1 at the declared buffers and bounds phase-only rider response', async () => {
  const { measureHoofWindows, hoofContactWeight, sampleHoofSupport } =
    await import('./authored-contact');
  const a = await assets(),
    windows = measureHoofWindows(a.horse, continuousGallop(a.run));
  for (const w of windows) {
    expect(w.transitionWidth).toBeCloseTo(w.halfWidth * 0.75, 12);
    for (const edge of [
      -w.halfWidth - w.transitionWidth,
      -w.halfWidth,
      w.halfWidth,
      w.halfWidth + w.transitionWidth,
    ]) {
      const time = w.center + edge,
        epsilon = 1e-7;
      const left = hoofContactWeight(time - epsilon, a.run.duration, w),
        at = hoofContactWeight(time, a.run.duration, w),
        right = hoofContactWeight(time + epsilon, a.run.duration, w);
      expect(Math.abs((at - left) / epsilon)).toBeLessThan(0.01);
      expect(Math.abs((right - at) / epsilon)).toBeLessThan(0.01);
    }
    expect(w.soleOffsets).toHaveLength(192);
    for (const v of [
      ...w.soleOffsets,
      ...w.soleCorrections,
      ...w.solveCompensationX,
      ...w.solveCompensationZ,
    ])
      expect(Number.isFinite(v)).toBe(true);
    for (const v of w.soleCorrections) expect(Math.abs(v)).toBeLessThanOrEqual(0.050000001);
    for (const v of [...w.solveCompensationX, ...w.solveCompensationZ])
      expect(Math.abs(v)).toBeLessThanOrEqual(0.050000001);
  }
  for (let i = 0; i < 384; i++) {
    const time = (i * a.run.duration) / 384,
      response = sampleHoofSupport(time, a.run.duration, windows);
    expect(response.load).toBeGreaterThanOrEqual(0);
    expect(response.load).toBeLessThanOrEqual(1);
    expect(Math.abs(response.pitch)).toBeLessThanOrEqual(1);
    expect(Math.abs(response.roll)).toBeLessThanOrEqual(1);
    const loop = sampleHoofSupport(time + a.run.duration, a.run.duration, windows);
    for (const key of ['load', 'pitch', 'roll'] as const)
      expect(response[key]).toBeCloseTo(loop[key], 10);
  }
});

it('keeps actual hoof positions and normalized limb rotations continuous at subframe buffer and loop boundaries', async () => {
  const { measureHoofWindows } = await import('./authored-contact');
  const a = await assets(),
    windows = measureHoofWindows(a.horse, continuousGallop(a.run)),
    horse = createRiggedHorse(a, '#774532', '#aa2244', 0);
  const sample = (time: number, name: string) => {
    const travel = time * 15;
    horse.root.position.x = travel;
    horse.animate((travel * 0.74) / (1.04 / 0.22), true);
    horse.root.updateMatrixWorld(true);
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
  let maxPosition = 0,
    maxRotation = 0;
  for (const w of windows)
    for (const time of [
      0,
      w.center - w.halfWidth - w.transitionWidth,
      w.center - w.halfWidth,
      w.center + w.halfWidth,
      w.center + w.halfWidth + w.transitionWidth,
    ]) {
      const left = sample(time - 1e-4, w.name),
        right = sample(time + 1e-4, w.name);
      maxPosition = Math.max(maxPosition, left.position.distanceTo(right.position));
      maxRotation = Math.max(
        maxRotation,
        ...left.rotations.map((q, i) => q.angleTo(right.rotations[i]))
      );
    }
  console.info('actual subframe continuity at epsilon .1ms', { maxPosition, maxRotation });
  expect(maxPosition).toBeLessThan(0.01);
  expect(maxRotation).toBeLessThan(0.05);
  horse.dispose!();
});
