import * as THREE from 'three';
import { placeFoot, reachHand } from './ik';
import { BONES, DIM, restLocalPosition, type Rig, type Side } from './rig';
import { applyAuthoredMotion, sampleAuthoredControl, type AuthoredMotionName } from './authored-motion';

/**
 * Authored body animation with contact-retargeting solvers. Every function first resets the skeleton to its bind pose, so a
 * pose depends only on its arguments. The caller positions `rig.root` (feet on the ground,
 * rotation.y = heading) before posing. Angles are radians; +Z is forward.
 */
export function resetPose(rig: Rig) {
  for (const name of BONES) {
    let position = REST_LOCAL.get(name);
    if (!position) { position = restLocalPosition(name); REST_LOCAL.set(name, position); }
    rig.bones[name].position.copy(position);
    rig.bones[name].quaternion.identity();
  }
}
const REST_LOCAL = new Map<(typeof BONES)[number], THREE.Vector3>();
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

/** Ankle height when the boot is flat on the turf. */
export const STANCE_ANKLE = 0.078;

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
  applyAuthoredMotion(rig, 'idle', t, { preserveHipsPosition: true });
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
  /** Bounded authored drive overlay; this does not change distance/phase/contact clocks. */
  acceleration?: number;
  accelerationTime?: number;
  /** Signed turn effort; root heading and world-space sole pivot remain separately constrained. */
  turn?: number;
  turnTime?: number;
}
export function poseRun(rig: Rig, phase: number, speed: number, options: RunOptions = {}) {
  begin(rig);
  const v = clamp(speed, 0.2, 10);
  const D = stanceDuty(v);
  const S = stanceTravel(v);
  const sprint = clamp(v / 8, 0, 1);
  const bob = 0.012 + 0.035 * sprint;
  const base = 0.86 - 0.05 * sprint;
  const hips = rig.bones.hips;
  const phi = ((phase % 1) + 1) % 1;
  hips.position.y = base - bob * (0.5 + 0.5 * Math.cos(4 * Math.PI * (phi - D / 2)));
  hips.position.x = 0.012 * Math.sin(2 * Math.PI * phi);
  applyAuthoredMotion(rig, 'run', phi, { strength: 0.65 + 0.35 * sprint, preserveHipsPosition: true });
  if (options.acceleration)
    applyAuthoredMotion(rig, 'acceleration', options.accelerationTime ?? phi * 0.55, {
      weight: clamp(options.acceleration, 0, 1) * 0.6, preserveHipsPosition: true,
    });
  const turn = options.turn ?? clamp((options.bank ?? 0) / 0.22, -1, 1);
  if (Math.abs(turn) > 0.02)
    applyAuthoredMotion(rig, 'plantedTurn', options.turnTime ?? 0.23, {
      weight: Math.abs(turn) * 0.65, mirror: turn < 0, preserveHipsPosition: true,
    });
  // Speed/contact adaptation is separate from the authored posture, with a bounded lean delta.
  if (options.lean !== undefined) hips.rotateX((options.lean - (0.07 + 0.2 * sprint)) * 0.4);
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
      // Original keyed IK-control arc, retargeted to this stride's fixed contact endpoints.
      // Preserve the stance velocity at the two ends by adapting only tangent handles.
      const m = -(1 - D) * strideLength(v) / (to.z - from.z);
      const control = sampleAuthoredControl('runSwing', 'footTarget', u, {
        start: [0, 0, m], end: [0, 0, m],
      });
      const pitch = sampleAuthoredControl('runSwing', 'footPitch', u)[0];
      a = {
        x: x + sideSign(side) * control[0],
        y: lerp(from.y, to.y, smooth(u)) + lift * Math.max(0, control[1]),
        z: lerp(from.z, to.z, control[2]), pitch,
      };
    }
    placeFoot(rig, side, local(rig, a.x, a.y, a.z), a.pitch, yaw);
  }
}

/** Per-foot world plant state. Owned by one player and cleared on teleports/state changes. */
export interface RunPlant {
  L?: {
    anchor: THREE.Vector3;
    yaw: number;
    phase: number;
    lastAnkle?: THREE.Vector3;
    lastPitch?: number;
    release?: { phase: number; from: THREE.Vector3 };
  };
  R?: {
    anchor: THREE.Vector3;
    yaw: number;
    phase: number;
    lastAnkle?: THREE.Vector3;
    lastPitch?: number;
    release?: { phase: number; from: THREE.Vector3 };
  };
}
/** Re-solve stance AFTER blending. A held boot does not rotate with the torso during a pivot. */
export const MAX_PLANT_TWIST = Math.PI / 4;
export const MAX_SUPPORT_DROP = 0.06; // world metres, minimal reach correction rather than a pose snap
export function plantRunFeet(rig: Rig, phase: number, speed: number, plants: RunPlant) {
  const duty = stanceDuty(speed);
  const scale = rig.root.getWorldScale(new THREE.Vector3()).y;
  const phi = ((phase % 1) + 1) % 1;
  const bodyYaw = new THREE.Euler().setFromQuaternion(
    rig.bones.hips.getWorldQuaternion(new THREE.Quaternion()),
    'YXZ'
  ).y;
  const plans: Array<{
    side: Side;
    ankle: THREE.Vector3;
    pitch: number;
    yaw: number;
    stance: boolean;
    phase: number;
    releasing?: boolean;
  }> = [];
  const releasedPlan = (side: Side, p: number, held: NonNullable<RunPlant['L']>) => {
    const foot = rig.bones[`foot${side}`];
    const target = foot.getWorldPosition(new THREE.Vector3());
    const angles = new THREE.Euler().setFromQuaternion(
      foot.getWorldQuaternion(new THREE.Quaternion()),
      'YXZ'
    );
    const progress = clamp((p - held.release!.phase) / 0.15, 0, 1);
    const ankle = held.release!.from.clone().lerp(target, smooth(progress));
    ankle.y += 0.025 * (1 - smooth(progress)) + 0.18 * Math.sin(Math.PI * progress);
    const difference = Math.atan2(Math.sin(bodyYaw - held.yaw), Math.cos(bodyYaw - held.yaw));
    const yaw = bodyYaw - clamp(difference, -MAX_PLANT_TWIST, MAX_PLANT_TWIST);
    const pitch = lerp(held.lastPitch ?? angles.x, angles.x, smooth(progress));
    const soleY =
      Math.min(
        HEEL.y * Math.cos(pitch) - HEEL.z * Math.sin(pitch),
        BALL.y * Math.cos(pitch) - BALL.z * Math.sin(pitch)
      ) * scale;
    ankle.y = Math.max(ankle.y, -soleY + 0.01);
    return { side, ankle, pitch, yaw, stance: false, phase: p, releasing: true };
  };
  for (const side of ['L', 'R'] as Side[]) {
    const p = (phi + (side === 'L' ? 0 : 0.5)) % 1;
    const previous = plants[side];
    if (previous?.release) {
      if (p >= previous.release.phase && p < previous.release.phase + 0.15) {
        plans.push(releasedPlan(side, p, previous));
        continue;
      }
      delete plants[side];
    }
    if (p >= duty) {
      if (previous?.lastAnkle && !previous.release) {
        previous.release = { phase: p, from: previous.lastAnkle.clone() };
        plans.push(releasedPlan(side, p, previous));
        continue;
      }
      delete plants[side];
      const foot = rig.bones[`foot${side}`];
      const angles = new THREE.Euler().setFromQuaternion(
        foot.getWorldQuaternion(new THREE.Quaternion()),
        'YXZ'
      );
      plans.push({
        side,
        ankle: foot.getWorldPosition(new THREE.Vector3()),
        pitch: angles.x,
        yaw: angles.y,
        stance: false,
        phase: p,
      });
      continue;
    }
    const u = p / duty;
    const offset = ankleOnContact(0, 0, u);
    offset.y *= scale;
    offset.z *= scale;
    let held = plants[side];
    const rotate = (yaw: number) =>
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    if (!held || p < held.phase) {
      const yaw = yawOf(rig);
      const ankle = rig.bones[`foot${side}`].getWorldPosition(new THREE.Vector3());
      held = plants[side] = {
        anchor: ankle
          .clone()
          .sub(new THREE.Vector3(0, offset.y, offset.z).applyQuaternion(rotate(yaw))),
        yaw,
        phase: p,
      };
      held.anchor.y = 0;
    }
    held.phase = p;
    const twist = Math.atan2(Math.sin(bodyYaw - held.yaw), Math.cos(bodyYaw - held.yaw));
    if (Math.abs(twist) > MAX_PLANT_TWIST) {
      // Pivot around the currently loaded sole point, rather than dragging the ankle or
      // allowing the pelvis to rotate a half-turn over an immobile boot/knee.
      const contactOffset = new THREE.Vector3(
        0,
        0,
        (BALL.z - HEEL.z) * smooth((u - 0.3) / 0.25) * scale
      );
      const contact = held.anchor
        .clone()
        .add(contactOffset.clone().applyQuaternion(rotate(held.yaw)));
      held.yaw = bodyYaw - Math.sign(twist) * MAX_PLANT_TWIST;
      held.anchor.copy(contact).sub(contactOffset.applyQuaternion(rotate(held.yaw)));
    }
    const ankle = new THREE.Vector3(0, offset.y, offset.z)
      .applyQuaternion(rotate(held.yaw))
      .add(held.anchor);
    plans.push({ side, ankle, pitch: offset.pitch, yaw: held.yaw, stance: true, phase: p });
  }
  // Blended idle hips can leave a ground target just beyond the rigid leg's reach. Lower
  // only as far as required by the active support targets, preserving the torso blend.
  const reach = (DIM.thigh + DIM.shin) * scale * 0.995;
  const requiredDrop = (plan: (typeof plans)[number]) => {
    const hip = rig.bones[`upperLeg${plan.side}`].getWorldPosition(new THREE.Vector3());
    const horizontal = Math.hypot(hip.x - plan.ankle.x, hip.z - plan.ankle.z);
    const verticalReach = Math.sqrt(Math.max(0, reach * reach - horizontal * horizontal));
    return hip.y - plan.ankle.y - verticalReach;
  };
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (plan.stance && requiredDrop(plan) > MAX_SUPPORT_DROP) {
      // A sharp direction reversal can leave an old world anchor beyond anatomical reach.
      // End that support window with a short lifted step; never stretch the leg or drag a
      // grounded boot towards a new anchor. Progress remains linked to travelled distance.
      const held = plants[plan.side]!;
      held.release = { phase: plan.phase, from: held.lastAnkle?.clone() ?? plan.ankle.clone() };
      plans[i] = releasedPlan(plan.side, plan.phase, held);
    }
  }
  let drop = 0;
  for (const plan of plans.filter((p) => p.stance || p.releasing))
    drop = Math.max(drop, requiredDrop(plan));
  rig.bones.hips.position.y -= Math.min(MAX_SUPPORT_DROP, Math.max(0, drop)) / scale;
  rig.root.updateMatrixWorld(true);
  for (const plan of plans) {
    if (plan.releasing) {
      // The airborne step is free to shorten its arc if a discrete travel reversal still
      // outruns the old target. Keep the knee short of full extension, without moving a
      // grounded contact or asking for more pelvis correction.
      const hip = rig.bones[`upperLeg${plan.side}`].getWorldPosition(new THREE.Vector3());
      const delta = plan.ankle.clone().sub(hip).clampLength(0, reach);
      plan.ankle.copy(hip).add(delta);
    }
    placeFoot(rig, plan.side, plan.ankle, plan.pitch, plan.yaw);
    if (plants[plan.side]) {
      plants[plan.side]!.lastAnkle = rig.bones[`foot${plan.side}`].getWorldPosition(
        new THREE.Vector3()
      );
      if (!plan.releasing) plants[plan.side]!.lastPitch = plan.pitch;
    }
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
  const load = Math.sin(Math.PI * clamp(t / KICK.contact, 0, 1));
  hips.position.y = DIM.hipsY - 0.07 - 0.055 * load;
  applyAuthoredMotion(rig, 'kick', t, { mirror: side === 'L', preserveHipsPosition: true });
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
    const s = clamp((t - 0.1) / (KICK.contact - 0.1), 0, 1);
    const ready = contactAnkle.clone().addScaledVector(dir, -0.18).setY(STANCE_ANKLE);
    ankle = t < 0.1 ? ready.lerp(back, smooth(t / 0.1)) : back.clone().lerp(contactAnkle, s ** 3);
    ankle.y += 0.06 * Math.sin(Math.PI * s) * (1 - s);
    pitch = lerp(0.2, 0.62 - 0.15 * spec.loft, s ** 2);
  } else {
    // Follow-through decelerates after the strike, then the leg begins settling for recovery.
    const s = clamp((t - KICK.contact) / KICK.through, 0, 1);
    ankle = contactAnkle.clone().lerp(through, 1 - (1 - s) ** 3);
    pitch = lerp(0.62 - 0.15 * spec.loft, 0.3, s);
    const settle = smooth((t - 0.68) / 0.17);
    const recover = contactAnkle.clone().addScaledVector(dir, 0.16).setY(STANCE_ANKLE);
    ankle.lerp(recover, settle * 0.45);
    pitch = lerp(pitch, 0, settle * 0.45);
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
  applyAuthoredMotion(rig, 'keeperReady', time, { preserveHipsPosition: true });
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
  const rise = smooth((t - 1.1) / 0.7);
  const load = Math.sin(Math.PI * clamp(t / 0.16, 0, 1));
  const landing = Math.sin(Math.PI * clamp((t - 0.55) / 0.3, 0, 1));
  const hips = rig.bones.hips;
  const air =
    Math.sin(Math.PI * clamp((t - 0.08) / 0.62, 0, 1)) *
    (0.15 + 0.2 * clamp(spec.height / 2.4, 0, 1));
  // Hips: crouch, leave the ground, come down onto the side, then get back up.
  hips.position.y =
    lerp(0.76, 0.16, down * (1 - rise)) + air * (1 - down) - 0.06 * load - 0.025 * landing;
  applyAuthoredMotion(rig, 'keeperDive', t, { mirror: spec.direction < 0, preserveHipsPosition: true });
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
const CELEBRATION_CLIPS: Record<Celebration, AuthoredMotionName> = {
  ARMS_UP: 'celebrate', WINGS: 'celebrateWings', KNEE_SLIDE: 'celebrateSlide',
  LEAP: 'celebrateLeap', HUG: 'celebrateHug', DEJECTED: 'dejected',
};
export function poseCelebrate(rig: Rig, kind: Celebration, time: number, running = 0) {
  begin(rig);
  const yaw = yawOf(rig);
  const pump = Math.sin(time * 9);
  const hips = rig.bones.hips;
  let kneeSlide = 0;
  switch (kind) {
    case 'ARMS_UP': hips.position.y = DIM.hipsY - 0.05 + Math.abs(pump) * 0.03; break;
    case 'LEAP': {
      const u = (time * 1.6) % 1;
      hips.position.y = DIM.hipsY + 0.45 * Math.sin(Math.PI * u) - 0.05;
      break;
    }
    case 'KNEE_SLIDE': kneeSlide = 1; hips.position.y = 0.55; break;
    default: hips.position.y = DIM.hipsY - 0.05;
  }
  applyAuthoredMotion(rig, CELEBRATION_CLIPS[kind], time, { preserveHipsPosition: true });
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
    const targetQ = rig.bones[n].quaternion.clone();
    const targetP = rig.bones[n].position.clone();
    rig.bones[n].quaternion.copy(from.q[i]).slerp(targetQ, w);
    rig.bones[n].position.copy(from.p[i]).lerp(targetP, w);
  });
  rig.root.updateMatrixWorld(true);
}
