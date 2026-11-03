import * as THREE from 'three';
import controls from './native-jog-controls.json';
import { solveTwoBone, setWorldQuaternion } from './ik';
import { BONES, DIM, type Rig, type BoneName } from './rig';
import { capture, type PoseSnapshot } from './poses';
import type { ReviewMotionInput, ReviewMotionState } from './review-player-motion';

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => {
  const u = clamp(x);
  return u * u * (3 - 2 * u);
};
export const NATIVE_JOG_PROVENANCE = Object.freeze({
  controlsSHA256: controls.sourceControlsSHA256,
  referenceSpeed: controls.referenceSpeed,
  canonicalRestSHA256: controls.canonicalRestSha256,
});
const finger = (name: string) => /^(thumb|index|middle|ring|pinky)/.test(name);
export interface NativeJogSample {
  pelvis: THREE.Vector3;
  rotation: THREE.Quaternion;
  upper: Partial<Record<BoneName, THREE.Quaternion>>;
  poles: { L: THREE.Vector3; R: THREE.Vector3 };
}
/** The explicit authoring handles are per phase, not per second. Quaternion
 * components are Hermite sampled before normalization; slerp here changes the take. */
export function sampleNativeJog(phase: number): NativeJogSample {
  const p = ((phase % 1) + 1) % 1;
  const samples = controls.samples;
  let i = Math.min(samples.length - 2, Math.floor(p * (samples.length - 1)));
  while (i > 0 && p < samples[i].phase) i--;
  while (i < samples.length - 2 && p > samples[i + 1].phase) i++;
  const a = samples[i],
    b = samples[i + 1],
    span = b.phase - a.phase;
  const u = (p - a.phase) / span,
    u2 = u * u,
    u3 = u2 * u;
  const curve = (av: number[], bv: number[], at: number[], bt: number[]) =>
    av.map(
      (v, axis) =>
        (2 * u3 - 3 * u2 + 1) * v +
        (u3 - 2 * u2 + u) * span * at[axis] +
        (-2 * u3 + 3 * u2) * bv[axis] +
        (u3 - u2) * span * bt[axis]
    );
  const vector = (v: number[]) => new THREE.Vector3().fromArray(v);
  const quaternion = (v: number[]) => new THREE.Quaternion().fromArray(v).normalize();
  const upper: NativeJogSample['upper'] = {};
  for (const name of Object.keys(a.upperBodyAndHands) as Array<keyof typeof a.upperBodyAndHands>)
    upper[name] = quaternion(
      curve(
        a.upperBodyAndHands[name],
        b.upperBodyAndHands[name],
        a.tangentsPerPhase.upperBodyAndHands[name],
        b.tangentsPerPhase.upperBodyAndHands[name]
      )
    );
  return {
    pelvis: vector(
      curve(
        a.pelvisLocalPositionMetres,
        b.pelvisLocalPositionMetres,
        a.tangentsPerPhase.pelvisLocalPositionMetres,
        b.tangentsPerPhase.pelvisLocalPositionMetres
      )
    ),
    rotation: quaternion(
      curve(
        a.pelvisQuaternion,
        b.pelvisQuaternion,
        a.tangentsPerPhase.pelvisQuaternion,
        b.tangentsPerPhase.pelvisQuaternion
      )
    ),
    upper,
    poles: Object.fromEntries(
      (['L', 'R'] as const).map((side) => [
        side,
        vector(
          curve(
            a.kneePoleRootSpace[side],
            b.kneePoleRootSpace[side],
            a.tangentsPerPhase.kneePoleRootSpace[side],
            b.tangentsPerPhase.kneePoleRootSpace[side]
          )
        ).normalize(),
      ])
    ) as NativeJogSample['poles'],
  };
}
export interface NativeJogState {
  weight: number;
  initialized: boolean;
  baseline?: PoseSnapshot;
  sample?: NativeJogSample;
  appliedWeight: number;
}
export const createNativeJogState = (): NativeJogState => ({
  weight: 0,
  initialized: false,
  appliedWeight: 0,
});
/** Remove only the previous visual hips/leg articulation before clearing history.
 * A subsequent generic action crossfade must capture the original locals, rather
 * than accidentally baking the outgoing native solution into its base pose.
 * Full world feet remain unchanged; actual current arm locals retain their owner.
 */
export function resetNativeJogState(state: NativeJogState, rig?: Rig) {
  if (rig && state.baseline) {
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
      rig.bones[name].position.copy(state.baseline.p[index]);
      rig.bones[name].quaternion.copy(state.baseline.q[index]);
    }
    rig.root.updateMatrixWorld(true);
  }
  Object.assign(state, createNativeJogState(), { baseline: undefined, sample: undefined });
}
/** Only the 2.4m/s forward jog was authored. Conservative smooth shoulders
 * [1.6,2.1,2.7,3.2]m/s attenuate it; drive/brake and sharp turns keep their existing take. */
export function nativeJogWeight(input: ReviewMotionInput) {
  if (input.kind !== 'run' || input.reducedMotion || !Number.isFinite(input.speed)) return 0;
  return (
    smooth((input.speed - 1.6) / 0.5) *
    (1 - smooth((input.speed - 2.7) / 0.5)) *
    (1 - smooth((Math.abs(input.acceleration ?? 0) - 0.35) / 2.65)) *
    (1 - smooth((Math.abs(input.turn ?? 0) - 0.04) / 0.31))
  );
}
/** Call once per released frame, before the accepted arm transition owner. */
export function prepareNativeJog(state: NativeJogState, input: ReviewMotionInput) {
  const target = nativeJogWeight(input);
  const dt = Math.max(0, Math.min(0.1, input.deltaSeconds ?? 0));
  // Start at the current take for deterministic seeks; subsequent dt0 observations freeze history.
  if (!state.initialized) {
    state.weight = target;
    state.initialized = true;
  } else state.weight += (target - state.weight) * (1 - Math.exp(-dt / 0.12));
  state.sample = input.kind === 'run' ? sampleNativeJog(input.phase) : undefined;
  state.appliedWeight = 0;
  return input.kind === 'run' ? state.weight : 0;
}
/** Native absolute arms are targets of the existing transition owner, so an
 * interrupted run -> action -> run starts from the last actually applied locals. */
export function nativeJogArmTargets(
  input: ReviewMotionInput,
  targets: Partial<Record<BoneName, readonly [number, number, number]>>
) {
  const weight = input.nativeJogWeight ?? 0;
  if (!weight) return targets;
  const result = { ...targets };
  const sample = input.nativeJogSample ?? sampleNativeJog(input.phase);
  for (const name of [
    'upperArmL',
    'foreArmL',
    'handL',
    'upperArmR',
    'foreArmR',
    'handR',
  ] as const) {
    const angles = targets[name];
    const q = angles
      ? new THREE.Quaternion().setFromEuler(
          new THREE.Euler(...(angles as [number, number, number]))
        )
      : new THREE.Quaternion();
    q.slerp(sample.upper[name]!, weight);
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    result[name] = [e.x, e.y, e.z] as const;
  }
  return result;
}
/** AFTER the original final plant, freeze actual full foot/toe transforms. Never
 * call plantRunFeet again: its hips-yaw pivot/release decisions remain authoritative. */
export function applyNativeJogAfterPlant(
  rig: Rig,
  state: NativeJogState,
  input: ReviewMotionInput,
  owner?: ReviewMotionState
) {
  state.baseline = capture(rig);
  const requested = input.kind === 'run' ? state.weight : 0;
  const sample = state.sample;
  if (!requested || !sample) {
    state.appliedWeight = 0;
    return 0;
  }
  const hips = rig.bones.hips;
  const basePosition = hips.position.clone(),
    baseRotation = hips.quaternion.clone();
  const scale = rig.root.getWorldScale(new THREE.Vector3()).y;
  const rootRotation = rig.root.getWorldQuaternion(new THREE.Quaternion());
  const feet = (['L', 'R'] as const).map((side) => ({
    side,
    target: rig.bones[`foot${side}`].getWorldPosition(new THREE.Vector3()),
    rotation: rig.bones[`foot${side}`].getWorldQuaternion(new THREE.Quaternion()),
    toe: rig.bones[`toe${side}`].quaternion.clone(),
  }));
  const setHips = (weight: number) => {
    hips.position.copy(basePosition).lerp(sample.pelvis, weight);
    hips.quaternion.copy(baseRotation).slerp(sample.rotation, weight);
    rig.root.updateMatrixWorld(true);
  };
  const reachable = () =>
    feet.every(({ side, target }) => {
      const d = rig.bones[`upperLeg${side}`]
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(target);
      return (
        d <= (DIM.thigh + DIM.shin) * scale * 0.9995 &&
        d >= Math.abs(DIM.thigh - DIM.shin) * scale + 0.001
      );
    });
  setHips(requested);
  let weight = requested;
  if (!reachable()) {
    setHips(0);
    if (!reachable()) weight = 0;
    else {
      let lo = 0,
        hi = requested;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        setHips(mid);
        if (reachable()) lo = mid;
        else hi = mid;
      }
      weight = lo;
    }
    setHips(weight);
  }
  if (weight <= 1e-7) {
    setHips(0);
    state.appliedWeight = 0;
    return 0;
  }
  for (const { side, target, rotation, toe } of feet) {
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
    // Blend bend direction in world space, preserving the current knee as the zero-weight limit.
    const hip = rig.bones[`upperLeg${side}`].getWorldPosition(new THREE.Vector3());
    const knee = rig.bones[`lowerLeg${side}`].getWorldPosition(new THREE.Vector3());
    const pole = knee
      .sub(hip)
      .normalize()
      .lerp(sample.poles[side].clone().applyQuaternion(rootRotation), weight)
      .normalize();
    solveTwoBone(
      rig.bones[`upperLeg${side}`],
      rig.bones[`lowerLeg${side}`],
      DIM.thigh * scale,
      DIM.shin * scale,
      target,
      pole,
      forward
    );
    setWorldQuaternion(rig.bones[`foot${side}`], rotation);
    rig.bones[`toe${side}`].quaternion.copy(toe);
  }
  for (const name of ['spine', 'chest', 'neck', 'head'] as const) {
    const bone = rig.bones[name],
      before = bone.quaternion.clone();
    bone.quaternion.slerp(sample.upper[name]!, weight);
    if (owner) {
      const old = owner.posture[name] ?? [0, 0, 0];
      const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(...old));
      const base = before.multiply(delta.invert());
      const e = new THREE.Euler().setFromQuaternion(base.invert().multiply(bone.quaternion), 'XYZ');
      owner.posture[name] = [e.x, e.y, e.z];
    }
  }
  rig.root.updateMatrixWorld(true);
  state.appliedWeight = weight;
  return weight;
}
/** Run after legacy hand targets and before the pool's existing temporal filter. */
export function poseNativeJogFingers(rig: Rig, state: NativeJogState) {
  if (!state.sample || !state.appliedWeight) return;
  for (const [name, q] of Object.entries(state.sample.upper))
    if (finger(name)) rig.bones[name as BoneName].quaternion.slerp(q!, state.appliedWeight);
}
