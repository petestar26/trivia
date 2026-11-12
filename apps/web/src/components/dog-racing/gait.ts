/**
 * Original procedural greyhound skeleton and rotary-gallop gait.
 *
 * Everything here is plain 2D math in the dog's own sagittal plane, in real
 * anatomical metres: +x forward, +y up, ground at y = 0. The renderer scales
 * the result by GREYHOUND_SCALE. No animation clips, captured motion or
 * third-party rigs are used. The gait is driven only by distance the dog has
 * actually travelled along its already-published position, so a planted paw
 * stays fixed on the ground and the stride never runs ahead of the race state.
 */

export type V2 = { x: number; y: number };
export const GREYHOUND_SCALE = 1.25;

const p = (x: number, y: number): V2 => ({ x, y });
const angle = (a: V2, b: V2) => Math.atan2(b.y - a.y, b.x - a.x);
const dist = (a: V2, b: V2) => Math.hypot(b.x - a.x, b.y - a.y);
const dir = (t: number, length = 1): V2 => ({ x: Math.cos(t) * length, y: Math.sin(t) * length });
const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap = (x: number) => x - Math.floor(x);

/** Spine joints, tail root to nose. Bone i runs from joint i to joint i + 1. */
export const SPINE_JOINTS: readonly V2[] = [
  p(-0.335, 0.645), // sacrum / tail root
  p(-0.185, 0.672), // lumbosacral
  p(-0.075, 0.69), // mid loin
  p(0.03, 0.693), // thoracolumbar: the fixed anchor
  p(0.15, 0.7), // mid thorax
  p(0.265, 0.718), // withers
  p(0.36, 0.805), // mid neck
  p(0.44, 0.9), // occiput
  p(0.69, 0.838), // nose tip
];
export const SPINE_BONES = [
  'pelvis',
  'lumbar1',
  'lumbar2',
  'thorax1',
  'thorax2',
  'neck1',
  'neck2',
  'head',
] as const;
const ANCHOR = 3;

export const TAIL_JOINTS: readonly V2[] = [
  p(-0.335, 0.645),
  p(-0.42, 0.578),
  p(-0.478, 0.482),
  p(-0.512, 0.372),
  p(-0.522, 0.262),
  p(-0.503, 0.172),
];
export const TAIL_BONES = ['tail0', 'tail1', 'tail2', 'tail3', 'tail4'] as const;

/** Leg joints in bind pose. Front: scapula top, shoulder, elbow, carpus, paw ball, toe tip. */
export const FRONT_JOINTS: readonly V2[] = [
  p(0.215, 0.665),
  p(0.305, 0.47),
  p(0.215, 0.315),
  p(0.225, 0.09),
  p(0.248, 0.03),
  p(0.3, 0.008),
];
/** Rear: hip, stifle, hock, paw ball, toe tip. */
export const REAR_JOINTS: readonly V2[] = [
  p(-0.25, 0.585),
  p(-0.15, 0.39),
  p(-0.33, 0.165),
  p(-0.312, 0.03),
  p(-0.262, 0.008),
];
export const FRONT_BONES = ['scapula', 'humerus', 'radius', 'metacarpus', 'forepaw'] as const;
export const REAR_BONES = ['femur', 'tibia', 'metatarsus', 'hindpaw'] as const;
/** Lateral offsets of each leg plane at the top and at the paw. */
export const LEG_Z = { front: [0.085, 0.06], rear: [0.085, 0.064] } as const;

export type LimbName = 'leftHind' | 'rightHind' | 'rightFore' | 'leftFore';
/**
 * Rotary gallop, as greyhounds and cheetahs run: left hind, right hind, right fore,
 * left fore, then a gathered flight with the spine flexed. The extended flight sits
 * between the hind lift-off and fore touchdown. The left (inside) fore leads, as on a
 * left-handed oval.
 */
export const FOOTFALLS: Record<LimbName, { touch: number; lift: number }> = {
  leftHind: { touch: 0, lift: 0.235 },
  rightHind: { touch: 0.075, lift: 0.31 },
  rightFore: { touch: 0.44, lift: 0.65 },
  leftFore: { touch: 0.515, lift: 0.725 },
};
export const LIMBS: readonly { name: LimbName; side: 1 | -1; rear: boolean }[] = [
  { name: 'leftHind', side: -1, rear: true },
  { name: 'rightHind', side: 1, rear: true },
  { name: 'rightFore', side: 1, rear: false },
  { name: 'leftFore', side: -1, rear: false },
];

/** Stride frequency rises gently with speed; length follows. Real m/s in, Hz and metres out. */
export function strideFor(speed: number) {
  const frequency = Math.max(2.4, Math.min(3.8, 2.4 + 0.09 * speed));
  return { frequency, length: Math.max(0.35, speed / frequency) };
}

const lengths = (joints: readonly V2[]) =>
  joints.slice(1).map((joint, i) => dist(joints[i], joint));
const angles = (joints: readonly V2[]) =>
  joints.slice(1).map((joint, i) => angle(joints[i], joint));
const SPINE_LENGTH = lengths(SPINE_JOINTS),
  SPINE_ANGLE = angles(SPINE_JOINTS),
  TAIL_LENGTH = lengths(TAIL_JOINTS),
  TAIL_ANGLE = angles(TAIL_JOINTS),
  FRONT_LENGTH = lengths(FRONT_JOINTS),
  FRONT_ANGLE = angles(FRONT_JOINTS),
  REAR_LENGTH = lengths(REAR_JOINTS),
  REAR_ANGLE = angles(REAR_JOINTS);
/** Attachments expressed in the frame of the bone that carries them. */
function local(origin: V2, boneAngle: number, point: V2): V2 {
  const dx = point.x - origin.x,
    dy = point.y - origin.y,
    c = Math.cos(-boneAngle),
    s = Math.sin(-boneAngle);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}
function place(origin: V2, boneAngle: number, offset: V2): V2 {
  const c = Math.cos(boneAngle),
    s = Math.sin(boneAngle);
  return { x: origin.x + offset.x * c - offset.y * s, y: origin.y + offset.x * s + offset.y * c };
}
const SCAPULA_ON_THORAX = local(SPINE_JOINTS[4], SPINE_ANGLE[4], FRONT_JOINTS[0]);
const HIP_ON_PELVIS = local(SPINE_JOINTS[0], SPINE_ANGLE[0], REAR_JOINTS[0]);
const KAPPA_BIND = FRONT_ANGLE[3] - FRONT_ANGLE[2];
const DELTA_BIND = REAR_ANGLE[2] - REAR_ANGLE[0];
const FRONT_STAND = FRONT_JOINTS[5],
  REAR_STAND = REAR_JOINTS[4];
const TOE_STAND = { front: FRONT_ANGLE[4], rear: REAR_ANGLE[3] };

/** Two-link inverse kinematics; bend > 0 places the joint on the cranial side of the reach. */
function solve(start: V2, target: V2, a: number, b: number, bend: 1 | -1) {
  const reach = Math.max(Math.abs(a - b) + 1e-4, Math.min(a + b - 1e-4, dist(start, target)));
  const base = angle(start, target),
    inner = Math.acos(Math.max(-1, Math.min(1, (a * a + reach * reach - b * b) / (2 * a * reach))));
  const first = base + bend * inner,
    joint = add(start, dir(first, a)),
    end = add(start, dir(base, reach));
  return { first, joint, second: angle(joint, end), end };
}

export type BonePose = { start: V2; angle: number };
export type GreyhoundPose = Record<string, BonePose> & {
  /** Toe-tip contact flags for each limb, for tests and dust. */
  contact?: Record<LimbName, boolean>;
};

export type GaitInput = {
  /** Stride fraction, accumulated from travelled distance. */
  phase: number;
  /** Real metres per second, smoothed. */
  speed: number;
  /** 0 standing, 1 full gallop. */
  run: number;
  /** Seconds, for idle breathing only. */
  time: number;
  /** Per-runner idle offset so the field does not breathe in unison. */
  seed?: number;
};

function swing(s: number, rear: boolean) {
  // Hermite lift: the paw trails, folds high under the body, then reaches and lands.
  const h = rear ? 0.2 : 0.235,
    shape = Math.pow(Math.sin(Math.PI * Math.pow(s, rear ? 0.72 : 0.8)), 1.15);
  return h * shape;
}
function hermite(x0: number, x1: number, m0: number, m1: number, s: number) {
  const s2 = s * s,
    s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * x0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * x1 + (s3 - s2) * m1
  );
}

type LimbState = { tip: V2; toe: number; fold: number; contact: boolean };
/** Paw target, toe angle and joint fold for one limb, in the dog's ground frame. */
export function limbState(name: LimbName, phase: number, length: number): LimbState {
  const { touch, lift } = FOOTFALLS[name],
    rear = name.endsWith('Hind'),
    duty = lift - touch,
    local = wrap(phase - touch),
    sweep = length * duty,
    centre = rear ? -0.2 : 0.255;
  if (local < duty) {
    const t = local / duty;
    // Linear in phase, so the planted toe tip stays fixed relative to the ground.
    return {
      tip: p(centre + sweep * (0.5 - t), 0.008),
      toe: lerp(rear ? -0.18 : -0.12, rear ? -0.85 : -0.9, smoothstep(0.45, 1, t)),
      fold: rear ? lerp(0.08, -0.12, t) : lerp(0.05, -0.1, t),
      contact: true,
    };
  }
  const s = (local - duty) / (1 - duty),
    tangent = -0.42 * length * (1 - duty);
  const x = hermite(centre - sweep / 2, centre + sweep / 2, tangent, tangent, s);
  const curl = rear ? -2.25 : -2.6;
  const toe =
    s < 0.32
      ? lerp(rear ? -0.85 : -0.9, curl, smoothstep(0, 0.32, s))
      : lerp(curl, rear ? -0.18 : -0.12, smoothstep(0.32, 0.88, s));
  const fold = Math.sin(Math.PI * Math.min(1, s / 0.78)) * (s < 0.78 ? 1 : 0);
  return { tip: p(x, 0.008 + swing(s, rear)), toe, fold, contact: false };
}

/** Full skeleton pose for one frame. */
export function poseGreyhound(input: GaitInput): GreyhoundPose {
  const run = Math.max(0, Math.min(1, input.run)),
    phase = wrap(input.phase),
    seed = input.seed ?? 0,
    breathe = Math.sin(input.time * 2.1 + seed * 5) * (1 - run);
  const { length } = strideFor(Math.max(0.5, input.speed));
  // Spine: flexed in gathered flight (just before the hind touchdown), extended in
  // extended flight. Pitch and bounce are small; the head is stabilised against both.
  const wave = Math.cos(2 * Math.PI * (phase - 0.93));
  // Strong lumbar flexion when gathered, a gentler stretch when extended.
  const flex = (wave > 0 ? wave : wave * 0.45) * run;
  const pitch = Math.sin(2 * Math.PI * (phase - 0.6)) * 0.045 * run;
  const bob = (Math.cos(4 * Math.PI * (phase - 0.39)) * 0.02 - 0.035) * run + breathe * 0.002;
  const back = [0.36, 0.28, 0.15];
  const spineAngles = SPINE_ANGLE.map((bind, i) => {
    if (i < ANCHOR) return bind + back[i] * flex;
    if (i === 3) return bind - 0.02 * flex;
    if (i === 4) return bind - 0.05 * flex + breathe * 0.004;
    return bind;
  });
  // Running carriage: neck lowered and stretched, nose forward; standing: head up and alert.
  const look = Math.sin(input.time * 0.45 + seed * 3.1) * (1 - run);
  spineAngles[5] = lerp(SPINE_ANGLE[5], 0.36, run) + 0.03 * flex;
  spineAngles[6] = lerp(SPINE_ANGLE[6] + look * 0.05, 0.42, run) + 0.02 * flex;
  spineAngles[7] =
    lerp(SPINE_ANGLE[7] + look * 0.08, -0.17, run) -
    pitch * 0.8 -
    0.04 * Math.sin(4 * Math.PI * phase) * run;
  const joints: V2[] = SPINE_JOINTS.map((j) => ({ ...j }));
  for (let i = ANCHOR - 1; i >= 0; i--)
    joints[i] = add(joints[i + 1], dir(spineAngles[i] + Math.PI, SPINE_LENGTH[i]));
  for (let i = ANCHOR; i < SPINE_LENGTH.length; i++)
    joints[i + 1] = add(joints[i], dir(spineAngles[i], SPINE_LENGTH[i]));
  // Whole-body pitch about the chest and vertical bounce.
  const pivot = p(0.02, 0.56),
    c = Math.cos(pitch),
    s = Math.sin(pitch);
  const body = (v: V2): V2 => ({
    x: pivot.x + (v.x - pivot.x) * c - (v.y - pivot.y) * s,
    y: pivot.y + (v.x - pivot.x) * s + (v.y - pivot.y) * c + bob,
  });
  const pose: GreyhoundPose = {} as GreyhoundPose;
  SPINE_BONES.forEach((name, i) => {
    pose[name] = { start: body(joints[i]), angle: spineAngles[i] + pitch };
  });
  // Tail streams behind at speed, hangs low at rest, and lags the spine.
  const pelvisAngle = spineAngles[0] + pitch;
  let tailStart = pose.pelvis.start;
  TAIL_BONES.forEach((name, i) => {
    const wave = Math.sin(2 * Math.PI * (phase - 0.08 * i) + 0.6) * (0.06 + 0.07 * i) * run;
    const rest = TAIL_ANGLE[i] - SPINE_ANGLE[0];
    // Relative to the pelvis: streaming back, slightly low, the tip lifting as a rudder.
    const running = [-2.5, -2.72, -2.96, -3.22, -3.5][i] - (pelvisAngle - SPINE_ANGLE[0]) * 0.5;
    const a =
      pelvisAngle +
      lerp(rest, running, run) +
      wave +
      Math.sin(input.time * 1.3 + seed) * 0.03 * (1 - run);
    pose[name] = { start: tailStart, angle: a };
    tailStart = add(tailStart, dir(a, TAIL_LENGTH[i]));
  });
  const contact = {} as Record<LimbName, boolean>;
  for (const limb of LIMBS) {
    const rear = limb.rear,
      stand = rear ? REAR_STAND : FRONT_STAND;
    const gait = limbState(limb.name, phase, length);
    contact[limb.name] = run < 0.5 || gait.contact;
    const tip = p(lerp(stand.x, gait.tip.x, run), lerp(stand.y, gait.tip.y, run));
    const toe = lerp(rear ? TOE_STAND.rear : TOE_STAND.front, gait.toe, run);
    const fold = gait.fold * run;
    const prefix = limb.side === 1 ? 'r_' : 'l_';
    if (rear) {
      // Hip follows the actual pelvis bone, including its flexion.
      const realHip = place(pose.pelvis.start, pose.pelvis.angle, HIP_ON_PELVIS);
      const ball = add(tip, dir(toe + Math.PI, REAR_LENGTH[3]));
      // The metatarsus keeps a pantograph relation to the femur, folding in swing.
      const delta = DELTA_BIND - 1.05 * fold + (gait.contact ? 0.12 * run : 0);
      const lf = REAR_LENGTH[0],
        lt = REAR_LENGTH[1],
        lm = REAR_LENGTH[2];
      const cx = lf + lm * Math.cos(delta),
        cy = lm * Math.sin(delta),
        reach = Math.hypot(cx, cy),
        offset = Math.atan2(cy, cx);
      const ik = solve(realHip, ball, reach, lt, 1);
      const femur = ik.first - offset;
      const stifle = add(realHip, dir(femur, lf));
      const hock = add(stifle, dir(ik.second, lt));
      const metatarsus = femur + delta;
      const paw = add(hock, dir(metatarsus, lm));
      pose[prefix + 'femur'] = { start: realHip, angle: femur };
      pose[prefix + 'tibia'] = { start: stifle, angle: ik.second };
      pose[prefix + 'metatarsus'] = { start: hock, angle: metatarsus };
      pose[prefix + 'hindpaw'] = { start: paw, angle: toe };
    } else {
      const top = place(pose.thorax2.start, pose.thorax2.angle, SCAPULA_ON_THORAX);
      const ball = add(tip, dir(toe + Math.PI, FRONT_LENGTH[4]));
      const line = angle(top, ball) - angle(FRONT_JOINTS[0], FRONT_JOINTS[4]);
      const scapula = FRONT_ANGLE[0] + (pose.thorax2.angle - SPINE_ANGLE[4]) + 0.6 * line;
      const shoulder = add(top, dir(scapula, FRONT_LENGTH[0]));
      // Carpus: slight hyperextension under load, folds sharply up and back in swing.
      const kappa = KAPPA_BIND - 2.15 * fold + (gait.contact ? 0.08 * run : 0);
      const lr = FRONT_LENGTH[2],
        lc = FRONT_LENGTH[3];
      const cx = lr + lc * Math.cos(kappa),
        cy = lc * Math.sin(kappa),
        reach = Math.hypot(cx, cy),
        offset = Math.atan2(cy, cx);
      const ik = solve(shoulder, ball, FRONT_LENGTH[1], reach, -1);
      const radius = ik.second - offset;
      const carpus = add(ik.joint, dir(radius, lr));
      const metacarpus = radius + kappa;
      const paw = add(carpus, dir(metacarpus, lc));
      pose[prefix + 'scapula'] = { start: top, angle: scapula };
      pose[prefix + 'humerus'] = { start: shoulder, angle: ik.first };
      pose[prefix + 'radius'] = { start: ik.joint, angle: radius };
      pose[prefix + 'metacarpus'] = { start: carpus, angle: metacarpus };
      pose[prefix + 'forepaw'] = { start: paw, angle: toe };
    }
  }
  pose.contact = contact;
  return pose;
}

/** Bind pose: the standing skeleton the mesh was authored around. */
export function bindPose(): GreyhoundPose {
  const pose = {} as GreyhoundPose;
  SPINE_BONES.forEach(
    (name, i) => (pose[name] = { start: SPINE_JOINTS[i], angle: SPINE_ANGLE[i] })
  );
  TAIL_BONES.forEach((name, i) => (pose[name] = { start: TAIL_JOINTS[i], angle: TAIL_ANGLE[i] }));
  for (const prefix of ['l_', 'r_']) {
    FRONT_BONES.forEach(
      (name, i) => (pose[prefix + name] = { start: FRONT_JOINTS[i], angle: FRONT_ANGLE[i] })
    );
    REAR_BONES.forEach(
      (name, i) => (pose[prefix + name] = { start: REAR_JOINTS[i], angle: REAR_ANGLE[i] })
    );
  }
  return pose;
}

/** End point of a posed bone, for tests and paw contact checks. */
export function boneEnd(pose: GreyhoundPose, name: string) {
  const bone = pose[name];
  const length = name.endsWith('forepaw')
    ? FRONT_LENGTH[4]
    : name.endsWith('hindpaw')
      ? REAR_LENGTH[3]
      : 0;
  return add(bone.start, dir(bone.angle, length));
}
