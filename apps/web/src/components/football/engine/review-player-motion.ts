import * as THREE from 'three';
import poseStudy from './review-authored-poses.json';
import type { ActorState } from './director';
import { reachHand, setWorldQuaternion } from './ik';
import { DIM, type BoneName, type Rig, type Side } from './rig';
import { DIVE_CONTACT, DIVE_DURATION, KICK, diveRoot, type DiveSpec, type KickSpec } from './poses';

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smooth = (v: number) => {
  const u = clamp(v);
  return u * u * (3 - 2 * u);
};
const cycle = (v: number) => ((v % 1) + 1) % 1;
type Angles = readonly [number, number, number];
type Posture = Partial<Record<BoneName, Angles>>;
/** Editable original key-pose study; not imported mocap or an artist-approved take. */
type StudyKey = {
  time: number;
  offsets?: Record<string, number[]>;
  arms?: Record<string, number[]>;
  armOffsets?: Record<string, number[]>;
};
type StudyClip = { duration: number; loop: boolean; keys: StudyKey[] };
type Curve = { times: number[]; values: number[][]; slopes: number[][] };
type CompiledStudy = { duration: number; loop: boolean; tracks: Record<string, Curve> };
function compileStudy(
  duration: number,
  loop: boolean,
  keys: Array<{ time: number; values: Record<string, number[]> }>
): CompiledStudy {
  const tracks: Record<string, Curve> = {};
  const names = new Set(keys.flatMap((key) => Object.keys(key.values)));
  for (const name of names) {
    const times = keys.map((key) => key.time);
    const dimension = keys.find((key) => key.values[name])!.values[name].length;
    const values = keys.map((key) => key.values[name] ?? Array(dimension).fill(0));
    const slope = (at: number, axis: number) => {
      if (loop && at === keys.length - 1) at = 0;
      if (!loop && (at === 0 || at === keys.length - 1)) return 0;
      const before = at === 0 ? keys.length - 2 : at - 1;
      const after = at + 1;
      const lSpan = at === 0 ? duration - times[before] : times[at] - times[before];
      const rSpan = times[after] - times[at];
      const left = (values[at][axis] - values[before][axis]) / lSpan;
      const right = (values[after][axis] - values[at][axis]) / rSpan;
      if (left * right <= 0) return 0;
      const w1 = 2 * rSpan + lSpan,
        w2 = rSpan + 2 * lSpan;
      return (w1 + w2) / (w1 / left + w2 / right);
    };
    tracks[name] = {
      times,
      values,
      slopes: keys.map((_, i) => Array.from({ length: dimension }, (__, axis) => slope(i, axis))),
    };
  }
  return { duration, loop, tracks };
}
const studies = Object.fromEntries(
  Object.entries(poseStudy.clips).map(([name, raw]) => {
    const clip = raw as StudyClip;
    return [
      name,
      compileStudy(
        clip.duration,
        clip.loop,
        clip.keys.map((key) => ({
          time: key.time,
          values: Object.fromEntries(
            ['offsets', 'arms', 'armOffsets'].flatMap((field) =>
              Object.entries(key[field as keyof StudyKey] ?? {}).map(([bone, values]) => [
                field + '.' + bone,
                values as number[],
              ])
            )
          ),
        }))
      ),
    ];
  })
) as Record<keyof typeof poseStudy.clips, CompiledStudy>;
const handStudies = Object.fromEntries(
  Object.entries(poseStudy.hands).map(([name, clip]) => [
    name,
    compileStudy(
      clip.duration,
      clip.loop,
      clip.keys.map((key) => ({
        time: key.time,
        values: { left: key.left, right: key.right },
      }))
    ),
  ])
) as Record<keyof typeof poseStudy.hands, CompiledStudy>;
function sampleStudy(clip: CompiledStudy, time: number): Record<string, number[]> {
  const t = clip.loop ? cycle(time / clip.duration) * clip.duration : clamp(time, 0, clip.duration);
  const sampled: Record<string, number[]> = {};
  for (const [name, curve] of Object.entries(clip.tracks)) {
    const { times, values, slopes } = curve;
    let i = 0;
    while (i < times.length - 2 && t > times[i + 1]) i++;
    const span = times[i + 1] - times[i],
      u = clamp((t - times[i]) / span),
      u2 = u * u,
      u3 = u2 * u;
    sampled[name] = values[i].map(
      (value, axis) =>
        (2 * u3 - 3 * u2 + 1) * value +
        (u3 - 2 * u2 + u) * slopes[i][axis] * span +
        (-2 * u3 + 3 * u2) * values[i + 1][axis] +
        (u3 - u2) * slopes[i + 1][axis] * span
    );
  }
  return sampled;
}
function poseChannels(
  clip: CompiledStudy,
  time: number,
  field: 'offsets' | 'arms' | 'armOffsets'
): Posture {
  return Object.fromEntries(
    Object.entries(sampleStudy(clip, time))
      .filter(([name]) => name.startsWith(field + '.'))
      .map(([name, angles]) => [name.slice(field.length + 1), angles.map(THREE.MathUtils.degToRad)])
  ) as Posture;
}
function addPose(target: Posture, delta: Posture, weight: number) {
  for (const [name, angles] of Object.entries(delta)) {
    const previous = target[name as BoneName] ?? [0, 0, 0];
    target[name as BoneName] = [
      previous[0] + angles[0] * weight,
      previous[1] + angles[1] * weight,
      previous[2] + angles[2] * weight,
    ];
  }
}
function mirrorPose(pose: Posture): Posture {
  return Object.fromEntries(
    Object.entries(pose).map(([name, a]) => [
      /[LR]$/.test(name) ? name.slice(0, -1) + (name.endsWith('L') ? 'R' : 'L') : name,
      [a[0], -a[1], -a[2]],
    ])
  ) as Posture;
}
/** Absolute free-arm targets replace exaggerated shared run carriage on this actor only. */
export function sampleReviewArmTargets(input: ReviewMotionInput): Posture {
  if (input.kind === 'idle') return poseChannels(studies.idle, input.time, 'arms');
  if (input.kind === 'kick') {
    const pose = poseChannels(studies.kick, input.time, 'arms');
    return input.direction === -1 ? mirrorPose(pose) : pose;
  }
  if (input.kind !== 'run') return {};
  const pose = poseChannels(studies.jog, input.phase, 'arms');
  addPose(
    pose,
    poseChannels(studies.drive, input.phase, 'armOffsets'),
    clamp((input.acceleration ?? 0) / 4)
  );
  addPose(
    pose,
    poseChannels(studies.brake, input.phase, 'armOffsets'),
    clamp(-(input.acceleration ?? 0) / 4)
  );
  const turn =
    clamp(input.turn ?? 0, -1, 1) *
    (input.turnPhase === undefined ? 1 : Math.sin(Math.PI * clamp(input.turnPhase)));
  const turnPose = poseChannels(studies.turn, input.phase, 'armOffsets');
  addPose(pose, turn < 0 ? mirrorPose(turnPose) : turnPose, Math.abs(turn));
  return pose;
}
export const REVIEW_AUTHORED_POSE_STUDY = Object.freeze({
  format: poseStudy.format,
  origin: poseStudy.origin,
  markers: Object.freeze({ ...poseStudy.markers }),
  clips: Object.freeze(Object.keys(poseStudy.clips)),
});

const OUTFIELD_REST_ABDUCTION = (5 * Math.PI) / 180;
const restArmLeft = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 0, 1),
  OUTFIELD_REST_ABDUCTION
);
const restArmRight = restArmLeft.clone().invert();
/** Apply once after the freshly sampled fixed outfield base pose, never to a keeper.
 * No animation clock or accumulated offsets: the caller resets the base each frame. */
function applyOutfieldRestingArms(rig: Rig) {
  rig.bones.upperArmL.quaternion.multiply(restArmLeft);
  rig.bones.upperArmR.quaternion.multiply(restArmRight);
  rig.root.updateMatrixWorld(true);
}

/** One review actor owns this decorative history; never share it across rigs. */
export interface ReviewMotionState {
  kind?: ReviewMotionInput['kind'];
  posture: Posture;
  outgoing: Posture;
  arms: Posture;
  outgoingArms: Posture;
  elapsed: number;
  acceleration: number;
  turn: number;
}
export const createReviewMotionState = (): ReviewMotionState => ({
  posture: {},
  outgoing: {},
  arms: {},
  outgoingArms: {},
  elapsed: 1,
  acceleration: 0,
  turn: 0,
});
export function resetReviewMotionState(state: ReviewMotionState) {
  Object.assign(state, createReviewMotionState(), { kind: undefined });
}

export interface ReviewMotionInput {
  kind: ActorState['anim']['kind'];
  /** Absolute seconds for idle/run; unchanged existing clip time for kick/dive. */
  time: number;
  /** Existing distance-driven full stride phase. Never advanced by this adapter. */
  phase: number;
  speed: number;
  /** Signed metres/second squared: positive drive, negative braking. */
  acceleration?: number;
  /** Signed bounded turn effort, independent of root yaw. */
  turn?: number;
  /** Optional normalized progression through a turn (0..1). */
  turnPhase?: number;
  direction?: 1 | -1;
  weight?: number;
  reducedMotion?: boolean;
  /** Optional history from released frames only. Omit for deterministic seek diagnostics. */
  motionState?: ReviewMotionState;
  /** Actual elapsed frame seconds; history does not advance without this value. */
  deltaSeconds?: number;
}

/** Small original posture offsets, not mocap or a replacement authored/contact pipeline. */
export function sampleReviewPlayerPosture(input: ReviewMotionInput): Posture {
  const t = Math.max(0, input.time),
    side = input.direction ?? 1;
  const breathe = Math.sin(t * 1.9),
    sway = Math.sin(t * 0.7);
  if (input.kind === 'idle') return poseChannels(studies.idle, t, 'offsets');
  if (input.kind === 'run') {
    const pose = poseChannels(studies.jog, input.phase, 'offsets');
    addPose(
      pose,
      poseChannels(studies.drive, input.phase, 'offsets'),
      clamp((input.acceleration ?? 0) / 4)
    );
    addPose(
      pose,
      poseChannels(studies.brake, input.phase, 'offsets'),
      clamp(-(input.acceleration ?? 0) / 4)
    );
    const turnWeight =
      clamp(input.turn ?? 0, -1, 1) *
      (input.turnPhase === undefined ? 1 : Math.sin(Math.PI * clamp(input.turnPhase)));
    addPose(pose, poseChannels(studies.turn, input.phase, 'offsets'), turnWeight);
    return pose;
  }
  if (input.kind === 'kick') {
    const pose = poseChannels(studies.kick, t, 'offsets');
    return side < 0 ? mirrorPose(pose) : pose;
  }
  if (input.kind === 'keeperReady')
    return {
      spine: [0.018 + breathe * 0.004, sway * 0.01, 0],
      chest: [-0.012, -sway * 0.01, 0],
      neck: [-0.012, 0, 0],
      head: [0.006, 0, 0],
    };
  if (input.kind === 'keeperDive') {
    const launch = Math.sin(Math.PI * clamp(t / 0.55));
    const landing = Math.sin(Math.PI * clamp((t - 0.55) / 0.45));
    const recover = Math.sin(Math.PI * clamp((t - 1.05) / 0.75));
    // Preserve the exact existing ball-contact pose, and settle to zero by recovery end.
    const envelope = smooth(Math.abs(t - DIVE_CONTACT) / 0.13) * (1 - smooth((t - 1.45) / 0.35));
    return {
      spine: [
        (0.025 * launch + 0.065 * landing - 0.035 * recover) * envelope,
        side * 0.025 * landing * envelope,
        side * (-0.035 * launch + 0.04 * recover) * envelope,
      ],
      chest: [
        (-0.018 * launch - 0.035 * landing + 0.025 * recover) * envelope,
        0,
        side * 0.02 * landing * envelope,
      ],
      neck: [
        (-0.025 * launch - 0.035 * landing + 0.015 * recover) * envelope,
        0,
        side * 0.035 * launch * envelope,
      ],
      head: [0.018 * landing * envelope, -side * 0.02 * landing * envelope, 0],
    };
  }
  return {};
}

/** Transition only decorative offsets, never blend solved leg/hand transforms.
 * The outgoing offset is captured once, avoiding frame-dependent recursive pose blending.
 * A turn/brake filter uses seconds rather than frame count and cannot inspect future states.
 */
function releasedPosture(rig: Rig, input: ReviewMotionInput): Posture {
  const state = input.motionState;
  if (!state) return sampleReviewPlayerPosture(input);
  const dt = clamp(input.deltaSeconds ?? 0, 0, 0.1);
  const first = state.kind === undefined;
  const response = first ? 1 : 1 - Math.exp(-dt / 0.085);
  state.acceleration += (clamp(input.acceleration ?? 0, -4, 4) - state.acceleration) * response;
  state.turn += (clamp(input.turn ?? 0, -1, 1) - state.turn) * response;
  const filtered = { ...input, acceleration: state.acceleration, turn: state.turn };
  const target = sampleReviewPlayerPosture(filtered);
  const armTarget = sampleReviewArmTargets(filtered);
  if (first || input.kind === 'keeperDive' || input.kind === 'keeperReady') {
    state.elapsed = 1;
    state.outgoing = {};
    state.outgoingArms = {};
  } else if (state.kind !== input.kind) {
    state.outgoing = state.posture;
    state.outgoingArms = state.arms;
    state.elapsed = 0;
  }
  state.kind = input.kind;
  state.elapsed += dt;
  const blend = smooth(state.elapsed / 0.2);
  const posture: Posture = {};
  const names = new Set([...Object.keys(target), ...Object.keys(state.outgoing)] as BoneName[]);
  for (const name of names) {
    const a = state.outgoing[name] ?? [0, 0, 0],
      b = target[name] ?? [0, 0, 0];
    posture[name] = [
      a[0] + (b[0] - a[0]) * blend,
      a[1] + (b[1] - a[1]) * blend,
      a[2] + (b[2] - a[2]) * blend,
    ];
  }
  state.arms = {};
  for (const [name, target] of Object.entries(armTarget)) {
    const bone = name as BoneName;
    let from = state.outgoingArms[bone];
    if (!from && blend < 1) {
      // Celebrations have no authored arm target. Freeze the already-blended
      // local pose once, rather than using the incoming target as its own origin.
      // Keeping the applied angles in state.arms also preserves interrupted blends.
      const origin = new THREE.Euler().setFromQuaternion(rig.bones[bone].quaternion, 'XYZ');
      from = state.outgoingArms[bone] = [origin.x, origin.y, origin.z];
    }
    from ??= target;
    state.arms[name as BoneName] = [
      from[0] + (target[0] - from[0]) * blend,
      from[1] + (target[1] - from[1]) * blend,
      from[2] + (target[2] - from[2]) * blend,
    ];
  }
  state.posture = posture;
  return posture;
}

/**
 * Call once after a freshly evaluated base pose/blend and before final foot contacts.
 * Only the explicitly selected review actor should call this. No root, pelvis, lower-body,
 * event, target or clock writes. Keeper wrists retain their exact pre-overlay world targets:
 * reduce torso weight when required for reach, then use the existing IK and wrist rotation.
 */
export function applyReviewPlayerMotion(rig: Rig, input: ReviewMotionInput) {
  const weight = clamp(input.weight ?? 1);
  if (!weight) {
    if (input.motionState) resetReviewMotionState(input.motionState);
    return;
  }
  if (input.reducedMotion) {
    if (input.motionState) resetReviewMotionState(input.motionState);
    // Reduced outfield players use only the same fixed 5-degree rest correction.
    // Keeper wrist targets and all breathing/transition motion remain untouched.
    if (input.kind !== 'keeperReady' && input.kind !== 'keeperDive') applyOutfieldRestingArms(rig);
    return;
  }
  const posture = releasedPosture(rig, input);
  const rotate = (name: BoneName, angles: Angles, w: number) =>
    rig.bones[name].quaternion.multiply(
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(angles[0] * w, angles[1] * w, angles[2] * w, 'XYZ')
      )
    );
  const keeper = input.kind === 'keeperReady' || input.kind === 'keeperDive';
  if (!keeper) {
    for (const [name, angles] of Object.entries(posture)) rotate(name as BoneName, angles, weight);
    const arms = input.motionState?.arms ?? sampleReviewArmTargets(input);
    for (const [name, angles] of Object.entries(arms))
      rig.bones[name as BoneName].quaternion.slerp(
        reviewArmTarget.setFromEuler(reviewArmEuler.set(...angles)),
        weight
      );
    rig.root.updateMatrixWorld(true);
    return;
  }
  rig.root.updateMatrixWorld(true);
  const wrists = (['L', 'R'] as Side[]).map((side) => ({
    side,
    target: rig.bones[`hand${side}`].getWorldPosition(new THREE.Vector3()),
    rotation: rig.bones[`hand${side}`].getWorldQuaternion(new THREE.Quaternion()),
  }));
  const torso = (['spine', 'chest'] as const).map((name) => ({
    name,
    q: rig.bones[name].quaternion.clone(),
  }));
  const scale = rig.root.getWorldScale(new THREE.Vector3()).y;
  const maxReach = (DIM.upperArm + DIM.foreArm) * scale * 0.9995;
  const minReach = Math.abs(DIM.upperArm - DIM.foreArm) * scale + 0.001;
  const applyTorso = (w: number) => {
    for (const { name, q } of torso) {
      rig.bones[name].quaternion.copy(q);
      if (posture[name]) rotate(name, posture[name]!, w);
    }
    rig.root.updateMatrixWorld(true);
  };
  const reachable = () =>
    wrists.every(({ side, target }) => {
      const distance = rig.bones[`upperArm${side}`]
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(target);
      return distance <= maxReach && distance >= minReach;
    });
  applyTorso(weight);
  let torsoWeight = weight;
  if (!reachable()) {
    // A near-extended arm must retain its contact instead of silently stretching to a new target.
    let lo = 0,
      hi = weight;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      applyTorso(mid);
      if (reachable()) lo = mid;
      else hi = mid;
    }
    torsoWeight = lo;
    applyTorso(torsoWeight);
  }
  for (const name of ['neck', 'head'] as const)
    if (posture[name]) rotate(name, posture[name]!, weight);
  // At the exact interception marker every offset is zero. Avoid even a redundant IK roundtrip.
  if (torsoWeight > 0 && torso.some(({ name }) => posture[name]?.some((v) => v !== 0)))
    for (const { side, target, rotation } of wrists) {
      reachHand(rig, side, target, new THREE.Vector3(0, -1, 0.2));
      setWorldQuaternion(rig.bones[`hand${side}`], rotation);
    }
  rig.root.updateMatrixWorld(true);
}

export const REVIEW_MOTION_SCENARIOS = [
  'idle',
  'jog',
  'acceleration',
  'deceleration',
  'plantedTurn',
  'kick',
  'keeperDive',
] as const;
export type ReviewMotionScenario = (typeof REVIEW_MOTION_SCENARIOS)[number];
export interface ReviewMotionSample {
  label: string;
  duration: number;
  position: { x: number; y: number; z: number };
  heading: number;
  distance: number;
  phase: number;
  speed: number;
  motion: ReviewMotionInput;
  keeperSpec?: DiveSpec;
}

/** Diagnostic only: continuous paths and an analytic distance/cadence integral, no frame history. */
export function sampleReviewMotionScenario(
  scenario: ReviewMotionScenario,
  seconds: number
): ReviewMotionSample {
  const durations: Record<ReviewMotionScenario, number> = {
    idle: 3,
    jog: 3,
    acceleration: 3,
    deceleration: 3,
    plantedTurn: 2.6,
    kick: KICK.duration,
    keeperDive: DIVE_DURATION,
  };
  const duration = durations[scenario],
    t = clamp(seconds, 0, duration);
  let speed = 0,
    distance = 0,
    heading = 0,
    acceleration = 0,
    turn = 0;
  let position = { x: 0, y: 0, z: 0 },
    kind: ReviewMotionInput['kind'] = 'idle';
  let label: string = scenario,
    turnPhase: number | undefined,
    keeperSpec: DiveSpec | undefined;
  if (scenario === 'jog' || scenario === 'plantedTurn') {
    kind = 'run';
    speed = 2.4;
    distance = t * speed;
    if (scenario === 'jog') {
      label = 'Jog - alternating support';
      position.z = distance;
    } else {
      const start = 0.6,
        turnDuration = 1.4,
        angle = Math.PI / 2,
        radius = (speed * turnDuration) / angle;
      turnPhase = clamp((t - start) / turnDuration);
      heading = angle * turnPhase;
      turn = t > start && t < start + turnDuration ? 1 : 0;
      const exit = Math.max(0, t - start - turnDuration) * speed;
      position = {
        x: radius * (1 - Math.cos(heading)) + exit,
        y: 0,
        z: Math.min(t, start) * speed + radius * Math.sin(heading),
      };
      label =
        t < start
          ? 'Turn approach'
          : t < start + turnDuration
            ? 'Moving planted quarter-turn'
            : 'Turn exit';
    }
  } else if (scenario === 'acceleration' || scenario === 'deceleration') {
    kind = 'run';
    const ramp = 1.8,
      u = clamp(t / ramp),
      delta = 3.2;
    const integral = ramp * (u ** 3 - 0.5 * u ** 4) + Math.max(0, t - ramp);
    const rampSlope = t < ramp ? (6 * u * (1 - u)) / ramp : 0;
    const accelerating = scenario === 'acceleration';
    speed = accelerating ? 1.2 + delta * smooth(u) : 4.4 - delta * smooth(u);
    distance = accelerating ? 1.2 * t + delta * integral : 4.4 * t - delta * integral;
    acceleration = (accelerating ? 1 : -1) * delta * rampSlope;
    position.z = distance;
    label = accelerating ? 'Acceleration - forward drive' : 'Deceleration - braking posture';
  } else if (scenario === 'kick') {
    kind = 'kick';
    label =
      t < KICK.contact
        ? 'Kick load'
        : t === KICK.contact
          ? 'Kick contact (0.30s)'
          : 'Kick follow-through';
  } else if (scenario === 'keeperDive') {
    kind = 'keeperDive';
    keeperSpec = { direction: 1, reach: 1.15, height: 1.1 };
    const root = diveRoot(keeperSpec, t);
    position = { x: root.x, y: root.y, z: root.z };
    label =
      t < 0.16
        ? 'Keeper load'
        : t < 0.55
          ? 'Keeper launch / interception'
          : t < 1.05
            ? 'Keeper landing'
            : 'Keeper recovery';
  } else label = 'Idle - breathing / weight shift';
  // All moving scenarios remain above the minimum-stride threshold; v/stride(v)=1.45+0.085v.
  const phase = kind === 'run' ? 1.45 * t + 0.085 * distance : 0;
  return {
    label,
    duration,
    position,
    heading,
    distance,
    phase,
    speed,
    keeperSpec,
    motion: { kind, time: t, phase, speed, acceleration, turn, turnPhase, direction: 1 },
  };
}

export const REVIEW_FINISHING_JOINS = [1.8, 3, 4.4, 6.2, 6.8] as const;
export const REVIEW_FINISHING_DURATION = 6.8 + KICK.duration;
export interface ReviewFinishingSample extends ReviewMotionSample {
  kickSpec?: KickSpec;
}

/** One continuous diagnostic journey. These clocks decorate simulated diagnostics,
 * and never feed the match director or predict a released result. */
export function sampleReviewFinishingSequence(seconds: number): ReviewFinishingSample {
  const t = clamp(seconds, 0, REVIEW_FINISHING_DURATION);
  const accelerationEnd = sampleReviewMotionScenario('acceleration', 1.8);
  const v = accelerationEnd.speed,
    beforeTurn = accelerationEnd.distance + 1.2 * v;
  const turnDuration = 1.4,
    radius = (v * turnDuration) / (Math.PI / 2);
  const turnDistance = turnDuration * v,
    beforeBrake = beforeTurn + turnDistance;
  const brakeDuration = 1.8;
  const brakeDistance = (u: number) => v * brakeDuration * (u - u ** 3 + 0.5 * u ** 4);
  const end = { x: radius + brakeDistance(1), y: 0, z: beforeTurn + radius };
  const dir = new THREE.Vector3(1, 0, 0),
    left = new THREE.Vector3(0, 0, -1);
  const kickSpec: KickSpec = {
    ball: new THREE.Vector3(end.x, 0.11, end.z)
      .addScaledVector(dir, 0.11)
      .addScaledVector(left, -0.14),
    dir,
    foot: 'R',
    power: 0.75,
    loft: 0.2,
  };
  let speed = 0,
    distance = beforeBrake + brakeDistance(1),
    heading = Math.PI / 2;
  let position = { ...end },
    phase = 0,
    acceleration = 0,
    turn = 0,
    turnPhase: number | undefined;
  let kind: ReviewMotionInput['kind'] = 'run',
    label = 'Acceleration — forward drive';
  if (t < 1.8) {
    const sample = sampleReviewMotionScenario('acceleration', t);
    return { ...sample, duration: REVIEW_FINISHING_DURATION, kickSpec };
  }
  if (t < 3) {
    const local = t - 1.8;
    speed = v;
    distance = accelerationEnd.distance + local * v;
    heading = 0;
    position = { x: 0, y: 0, z: distance };
    label = 'Jog — approach';
  } else if (t < 4.4) {
    const sample = sampleReviewMotionScenario('plantedTurn', t - 3 + 0.6);
    const scale = v / sample.speed;
    speed = v;
    distance = beforeTurn + (t - 3) * v;
    heading = sample.heading;
    position = {
      x: sample.position.x * scale,
      y: 0,
      z: beforeTurn + (sample.position.z - 0.6 * sample.speed) * scale,
    };
    turn = 1;
    turnPhase = (t - 3) / turnDuration;
    label = 'Moving quarter-turn';
  } else if (t < 6.2) {
    const u = (t - 4.4) / brakeDuration;
    speed = v * (1 - smooth(u));
    acceleration = (-v * 6 * u * (1 - u)) / brakeDuration;
    distance = beforeBrake + brakeDistance(u);
    position = { x: radius + brakeDistance(u), y: 0, z: end.z };
    label = 'Braking — settle';
  } else {
    kind = t < 6.8 ? 'idle' : 'kick';
    label = kind === 'idle' ? 'Settled idle' : 'Kick — load / contact / follow-through';
  }
  // Integrate exact cadence: v/stride(v) = min(2.5v, 1.45+.085v).
  // The smooth brake crosses the minimum-stride threshold once. Solve its fixed
  // split independently of frame history, then use the analytic distance primitive.
  const threshold = 0.58 / 0.966;
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (v * (1 - smooth(mid)) > threshold) lo = mid;
    else hi = mid;
  }
  const split = (lo + hi) / 2,
    u = clamp((t - 4.4) / brakeDuration),
    fast = Math.min(u, split);
  const brakePhase =
    1.45 * brakeDuration * fast +
    0.085 * brakeDistance(fast) +
    Math.max(0, brakeDistance(u) - brakeDistance(split)) / 0.4;
  phase = t <= 4.4 ? 1.45 * t + 0.085 * distance : 1.45 * 4.4 + 0.085 * beforeBrake + brakePhase;
  return {
    label,
    duration: REVIEW_FINISHING_DURATION,
    position,
    heading,
    distance,
    phase,
    speed,
    kickSpec,
    motion: {
      kind,
      time: kind === 'kick' ? t - 6.8 : t,
      phase,
      speed,
      acceleration,
      turn,
      turnPhase,
      direction: 1,
    },
  };
}

const reviewArmEuler = new THREE.Euler(),
  reviewArmTarget = new THREE.Quaternion();
const reviewFingerEuler = new THREE.Euler();
/** Natural relaxed cascade/opposition on the review actor only. Wrist/palm and
 * contact targets stay untouched; reduced motion uses one fixed resting pose. */
export function poseReviewPlayerHands(
  rig: Rig,
  kind: ActorState['anim']['kind'],
  moving: boolean,
  phase = 0,
  action?: { time: number; direction?: 1 | -1 }
) {
  const keeper = kind === 'keeperDive' || kind === 'keeperReady';
  const clip = !moving
    ? handStudies.fixedRest
    : keeper
      ? handStudies.keeper
      : kind === 'run'
        ? handStudies.run
        : kind === 'kick'
          ? handStudies.kick
          : handStudies.idle;
  const time = kind === 'run' ? phase : kind === 'kick' ? (action?.time ?? 0) : 0;
  const hands = sampleStudy(clip, moving ? time : 0);
  const fingers = ['index', 'middle', 'ring', 'pinky'] as const;
  for (const side of ['L', 'R'] as const) {
    const mirrored = moving && kind === 'kick' && action?.direction === -1;
    const channel = (side === 'L') !== mirrored ? hands.left : hands.right;
    const values = channel.map(THREE.MathUtils.degToRad);
    const sign = side === 'L' ? 1 : -1;
    fingers.forEach((finger, digit) => {
      for (let joint = 1; joint <= 3; joint++) {
        const bend = values[digit] * (joint === 1 ? 0.55 : joint === 2 ? 1 : 0.72);
        const splay = joint === 1 ? sign * (digit - 1.1) * values[7] : 0;
        rig.bones[`${finger}${joint}${side}` as BoneName].quaternion.setFromEuler(
          reviewFingerEuler.set(-bend, 0, splay)
        );
      }
    });
    for (let joint = 1; joint <= 3; joint++)
      rig.bones[`thumb${joint}${side}` as BoneName].quaternion.setFromEuler(
        reviewFingerEuler.set(
          -values[4] * (joint === 1 ? 0.55 : joint === 2 ? 1 : 0.75),
          sign * values[5] * (joint === 1 ? 1 : joint === 2 ? 0.2 : 0.05),
          sign * values[6] * (joint === 1 ? 1 : joint === 2 ? 0.3 : 0)
        )
      );
  }
}
