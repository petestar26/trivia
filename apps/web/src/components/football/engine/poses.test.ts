import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  blendTo,
  capture,
  DIVE_CONTACT,
  DIVE_DURATION,
  diveRoot,
  KICK,
  kickGeometry,
  poseCelebrate,
  poseIdle,
  poseKeeperDive,
  poseKeeperReady,
  poseKick,
  poseRun,
  STANCE_ANKLE,
  stanceDuty,
  strideLength,
} from './poses';
import { BONES, createRig, DIM, humanGeometry, kitFromClub, lookGeometry, type Rig } from './rig';

function makeRig(): Rig {
  const look = lookGeometry({
    kit: kitFromClub({ primary: '#ff0000', secondary: '#ffffff', pattern: 'solid' }),
    skin: '#d99c73',
    hair: '#222222',
  });
  return createRig(new THREE.MeshBasicMaterial(), look.geometry);
}
const wp = (rig: Rig, name: (typeof BONES)[number]) =>
  rig.bones[name].getWorldPosition(new THREE.Vector3());
const finite = (rig: Rig) =>
  BONES.every(
    (n) =>
      rig.bones[n].quaternion.toArray().every(Number.isFinite) &&
      rig.bones[n].position.toArray().every(Number.isFinite)
  );

describe('skinned body', () => {
  it('has one shared geometry, correct skin data, and per-player skeletons', () => {
    const a = makeRig();
    const b = makeRig();
    const geo = humanGeometry().geometry;
    expect(geo.getAttribute('skinIndex').count).toBe(geo.getAttribute('position').count);
    const weights = geo.getAttribute('skinWeight');
    for (let i = 0; i < weights.count; i++) {
      const sum = weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i);
      expect(sum).toBeCloseTo(1, 4);
    }
    const index = geo.getAttribute('skinIndex');
    for (let i = 0; i < index.count; i++)
      for (const v of [index.getX(i), index.getY(i), index.getZ(i), index.getW(i)])
        expect(v).toBeLessThan(BONES.length);
    expect(a.skeleton).not.toBe(b.skeleton);
    expect(a.bones.hips).not.toBe(b.bones.hips);
    // Posing one rig must not move the other.
    a.root.position.set(5, 0, 0);
    poseRun(a, 0.3, 6);
    poseIdle(b, 0);
    expect(wp(b, 'footL').x).toBeCloseTo(0.12, 2);
    expect(geo.getAttribute('position').count).toBeLessThan(2500);
    a.dispose();
    b.dispose();
  });

  it('keeps the standing figure about 1.8 m tall with realistic limb proportions', () => {
    const rig = makeRig();
    poseIdle(rig, 0);
    const box = new THREE.Box3().setFromObject(rig.root);
    void box;
    const head = wp(rig, 'head').y + 0.2; // head bone to the crown
    expect(head).toBeGreaterThan(1.7);
    expect(head).toBeLessThan(1.9);
    expect(wp(rig, 'footL').y).toBeCloseTo(STANCE_ANKLE, 2);
    expect(DIM.thigh + DIM.shin).toBeGreaterThan(0.8);
    rig.dispose();
  });
});

describe('running', () => {
  // Stud contact points (heel and forefoot). A stud that is on the turf in two consecutive
  // frames is planted and must not move in the world while the body travels over it. (A point
  // rolling up at push-off moves at r*omega, which is lift-off, not sliding.)
  const soles = [new THREE.Vector3(0, -0.07, -0.07), new THREE.Vector3(0, -0.068, 0.15)];
  const solePoints = (rig: Rig, side: 'L' | 'R') => {
    const foot = rig.bones[`foot${side}`];
    foot.updateWorldMatrix(true, false);
    return soles.map((p) => p.clone().applyMatrix4(foot.matrixWorld));
  };
  for (const speed of [2.5, 4.5, 7, 9]) {
    it(`plants stance feet without sliding and never penetrates the turf at ${speed} m/s`, () => {
      const rig = makeRig();
      const L = strideLength(speed);
      const D = stanceDuty(speed);
      const dt = 1 / 120;
      let phase = 0.13;
      let z = 0;
      const prev: Record<'L' | 'R', THREE.Vector3[]> = { L: [], R: [] };
      let slip = 0;
      let grounded = 0;
      let stanceFrames = 0;
      let minSole = 9;
      let swingMax = 0;
      let liftedFrames = 0;
      for (let step = 0; step < 120 * 4; step++) {
        z += speed * dt;
        phase += (speed * dt) / L;
        rig.root.position.set(0, 0, z);
        poseRun(rig, phase, speed);
        expect(finite(rig)).toBe(true);
        for (const side of ['L', 'R'] as const) {
          const now = solePoints(rig, side);
          minSole = Math.min(minSole, ...now.map((p) => p.y));
          const p = (((phase + (side === 'L' ? 0 : 0.5)) % 1) + 1) % 1;
          const inStance = p > 0.08 * D && p < 0.92 * D;
          if (step > 0 && inStance) {
            stanceFrames++;
            if (Math.min(...now.map((q) => q.y)) > 0.03) liftedFrames++;
            now.forEach((q, i) => {
              const before = prev[side][i];
              // On the turf and not rising (a rising stud is lifting off, not sliding).
              if (before && q.y < 0.006 && before.y < 0.006 && q.y <= before.y + 0.0003) {
                slip = Math.max(slip, Math.hypot(q.x - before.x, q.z - before.z) / dt);
                grounded++;
              }
            });
          }
          if (p > D + 0.3 * (1 - D) && p < D + 0.7 * (1 - D))
            swingMax = Math.max(swingMax, Math.min(...now.map((q) => q.y)));
          prev[side] = now;
        }
      }
      expect(stanceFrames).toBeGreaterThan(80);
      expect(grounded, 'no sole point reached the turf in stance').toBeGreaterThan(
        stanceFrames * 0.4
      );
      expect(slip, `max planted-boot speed ${slip.toFixed(3)} m/s`).toBeLessThan(
        0.1 * speed + 0.15
      );
      expect(liftedFrames / stanceFrames, 'boot floating above the turf in stance').toBeLessThan(
        0.1
      );
      expect(minSole, 'boot pushed through the turf').toBeGreaterThan(-0.03);
      expect(swingMax).toBeGreaterThan(0.08);
      rig.dispose();
    });
  }

  it('bends the knees forward and keeps every segment rigid', () => {
    const rig = makeRig();
    for (let i = 0; i < 40; i++) {
      poseRun(rig, i / 40, 5);
      for (const side of ['L', 'R'] as const) {
        const hip = wp(rig, `upperLeg${side}`);
        const knee = wp(rig, `lowerLeg${side}`);
        const ankle = wp(rig, `foot${side}`);
        expect(hip.distanceTo(knee)).toBeCloseTo(DIM.thigh, 3);
        expect(knee.distanceTo(ankle)).toBeCloseTo(DIM.shin, 3);
        const mid = hip.clone().add(ankle).multiplyScalar(0.5);
        expect(knee.z - mid.z).toBeGreaterThanOrEqual(-0.005);
      }
      const shoulder = wp(rig, 'upperArmL');
      expect(shoulder.distanceTo(wp(rig, 'foreArmL'))).toBeCloseTo(DIM.upperArm, 3);
    }
    rig.dispose();
  });

  it('moves arms contralaterally to the legs and leans forward more at speed', () => {
    const rig = makeRig();
    poseRun(rig, 0, 6);
    const leftFoot = wp(rig, 'footL').z;
    const rightFoot = wp(rig, 'footR').z;
    const leftHand = wp(rig, 'handL').z;
    const rightHand = wp(rig, 'handR').z;
    // The leg that is ahead has the opposite arm ahead.
    expect(Math.sign(leftFoot - rightFoot)).toBe(Math.sign(rightHand - leftHand));
    poseRun(rig, 0.2, 2);
    const slow = wp(rig, 'head').z - wp(rig, 'hips').z;
    poseRun(rig, 0.2, 9);
    const fast = wp(rig, 'head').z - wp(rig, 'hips').z;
    expect(fast).toBeGreaterThan(slow);
    rig.dispose();
  });

  it('follows the heading: the same pose rotated stays consistent', () => {
    const a = makeRig();
    const b = makeRig();
    poseRun(a, 0.37, 5);
    b.root.rotation.y = Math.PI / 2;
    poseRun(b, 0.37, 5);
    const fa = wp(a, 'footL');
    const fb = wp(b, 'footL');
    expect(fb.x).toBeCloseTo(fa.z, 3);
    expect(fb.z).toBeCloseTo(-fa.x, 3);
    a.dispose();
    b.dispose();
  });
});

describe('kicking', () => {
  const spec = (foot: 'L' | 'R', power = 1, loft = 0) => ({
    ball: new THREE.Vector3(2, DIM.ballRadius, 3),
    dir: new THREE.Vector3(1, 0, 0),
    foot,
    power,
    loft,
  });
  for (const foot of ['R', 'L'] as const) {
    it(`brings the ${foot} boot to the ball at contact with the plant foot fixed`, () => {
      const rig = makeRig();
      const s = spec(foot);
      const { root, plant } = kickGeometry(s);
      rig.root.position.copy(root);
      rig.root.rotation.y = Math.atan2(s.dir.x, s.dir.z);
      const other = foot === 'R' ? 'L' : 'R';
      const plantPositions: THREE.Vector3[] = [];
      let tracked = new THREE.Vector3();
      for (let t = 0; t <= KICK.duration; t += 0.01) {
        poseKick(rig, t, s);
        expect(finite(rig)).toBe(true);
        plantPositions.push(wp(rig, `foot${other}`));
        const ankleY = wp(rig, `foot${foot}`).y;
        expect(ankleY).toBeGreaterThan(0.06);
        if (Math.abs(t - KICK.contact) < 0.006) tracked = wp(rig, `toe${foot}`);
      }
      for (const p of plantPositions)
        expect(p.distanceTo(plant), 'plant foot moved').toBeLessThan(0.03);
      // The toe passes within a ball radius plus a small margin of the ball centre at contact.
      expect(
        tracked.distanceTo(s.ball),
        `toe ${tracked.toArray().map((v) => v.toFixed(2))}`
      ).toBeLessThan(DIM.ballRadius + 0.1);
      rig.dispose();
    });
  }

  it('swings through the ball: fast, along the kick direction, and faster with more power', () => {
    const speedAt = (power: number) => {
      const rig = makeRig();
      const s = spec('R', power);
      rig.root.position.copy(kickGeometry(s).root);
      rig.root.rotation.y = Math.atan2(s.dir.x, s.dir.z);
      poseKick(rig, KICK.contact - 0.01, s);
      const a = wp(rig, 'toeR');
      poseKick(rig, KICK.contact + 0.01, s);
      const b = wp(rig, 'toeR');
      rig.dispose();
      return { speed: b.distanceTo(a) / 0.02, along: b.clone().sub(a).normalize().dot(s.dir) };
    };
    const hard = speedAt(1);
    const soft = speedAt(0.2);
    expect(hard.speed).toBeGreaterThan(6);
    expect(hard.along).toBeGreaterThan(0.7);
    expect(hard.speed).toBeGreaterThan(soft.speed);
  });

  it('lofted kicks follow through higher than driven ones', () => {
    const height = (loft: number) => {
      const rig = makeRig();
      const s = spec('R', 1, loft);
      rig.root.position.copy(kickGeometry(s).root);
      rig.root.rotation.y = Math.atan2(s.dir.x, s.dir.z);
      poseKick(rig, KICK.duration * 0.95, s);
      const y = wp(rig, 'footR').y;
      rig.dispose();
      return y;
    };
    expect(height(1)).toBeGreaterThan(height(0) + 0.1);
  });
});

describe('goalkeeper', () => {
  it('crouches, dives and reaches the ball at contact, lies on the ground, then recovers', () => {
    const rig = makeRig();
    poseKeeperReady(rig, 0.3);
    expect(wp(rig, 'hips').y).toBeLessThan(0.85);
    const ball = new THREE.Vector3(1.3, 1.1, 0.4);
    const spec = { direction: 1 as const, reach: 1.3, height: 1.1 };
    let atContact = 9;
    let lowest = 9;
    let lyingAt = 0;
    for (let t = 0; t <= DIVE_DURATION + 1e-9; t += 0.02) {
      rig.root.position.copy(diveRoot(spec, t));
      poseKeeperDive(rig, t, spec, ball);
      expect(finite(rig)).toBe(true);
      if (Math.abs(t - DIVE_CONTACT) < 0.011)
        atContact = Math.min(wp(rig, 'handL').distanceTo(ball), wp(rig, 'handR').distanceTo(ball));
      lowest = Math.min(lowest, wp(rig, 'hips').y);
      if (t > 0.9 && t < 1.05) lyingAt = Math.max(lyingAt, wp(rig, 'hips').y);
    }
    expect(atContact, 'hand within reach of the ball at contact').toBeLessThan(0.3);
    expect(lowest).toBeLessThan(0.25);
    expect(lyingAt).toBeLessThan(0.3);
    // Fully recovered at the end: upright and out of the dive.
    expect(wp(rig, 'hips').y).toBeGreaterThan(0.7);
    expect(wp(rig, 'head').y).toBeGreaterThan(1.3);
    rig.dispose();
  });

  it('lies along the dive direction with the head leading', () => {
    const rig = makeRig();
    const spec = { direction: -1 as const, reach: 1.5, height: 0.5 };
    poseKeeperDive(rig, 0.95, spec, new THREE.Vector3(-1.5, 0.5, 0.3));
    expect(wp(rig, 'head').x).toBeLessThan(wp(rig, 'hips').x - 0.4);
    expect(Math.abs(wp(rig, 'head').y - wp(rig, 'hips').y)).toBeLessThan(0.4);
    rig.dispose();
  });
});

describe('celebrations and blending', () => {
  it('raises both hands overhead for the arms-up celebration', () => {
    const rig = makeRig();
    poseCelebrate(rig, 'ARMS_UP', 0.2);
    expect(wp(rig, 'handL').y).toBeGreaterThan(wp(rig, 'head').y);
    expect(wp(rig, 'handR').y).toBeGreaterThan(wp(rig, 'head').y);
    poseCelebrate(rig, 'DEJECTED', 0.2);
    expect(wp(rig, 'head').y).toBeLessThan(1.78);
    poseCelebrate(rig, 'KNEE_SLIDE', 0.2);
    expect(wp(rig, 'hips').y).toBeLessThan(0.7);
    for (const kind of ['ARMS_UP', 'WINGS', 'KNEE_SLIDE', 'LEAP', 'HUG', 'DEJECTED'] as const) {
      for (let t = 0; t < 2; t += 0.1) {
        poseCelebrate(rig, kind, t);
        expect(finite(rig), kind).toBe(true);
      }
    }
    rig.dispose();
  });

  it('blends between two poses and lands exactly on the target', () => {
    const rig = makeRig();
    poseIdle(rig, 0);
    const from = capture(rig);
    poseRun(rig, 0.3, 6);
    const target = BONES.map((n) => rig.bones[n].quaternion.clone());
    blendTo(rig, from, 0);
    BONES.forEach((n, i) => expect(rig.bones[n].quaternion.angleTo(from.q[i])).toBeLessThan(1e-4));
    poseRun(rig, 0.3, 6);
    blendTo(rig, from, 1);
    BONES.forEach((n, i) => expect(rig.bones[n].quaternion.angleTo(target[i])).toBeLessThan(1e-4));
    rig.dispose();
  });
});
