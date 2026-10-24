import * as THREE from 'three';
import poseStudy from './review-authored-poses.json';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { BONES, createRig, humanGeometry, type Rig } from './rig';
import {
  DIVE_CONTACT,
  DIVE_DURATION,
  KICK,
  diveRoot,
  kickGeometry,
  plantRunFeet,
  poseIdle,
  poseKeeperDive,
  poseKeeperReady,
  poseKick,
  poseRun,
  type RunPlant,
  strideLength,
} from './poses';
import {
  applyReviewPlayerMotion,
  createReviewMotionState,
  resetReviewMotionState,
  poseReviewPlayerHands,
  REVIEW_MOTION_SCENARIOS,
  sampleReviewMotionScenario,
  sampleReviewPlayerPosture,
  sampleReviewArmTargets,
  REVIEW_AUTHORED_POSE_STUDY,
  sampleReviewFinishingSequence,
  REVIEW_FINISHING_JOINS,
  REVIEW_FINISHING_DURATION,
  type ReviewMotionInput,
} from './review-player-motion';

const makeRig = () => createRig(new THREE.MeshBasicMaterial(), humanGeometry().geometry);
const world = (rig: Rig, name: (typeof BONES)[number]) => {
  rig.root.updateMatrixWorld(true);
  return rig.bones[name].matrixWorld.clone();
};
const matrixError = (a: THREE.Matrix4, b: THREE.Matrix4) =>
  Math.max(...a.elements.map((v, i) => Math.abs(v - b.elements[i])));
const protectedBones = [
  'hips',
  'upperLegL',
  'lowerLegL',
  'footL',
  'toeL',
  'upperLegR',
  'lowerLegR',
  'footR',
  'toeR',
] as const;
const kick = {
  ball: new THREE.Vector3(0, 0.11, 0),
  dir: new THREE.Vector3(0, 0, 1),
  foot: 'R' as const,
  power: 0.75,
  loft: 0.2,
};

function basePose(rig: Rig, input: ReviewMotionInput) {
  switch (input.kind) {
    case 'run':
      poseRun(rig, input.phase, input.speed);
      break;
    case 'kick':
      rig.root.position.copy(kickGeometry(kick).root);
      poseKick(rig, input.time, kick);
      break;
    case 'keeperReady':
      poseKeeperReady(rig, input.time);
      break;
    case 'keeperDive': {
      const spec = { direction: input.direction ?? 1, reach: 1.15, height: 1.1 };
      rig.root.position.copy(diveRoot(spec, input.time));
      poseKeeperDive(rig, input.time, spec, new THREE.Vector3(spec.direction * 1.15, 1.1, 0.4));
      break;
    }
    default:
      poseIdle(rig, input.time);
  }
}

describe('isolated review player posture adapter', () => {
  it('samples delayed shoulder and elbow recoil from the unchanged periodic distance phase', () => {
    const input = { kind: 'run' as const, time: 0, phase: 0, speed: 4 };
    // Arms are authored absolute targets, while the torso remains additive. Both
    // channels must follow the same released distance phase and loop smoothly.
    const sample = (phase: number, time = 0) => ({
      ...sampleReviewPlayerPosture({ ...input, phase, time }),
      ...sampleReviewArmTargets({ ...input, phase, time }),
    });
    const first = sample(0);
    expect(Math.abs(first.chest![1])).toBeGreaterThan(0.005);
    expect(Math.abs(first.upperArmL![0])).toBeGreaterThan(0.005);
    // Explicit shoulder peak follows support reversal; elbow recoil follows it.
    const shoulder = sample(0.04),
      elbow = sample(0.125);
    expect(shoulder.upperArmL![0]).toBeGreaterThan(first.upperArmL![0]);
    expect(Math.abs(shoulder.upperArmR![0])).toBeGreaterThan(Math.abs(first.upperArmR![0]));
    expect(elbow.foreArmL![0]).toBeLessThan(shoulder.foreArmL![0]);
    expect(elbow.upperArmL![0]).toBeLessThan(shoulder.upperArmL![0]);
    for (let step = 0; step <= 120; step++) {
      const phase = step / 120;
      const a = sample(phase),
        b = sample(phase + 7, 900);
      for (const name of Object.keys(a) as (keyof typeof a)[])
        a[name]!.forEach((angle, axis) => expect(angle).toBeCloseTo(b[name]![axis], 12));
    }
    const epsilon = 1e-6;
    const left = sample(-epsilon),
      right = sample(epsilon);
    for (const name of Object.keys(first) as (keyof typeof first)[])
      first[name]!.forEach((angle, axis) => {
        const incoming = (angle - left[name]![axis]) / epsilon;
        const outgoing = (right[name]![axis] - angle) / epsilon;
        expect(Math.abs(incoming - outgoing)).toBeLessThan(0.0001);
      });
  });

  it('releases keyed turn arm effort at the same turn envelope boundaries as the torso', () => {
    const input = { kind: 'run' as const, time: 1, phase: 0.23, speed: 4 };
    const coast = sampleReviewArmTargets(input);
    for (const direction of [-1, 1]) {
      for (const turnPhase of [0, 1]) {
        const arms = sampleReviewArmTargets({ ...input, turn: direction, turnPhase });
        for (const name of Object.keys(coast) as (keyof typeof coast)[])
          arms[name]!.forEach((angle, axis) => expect(angle).toBeCloseTo(coast[name]![axis], 12));
      }
      const balancing = sampleReviewArmTargets({ ...input, turn: direction, turnPhase: 0.5 });
      expect(balancing).not.toEqual(coast);
    }
  });

  it('coordinates both balancing arms during braking without changing its support phase', () => {
    for (const phase of [0, 0.2, 0.49, 0.73]) {
      const input = { kind: 'run' as const, time: 0.8, phase, speed: 4 };
      const coast = sampleReviewArmTargets(input);
      const brake = sampleReviewArmTargets({ ...input, acceleration: -4 });
      for (const side of ['L', 'R'] as const) {
        // Intent is retained in the editable source, replacing formula-only radians.
        expect(brake[`foreArm${side}`]![0] - coast[`foreArm${side}`]![0]).toBeCloseTo(
          THREE.MathUtils.degToRad(-2),
          12
        );
        expect(brake[`upperArm${side}`]![0]).toBeLessThan(coast[`upperArm${side}`]![0]);
      }
      expect(input.phase).toBe(phase);
    }
  });

  it('retains balancing torso and arms through the existing kick marker, then settles smoothly', () => {
    for (const direction of [-1, 1] as const) {
      const input = { kind: 'kick' as const, speed: 0, phase: 0, direction };
      const impact = sampleReviewPlayerPosture({ ...input, time: KICK.contact });
      expect(impact.spine![1]).toBeCloseTo(direction * THREE.MathUtils.degToRad(2), 12);
      for (const time of [KICK.contact, KICK.through]) {
        const arms = sampleReviewArmTargets({ ...input, time });
        expect(arms.upperArmL![0] * arms.upperArmR![0]).toBeLessThan(0);
        expect(Math.abs(arms.upperArmL![0])).toBeGreaterThan(0.3);
        expect(Math.abs(arms.upperArmR![0])).toBeGreaterThan(0.3);
      }
      for (const marker of [0, KICK.contact, KICK.through, KICK.duration]) {
        for (const sampler of [sampleReviewPlayerPosture, sampleReviewArmTargets]) {
          const a = sampler({ ...input, time: Math.max(0, marker - 1e-6) });
          const b = sampler({ ...input, time: marker + 1e-6 });
          for (const name of Object.keys(a) as (keyof typeof a)[])
            a[name]!.forEach((angle, axis) =>
              expect(Math.abs(angle - b[name]![axis])).toBeLessThan(0.00001)
            );
        }
      }
      const settled = sampleReviewPlayerPosture({ ...input, time: KICK.duration });
      for (const angles of Object.values(settled))
        for (const angle of angles) expect(Math.abs(angle)).toBeLessThan(1e-12);
      const settledArms = sampleReviewArmTargets({ ...input, time: KICK.duration });
      const restArms = sampleReviewArmTargets({ kind: 'idle', time: 0, phase: 0, speed: 0 });
      // Mirror recovery still uses the accepted outward abduction on each side.
      expect(settledArms.upperArmL![2]).toBeGreaterThan(0.2);
      expect(settledArms.upperArmR![2]).toBeLessThan(-0.2);
      if (direction === 1) expect(settledArms).toEqual(restArms);
    }
    expect(KICK).toMatchObject({ contact: 0.3, through: 0.34, duration: 0.85 });
  });

  it('leaves both-foot kick roots, legs and ball facts exact throughout recoil and follow-through', () => {
    for (const scale of [0.96, 1.04])
      for (const side of ['L', 'R'] as const) {
        const rig = makeRig();
        rig.root.scale.setScalar(scale);
        const spec = { ...kick, foot: side };
        const ballBefore = spec.ball.clone();
        const dirBefore = spec.dir.clone();
        try {
          for (let frame = 0; frame <= 102; frame++) {
            const time = frame / 120;
            rig.root.position.copy(kickGeometry(spec).root);
            poseKick(rig, time, spec);
            const before = protectedBones.map((name) => world(rig, name));
            const rootBefore = rig.root.matrixWorld.clone();
            applyReviewPlayerMotion(rig, {
              kind: 'kick',
              time,
              phase: 0,
              speed: 0,
              direction: side === 'R' ? 1 : -1,
            });
            protectedBones.forEach((name, i) =>
              expect(matrixError(world(rig, name), before[i])).toBeLessThan(1e-12)
            );
            expect(matrixError(rig.root.matrixWorld, rootBefore)).toBeLessThan(1e-12);
            expect(spec.ball.equals(ballBefore)).toBe(true);
            expect(spec.dir.equals(dirBefore)).toBe(true);
          }
        } finally {
          rig.dispose();
          (rig.mesh.material as THREE.Material).dispose();
        }
      }
  });

  it('adds distinct bounded idle, drive, brake, turn, kick, landing and recovery postures', () => {
    const drive = sampleReviewPlayerPosture({
      kind: 'run',
      time: 0.6,
      phase: 0.2,
      speed: 3,
      acceleration: 4,
    });
    const brake = sampleReviewPlayerPosture({
      kind: 'run',
      time: 0.6,
      phase: 0.2,
      speed: 3,
      acceleration: -4,
    });
    expect(drive.spine![0]).toBeGreaterThan(0.08);
    expect(brake.spine![0]).toBeLessThan(-0.05);
    for (const scenario of REVIEW_MOTION_SCENARIOS)
      for (const t of [0.2, 0.7, 1.3]) {
        const { motion } = sampleReviewMotionScenario(scenario, t);
        for (const angles of Object.values(sampleReviewPlayerPosture(motion)))
          for (const v of angles) {
            expect(Number.isFinite(v)).toBe(true);
            expect(Math.abs(v)).toBeLessThan(0.16);
          }
      }
    const landing = sampleReviewPlayerPosture({
      kind: 'keeperDive',
      time: 0.78,
      speed: 0,
      phase: 0,
    });
    const recovery = sampleReviewPlayerPosture({
      kind: 'keeperDive',
      time: 1.4,
      speed: 0,
      phase: 0,
    });
    expect(landing.spine![0]).toBeGreaterThan(0);
    expect(recovery.spine![0]).toBeLessThan(0);
  });

  for (const scale of [0.96, 1.04])
    it(`never changes root, pelvis, leg or ball-contact transforms (${scale})`, () => {
      const rig = makeRig();
      rig.root.scale.setScalar(scale);
      for (const scenario of REVIEW_MOTION_SCENARIOS)
        for (const t of [0, 0.1, 0.3, 0.45, 0.7, 1.3, 1.8]) {
          const input = sampleReviewMotionScenario(scenario, t).motion;
          basePose(rig, input);
          const before = protectedBones.map((name) => world(rig, name));
          const root = rig.root.matrixWorld.clone();
          const inputBefore = JSON.stringify(input);
          applyReviewPlayerMotion(rig, input);
          protectedBones.forEach((name, i) =>
            expect(matrixError(world(rig, name), before[i])).toBeLessThan(1e-12)
          );
          expect(matrixError(rig.root.matrixWorld, root)).toBeLessThan(1e-12);
          expect(JSON.stringify(input)).toBe(inputBefore);
        }
      expect(KICK.contact).toBe(0.3);
      expect(DIVE_CONTACT).toBe(0.45);
      expect(DIVE_DURATION).toBe(1.8);
      rig.dispose();
    });

  for (const direction of [-1, 1] as const)
    for (const scale of [0.96, 1.04])
      it(`retains both solved keeper wrist anchors and rotations throughout dive (${direction}, ${scale})`, () => {
        const rig = makeRig();
        rig.root.scale.setScalar(scale);
        for (let frame = 0; frame <= 108; frame++) {
          const input: ReviewMotionInput = {
            kind: 'keeperDive',
            time: frame / 60,
            phase: 0,
            speed: 0,
            direction,
          };
          basePose(rig, input);
          const before = ['handL', 'handR'].map((name) => world(rig, name as 'handL' | 'handR'));
          applyReviewPlayerMotion(rig, input);
          (['handL', 'handR'] as const).forEach((name, i) =>
            expect(matrixError(world(rig, name), before[i])).toBeLessThan(1e-8)
          );
          if (input.time === DIVE_CONTACT)
            for (const angles of Object.values(sampleReviewPlayerPosture(input)))
              for (const value of angles) expect(Math.abs(value)).toBe(0);
        }
        rig.dispose();
      });

  it('is independent of previous frame order when applied to freshly sampled poses and does not affect another rig', () => {
    const a = makeRig(),
      b = makeRig();
    const target = sampleReviewMotionScenario('acceleration', 0.8).motion;
    basePose(a, target);
    applyReviewPlayerMotion(a, target);
    const expected = BONES.map((name) => a.bones[name].quaternion.clone());
    const otherBefore = BONES.map((name) => b.bones[name].quaternion.clone());
    for (const t of [1.7, 0.1, 0.9]) {
      const input = sampleReviewMotionScenario('plantedTurn', t).motion;
      basePose(a, input);
      applyReviewPlayerMotion(a, input);
    }
    basePose(a, target);
    applyReviewPlayerMotion(a, target);
    BONES.forEach((name, i) => {
      expect(a.bones[name].quaternion.angleTo(expected[i])).toBeLessThan(1e-7);
      expect(b.bones[name].quaternion.angleTo(otherBefore[i])).toBeLessThan(1e-7);
    });
    a.dispose();
    b.dispose();
  });

  it('blends released run into kick offsets and settles without moving protected contacts', () => {
    const rig = makeRig(),
      state = createReviewMotionState();
    const run = { kind: 'run' as const, time: 2, phase: 0.23, speed: 4, acceleration: -4 };
    basePose(rig, run);
    applyReviewPlayerMotion(rig, { ...run, motionState: state, deltaSeconds: 1 / 60 });
    const outgoing = state.posture.spine![0];
    const kickInput = { kind: 'kick' as const, time: 0, phase: 0, speed: 0 };
    basePose(rig, kickInput);
    const protectedBefore = protectedBones.map((name) => world(rig, name));
    applyReviewPlayerMotion(rig, { ...kickInput, motionState: state, deltaSeconds: 0 });
    expect(state.posture.spine![0]).toBe(outgoing);
    protectedBones.forEach((name, i) =>
      expect(matrixError(world(rig, name), protectedBefore[i])).toBeLessThan(1e-12)
    );
    for (let frame = 1; frame <= 12; frame++) {
      const input = { ...kickInput, time: frame / 60 };
      basePose(rig, input);
      applyReviewPlayerMotion(rig, { ...input, motionState: state, deltaSeconds: 1 / 60 });
    }
    expect(state.posture.spine![0]).toBeCloseTo(
      sampleReviewPlayerPosture({ ...kickInput, time: 0.2 }).spine![0],
      12
    );
    resetReviewMotionState(state);
    expect(state.kind).toBeUndefined();
    expect(state.posture).toEqual({});
    rig.dispose();
  });

  it('discards locomotion transition history at the exact keeper interception', () => {
    const rig = makeRig(),
      state = createReviewMotionState();
    const run = { kind: 'run' as const, time: 2, phase: 0.2, speed: 4, turn: 1 };
    basePose(rig, run);
    applyReviewPlayerMotion(rig, { ...run, motionState: state });
    const input = { kind: 'keeperDive' as const, time: DIVE_CONTACT, phase: 0, speed: 0 };
    basePose(rig, input);
    const before = BONES.map((name) => world(rig, name));
    applyReviewPlayerMotion(rig, { ...input, motionState: state, deltaSeconds: 1 / 60 });
    BONES.forEach((name, i) =>
      expect(matrixError(world(rig, name), before[i])).toBeLessThan(1e-12)
    );
    for (const angles of Object.values(state.posture))
      for (const value of angles) expect(value).toBe(0);
    rig.dispose();
  });

  it('filters turn and brake effort by elapsed seconds and clears history for still motion', () => {
    const a = makeRig(),
      b = makeRig();
    const states = [createReviewMotionState(), createReviewMotionState()];
    for (let i = 0; i < 2; i++) {
      const rig = i ? b : a,
        state = states[i],
        frames = i ? 24 : 12;
      const input = { kind: 'run' as const, time: 0, phase: 0.2, speed: 3 };
      basePose(rig, input);
      applyReviewPlayerMotion(rig, { ...input, motionState: state, deltaSeconds: 0 });
      for (let frame = 0; frame < frames; frame++) {
        basePose(rig, input);
        applyReviewPlayerMotion(rig, {
          ...input,
          acceleration: -4,
          turn: 1,
          motionState: state,
          deltaSeconds: 0.2 / frames,
        });
      }
    }
    expect(states[0].acceleration).toBeCloseTo(states[1].acceleration, 12);
    expect(states[0].turn).toBeCloseTo(states[1].turn, 12);
    applyReviewPlayerMotion(a, {
      kind: 'run',
      time: 1,
      phase: 0.2,
      speed: 3,
      reducedMotion: true,
      motionState: states[0],
    });
    expect(states[0].kind).toBeUndefined();
    expect(states[1].kind).toBe('run');
    a.dispose();
    b.dispose();
  });

  it('uses a fixed 5-degree outward outfield rest after each reduced base pose, preserving root/feet', () => {
    const rig = makeRig(),
      state = createReviewMotionState();
    const rest = sampleReviewPlayerPosture({ kind: 'idle', time: 0, phase: 0, speed: 0 });
    expect(rest.upperArmL![2]).toBeCloseTo((5 * Math.PI) / 180, 12);
    expect(rest.upperArmR![2]).toBeCloseTo((-5 * Math.PI) / 180, 12);
    poseIdle(rig, 0);
    const before = BONES.map((name) => rig.bones[name].quaternion.clone());
    const feet = protectedBones.map((name) => world(rig, name));
    const root = rig.root.matrixWorld.clone();
    applyReviewPlayerMotion(rig, {
      kind: 'idle',
      time: 10,
      phase: 0.7,
      speed: 4,
      reducedMotion: true,
      motionState: state,
    });
    BONES.forEach((name, i) => {
      const angle = rig.bones[name].quaternion.angleTo(before[i]);
      if (name === 'upperArmL' || name === 'upperArmR')
        expect(angle).toBeCloseTo((5 * Math.PI) / 180, 10);
      else expect(angle).toBeLessThan(1e-7);
    });
    protectedBones.forEach((name, i) =>
      expect(matrixError(world(rig, name), feet[i])).toBeLessThan(1e-12)
    );
    expect(matrixError(rig.root.matrixWorld, root)).toBeLessThan(1e-12);
    const fixed = BONES.map((name) => rig.bones[name].quaternion.clone());
    for (const time of [0, 0.1, 1, 7, 20]) {
      poseRun(rig, 0.4, 4); // A prior moving pose must not leak into the reduced reset.
      poseIdle(rig, 0); // Production samples a fresh fixed base before the adapter.
      applyReviewPlayerMotion(rig, {
        kind: 'run',
        time,
        phase: time,
        speed: 4,
        reducedMotion: true,
        motionState: state,
      });
      BONES.forEach((name, i) =>
        expect(rig.bones[name].quaternion.angleTo(fixed[i])).toBeLessThan(1e-7)
      );
    }
    expect(state.kind).toBeUndefined();
    rig.dispose();
  });

  it('bypasses resting-arm offsets for keeper contacts and preserves zero-weight poses', () => {
    const rig = makeRig();
    for (const kind of ['keeperReady', 'keeperDive'] as const) {
      const input = { kind, time: DIVE_CONTACT, phase: 0, speed: 0 };
      basePose(rig, input);
      const before = BONES.map((name) => world(rig, name));
      applyReviewPlayerMotion(rig, { ...input, reducedMotion: true });
      BONES.forEach((name, i) =>
        expect(matrixError(world(rig, name), before[i])).toBeLessThan(1e-12)
      );
    }
    poseRun(rig, 0.2, 4);
    const before = BONES.map((name) => world(rig, name));
    applyReviewPlayerMotion(rig, {
      kind: 'run',
      time: 0.4,
      phase: 0.2,
      speed: 4,
      acceleration: 4,
      weight: 0,
    });
    BONES.forEach((name, i) => expect(matrixError(world(rig, name), before[i])).toBe(0));
    applyReviewPlayerMotion(rig, {
      kind: 'idle',
      time: 0,
      phase: 0,
      speed: 0,
      weight: 0,
      reducedMotion: true,
    });
    BONES.forEach((name, i) => expect(matrixError(world(rig, name), before[i])).toBe(0));
    rig.dispose();
  });
});

describe('deterministic diagnostic motion paths', () => {
  it('advances through a moving planted turn with velocity aligned to heading and phase tied to distance', () => {
    const a = makeRig(),
      b = makeRig(),
      plantsA: RunPlant = {},
      plantsB: RunPlant = {};
    let contacts = 0;
    for (let frame = 0; frame <= 312; frame++) {
      const t = frame / 120,
        sample = sampleReviewMotionScenario('plantedTurn', t);
      const next = sampleReviewMotionScenario('plantedTurn', t + 1e-5);
      if (t > 0.61 && t < 1.99) {
        expect(
          Math.hypot(next.position.x - sample.position.x, next.position.z - sample.position.z)
        ).toBeGreaterThan(0.00002);
        expect(
          Math.atan2(next.position.x - sample.position.x, next.position.z - sample.position.z)
        ).toBeCloseTo(sample.heading, 4);
        expect(next.phase).toBeGreaterThan(sample.phase);
      }
      for (const rig of [a, b]) {
        rig.root.position.set(sample.position.x, 0, sample.position.z);
        rig.root.rotation.y = sample.heading;
        poseRun(rig, sample.phase, sample.speed);
      }
      applyReviewPlayerMotion(a, sample.motion);
      plantRunFeet(a, sample.phase, sample.speed, plantsA);
      plantRunFeet(b, sample.phase, sample.speed, plantsB);
      for (const side of ['L', 'R'] as const) {
        expect(matrixError(world(a, `foot${side}`), world(b, `foot${side}`))).toBeLessThan(1e-10);
        const pa = plantsA[side],
          pb = plantsB[side];
        expect(!!pa).toBe(!!pb);
        if (pa && pb) {
          expect(pa.anchor.distanceTo(pb.anchor)).toBeLessThan(1e-12);
          expect(pa.phase).toBe(pb.phase);
          expect(pa.yaw).toBe(pb.yaw);
          contacts++;
        }
      }
    }
    expect(contacts).toBeGreaterThan(100);
    a.dispose();
    b.dispose();
  });

  for (const scenario of ['jog', 'acceleration', 'deceleration'] as const)
    it(`integrates real travel and cadence without a frame-step accumulator (${scenario})`, () => {
      for (const t of [0.1, 0.5, 1.2, 2.1]) {
        const a = sampleReviewMotionScenario(scenario, t),
          b = sampleReviewMotionScenario(scenario, t + 1e-5);
        expect((b.distance - a.distance) / 1e-5).toBeCloseTo(a.speed, 3);
        expect((b.phase - a.phase) / 1e-5).toBeCloseTo(1.45 + 0.085 * a.speed, 3);
        expect(a.position.z).toBe(a.distance);
        expect(sampleReviewMotionScenario(scenario, t)).toEqual(a);
      }
    });
});

const fingerNames = BONES.filter((name) => /^(thumb|index|middle|ring|pinky)[123][LR]$/.test(name));
describe('review-only anatomical hand gestures', () => {
  it('keeps weighted palm contacts and all nonfinger transforms intact while moving real fingers on one rig', async () => {
    const parsed = await new GLTFLoader().parseAsync(
      Uint8Array.from(readFileSync('public/models/football/player-body-high.glb')).buffer,
      ''
    );
    let geometry!: THREE.BufferGeometry;
    parsed.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) geometry = o.geometry;
    });
    const material = new THREE.MeshBasicMaterial(),
      a = createRig(material, geometry),
      b = createRig(material, geometry);
    try {
      const position = geometry.getAttribute('position'),
        skin = geometry.getAttribute('skinIndex'),
        weight = geometry.getAttribute('skinWeight');
      const originalPositions = position.array.slice();
      const palms: number[] = [],
        fingers: number[] = [];
      for (let i = 0; i < position.count; i++) {
        let palmWeight = 0,
          fingerWeight = 0;
        for (let k = 0; k < 4; k++) {
          const name = BONES[skin.getComponent(i, k)],
            w = weight.getComponent(i, k);
          if (/^hand[LR]$/.test(name)) palmWeight += w;
          if (/^(thumb|index|middle|ring|pinky)/.test(name)) fingerWeight += w;
        }
        if (palmWeight > 0.3 && fingerWeight < 1e-6) palms.push(i);
        if (fingerWeight > 0.5) fingers.push(i);
      }
      expect(palms.length).toBeGreaterThan(10);
      expect(fingers.length).toBeGreaterThan(1000);
      for (const scale of [0.96, 1.04]) {
        for (const rig of [a, b]) {
          rig.root.scale.setScalar(scale);
          rig.root.rotation.y = 0.73;
          poseRun(rig, 0.23, 4);
          rig.root.updateMatrixWorld(true);
          rig.skeleton.update();
        }
        const fixedNames = BONES.filter((name) => !fingerNames.includes(name));
        const fixedBefore = fixedNames.map((name) => world(a, name));
        const otherBefore = BONES.map((name) => world(b, name));
        const palmBefore = palms.map((i) => a.mesh.getVertexPosition(i, new THREE.Vector3()));
        const sample = fingers.filter((_, i) => i % 23 === 0);
        const fingerBefore = sample.map((i) => a.mesh.getVertexPosition(i, new THREE.Vector3()));
        poseReviewPlayerHands(a, 'run', true, 0.25);
        a.root.updateMatrixWorld(true);
        a.skeleton.update();
        fixedNames.forEach((name, i) =>
          expect(matrixError(world(a, name), fixedBefore[i])).toBeLessThan(1e-12)
        );
        BONES.forEach((name, i) =>
          expect(matrixError(world(b, name), otherBefore[i])).toBeLessThan(1e-12)
        );
        let palmError = 0;
        palms.forEach(
          (i, j) =>
            (palmError = Math.max(
              palmError,
              a.mesh.getVertexPosition(i, new THREE.Vector3()).distanceTo(palmBefore[j])
            ))
        );
        expect(palmError).toBeLessThan(1e-10);
        const movement = sample.map((i, j) =>
          a.mesh.getVertexPosition(i, new THREE.Vector3()).distanceTo(fingerBefore[j])
        );
        expect(movement.every(Number.isFinite)).toBe(true);
        expect(Math.max(...movement)).toBeGreaterThan(0.005);
        expect(Math.max(...movement)).toBeLessThan(0.08);
      }
      expect(position.array).toEqual(originalPositions);
    } finally {
      a.dispose();
      b.dispose();
      material.dispose();
      parsed.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
        if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
      });
    }
  });

  it('uses a relaxed digit cascade and opposed thumbs, opens keeper fingers and freezes reduced-motion hands', () => {
    const rig = makeRig();
    try {
      const bend = (name: (typeof BONES)[number]) =>
        Math.abs(new THREE.Euler().setFromQuaternion(rig.bones[name].quaternion).x);
      poseReviewPlayerHands(rig, 'idle', true);
      for (const side of ['L', 'R'] as const) {
        const pip = (['index', 'middle', 'ring', 'pinky'] as const).map((finger) =>
          bend(`${finger}2${side}`)
        );
        for (let i = 1; i < pip.length; i++) expect(pip[i]).toBeGreaterThan(pip[i - 1]);
        for (const finger of ['index', 'middle', 'ring', 'pinky'] as const) {
          expect(bend(`${finger}2${side}`)).toBeGreaterThan(bend(`${finger}1${side}`));
          expect(bend(`${finger}2${side}`)).toBeGreaterThan(bend(`${finger}3${side}`));
        }
      }
      const left = new THREE.Euler().setFromQuaternion(rig.bones.thumb1L.quaternion);
      const right = new THREE.Euler().setFromQuaternion(rig.bones.thumb1R.quaternion);
      expect(left.y).toBeGreaterThan(0.15);
      expect(right.y).toBeLessThan(-0.15);
      for (const kind of ['keeperReady', 'keeperDive'] as const) {
        poseReviewPlayerHands(rig, kind, true);
        for (const side of ['L', 'R'] as const) expect(bend(`index2${side}`)).toBeLessThan(0.06);
      }
      poseReviewPlayerHands(rig, 'run', false, 0);
      const resting = fingerNames.map((name) => rig.bones[name].quaternion.clone());
      for (const phase of [0.1, 0.37, 0.8, 20.2]) {
        poseReviewPlayerHands(rig, 'run', false, phase);
        fingerNames.forEach((name, i) => {
          const q = rig.bones[name].quaternion;
          expect(q.toArray().every(Number.isFinite)).toBe(true);
          expect(q.angleTo(resting[i])).toBeLessThan(1e-7);
        });
      }
    } finally {
      rig.dispose();
      (rig.mesh.material as THREE.Material).dispose();
    }
  });
});

describe('continuous finishing diagnostic journey', () => {
  it('joins moving paths, heading, travel and cadence continuously through the settled kick', () => {
    const epsilon = 1e-7;
    for (const t of REVIEW_FINISHING_JOINS) {
      const a = sampleReviewFinishingSequence(t - epsilon),
        b = sampleReviewFinishingSequence(t + epsilon);
      expect(new THREE.Vector3().copy(a.position).distanceTo(b.position)).toBeLessThan(1e-5);
      expect(Math.abs(a.heading - b.heading)).toBeLessThan(1e-6);
      expect(Math.abs(a.speed - b.speed)).toBeLessThan(1e-5);
      expect(Math.abs(a.distance - b.distance)).toBeLessThan(1e-5);
      expect(Math.abs(a.phase - b.phase)).toBeLessThan(1e-5);
    }
    for (const t of [0.2, 1.2, 2.2, 3.2, 3.8, 4.8, 5.6, 6, 6.15]) {
      const a = sampleReviewFinishingSequence(t),
        b = sampleReviewFinishingSequence(t + 1e-6);
      expect((b.distance - a.distance) / 1e-6).toBeCloseTo(a.speed, 4);
      expect((b.phase - a.phase) / 1e-6).toBeCloseTo(a.speed / strideLength(a.speed), 4);
      const dx = b.position.x - a.position.x,
        dz = b.position.z - a.position.z;
      expect(Math.hypot(dx, dz) / 1e-6).toBeCloseTo(a.speed, 4);
      expect(Math.atan2(dx, dz)).toBeCloseTo(a.heading, 4);
      expect(a.motion.kind).toBe('run');
      expect(a.speed).toBeGreaterThan(0);
    }
  });

  it('keeps a genuine moving ninety-degree turn and exact existing kick root/contact clock', () => {
    for (const t of [3.1, 3.5, 4.1]) {
      const a = sampleReviewFinishingSequence(t),
        b = sampleReviewFinishingSequence(t + 0.01);
      expect(a.speed).toBeGreaterThan(4);
      expect(b.heading).toBeGreaterThan(a.heading);
      expect(b.distance - a.distance).toBeGreaterThan(0.04);
    }
    const idle = sampleReviewFinishingSequence(6.5),
      start = sampleReviewFinishingSequence(6.8);
    const contact = sampleReviewFinishingSequence(6.8 + KICK.contact);
    expect(idle.motion.kind).toBe('idle');
    expect(idle.speed).toBe(0);
    expect(start.motion.kind).toBe('kick');
    expect(start.motion.time).toBe(0);
    expect(contact.motion.time).toBeCloseTo(0.3, 12);
    expect(contact.heading).toBe(Math.PI / 2);
    for (const t of [6.8, 7.1, REVIEW_FINISHING_DURATION]) {
      const sample = sampleReviewFinishingSequence(t),
        root = kickGeometry(sample.kickSpec!).root;
      expect(root.distanceTo(new THREE.Vector3().copy(sample.position))).toBeLessThan(1e-12);
      expect(sample.position).toEqual(idle.position);
      expect(sample.distance).toBe(idle.distance);
      expect(sample.phase).toBe(idle.phase);
    }
    expect(sampleReviewFinishingSequence(100)).toEqual(
      sampleReviewFinishingSequence(REVIEW_FINISHING_DURATION)
    );
  });
});

describe('original review-only key-pose study', () => {
  it('retains explicit editable poses and unchanged authority markers without body-root/leg tracks', () => {
    expect(REVIEW_AUTHORED_POSE_STUDY.markers).toEqual({
      kickContact: KICK.contact,
      kickThrough: KICK.through,
      kickDuration: KICK.duration,
    });
    expect(REVIEW_AUTHORED_POSE_STUDY.origin).toContain('No imported action');
    const allowed = new Set([
      'spine',
      'chest',
      'neck',
      'head',
      'upperArmL',
      'foreArmL',
      'handL',
      'upperArmR',
      'foreArmR',
      'handR',
    ]);
    for (const clip of Object.values(poseStudy.clips)) {
      expect(clip.keys[0].time).toBe(0);
      expect(clip.keys.at(-1)!.time).toBe(clip.duration);
      clip.keys.forEach((key, i) => {
        if (i) expect(key.time).toBeGreaterThan(clip.keys[i - 1].time);
        expect(key.intent.length).toBeGreaterThan(5);
        for (const field of ['offsets', 'arms', 'armOffsets'])
          for (const [bone, values] of Object.entries(
            (key as unknown as Record<string, unknown>)[field] ?? {}
          )) {
            expect(allowed.has(bone)).toBe(true);
            expect((values as number[]).every(Number.isFinite)).toBe(true);
          }
      });
    }
  });

  it('replaces exaggerated shared arm carriage with intentional compact key poses on one actor', () => {
    const rig = makeRig();
    try {
      const input = { kind: 'run' as const, time: 0, phase: 0, speed: 4.4 };
      basePose(rig, input);
      const before = Math.abs(
        new THREE.Euler().setFromQuaternion(rig.bones.upperArmR.quaternion).x
      );
      const fixed = protectedBones.map((bone) => world(rig, bone));
      applyReviewPlayerMotion(rig, input);
      const after = Math.abs(new THREE.Euler().setFromQuaternion(rig.bones.upperArmR.quaternion).x);
      expect(after).toBeLessThan(before - 0.1);
      const authored = sampleReviewArmTargets(input);
      expect(authored.upperArmR![0]).toBeCloseTo(THREE.MathUtils.degToRad(-24), 12);
      expect(
        rig.bones.upperArmR.quaternion.angleTo(
          new THREE.Quaternion().setFromEuler(new THREE.Euler(...authored.upperArmR!))
        )
      ).toBeLessThan(1e-7);
      protectedBones.forEach((bone, i) =>
        expect(matrixError(world(rig, bone), fixed[i])).toBeLessThan(1e-12)
      );
    } finally {
      rig.dispose();
    }
  });

  it('retains the accepted outward idle arm clearance and bent elbows in the absolute source', () => {
    const rig = makeRig();
    try {
      poseIdle(rig, 0);
      const expected = (['L', 'R'] as const).map((side) =>
        rig.bones[`upperArm${side}`].quaternion
          .clone()
          .multiply(
            new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(0, 0, 1),
              THREE.MathUtils.degToRad(side === 'L' ? 5 : -5)
            )
          )
      );
      applyReviewPlayerMotion(rig, { kind: 'idle', time: 0, phase: 0, speed: 0 });
      (['L', 'R'] as const).forEach((side, i) =>
        expect(rig.bones[`upperArm${side}`].quaternion.angleTo(expected[i])).toBeLessThan(1e-7)
      );
      expect(new THREE.Euler().setFromQuaternion(rig.bones.foreArmL.quaternion).x).toBeCloseTo(
        THREE.MathUtils.degToRad(-17),
        12
      );
      expect(new THREE.Euler().setFromQuaternion(rig.bones.foreArmR.quaternion).x).toBeCloseTo(
        THREE.MathUtils.degToRad(-18),
        12
      );
    } finally {
      rig.dispose();
    }
  });

  it('keeps authored locomotion cycle position and tangent continuity at its seam', () => {
    const epsilon = 1e-5;
    const sample = (phase: number) =>
      sampleReviewArmTargets({
        kind: 'run',
        time: 0,
        phase,
        speed: 2.4,
        acceleration: 1.2,
        turn: 0.5,
      });
    const a = sample(-epsilon),
      b = sample(0),
      c = sample(epsilon);
    for (const name of Object.keys(b) as Array<keyof typeof b>)
      for (let axis = 0; axis < 3; axis++) {
        expect(Math.abs(a[name]![axis] - c[name]![axis])).toBeLessThan(0.0002);
        const incoming = (b[name]![axis] - a[name]![axis]) / epsilon;
        const outgoing = (c[name]![axis] - b[name]![axis]) / epsilon;
        expect(Math.abs(incoming - outgoing)).toBeLessThan(0.02);
      }
  });

  it('blends absolute arm targets on run-to-kick without a target snap or hidden phase advancement', () => {
    const rig = makeRig(),
      state = createReviewMotionState();
    try {
      const run = { kind: 'run' as const, time: 1, phase: 0.23, speed: 4.4 };
      basePose(rig, run);
      applyReviewPlayerMotion(rig, { ...run, motionState: state, deltaSeconds: 0 });
      const names = ['upperArmL', 'foreArmL', 'handL', 'upperArmR', 'foreArmR', 'handR'] as const;
      const outgoing = names.map((name) => rig.bones[name].quaternion.clone());
      const kickInput = { kind: 'kick' as const, time: 0, phase: 0, speed: 0 };
      basePose(rig, kickInput);
      applyReviewPlayerMotion(rig, { ...kickInput, motionState: state, deltaSeconds: 0 });
      names.forEach((name, i) =>
        expect(rig.bones[name].quaternion.angleTo(outgoing[i])).toBeLessThan(1e-7)
      );
      for (let frame = 1; frame <= 12; frame++) {
        const input = { ...kickInput, time: frame / 60 };
        basePose(rig, input);
        applyReviewPlayerMotion(rig, { ...input, motionState: state, deltaSeconds: 1 / 60 });
      }
      const expected = sampleReviewArmTargets({ ...kickInput, time: 0.2 });
      names.forEach((name) =>
        expect(
          rig.bones[name].quaternion.angleTo(
            new THREE.Quaternion().setFromEuler(new THREE.Euler(...expected[name]!))
          )
        ).toBeLessThan(1e-7)
      );
      resetReviewMotionState(state);
      expect(state.arms).toEqual({});
      expect(state.outgoingArms).toEqual({});
    } finally {
      rig.dispose();
    }
  });

  it('samples distinct authored hands at run phase and the released kick clock, with bilateral mirroring', () => {
    const a = makeRig(),
      b = makeRig();
    try {
      const nonFinger = BONES.filter((name) => !fingerNames.includes(name));
      const fixed = nonFinger.map((name) => world(a, name));
      poseReviewPlayerHands(a, 'run', true, 0);
      const before = a.bones.index2L.quaternion.clone();
      poseReviewPlayerHands(a, 'run', true, 0.5);
      expect(a.bones.index2L.quaternion.angleTo(before)).toBeGreaterThan(0.04);
      poseReviewPlayerHands(a, 'kick', true, 0.77, { time: 0.3, direction: 1 });
      poseReviewPlayerHands(b, 'kick', true, 0.01, { time: 0.3, direction: -1 });
      for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky'] as const)
        for (const joint of [1, 2, 3] as const) {
          const q = b.bones[`${finger}${joint}R`].quaternion;
          expect(
            a.bones[`${finger}${joint}L`].quaternion.angleTo(
              new THREE.Quaternion(q.x, -q.y, -q.z, q.w)
            )
          ).toBeLessThan(1e-7);
        }
      const contact = a.bones.index2L.quaternion.clone();
      poseReviewPlayerHands(a, 'kick', true, 0.77, { time: 0, direction: 1 });
      expect(a.bones.index2L.quaternion.angleTo(contact)).toBeGreaterThan(0.04);
      nonFinger.forEach((name, i) =>
        expect(matrixError(world(a, name), fixed[i])).toBeLessThan(1e-12)
      );
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('keeps reduced-motion hand channels fixed regardless of action clock, phase or side', () => {
    const rig = makeRig();
    try {
      poseReviewPlayerHands(rig, 'kick', false, 0, { time: 0, direction: 1 });
      const expected = fingerNames.map((name) => rig.bones[name].quaternion.clone());
      for (const time of [0.1, 0.3, 0.34, 0.85, 20]) {
        poseReviewPlayerHands(rig, 'kick', false, time, { time, direction: -1 });
        fingerNames.forEach((name, i) =>
          expect(rig.bones[name].quaternion.angleTo(expected[i])).toBeLessThan(1e-7)
        );
      }
    } finally {
      rig.dispose();
    }
  });
});
