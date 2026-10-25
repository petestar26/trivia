import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import controls from './native-jog-controls.json';
import { BONES, createRig, humanGeometry, type Rig } from './rig';
import {
  capture,
  plantRunFeet,
  poseRun,
  poseKick,
  poseKeeperReady,
  poseIdle,
  type RunPlant,
} from './poses';
import {
  applyReviewPlayerMotion,
  createReviewMotionState,
  type ReviewMotionInput,
} from './review-player-motion';
import {
  sampleNativeJog,
  nativeJogWeight,
  createNativeJogState,
  prepareNativeJog,
  applyNativeJogAfterPlant,
  poseNativeJogFingers,
  resetNativeJogState,
} from './native-jog';
const make = () => createRig(new THREE.MeshBasicMaterial(), humanGeometry().geometry);
const error = (a: THREE.Matrix4, b: THREE.Matrix4) =>
  Math.max(...a.elements.map((v, i) => Math.abs(v - b.elements[i])));
const matrices = (rig: Rig) => {
  rig.root.updateMatrixWorld(true);
  return Object.fromEntries(
    ['footL', 'footR', 'toeL', 'toeR'].map((name) => [
      name,
      rig.bones[name as keyof Rig['bones']].matrixWorld.clone(),
    ])
  );
};
const snapshotPlant = (plants: RunPlant) => JSON.stringify(plants);
const input = (phase = 0): ReviewMotionInput => ({
  kind: 'run',
  phase,
  time: 900,
  speed: 2.4,
  deltaSeconds: 1 / 60,
});

describe('native one-actor jog semantic controls', () => {
  it('uses absolute canonical locals and explicit per-phase Hermite handles', () => {
    const a = controls.samples[31],
      b = controls.samples[32],
      phase = (a.phase + b.phase) / 2;
    const sample = sampleNativeJog(phase),
      span = b.phase - a.phase;
    const expected = a.pelvisLocalPositionMetres.map(
      (v, i) =>
        0.5 * v +
        0.125 * span * a.tangentsPerPhase.pelvisLocalPositionMetres[i] +
        0.5 * b.pelvisLocalPositionMetres[i] -
        0.125 * span * b.tangentsPerPhase.pelvisLocalPositionMetres[i]
    );
    expect(sample.pelvis.toArray()).toEqual(
      expect.arrayContaining(expected.map((v) => expect.closeTo(v, 13)))
    );
    expect(sample.pelvis.y).toBeGreaterThan(0.7);
    for (const q of [sample.rotation, ...Object.values(sample.upper)])
      expect(q!.length()).toBeCloseTo(1, 13);
    expect(sample.poles.L.length()).toBeCloseTo(1, 13);
    expect(sample.poles.R.length()).toBeCloseTo(1, 13);
    expect(sample.upper).not.toHaveProperty('root');
    expect(sample.upper).not.toHaveProperty('footL');
    expect(sample.upper).not.toHaveProperty('upperLegL');
  });
  it('is a closed distance-phase loop and is independent of elapsed time', () => {
    const a = sampleNativeJog(0),
      b = sampleNativeJog(1),
      c = sampleNativeJog(-0.75),
      d = sampleNativeJog(0.25);
    expect(a).toEqual(b);
    expect(c).toEqual(d);
    const l = sampleNativeJog(1 - 1e-7),
      r = sampleNativeJog(1e-7);
    expect(l.pelvis.distanceTo(r.pelvis)).toBeLessThan(1e-6);
    expect(l.rotation.angleTo(r.rotation)).toBeLessThan(1e-5);
  });
  it('keeps contribution bounded to the supported speed/effort domain', () => {
    expect(nativeJogWeight(input())).toBe(1);
    for (const speed of [0, 1.6, 3.2, 9]) expect(nativeJogWeight({ ...input(), speed })).toBe(0);
    for (const acceleration of [-4, 4])
      expect(nativeJogWeight({ ...input(), acceleration })).toBe(0);
    for (const turn of [-0.4, 0.4]) expect(nativeJogWeight({ ...input(), turn })).toBe(0);
    for (const kind of ['kick', 'keeperReady', 'keeperDive', 'idle', 'celebrate'] as const)
      expect(nativeJogWeight({ ...input(), kind })).toBe(0);
    expect(nativeJogWeight({ ...input(), reducedMotion: true })).toBe(0);
  });
  it('preserves full world foot/toe matrices and the original once-planned RunPlant at scales, yaws and speeds', () => {
    let changed = 0,
      checked = 0,
      maximum = 0;
    for (const scale of [0.96, 1, 1.04])
      for (const yaw of [-2.9, 0, 2.9])
        for (const speed of [1.85, 2.4, 2.95]) {
          const rig = make(),
            plants: RunPlant = {};
          rig.root.scale.setScalar(scale);
          rig.root.rotation.y = yaw;
          for (let step = 0; step <= 48; step++) {
            const phase = step / 48,
              at = { ...input(phase), speed };
            rig.root.position.set(Math.sin(yaw) * phase * 1.45, 0, Math.cos(yaw) * phase * 1.45);
            poseRun(rig, phase, speed);
            applyReviewPlayerMotion(rig, at);
            plantRunFeet(rig, phase, speed, plants);
            // Non-identity toe articulation must survive the ankle IK and complete world rotation restoration.
            rig.bones.toeL.rotation.x = 0.13;
            rig.bones.toeR.rotation.x = -0.09;
            const before = matrices(rig),
              held = snapshotPlant(plants),
              root = rig.root.matrixWorld.clone();
            const hips = rig.bones.hips.position.clone(),
              state = createNativeJogState();
            prepareNativeJog(state, at);
            applyNativeJogAfterPlant(rig, state, at);
            const after = matrices(rig);
            for (const name of Object.keys(before))
              maximum = Math.max(maximum, error(before[name], after[name]));
            expect(snapshotPlant(plants)).toBe(held);
            expect(error(root, rig.root.matrixWorld)).toBe(0);
            expect(state.appliedWeight).toBeGreaterThanOrEqual(0);
            expect(state.appliedWeight).toBeLessThanOrEqual(nativeJogWeight(at));
            if (hips.distanceTo(rig.bones.hips.position) > 1e-6) changed++;
            checked++;
          }
          rig.dispose();
        }
    expect(checked).toBe(1323);
    expect(changed).toBeGreaterThan(1000);
    expect(maximum).toBeLessThan(5e-12);
  });
  it('restores the original complete pose if the requested pelvis is infeasible', () => {
    const rig = make(),
      at = input(0.17),
      state = createNativeJogState();
    poseRun(rig, at.phase, at.speed);
    plantRunFeet(rig, at.phase, at.speed, {});
    const before = capture(rig),
      root = rig.root.matrixWorld.clone();
    prepareNativeJog(state, at);
    state.sample!.pelvis.set(1e8, 1e8, 1e8);
    expect(applyNativeJogAfterPlant(rig, state, at)).toBe(0);
    expect(capture(rig)).toEqual(before);
    expect(error(root, rig.root.matrixWorld)).toBe(0);
  });
  it('retains the accepted other-action poses and private state reset semantics', () => {
    const rig = make(),
      state = createNativeJogState();
    for (const kind of ['idle', 'kick', 'keeperReady'] as const) {
      if (kind === 'idle') poseIdle(rig, 1);
      else if (kind === 'keeperReady') poseKeeperReady(rig, 1);
      else
        poseKick(rig, 0.3, {
          ball: new THREE.Vector3(0, 0.11, 0),
          dir: new THREE.Vector3(0, 0, 1),
          foot: 'R',
          power: 0.8,
          loft: 0.2,
        });
      const at = { ...input(), kind },
        before = capture(rig);
      prepareNativeJog(state, at);
      applyNativeJogAfterPlant(rig, state, at);
      poseNativeJogFingers(rig, state);
      expect(capture(rig)).toEqual(before);
    }
    resetNativeJogState(state);
    expect(state).toEqual(createNativeJogState());
  });
  it('does not advance entry/exit histories at dt0 and resets owned sample/pose buffers', () => {
    const state = createNativeJogState();
    prepareNativeJog(state, { ...input(), speed: 0 });
    expect(prepareNativeJog(state, { ...input(), deltaSeconds: 0 })).toBe(0);
    const entered = prepareNativeJog(state, input());
    expect(entered).toBeGreaterThan(0);
    const held = state.weight;
    prepareNativeJog(state, { ...input(), speed: 7, deltaSeconds: 0 });
    expect(state.weight).toBe(held);
    prepareNativeJog(state, { ...input(), speed: 7 });
    expect(state.weight).toBeLessThan(held);
    state.baseline = capture(make());
    resetNativeJogState(state);
    expect(state.baseline).toBeUndefined();
    expect(state.sample).toBeUndefined();
  });
  it('hands leave wrists intact, use native finger locals, and outgoing arms retain actual native targets on interruption', () => {
    const rig = make(),
      owner = createReviewMotionState(),
      state = createNativeJogState();
    const at = input(0.2);
    poseRun(rig, at.phase, at.speed);
    const w = prepareNativeJog(state, at);
    applyReviewPlayerMotion(rig, { ...at, nativeJogWeight: w, motionState: owner });
    plantRunFeet(rig, at.phase, at.speed, {});
    applyNativeJogAfterPlant(rig, state, at, owner);
    const arm = rig.bones.upperArmL.quaternion.clone(),
      wrist = rig.bones.handL.quaternion.clone();
    poseNativeJogFingers(rig, state);
    expect(rig.bones.handL.quaternion.toArray()).toEqual(wrist.toArray());
    expect(
      rig.bones.index1L.quaternion.angleTo(sampleNativeJog(at.phase).upper.index1L!)
    ).toBeLessThan(1e-6);
    poseIdle(rig, 0);
    applyReviewPlayerMotion(rig, {
      ...at,
      kind: 'idle',
      nativeJogWeight: 0,
      motionState: owner,
      deltaSeconds: 0,
    });
    expect(rig.bones.upperArmL.quaternion.angleTo(arm)).toBeLessThan(1e-6);
    const interrupted = rig.bones.upperArmL.quaternion.clone();
    poseRun(rig, 0.4, 2.4);
    applyReviewPlayerMotion(rig, {
      ...at,
      phase: 0.4,
      nativeJogWeight: 1,
      motionState: owner,
      deltaSeconds: 0,
    });
    expect(rig.bones.upperArmL.quaternion.angleTo(interrupted)).toBeLessThan(1e-6);
    poseRun(rig, 0.4, 2.4);
    applyReviewPlayerMotion(rig, {
      ...at,
      phase: 0.4,
      nativeJogWeight: 1,
      motionState: owner,
      deltaSeconds: 1 / 60,
    });
    expect(rig.bones.upperArmL.quaternion.angleTo(interrupted)).toBeGreaterThan(1e-5);
    expect(BONES).toContain('index1L');
  });
});

describe('native reset restoration boundary', () => {
  it('restores original protected locals and identical world feet immediately while retaining actual arms', () => {
    const rig = make(),
      at = input(0.27),
      state = createNativeJogState(),
      owner = createReviewMotionState();
    poseRun(rig, at.phase, at.speed);
    const weight = prepareNativeJog(state, at);
    applyReviewPlayerMotion(rig, {
      ...at,
      motionState: owner,
      nativeJogWeight: weight,
      nativeJogSample: state.sample,
    });
    plantRunFeet(rig, at.phase, at.speed, {});
    applyNativeJogAfterPlant(rig, state, at, owner);
    const original = state.baseline!,
      feet = matrices(rig),
      root = rig.root.matrixWorld.clone();
    const arms = ['upperArmL', 'foreArmL', 'handL', 'upperArmR', 'foreArmR', 'handR'] as const;
    const actualArms = arms.map((name) => rig.bones[name].quaternion.toArray());
    resetNativeJogState(state, rig);
    for (const name of [
      'hips',
      'upperLegL',
      'lowerLegL',
      'footL',
      'toeL',
      'upperLegR',
      'lowerLegR',
      'footR',
      'toeR',
    ] as const) {
      const index = BONES.indexOf(name);
      expect(rig.bones[name].position.toArray()).toEqual(original.p[index].toArray());
      expect(rig.bones[name].quaternion.toArray()).toEqual(original.q[index].toArray());
    }
    expect(arms.map((name) => rig.bones[name].quaternion.toArray())).toEqual(actualArms);
    for (const [name, matrix] of Object.entries(matrices(rig)))
      expect(error(matrix, feet[name])).toBeLessThan(5e-12);
    expect(error(root, rig.root.matrixWorld)).toBe(0);
    expect(state).toEqual(createNativeJogState());
  });
});
