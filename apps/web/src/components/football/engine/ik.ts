import * as THREE from 'three';
import { DIM, type Rig, type Side } from './rig';

const A = new THREE.Vector3();
const B = new THREE.Vector3();
const X = new THREE.Vector3();
const Y = new THREE.Vector3();
const Z = new THREE.Vector3();
const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();

/** Sets a bone's WORLD rotation, converting through its parent. Updates its subtree. */
export function setWorldQuaternion(bone: THREE.Bone, world: THREE.Quaternion) {
  bone.parent!.getWorldQuaternion(Q2);
  bone.quaternion.copy(Q2.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

/**
 * Rotates `bone` so its child direction (local -Y) points at `to`, keeping local +Z as close
 * to `forward` as possible. The bone's parent matrices must be current.
 */
export function aimBone(bone: THREE.Bone, to: THREE.Vector3, forward: THREE.Vector3) {
  bone.getWorldPosition(A);
  Y.subVectors(A, to).normalize(); // local +Y points from the child back to the bone
  Z.copy(forward).addScaledVector(Y, -forward.dot(Y));
  if (Z.lengthSq() < 1e-8) Z.set(0, 0, 1).addScaledVector(Y, -Y.z);
  Z.normalize();
  X.crossVectors(Y, Z);
  M.makeBasis(X, Y, Z);
  setWorldQuaternion(bone, Q.setFromRotationMatrix(M));
}

export interface TwoBoneResult {
  /** Straight-line distance requested from the hip/shoulder to the target. */
  requested: number;
  /** True when the target was beyond reach and had to be clamped. */
  clamped: boolean;
}

/**
 * Two-bone IK for a limb of lengths l1, l2. `root`, `mid` and `tip` are bones, `target` is a
 * world position for `tip`, and `pole` a world direction the middle joint bends towards.
 * Parent matrices of `root` must be current; matrices below it are updated.
 */
export function solveTwoBone(
  root: THREE.Bone,
  mid: THREE.Bone,
  l1: number,
  l2: number,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  forward: THREE.Vector3
): TwoBoneResult {
  const h = root.getWorldPosition(new THREE.Vector3());
  const toTarget = new THREE.Vector3().subVectors(target, h);
  const requested = toTarget.length();
  const reach = (l1 + l2) * 0.9995;
  const min = Math.abs(l1 - l2) + 1e-3;
  const d = Math.min(reach, Math.max(min, requested));
  const u = toTarget.lengthSq() > 1e-12 ? toTarget.normalize() : new THREE.Vector3(0, -1, 0);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const height = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const p = new THREE.Vector3().copy(pole).addScaledVector(u, -pole.dot(u));
  if (p.lengthSq() < 1e-8) p.set(0, 0, 1).addScaledVector(u, -u.z);
  p.normalize();
  const knee = new THREE.Vector3().copy(h).addScaledVector(u, a).addScaledVector(p, height);
  const end = new THREE.Vector3().copy(h).addScaledVector(u, d);
  aimBone(root, knee, forward);
  aimBone(mid, end, forward);
  return { requested, clamped: requested > reach + 1e-6 || requested < min - 1e-6 };
}

const FOOT = new THREE.Quaternion();
const TILT = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
/** Plants a foot: leg IK to `ankle`, then foot orientation = heading yaw + pitch (toes down +). */
export function placeFoot(
  rig: Rig,
  side: Side,
  ankle: THREE.Vector3,
  pitch: number,
  yaw: number,
  roll = 0
): TwoBoneResult {
  const upper = rig.bones[`upperLeg${side}`];
  const lower = rig.bones[`lowerLeg${side}`];
  const foot = rig.bones[`foot${side}`];
  const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const result = solveTwoBone(upper, lower, DIM.thigh, DIM.shin, ankle, forward, forward);
  FOOT.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  TILT.setFromAxisAngle(AXIS_X, pitch);
  FOOT.multiply(TILT);
  if (roll)
    FOOT.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
  setWorldQuaternion(foot, FOOT);
  return result;
}

/** Reaches a hand to a world point; the elbow bends towards `pole`. */
export function reachHand(
  rig: Rig,
  side: Side,
  target: THREE.Vector3,
  pole: THREE.Vector3
): TwoBoneResult {
  const upper = rig.bones[`upperArm${side}`];
  const fore = rig.bones[`foreArm${side}`];
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(
    rig.root.getWorldQuaternion(new THREE.Quaternion())
  );
  return solveTwoBone(upper, fore, DIM.upperArm, DIM.foreArm, target, pole, forward);
}

export const worldPositionOf = (bone: THREE.Object3D) => bone.getWorldPosition(new THREE.Vector3());
void B;
