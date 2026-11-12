import * as THREE from 'three';
import { RACING_DOGS } from '@socialplay/shared';
import {
  bindPose,
  poseGreyhound,
  FRONT_BONES,
  FRONT_JOINTS,
  GREYHOUND_SCALE,
  LEG_Z,
  REAR_BONES,
  REAR_JOINTS,
  SPINE_BONES,
  SPINE_JOINTS,
  TAIL_BONES,
  TAIL_JOINTS,
  type GreyhoundPose,
  type V2,
} from './gait';

/**
 * Original procedural greyhound. Every vertex, weight, colour and texture is
 * generated here from anatomical cross-sections; no scanned, purchased or
 * downloaded model is used. One continuous skinned surface (body, neck, head,
 * legs, tail, ears) is deformed by a 31-bone skeleton posed by ./gait.
 */
export type GreyhoundDetail = 'high' | 'balanced' | 'low';
export type GreyhoundFrame = {
  phase: number;
  speed: number;
  run: number;
  time: number;
  /** Roll into the bend, radians; positive leans to the dog's left (inside). */
  lean?: number;
};
export type GreyhoundKit = {
  detail: GreyhoundDetail;
  coat: THREE.Material;
  fur: THREE.Texture | null;
  dispose(): void;
};

type V3 = [number, number, number];
type Weights = Record<string, number>;
type Section = {
  at: V3;
  top: number;
  bottom: number;
  side: number;
  pTop?: number;
  pBottom?: number;
  w?: Weights;
};

const ALL_BONES = [
  ...SPINE_BONES,
  ...TAIL_BONES,
  ...['l_', 'r_'].flatMap((s) => [...FRONT_BONES, ...REAR_BONES].map((b) => s + b)),
];
const BONE_INDEX = new Map(ALL_BONES.map((name, i) => [name, i]));

// ---------------------------------------------------------------- appearance
type Coat = {
  base: string;
  dark?: string;
  white?: 'chest' | 'parti' | 'socks';
  brindle?: number;
  mask?: boolean;
  patch?: string;
};
const COATS: Coat[] = [
  { base: RACING_DOGS[0].coat, mask: true, dark: '#5a3b22' },
  { base: RACING_DOGS[1].coat, white: 'chest', dark: '#151312' },
  { base: '#ece6d8', white: 'parti', patch: '#b98552' },
  { base: RACING_DOGS[3].coat, white: 'chest', dark: '#4d4a45' },
  { base: RACING_DOGS[4].coat, mask: true, dark: '#6a3d1d' },
  { base: '#ebe6dc', white: 'parti', patch: '#1d1c1b' },
  { base: '#6b5640', brindle: 0.62, dark: '#231c16', white: 'socks' },
  { base: '#b1946c', brindle: 0.45, dark: '#4b3825', mask: true },
];

function hash(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
/** Smooth value noise, enough for coat mottling and patch shapes. */
function noise(x: number, y: number, z: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  const fx = x - ix,
    fy = y - iy,
    fz = z - iz;
  const u = fx * fx * (3 - 2 * fx),
    v = fy * fy * (3 - 2 * fy),
    w = fz * fz * (3 - 2 * fz);
  let total = 0;
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++)
        total +=
          hash(ix + dx, iy + dy, iz + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  return total;
}

type Part = 'body' | 'head' | 'leg' | 'paw' | 'tail' | 'ear' | 'eye' | 'nose';
function coatColour(coat: Coat, part: Part, at: V3, out: THREE.Color, seed: number) {
  const [x, y, z] = at;
  const base = new THREE.Color(coat.base),
    dark = new THREE.Color(coat.dark ?? coat.base).lerp(new THREE.Color('#000000'), 0.15);
  out.copy(base);
  if (part === 'eye') return out.set('#0d0907');
  if (part === 'nose') return out.set('#141212');
  // Countershading and a slightly darker topline read as real coat under light.
  const shade = THREE.MathUtils.clamp((y - 0.5) * 1.6, -0.2, 0.32);
  out.offsetHSL(0, shade * 0.05, -shade * 0.22);
  const n = noise(x * 18 + seed, y * 18, z * 18) - 0.5;
  out.offsetHSL(0, 0, n * 0.05);
  if (coat.brindle) {
    const stripe = Math.sin((x * 34 + y * 7 + noise(x * 6 + seed, y * 6, z * 6) * 5.5) * Math.PI);
    if (stripe > 1 - coat.brindle * 1.4) out.lerp(dark, 0.78);
  }
  if (coat.mask && (part === 'head' || part === 'ear') && x > 0.53)
    out.lerp(dark, THREE.MathUtils.smoothstep(x, 0.55, 0.64) * 0.85);
  if (part === 'ear' && !coat.white) out.lerp(dark, 0.45);
  const white = new THREE.Color('#f1ece2');
  if (coat.white === 'chest') {
    const chest = part === 'body' && x > 0.16 && y < 0.6 - (x - 0.16) * 0.2;
    const toes = (part === 'paw' || part === 'leg') && y < 0.07;
    if (chest || toes) out.lerp(white, 0.9);
  }
  if (coat.white === 'socks' && (part === 'paw' || (part === 'leg' && y < 0.11)))
    out.lerp(white, 0.85);
  if (coat.white === 'parti' && coat.patch) {
    const blob = noise(x * 4.2 + seed * 3, y * 4.2, z * 1.5);
    const onHead = (part === 'head' || part === 'ear') && x < 0.6;
    if ((part === 'body' && blob > 0.56) || onHead || (part === 'tail' && blob > 0.5))
      out.lerp(new THREE.Color(coat.patch), part === 'ear' ? 0.95 : 0.9);
  }
  return out;
}

// ---------------------------------------------------------------- weights
type Chain = { name: string; a: V2; b: V2 }[];
function chainOf(joints: readonly V2[], names: readonly string[], prefix = ''): Chain {
  return names.map((name, i) => ({ name: prefix + name, a: joints[i], b: joints[i + 1] }));
}
/** Projection onto a joint chain, blending smoothly across each joint. */
function chainWeights(point: V3, chain: Chain, blend = 0.32): Weights {
  let best = { i: 0, u: 0, d: Infinity };
  chain.forEach((bone, i) => {
    const dx = bone.b.x - bone.a.x,
      dy = bone.b.y - bone.a.y,
      l2 = dx * dx + dy * dy;
    const u = ((point[0] - bone.a.x) * dx + (point[1] - bone.a.y) * dy) / l2;
    const cu = Math.max(0, Math.min(1, u));
    const d = Math.hypot(point[0] - (bone.a.x + dx * cu), point[1] - (bone.a.y + dy * cu));
    if (d < best.d - 1e-9) best = { i, u, d };
  });
  const { i, u } = best,
    w: Weights = {};
  const name = chain[i].name;
  if (u < blend && i > 0) {
    const t = THREE.MathUtils.smoothstep(u, -blend, blend);
    w[name] = t;
    w[chain[i - 1].name] = 1 - t;
  } else if (u > 1 - blend && i < chain.length - 1) {
    const t = THREE.MathUtils.smoothstep(u, 1 - blend, 1 + blend);
    w[name] = 1 - t;
    w[chain[i + 1].name] = t;
  } else w[name] = 1;
  return w;
}
const mix = (a: Weights, b: Weights, t: number): Weights => {
  const out: Weights = {};
  for (const [k, v] of Object.entries(a)) out[k] = (out[k] ?? 0) + v * (1 - t);
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v * t;
  return out;
};

// ---------------------------------------------------------------- anatomy
const SPINE_CHAIN = chainOf(SPINE_JOINTS, SPINE_BONES);
const TAIL_CHAIN = chainOf(TAIL_JOINTS, TAIL_BONES);
const s = (
  x: number,
  y: number,
  top: number,
  bottom: number,
  side: number,
  pBottom = 2,
  pTop = 2.2
): Section => ({ at: [x, y, 0], top, bottom, side, pTop, pBottom });
/** Rump to nose. Radii follow a racing greyhound: deep keel, tight tuck-up, long head. */
const TORSO: Section[] = [
  s(-0.392, 0.598, 0.012, 0.012, 0.012),
  s(-0.372, 0.604, 0.062, 0.095, 0.058),
  s(-0.336, 0.612, 0.088, 0.135, 0.078),
  s(-0.282, 0.62, 0.093, 0.14, 0.087),
  s(-0.205, 0.632, 0.07, 0.095, 0.075),
  s(-0.12, 0.645, 0.062, 0.062, 0.062),
  s(-0.045, 0.64, 0.07, 0.092, 0.07, 1.9),
  s(0.04, 0.612, 0.1, 0.168, 0.09, 1.6),
  s(0.13, 0.582, 0.13, 0.222, 0.095, 1.5),
  s(0.215, 0.584, 0.142, 0.222, 0.088, 1.55),
  s(0.29, 0.612, 0.118, 0.19, 0.08, 1.8),
  s(0.338, 0.674, 0.088, 0.12, 0.066),
  s(0.382, 0.75, 0.072, 0.086, 0.06),
  s(0.425, 0.83, 0.064, 0.07, 0.054),
  s(0.462, 0.888, 0.055, 0.057, 0.049),
  s(0.5, 0.909, 0.054, 0.05, 0.053),
  s(0.545, 0.902, 0.05, 0.047, 0.05),
  s(0.597, 0.876, 0.036, 0.04, 0.034),
  s(0.645, 0.857, 0.028, 0.032, 0.026),
  s(0.68, 0.845, 0.019, 0.022, 0.018),
  s(0.694, 0.841, 0.004, 0.005, 0.004),
];
const HEAD_FROM = 0.47;
function legSections(rear: boolean, side: 1 | -1): Section[] {
  const [zTop, zPaw] = rear ? LEG_Z.rear : LEG_Z.front;
  const raw: [number, number, number, number, number][] = rear
    ? [
        [-0.262, 0.655, 0.03, 0.026, 0.026],
        [-0.252, 0.578, 0.072, 0.078, 0.066],
        [-0.222, 0.472, 0.07, 0.086, 0.062],
        [-0.176, 0.396, 0.048, 0.045, 0.045],
        [-0.205, 0.338, 0.028, 0.052, 0.037],
        [-0.262, 0.258, 0.016, 0.028, 0.023],
        [-0.31, 0.198, 0.012, 0.016, 0.018],
        [-0.332, 0.162, 0.012, 0.02, 0.018],
        [-0.323, 0.1, 0.013, 0.013, 0.015],
        [-0.313, 0.042, 0.016, 0.016, 0.019],
        [-0.296, 0.026, 0.019, 0.017, 0.021],
        [-0.275, 0.017, 0.012, 0.01, 0.016],
        [-0.262, 0.012, 0.003, 0.003, 0.003],
      ]
    : [
        [0.206, 0.688, 0.018, 0.018, 0.02],
        [0.247, 0.592, 0.045, 0.04, 0.042],
        [0.296, 0.478, 0.04, 0.034, 0.045],
        [0.27, 0.402, 0.026, 0.044, 0.04],
        [0.218, 0.322, 0.017, 0.026, 0.031],
        [0.218, 0.25, 0.017, 0.02, 0.022],
        [0.222, 0.155, 0.013, 0.014, 0.017],
        [0.225, 0.092, 0.014, 0.014, 0.018],
        [0.236, 0.058, 0.011, 0.011, 0.015],
        [0.25, 0.034, 0.015, 0.016, 0.019],
        [0.274, 0.026, 0.019, 0.017, 0.021],
        [0.294, 0.017, 0.012, 0.01, 0.016],
        [0.304, 0.012, 0.003, 0.003, 0.003],
      ];
  const joints = rear ? REAR_JOINTS : FRONT_JOINTS,
    names = rear ? REAR_BONES : FRONT_BONES,
    prefix = side === 1 ? 'r_' : 'l_';
  const chain = chainOf(joints, names, prefix);
  return raw.map(([x, y, top, bottom, sideR], i) => {
    const t = i / (raw.length - 1);
    const at: V3 = [x, y, side * (zTop + (zPaw - zTop) * Math.pow(t, 0.8))];
    let w = chainWeights(at, chain, 0.28);
    // The top of each leg stays anchored to the trunk; the muscle mass slides over it.
    if (i === 0) w = mix(w, { [rear ? 'pelvis' : 'thorax2']: 1 }, 0.7);
    if (i === 1) w = mix(w, { [rear ? 'pelvis' : 'thorax2']: 1 }, rear ? 0.42 : 0.25);
    return { at, top, bottom, side: sideR, w };
  });
}
function tailSections(): Section[] {
  const radii = [0.024, 0.02, 0.016, 0.012, 0.009, 0.006, 0.002];
  const pts = [[-0.322, 0.652], ...TAIL_JOINTS.slice(1).map((j) => [j.x, j.y]), [-0.495, 0.15]];
  return pts.map(([x, y], i) => {
    const at: V3 = [x, y, 0];
    const w = i === 0 ? { pelvis: 0.6, tail0: 0.4 } : chainWeights(at, TAIL_CHAIN, 0.3);
    return { at, top: radii[i], bottom: radii[i], side: radii[i], w };
  });
}
function earSections(side: 1 | -1): Section[] {
  // Rose ears folded back flat along the skull and upper neck.
  const pts: [number, number, number, number][] = [
    [0.512, 0.938, 0.036, 0.018],
    [0.49, 0.946, 0.044, 0.022],
    [0.462, 0.944, 0.05, 0.021],
    [0.437, 0.928, 0.054, 0.016],
    [0.425, 0.91, 0.055, 0.004],
  ];
  return pts.map(([x, y, z, width]) => ({
    at: [x, y, side * z] as V3,
    top: width,
    bottom: width * 0.7,
    side: 0.0045,
    w: { head: 1 },
  }));
}

// ---------------------------------------------------------------- geometry
class Builder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  skinIndex: number[] = [];
  skinWeight: number[] = [];
  indices: number[] = [];
  add(
    sections: Section[],
    segments: number,
    spacing: number,
    colour: (at: V3, t: number) => THREE.Color,
    defaultWeights: (at: V3) => Weights,
    span?: [number, number]
  ) {
    const curve = new THREE.CatmullRomCurve3(
      sections.map((sec) => new THREE.Vector3(...sec.at)),
      false,
      'centripetal'
    );
    const weights = sections.map((sec) => sec.w ?? defaultWeights(sec.at));
    const length = curve.getLength(),
      rings = Math.max(4, Math.ceil(length / spacing));
    const first = this.positions.length / 3;
    const tangent = new THREE.Vector3(),
      up = new THREE.Vector3(),
      lateral = new THREE.Vector3(),
      sideAxis = new THREE.Vector3(),
      centre = new THREE.Vector3(),
      point = new THREE.Vector3();
    const [a0, a1] = span ?? [0, Math.PI * 2];
    const closed = !span;
    const n = sections.length - 1;
    let travelled = 0,
      previous: THREE.Vector3 | null = null;
    const radius = (k: number, f: number, key: 'top' | 'bottom' | 'side' | 'pTop' | 'pBottom') => {
      const at = (i: number) => {
        const v = sections[Math.max(0, Math.min(n, i))][key];
        return v ?? (key === 'pTop' ? 2.2 : 2);
      };
      const p0 = at(k - 1),
        p1 = at(k),
        p2 = at(k + 1),
        p3 = at(k + 2);
      const f2 = f * f,
        f3 = f2 * f;
      const v =
        0.5 *
        (2 * p1 +
          (-p0 + p2) * f +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
          (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
      return Math.max(0.0008, v);
    };
    for (let i = 0; i <= rings; i++) {
      const t = i / rings,
        k = Math.min(n - 1, Math.floor(t * n)),
        f = t * n - k;
      curve.getPoint(t, centre);
      curve.getTangent(t, tangent);
      if (previous) travelled += centre.distanceTo(previous);
      previous = centre.clone();
      lateral.set(0, 0, 1);
      up.crossVectors(lateral, tangent).normalize();
      sideAxis.crossVectors(tangent, up).normalize();
      const w = mix(weights[k], weights[k + 1], THREE.MathUtils.smoothstep(f, 0, 1));
      const ranked = Object.entries(w)
        .filter(([, v]) => v > 0.001)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 4);
      const total = ranked.reduce((sum, [, v]) => sum + v, 0);
      const top = radius(k, f, 'top'),
        bottom = radius(k, f, 'bottom'),
        side = radius(k, f, 'side'),
        pTop = radius(k, f, 'pTop'),
        pBottom = radius(k, f, 'pBottom');
      for (let j = 0; j <= segments; j++) {
        const a = a0 + ((a1 - a0) * j) / segments;
        const cy = -Math.cos(a),
          cs = Math.sin(a);
        const vy =
          (cy >= 0 ? top : bottom) *
          Math.sign(cy) *
          Math.pow(Math.abs(cy), 2 / (cy >= 0 ? pTop : pBottom));
        const vs = side * Math.sign(cs) * Math.pow(Math.abs(cs), 2 / 2.1);
        point.copy(centre).addScaledVector(up, vy).addScaledVector(sideAxis, vs);
        this.positions.push(point.x, point.y, point.z);
        this.normals.push(0, 0, 0);
        this.uvs.push(closed ? j / segments : (a - a0) / (a1 - a0), travelled / 0.3);
        const c = colour([point.x, point.y, point.z], t);
        this.colors.push(c.r, c.g, c.b);
        for (let q = 0; q < 4; q++) {
          this.skinIndex.push(ranked[q] ? BONE_INDEX.get(ranked[q][0])! : 0);
          this.skinWeight.push(ranked[q] ? ranked[q][1] / total : 0);
        }
      }
    }
    const row = segments + 1;
    for (let i = 0; i < rings; i++)
      for (let j = 0; j < segments; j++) {
        const v = first + i * row + j;
        this.indices.push(v, v + row, v + 1, v + 1, v + row, v + row + 1);
      }
    return { first, rings, row, closed };
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.skinWeight, 4));
    g.setIndex(this.indices);
    g.computeVertexNormals();
    return g;
  }
}
/** Average the duplicated seam column so closed tubes shade without a visible line. */
function weldSeams(
  g: THREE.BufferGeometry,
  parts: { first: number; rings: number; row: number; closed: boolean }[]
) {
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const v = new THREE.Vector3(),
    w = new THREE.Vector3();
  for (const part of parts) {
    if (!part.closed) continue;
    for (let i = 0; i <= part.rings; i++) {
      const a = part.first + i * part.row,
        b = a + part.row - 1;
      v.fromBufferAttribute(n, a).add(w.fromBufferAttribute(n, b)).normalize();
      n.setXYZ(a, v.x, v.y, v.z);
      n.setXYZ(b, v.x, v.y, v.z);
    }
  }
  n.needsUpdate = true;
}

const DETAIL = {
  high: { body: 22, leg: 10, spacing: 0.016, legSpacing: 0.014 },
  balanced: { body: 18, leg: 8, spacing: 0.02, legSpacing: 0.018 },
  low: { body: 12, leg: 6, spacing: 0.034, legSpacing: 0.03 },
};

function furTexture() {
  const size = 128,
    canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // Short hair strokes laid along the body axis (texture v), wrapping seamlessly.
  for (let i = 0; i < 2600; i++) {
    const x = rand() * size,
      y = rand() * size,
      len = 3 + rand() * 6,
      g = 90 + Math.floor(rand() * 90);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    for (const dx of [0, -size, size])
      for (const dy of [0, -size, size]) ctx.fillRect(x + dx, y + dy, 1, len);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 3);
  return texture;
}

/** Shared per-scene materials. Dispose once, after every runner using it. */
export function createGreyhoundKit(detail: GreyhoundDetail = 'balanced'): GreyhoundKit {
  const fur = detail === 'low' ? null : furTexture();
  // Low: matte. Balanced: standard PBR with the hair bump. High adds a velvet sheen.
  const coat =
    detail === 'low'
      ? new THREE.MeshLambertMaterial({ vertexColors: true })
      : detail === 'balanced'
        ? new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.66,
            metalness: 0,
            bumpMap: fur ?? undefined,
            bumpScale: 0.9,
            envMapIntensity: 0.5,
          })
        : new THREE.MeshPhysicalMaterial({
            vertexColors: true,
            roughness: 0.62,
            metalness: 0,
            bumpMap: fur ?? undefined,
            bumpScale: 0.9,
            envMapIntensity: 0.45,
            // Short, close coat: a soft velvet rim instead of a plastic highlight.
            sheen: 0.7,
            sheenRoughness: 0.45,
            sheenColor: new THREE.Color('#fff2dc'),
            specularIntensity: 0.35,
          });
  return {
    detail,
    coat,
    fur,
    dispose() {
      coat.dispose();
      fur?.dispose();
    },
  };
}

function jacketTexture(index: number, detail: GreyhoundDetail) {
  const dog = RACING_DOGS[index];
  const canvas = document.createElement('canvas');
  // 512x384 only on High; a jacket rarely spans more than ~100 px on screen otherwise.
  const k = detail === 'high' ? 1 : 0.5;
  canvas.width = 512 * k;
  canvas.height = 384 * k;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const W = canvas.width,
    H = canvas.height;
  ctx.fillStyle = dog.color;
  ctx.fillRect(0, 0, W, H);
  // Subtle woven texture so the cloth does not read as plastic.
  ctx.globalAlpha = 0.07;
  for (let y = 0; y < H; y += Math.max(2, 3 * k)) {
    ctx.fillStyle = Math.round(y / Math.max(2, 3 * k)) % 2 ? '#000' : '#fff';
    ctx.fillRect(0, y, W, 1);
  }
  ctx.globalAlpha = 1;
  // Contrasting hem along the lower edges and the front/back of the jacket.
  ctx.fillStyle = dog.ink;
  ctx.fillRect(0, 0, 12 * k, H);
  ctx.fillRect(W - 12 * k, 0, 12 * k, H);
  ctx.fillRect(0, 0, W, 9 * k);
  ctx.fillRect(0, H - 9 * k, W, 9 * k);
  // Numbers: u (canvas x) runs around the body, v (canvas y, flipped) along it.
  // Each flank gets its own orientation so the number reads correctly on both sides.
  const number = String(index + 1);
  const draw = (cx: number, right: boolean) => {
    ctx.save();
    ctx.setTransform(0, right ? -1 : 1, right ? -1 : 1, 0, cx, H / 2);
    ctx.font = `bold ${168 * k}px "Arial Black", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 14 * k;
    ctx.strokeStyle = dog.ink === '#ffffff' ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.45)';
    ctx.strokeText(number, 0, 6 * k);
    ctx.fillStyle = dog.ink;
    ctx.fillText(number, 0, 6 * k);
    ctx.restore();
  };
  draw(W * 0.25, true);
  draw(W * 0.75, false);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function createGreyhound(index: number, sharedKit?: GreyhoundKit) {
  const kit = sharedKit ?? createGreyhoundKit('balanced'),
    detail = DETAIL[kit.detail],
    coat = COATS[index % COATS.length];
  const root = new THREE.Group(),
    lean = new THREE.Group(),
    body = new THREE.Group();
  root.add(lean);
  lean.add(body);
  body.scale.setScalar(GREYHOUND_SCALE);
  root.userData.runner = index + 1;
  const resources: { dispose(): void }[] = [];
  const colour = new THREE.Color();
  const builder = new Builder(),
    parts: ReturnType<Builder['add']>[] = [];
  const paint = (part: (at: V3) => Part) => (at: V3) =>
    coatColour(coat, part(at), at, colour, index * 1.7);
  parts.push(
    builder.add(
      TORSO,
      detail.body,
      detail.spacing,
      paint((at) => (at[0] > 0.678 ? 'nose' : at[0] > HEAD_FROM ? 'head' : 'body')),
      (at) => chainWeights(at, SPINE_CHAIN, 0.34)
    )
  );
  for (const side of [-1, 1] as const)
    for (const rear of [false, true]) {
      parts.push(
        builder.add(
          legSections(rear, side),
          detail.leg,
          detail.legSpacing,
          paint((at) => (at[1] < 0.045 ? 'paw' : 'leg')),
          () => ({})
        )
      );
    }
  parts.push(
    builder.add(
      tailSections(),
      Math.max(6, detail.leg - 2),
      detail.legSpacing,
      paint(() => 'tail'),
      () => ({})
    )
  );
  for (const side of [-1, 1] as const)
    parts.push(
      builder.add(
        earSections(side),
        6,
        0.012,
        paint(() => 'ear'),
        () => ({}),
        [0, Math.PI * 2]
      )
    );
  // Eyes: small dark domes set into the head.
  for (const side of [-1, 1] as const) {
    const eye: Section[] = [-1, -0.5, 0, 0.5, 1].map((u) => ({
      at: [0.553 + u * 0.009, 0.917, side * 0.036] as V3,
      top: Math.sqrt(1 - u * u) * 0.009 + 0.0008,
      bottom: Math.sqrt(1 - u * u) * 0.009 + 0.0008,
      side: Math.sqrt(1 - u * u) * 0.009 + 0.0008,
      w: { head: 1 },
    }));
    parts.push(
      builder.add(
        eye,
        6,
        0.004,
        () => colour.set('#0d0907'),
        () => ({})
      )
    );
  }
  const geometry = builder.geometry();
  weldSeams(geometry, parts);
  resources.push(geometry);

  const bones = ALL_BONES.map((name) => {
    const bone = new THREE.Bone();
    bone.name = name;
    return bone;
  });
  const mesh = new THREE.SkinnedMesh(geometry, kit.coat);
  mesh.name = 'greyhound-' + (index + 1);
  mesh.castShadow = kit.detail !== 'low';
  mesh.frustumCulled = false;
  bones.forEach((bone) => mesh.add(bone));
  body.add(mesh);
  const zOf = (name: string) => {
    const side = name.startsWith('r_') ? 1 : name.startsWith('l_') ? -1 : 0;
    if (!side) return 0;
    const bare = name.slice(2),
      front = (FRONT_BONES as readonly string[]).includes(bare);
    const list = (front ? FRONT_BONES : REAR_BONES) as readonly string[];
    const [zTop, zPaw] = front ? LEG_Z.front : LEG_Z.rear;
    const t = list.indexOf(bare) / (list.length - 1);
    return side * (zTop + (zPaw - zTop) * Math.pow(t, 0.8));
  };
  const axis = new THREE.Vector3(0, 0, 1);
  const apply = (pose: GreyhoundPose) => {
    for (const bone of bones) {
      const p = pose[bone.name];
      if (!p) continue;
      bone.position.set(p.start.x, p.start.y, zOf(bone.name));
      bone.quaternion.setFromAxisAngle(axis, p.angle);
    }
  };
  apply(bindPose());
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  resources.push(skeleton);

  // Racing jacket: a cloth layer on the same skeleton, numbered on both flanks.
  const jacketMap = jacketTexture(index, kit.detail);
  if (jacketMap) resources.push(jacketMap);
  const jacketSections = TORSO.filter((sec) => sec.at[0] > -0.2 && sec.at[0] < 0.27).map((sec) => ({
    ...sec,
    top: sec.top + 0.007,
    bottom: sec.bottom + 0.007,
    side: sec.side + 0.007,
  }));
  const jb = new Builder();
  jb.add(
    jacketSections,
    detail.body,
    detail.spacing,
    () => colour.set('#ffffff'),
    (at) => chainWeights(at, SPINE_CHAIN, 0.34),
    [Math.PI * 0.3, Math.PI * 1.7]
  );
  const jacketGeometry = jb.geometry();
  // Re-map v from metres travelled to 0..1 along the jacket.
  const uv = jacketGeometry.getAttribute('uv') as THREE.BufferAttribute;
  let maxV = 0;
  for (let i = 0; i < uv.count; i++) maxV = Math.max(maxV, uv.getY(i));
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) / maxV);
  resources.push(jacketGeometry);
  const jacketMaterial =
    kit.detail === 'low'
      ? new THREE.MeshLambertMaterial({ map: jacketMap, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({
          map: jacketMap,
          roughness: 0.78,
          metalness: 0,
          side: THREE.DoubleSide,
          envMapIntensity: 0.5,
        });
  resources.push(jacketMaterial);
  const jacket = new THREE.SkinnedMesh(jacketGeometry, jacketMaterial);
  jacket.name = 'jacket-' + (index + 1);
  jacket.castShadow = kit.detail !== 'low';
  jacket.frustumCulled = false;
  body.add(jacket);
  jacket.bind(skeleton, mesh.bindMatrix);

  let lastPose = bindPose();
  function update(frame: GreyhoundFrame) {
    lastPose = poseGreyhound({
      phase: frame.phase,
      speed: frame.speed / GREYHOUND_SCALE,
      run: frame.run,
      time: frame.time,
      seed: index,
    });
    apply(lastPose);
    lean.rotation.x = -(frame.lean ?? 0);
  }
  /** Compatibility with the earlier renderer: radians of stride and a moving flag. */
  function pose(phase: number, moving: boolean) {
    update({
      phase: phase / (Math.PI * 2),
      speed: moving ? 10.5 : 0,
      run: moving ? 1 : 0,
      time: phase,
    });
  }
  update({ phase: 0, speed: 0, run: 0, time: index });
  return {
    root,
    body,
    mesh,
    jacket,
    bones,
    update,
    pose,
    contacts: () => lastPose.contact,
    dispose: () => {
      resources.forEach((r) => r.dispose());
      if (!sharedKit) kit.dispose();
    },
  };
}
export type Greyhound = ReturnType<typeof createGreyhound>;
