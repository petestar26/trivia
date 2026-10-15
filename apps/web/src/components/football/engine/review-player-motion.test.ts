import * as THREE from 'three';
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
} from './poses';
import {
  applyReviewPlayerMotion,
  poseReviewPlayerHands,
  REVIEW_MOTION_SCENARIOS,
  sampleReviewMotionScenario,
  sampleReviewPlayerPosture,
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

  it('leaves every bone unchanged under reduced motion or zero weight', () => {
    const rig = makeRig();
    poseRun(rig, 0.2, 4);
    const before = BONES.map((name) => world(rig, name));
    for (const options of [{ reducedMotion: true }, { weight: 0 }]) {
      applyReviewPlayerMotion(rig, {
        kind: 'run',
        time: 0.4,
        phase: 0.2,
        speed: 4,
        acceleration: 4,
        ...options,
      });
      BONES.forEach((name, i) => expect(matrixError(world(rig, name), before[i])).toBe(0));
    }
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
