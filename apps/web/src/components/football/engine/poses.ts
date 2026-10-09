import * as THREE from 'three';
import { placeFoot, reachHand } from './ik';
import { BONES, DIM, restPosition, type BoneName, type Rig, type Side } from './rig';

/**
 * Procedural pose solvers. Every function first resets the skeleton to its bind pose, so a
 * pose depends only on its arguments. The caller positions `rig.root` (feet on the ground,
 * rotation.y = heading) before posing. Angles are radians; +Z is forward.
 */
const REST_LOCAL = new Map<BoneName, THREE.Vector3>();
function restLocal(name: BoneName) {
  let v = REST_LOCAL.get(name);
  if (!v) {
    const parent = (
      {
        spine: 'hips',
        chest: 'spine',
        neck: 'chest',
        head: 'neck',
        upperArmL: 'chest',
        foreArmL: 'upperArmL',
        handL: 'foreArmL',
        upperArmR: 'chest',
        foreArmR: 'upperArmR',
        handR: 'foreArmR',
        upperLegL: 'hips',
        lowerLegL: 'upperLegL',
        footL: 'lowerLegL',
        toeL: 'footL',
        upperLegR: 'hips',
        lowerLegR: 'upperLegR',
        footR: 'lowerLegR',
        toeR: 'footR',
      } as Partial<Record<BoneName, BoneName>>
    )[name];
    v = restPosition(name);
    if (parent) v = v.clone().sub(restPosition(parent));
    REST_LOCAL.set(name, v);
  }
  return v;
}
export function resetPose(rig: Rig) {
  for (const name of BONES) {
    rig.bones[name].position.copy(restLocal(name));
    rig.bones[name].quaternion.identity();
  }
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (t: number) => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function begin(rig: Rig) {
  resetPose(rig);
  rig.root.updateMatrixWorld(true);
}
const yawOf = (rig: Rig) => rig.root.rotation.y;
const local = (rig: Rig, x: number, y: number, z: number) =>
  rig.root.localToWorld(new THREE.Vector3(x, y, z));
const sideSign = (side: Side) => (side === 'L' ? 1 : -1);
const euler = (bone: THREE.Bone, x = 0, y = 0, z = 0) =>
  bone.quaternion.setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));

/** Ankle height when the boot is flat on the turf. */
export const STANCE_ANKLE = 0.078;

/* ------------------------------------------------------------------------------------- *
 * Arms: forward swing (+ = forward), elbow flexion (+ = hand up and forward), abduction.
 * ------------------------------------------------------------------------------------- */
function armFK(rig: Rig, side: Side, swing: number, flex: number, abduct = 0.1) {
  const s = sideSign(side);
  euler(rig.bones[`upperArm${side}`], -swing, 0, s * abduct);
  euler(rig.bones[`foreArm${side}`], -flex, 0, 0);
  euler(rig.bones[`hand${side}`], 0, 0, 0);
}

/* ------------------------------------------------------------------------------------- *
 * Idle
 * ------------------------------------------------------------------------------------- */
export function poseIdle(rig: Rig, time: number, phaseOffset = 0) {
  begin(rig);
  const t = time + phaseOffset;
  const breathe = Math.sin(t * 1.9);
  const sway = Math.sin(t * 0.7) * 0.012;
  const hips = rig.bones.hips;
  hips.position.y = DIM.hipsY - 0.025 + breathe * 0.004;
  hips.position.x = sway;
  euler(rig.bones.spine, 0.03, sway * 2, 0);
  euler(rig.bones.chest, 0.02 + breathe * 0.012, 0, 0);
  euler(rig.bones.head, 0, Math.sin(t * 0.4) * 0.25, 0);
  armFK(rig, 'L', 0.05 + sway * 3, 0.25 + breathe * 0.03);
  armFK(rig, 'R', 0.05 - sway * 3, 0.25 - breathe * 0.03);
  rig.root.updateMatrixWorld(true);
  const yaw = yawOf(rig);
  for (const side of ['L', 'R'] as Side[])
    placeFoot(
      rig,
      side,
      local(rig, sideSign(side) * 0.12, STANCE_ANKLE, 0.02 * (side === 'L' ? 1 : -1)),
      0,
      yaw
    );
}

/* ------------------------------------------------------------------------------------- *
 * Running. The cycle phase must advance by distance / strideLength so planted feet never
 * slide: during stance the ankle moves backwards relative to the hips at exactly the body
 * speed.
 * ------------------------------------------------------------------------------------- */
export const strideLength = (speed: number) => {
  const cadence = 1.45 + 0.085 * Math.min(speed, 9); // full cycles per second
  return Math.max(0.4, speed / cadence);
};
/** Distance the body travels while one foot is on the ground (limited by leg reach). */
export const stanceTravel = (speed: number) => Math.min(0.95, 0.45 + 0.07 * Math.min(speed, 9));
export const stanceDuty = (speed: number) =>
  clamp(stanceTravel(speed) / strideLength(speed), 0.2, 0.5);

// Contact points on the boot sole in foot-bone space (y down, z forward).
const HEEL = { y: -0.07, z: -0.07 };
const BALL = { y: -0.068, z: 0.15 };
const STANCE_PITCH_IN = -0.2; // toes up at heel strike
const STANCE_PITCH_OUT = 0.85; // toes down at push-off
function stancePitch(u: number) {
  return u < 0.3
    ? lerp(STANCE_PITCH_IN, 0, smooth(u / 0.3))
    : u < 0.55
      ? 0
      : lerp(0, STANCE_PITCH_OUT, smooth((u - 0.55) / 0.45));
}
/**
 * Ankle position (local) for stance progress u. `baseZ` is where the HEEL contact would be
 * (touchdown - travel * u). The held sole point moves from heel to ball while the foot is flat
 * on the turf, so shifting the reference by the sole offset keeps the boot perfectly still.
 */
function ankleOnContact(x: number, baseZ: number, u: number) {
  const k = smooth((u - 0.3) / 0.25); // hand-over happens only during the flat-foot phase
  const cy = lerp(HEEL.y, BALL.y, k);
  const cz = lerp(HEEL.z, BALL.z, k);
  const theta = stancePitch(u);
  const rotY = cy * Math.cos(theta) - cz * Math.sin(theta);
  const rotZ = cy * Math.sin(theta) + cz * Math.cos(theta);
  return { x, y: -rotY, z: baseZ + (cz - HEEL.z) - rotZ, pitch: theta };
}

export interface RunOptions {
  /** Forward torso lean in radians. Default depends on speed. */
  lean?: number;
  /** Lateral lean into a turn (positive = towards the character's left). */
  bank?: number;
}
export function poseRun(rig: Rig, phase: number, speed: number, options: RunOptions = {}) {
  begin(rig);
  const v = clamp(speed, 0.2, 10);
  const D = stanceDuty(v);
  const S = stanceTravel(v);
  const sprint = clamp(v / 8, 0, 1);
  const lean = options.lean ?? 0.07 + 0.2 * sprint;
  const bob = 0.012 + 0.035 * sprint;
  const base = 0.86 - 0.05 * sprint;
  const hips = rig.bones.hips;
  const phi = ((phase % 1) + 1) % 1;
  hips.position.y = base - bob * (0.5 + 0.5 * Math.cos(4 * Math.PI * (phi - D / 2)));
  hips.position.x = 0.012 * Math.sin(2 * Math.PI * phi);
  const twist = 0.1 + 0.1 * sprint;
  euler(
    hips,
    lean * 0.4,
    twist * Math.sin(2 * Math.PI * phi),
    (options.bank ?? 0) * 0.5 + 0.03 * Math.sin(2 * Math.PI * phi)
  );
  euler(
    rig.bones.spine,
    lean * 0.3,
    -twist * 0.5 * Math.sin(2 * Math.PI * phi),
    (options.bank ?? 0) * 0.3
  );
  euler(
    rig.bones.chest,
    lean * 0.3,
    -twist * 0.9 * Math.sin(2 * Math.PI * phi),
    (options.bank ?? 0) * 0.2
  );
  euler(rig.bones.head, -lean * 0.8, 0.1 * Math.sin(2 * Math.PI * phi), 0);
  const arm = 0.5 + 0.55 * sprint;
  armFK(
    rig,
    'L',
    -arm * Math.cos(2 * Math.PI * phi),
    1.2 + 0.25 * sprint + 0.15 * Math.sin(2 * Math.PI * phi),
    0.12
  );
  armFK(
    rig,
    'R',
    arm * Math.cos(2 * Math.PI * phi),
    1.2 + 0.25 * sprint - 0.15 * Math.sin(2 * Math.PI * phi),
    0.12
  );
  rig.root.updateMatrixWorld(true);
  const yaw = yawOf(rig);
  const lift = 0.09 + 0.035 * v;
  const touchdown = 0.42 * S; // the foot lands ahead of the hips and pushes off behind them
  for (const side of ['L', 'R'] as Side[]) {
    const x = sideSign(side) * 0.1;
    const p = (phi + (side === 'L' ? 0 : 0.5)) % 1;
    let a: { x: number; y: number; z: number; pitch: number };
    if (p < D) {
      // Stance: the contact point moves backwards at exactly the body speed (planted).
      const u = p / D;
      a = ankleOnContact(x, touchdown - S * u, u);
    } else {
      const u = (p - D) / (1 - D);
      const from = ankleOnContact(x, touchdown - S, 1);
      const to = ankleOnContact(x, touchdown, 0);
      // Hermite swing: both end tangents equal the stance velocity (-v relative to the hips), so
      // the boot leaves and lands moving with the turf and never skates at touchdown.
      const m = -(1 - D) * strideLength(v);
      const u2 = u * u;
      const u3 = u2 * u;
      const z =
        (2 * u3 - 3 * u2 + 1) * from.z +
        (u3 - 2 * u2 + u) * m +
        (-2 * u3 + 3 * u2) * to.z +
        (u3 - u2) * m;
      const y =
        lerp(from.y, to.y, smooth(u)) + lift * Math.sin(Math.PI * clamp(u * 1.06, 0, 1)) ** 1.15;
      a = { x, y, z, pitch: lerp(from.pitch, to.pitch, smooth(u * 1.1)) };
    }
    placeFoot(rig, side, local(rig, a.x, a.y, a.z), a.pitch, yaw);
  }
}

/* ------------------------------------------------------------------------------------- *
 * Kicking. The plant foot is fixed at `plant`; the kicking ankle follows a path through
 * back-swing, contact and follow-through. Contact happens at t = KICK.contact.
 * ------------------------------------------------------------------------------------- */
export const KICK = Object.freeze({ contact: 0.3, duration: 0.85, through: 0.34 });
export interface KickSpec {
  /** Ball centre at the instant of contact (world). */
  ball: THREE.Vector3;
  /** Horizontal unit direction of the kick (world). */
  dir: THREE.Vector3;
  foot: Side;
  power: number; // 0..1
  /** 0 = driven along the ground, 1 = lofted. */
  loft: number;
}
export function kickGeometry(spec: KickSpec) {
  const up = new THREE.Vector3(0, 1, 0);
  const left = new THREE.Vector3().crossVectors(up, spec.dir).normalize();
  const plantSide = spec.foot === 'R' ? 1 : -1; // plant foot on the opposite side
  const plant = spec.ball
    .clone()
    .addScaledVector(left, plantSide * 0.24)
    .addScaledVector(spec.dir, -0.05);
  plant.y = STANCE_ANKLE;
  // Hips sit above the plant foot, slightly behind the ball.
  const root = plant
    .clone()
    .addScaledVector(left, -plantSide * 0.1)
    .addScaledVector(spec.dir, -0.06);
  root.y = 0;
  return { left, plant, root };
}
export function poseKick(rig: Rig, t: number, spec: KickSpec) {
  begin(rig);
  const { left, plant } = kickGeometry(spec);
  const yaw = Math.atan2(spec.dir.x, spec.dir.z);
  const side = spec.foot;
  const other: Side = side === 'L' ? 'R' : 'L';
  const u = clamp(t / KICK.duration, 0, 1);
  const tc = KICK.contact / KICK.duration;
  const hips = rig.bones.hips;
  const swingBack = smooth(u / tc) * (1 - smooth((u - tc) / 0.1));
  hips.position.y = DIM.hipsY - 0.07 - 0.03 * swingBack;
  euler(
    hips,
    0.05,
    (side === 'R' ? -1 : 1) * 0.25 * (swingBack - smooth((u - tc) / 0.3)),
    (side === 'R' ? 1 : -1) * 0.06 * swingBack
  );
  euler(
    rig.bones.spine,
    0.1 * (1 - smooth((u - tc) / 0.3)) + 0.05,
    (side === 'R' ? 1 : -1) * 0.2 * (swingBack - smooth((u - tc) / 0.3)),
    0
  );
  euler(
    rig.bones.chest,
    0.1,
    (side === 'R' ? 1 : -1) * 0.2 * (swingBack - smooth((u - tc) / 0.3)),
    0
  );
  euler(rig.bones.head, 0.18, 0, 0);
  // Arms: the opposite arm swings forward for balance, the other trails.
  const armSwing = 0.4 + 0.6 * spec.power;
  armFK(rig, other, armSwing * (swingBack - 0.3), 0.7, 0.55);
  armFK(rig, side, -armSwing * 0.5 * (swingBack - 0.3), 0.7, 0.55);
  rig.root.updateMatrixWorld(true);
  // Kicking ankle path in world space: back-swing -> contact -> follow-through.
  const dir = spec.dir;
  const contactAnkle = spec.ball
    .clone()
    .addScaledVector(dir, -0.2)
    .addScaledVector(left, 0)
    .setY(0.1 + 0.05 * spec.loft);
  const back = contactAnkle
    .clone()
    .addScaledVector(dir, -(0.55 + 0.25 * spec.power))
    .setY(0.3 + 0.2 * spec.power)
    .addScaledVector(left, (side === 'R' ? -1 : 1) * 0.06);
  const through = contactAnkle
    .clone()
    .addScaledVector(dir, 0.55 + 0.35 * spec.power)
    .setY(0.35 + 0.55 * spec.loft + 0.15 * spec.power);
  let ankle: THREE.Vector3;
  let pitch: number;
  if (u <= tc) {
    // Cubic ramp: the boot is fastest exactly at contact, like a real strike.
    const s = clamp(u / tc, 0, 1);
    ankle = back.clone().lerp(contactAnkle, s ** 3);
    ankle.y += 0.06 * Math.sin(Math.PI * s) * (1 - s);
    pitch = lerp(0.2, 0.62 - 0.15 * spec.loft, s ** 2);
  } else {
    // Follow-through leaves contact at the same speed and decelerates (cubic ease-out), then holds.
    const s = clamp((t - KICK.contact) / KICK.through, 0, 1);
    ankle = contactAnkle.clone().lerp(through, 1 - (1 - s) ** 3);
    pitch = lerp(0.62, 0.3, s);
  }
  placeFoot(rig, other, plant, 0, yaw);
  placeFoot(rig, side, ankle, pitch, yaw);
}

/* ------------------------------------------------------------------------------------- *
 * Goalkeeper
 * ------------------------------------------------------------------------------------- */
export function poseKeeperReady(rig: Rig, time: number, shift = 0) {
  begin(rig);
  const t = time * 2.2;
  const hips = rig.bones.hips;
  hips.position.y = 0.76 + Math.sin(t) * 0.01;
  hips.position.x = shift * 0.08;
  euler(hips, 0.25, 0, 0);
  euler(rig.bones.spine, 0.18, 0, 0);
  euler(rig.bones.chest, 0.14, 0, 0);
  euler(rig.bones.head, -0.3, 0, 0);
  armFK(rig, 'L', 0.45, 1.0, 0.75);
  armFK(rig, 'R', 0.45, 1.0, 0.75);
  rig.root.updateMatrixWorld(true);
  const yaw = yawOf(rig);
  for (const side of ['L', 'R'] as Side[])
    placeFoot(
      rig,
      side,
      local(rig, sideSign(side) * 0.3, STANCE_ANKLE, 0.04),
      0,
      yaw,
      sideSign(side) * 0.05
    );
}

export interface DiveSpec {
  /** +1 dives to the keeper's left, -1 to the right. */
  direction: 1 | -1;
  /** Distance travelled sideways, metres. */
  reach: number;
  /** Ball interception height (0..2.4). */
  height: number;
}
/** Launch 0-0.55 s, contact ~0.45 s, ground 0.55-1.15 s, recovery to the ready stance by 1.8 s. */
export const DIVE_DURATION = 1.8;
export const DIVE_CONTACT = 0.45;
/** Offsets in the keeper's LOCAL frame at dive time t. Returns where to put the root. */
export function diveRoot(spec: DiveSpec, t: number) {
  const out = smooth(clamp(t / 0.55, 0, 1));
  return new THREE.Vector3(spec.direction * spec.reach * out, 0, 0.2 * out);
}
export function poseKeeperDive(rig: Rig, t: number, spec: DiveSpec, ballWorld: THREE.Vector3) {
  begin(rig);
  const launch = smooth(t / 0.5);
  const down = smooth((t - 0.5) / 0.3);
  const rise = smooth((t - 1.15) / 0.65);
  const side = launch * (1 - rise); // 0 = upright, 1 = rolled onto the side
  const hips = rig.bones.hips;
  const air =
    Math.sin(Math.PI * clamp(t / 0.7, 0, 1)) * (0.15 + 0.2 * clamp(spec.height / 2.4, 0, 1));
  // Hips: crouch, leave the ground, come down onto the side, then get back up.
  hips.position.y = lerp(0.76, 0.16, down * (1 - rise)) + air * (1 - down);
  euler(hips, 0.1 * (1 - side), 0, -spec.direction * (Math.PI / 2) * 0.95 * side);
  euler(rig.bones.spine, 0, 0, 0);
  euler(rig.bones.head, -0.2, spec.direction * 0.35 * side, 0);
  rig.root.updateMatrixWorld(true);
  const yaw = yawOf(rig);
  const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const lateral = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(
    spec.direction
  ); // dive direction
  // Hands reach for the ball until contact, then stretch along the dive direction.
  const toBall = smooth(t / DIVE_CONTACT) * (1 - smooth((t - DIVE_CONTACT) / 0.2));
  for (const sideName of ['L', 'R'] as Side[]) {
    const shoulder = rig.bones[`upperArm${sideName}`].getWorldPosition(new THREE.Vector3());
    const ahead = shoulder
      .clone()
      .addScaledVector(lateral, 0.55)
      .setY(Math.max(0.1, shoulder.y - 0.05));
    const ready = shoulder
      .clone()
      .addScaledVector(forward, 0.35)
      .addScaledVector(new THREE.Vector3(0, -1, 0), 0.25);
    const target = ahead.clone().lerp(ballWorld, toBall).lerp(ready, rise);
    reachHand(rig, sideName, target, new THREE.Vector3(0, -1, 0).addScaledVector(forward, 0.2));
  }
  // Legs trail behind the dive: along the body axis, knees bent, then plant again for the get-up.
  const trail = launch * (1 - rise);
  for (const sideName of ['L', 'R'] as Side[]) {
    const sx = sideSign(sideName);
    const hipWorld = rig.bones.hips.getWorldPosition(new THREE.Vector3());
    const lying = hipWorld
      .clone()
      .addScaledVector(lateral, -0.75)
      .addScaledVector(forward, sx * 0.12 * 0.5)
      .setY(0.1 + (sideName === 'L' ? 0.05 : 0.18) * trail);
    const standing = rig.root.localToWorld(new THREE.Vector3(sx * 0.3, STANCE_ANKLE, 0.04));
    placeFoot(rig, sideName, standing.clone().lerp(lying, trail), 0.6 * trail, yaw);
  }
}

/* ------------------------------------------------------------------------------------- *
 * Celebrations
 * ------------------------------------------------------------------------------------- */
export type Celebration = 'ARMS_UP' | 'WINGS' | 'KNEE_SLIDE' | 'LEAP' | 'HUG' | 'DEJECTED';
export function poseCelebrate(rig: Rig, kind: Celebration, time: number, running = 0) {
  begin(rig);
  const yaw = yawOf(rig);
  const pump = Math.sin(time * 9);
  const hips = rig.bones.hips;
  let kneeSlide = 0;
  switch (kind) {
    case 'ARMS_UP':
      hips.position.y = DIM.hipsY - 0.05 + Math.abs(pump) * 0.03;
      euler(rig.bones.chest, -0.15, 0, 0);
      euler(rig.bones.head, -0.35, 0, 0);
      armFK(rig, 'L', -2.9 + pump * 0.1, 0.25, 0.5);
      armFK(rig, 'R', -2.9 - pump * 0.1, 0.25, 0.5);
      break;
    case 'WINGS':
      hips.position.y = DIM.hipsY - 0.05;
      euler(rig.bones.chest, 0.1, 0, 0.1 * pump);
      armFK(rig, 'L', 0, 0.1, 1.45 + pump * 0.05);
      armFK(rig, 'R', 0, 0.1, 1.45 - pump * 0.05);
      break;
    case 'LEAP': {
      const u = (time * 1.6) % 1;
      hips.position.y = DIM.hipsY + 0.45 * Math.sin(Math.PI * u) - 0.05;
      euler(rig.bones.chest, -0.25, 0, 0);
      armFK(rig, 'L', -2.8, 0.2, 0.3);
      armFK(rig, 'R', -2.8, 0.2, 0.3);
      break;
    }
    case 'KNEE_SLIDE':
      kneeSlide = 1;
      hips.position.y = 0.55;
      euler(rig.bones.spine, -0.3, 0, 0);
      euler(rig.bones.chest, -0.2, 0, 0);
      euler(rig.bones.head, -0.3, 0, 0);
      armFK(rig, 'L', -2.4, 0.3, 0.9);
      armFK(rig, 'R', -2.4, 0.3, 0.9);
      break;
    case 'HUG':
      hips.position.y = DIM.hipsY - 0.07 + Math.abs(pump) * 0.02;
      euler(rig.bones.spine, 0.18, 0, 0);
      armFK(rig, 'L', -1.1, 1.0, 0.2);
      armFK(rig, 'R', -1.1, 1.0, 0.2);
      break;
    case 'DEJECTED':
      hips.position.y = DIM.hipsY - 0.05;
      euler(rig.bones.spine, 0.25, 0, 0);
      euler(rig.bones.chest, 0.15, 0, 0);
      euler(rig.bones.head, 0.5, 0, 0);
      armFK(rig, 'L', 0.0, 1.2, 0.1);
      armFK(rig, 'R', 0.0, 1.2, 0.1);
      break;
  }
  void running;
  rig.root.updateMatrixWorld(true);
  if (kneeSlide) {
    placeFoot(rig, 'L', local(rig, 0.1, 0.12, -0.35), 1.1, yaw);
    placeFoot(rig, 'R', local(rig, -0.1, 0.45, 0.3), 0.3, yaw);
    return;
  }
  const bounce = kind === 'LEAP' ? Math.max(0, Math.sin(Math.PI * ((time * 1.6) % 1))) : 0;
  for (const side of ['L', 'R'] as Side[])
    placeFoot(
      rig,
      side,
      local(
        rig,
        sideSign(side) * 0.13,
        STANCE_ANKLE + bounce * 0.4 + (kind === 'ARMS_UP' ? Math.max(0, pump) * 0.03 : 0),
        bounce * -0.1
      ),
      bounce * 0.4,
      yaw
    );
}

/* ------------------------------------------------------------------------------------- *
 * Blending between two poses (so state changes never snap)
 * ------------------------------------------------------------------------------------- */
export interface PoseSnapshot {
  q: THREE.Quaternion[];
  p: THREE.Vector3[];
}
export function capture(rig: Rig): PoseSnapshot {
  return {
    q: BONES.map((n) => rig.bones[n].quaternion.clone()),
    p: BONES.map((n) => rig.bones[n].position.clone()),
  };
}
export function blendTo(rig: Rig, from: PoseSnapshot, weight: number) {
  const w = clamp(weight, 0, 1);
  if (w >= 1) return;
  BONES.forEach((n, i) => {
    rig.bones[n].quaternion.copy(from.q[i]).slerp(rig.bones[n].quaternion.clone(), w);
    rig.bones[n].position.copy(from.p[i]).lerp(rig.bones[n].position.clone(), w);
  });
  rig.root.updateMatrixWorld(true);
}
