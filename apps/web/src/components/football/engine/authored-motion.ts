import * as THREE from 'three';
import bundle from './authored-motion-clips.json';
import type { Rig } from './rig';

export type AuthoredMotionName =
  | 'run' | 'acceleration' | 'plantedTurn' | 'idle' | 'kick' | 'keeperReady' | 'keeperDive'
  | 'celebrate' | 'celebrateWings' | 'celebrateSlide' | 'celebrateLeap' | 'celebrateHug'
  | 'dejected' | 'runSwing';
export interface AuthoredMotionOptions {
  /** Blend an authored posture into the current pose. The caller resets its base each frame. */
  weight?: number;
  /** Mirror left/right joints and yaw/roll for left-foot strikes or rightward dives. */
  mirror?: boolean;
  /** Rotation amplitude; used to adapt the authored run to walking/sprinting. */
  strength?: number;
  /** Preserve the support solver's pelvis translation while using authored pelvis rotation. */
  preserveHipsPosition?: boolean;
}
type Control = { dimension: number; keys: Array<[number, number[], number[]]> };
type RuntimeMotion = {
  clip: THREE.AnimationClip;
  loop: boolean;
  controls: Record<string, Control>;
  tracks: Array<{ name: string; property: 'position' | 'quaternion'; interpolant: THREE.Interpolant }>;
};
const motions = Object.fromEntries(bundle.clips.map((definition) => {
  const blendMode = definition.clip.blendMode;
  if (blendMode !== THREE.NormalAnimationBlendMode && blendMode !== THREE.AdditiveAnimationBlendMode)
    throw new Error(`Unsupported authored blend mode: ${blendMode}`);
  const clip = THREE.AnimationClip.parse({ ...definition.clip, blendMode, tracks: definition.clip.tracks.map((track) => {
    const interpolation = ('interpolation' in track ? track.interpolation : undefined) ?? THREE.InterpolateLinear;
    if (interpolation !== THREE.InterpolateLinear && interpolation !== THREE.InterpolateSmooth && interpolation !== THREE.InterpolateDiscrete)
      throw new Error(`Unsupported authored interpolation mode: ${interpolation}`);
    return { ...track, interpolation };
  }) });
  return [clip.name, {
    clip,
    loop: definition.loop,
    controls: definition.controls as unknown as Record<string, Control>,
    tracks: clip.tracks.filter((track) => bundle.bodyBones.some((name) => track.name.startsWith(`${name}.`))).map((track) => {
      const [name, property] = track.name.split('.');
      if (property !== 'position' && property !== 'quaternion') throw new Error(`Unsupported body track: ${track.name}`);
      return { name, property, interpolant: track.InterpolantFactoryMethodLinear() };
    }),
  }];
})) as unknown as Record<AuthoredMotionName, RuntimeMotion>;
export const AUTHORED_MOTION_NAMES = Object.freeze(Object.keys(motions) as AuthoredMotionName[]);
export const AUTHORED_CONTACT_MARKERS = Object.freeze({ ...bundle.contactMarkers });
export const AUTHORED_MOTION_PROVENANCE = Object.freeze({
  sourceSha256: bundle.sourceSha256, origin: bundle.origin, rig: bundle.rig,
});
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const timeFor = (motion: RuntimeMotion, time: number) =>
  motion.loop ? ((time % motion.clip.duration) + motion.clip.duration) % motion.clip.duration
    : clamp(time, 0, motion.clip.duration);
const target = new THREE.Quaternion();
const scaled = new THREE.Quaternion();

/** Apply actual authored quaternion tracks. World sole/ball/hand IK must run afterwards. */
export function applyAuthoredMotion(rig: Rig, name: AuthoredMotionName, time: number, options: AuthoredMotionOptions = {}) {
  const motion = motions[name];
  const t = timeFor(motion, time);
  const weight = clamp(options.weight ?? 1);
  const strength = clamp(options.strength ?? 1, 0, 1.35);
  for (const track of motion.tracks) {
    const boneName = options.mirror && /[LR]$/.test(track.name)
      ? track.name.slice(0, -1) + (track.name.endsWith('L') ? 'R' : 'L') : track.name;
    const bone = (rig.bones as Record<string, THREE.Bone>)[boneName];
    if (!bone) continue; // Optional adapter joints never affect the core contact rig.
    const values = track.interpolant.evaluate(t);
    if (track.property === 'quaternion') {
      target.fromArray(values).normalize();
      if (options.mirror) target.set(target.x, -target.y, -target.z, target.w);
      scaled.identity().slerp(target, strength);
      bone.quaternion.slerp(scaled, weight);
    } else if (!(options.preserveHipsPosition && track.name === 'hips')) {
      const x = options.mirror ? -values[0] : values[0];
      bone.position.x += (x - bone.position.x) * weight;
      bone.position.y += (values[1] - bone.position.y) * weight;
      bone.position.z += (values[2] - bone.position.z) * weight;
    }
  }
}

/** Curated Hermite IK/gesture controls, including their authored tangent handles. */
export function sampleAuthoredControl(name: AuthoredMotionName, controlName: string, time: number, endpointTangents?: { start?: number[]; end?: number[] }): number[] {
  const motion = motions[name], control = motion.controls[controlName];
  if (!control) return [];
  const t = timeFor(motion, time), keys = control.keys;
  let index = 0;
  while (index < keys.length - 2 && t > keys[index + 1][0]) index++;
  const a = keys[index], b = keys[Math.min(index + 1, keys.length - 1)];
  if (t <= keys[0][0]) return [...keys[0][1]];
  if (t >= keys.at(-1)![0]) return [...keys.at(-1)![1]];
  const span = b[0] - a[0], u = (t - a[0]) / span, u2 = u * u, u3 = u2 * u;
  const da = index === 0 && endpointTangents?.start ? endpointTangents.start : a[2];
  const db = index === keys.length - 2 && endpointTangents?.end ? endpointTangents.end : b[2];
  return a[1].map((v, axis) =>
    (2 * u3 - 3 * u2 + 1) * v + (u3 - 2 * u2 + u) * da[axis] * span
    + (-2 * u3 + 3 * u2) * b[1][axis] + (u3 - u2) * db[axis] * span
  );
}

/** Portable body tracks can also drive a native Three AnimationMixer or offline exporter. */
export function createAuthoredBodyClip(name: AuthoredMotionName): THREE.AnimationClip {
  const motion = motions[name];
  return new THREE.AnimationClip(name, motion.clip.duration,
    motion.clip.tracks.filter((track) => bundle.bodyBones.some((bone) => track.name.startsWith(`${bone}.`))).map((track) => track.clone()));
}
