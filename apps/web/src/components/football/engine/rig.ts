import * as THREE from 'three';

/**
 * Procedural human rig. Original geometry generated in code: no downloaded model, no
 * third-party animation data. Character frame: +Y up, +Z forward, +X the character's left.
 * One shared skinned body geometry; every player gets its OWN bone hierarchy, skeleton and
 * mesh, so poses never leak between players.
 */
export const BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'upperArmL',
  'foreArmL',
  'handL',
  'upperArmR',
  'foreArmR',
  'handR',
  'upperLegL',
  'lowerLegL',
  'footL',
  'toeL',
  'upperLegR',
  'lowerLegR',
  'footR',
  'toeR',
] as const;
export type BoneName = (typeof BONES)[number];
export type Side = 'L' | 'R';

export const DIM = Object.freeze({
  hipsY: 0.95,
  thigh: 0.43,
  shin: 0.42,
  ankleY: 0.08,
  upperArm: 0.29,
  foreArm: 0.26,
  footLength: 0.27,
  heelBack: 0.07,
  ballRadius: 0.11,
  height: 1.8,
});

type V3 = [number, number, number];
const REST: Record<BoneName, [BoneName | null, V3]> = {
  hips: [null, [0, DIM.hipsY, 0]],
  spine: ['hips', [0, 0.1, 0]],
  chest: ['spine', [0, 0.22, 0]],
  neck: ['chest', [0, 0.24, 0]],
  head: ['neck', [0, 0.1, 0]],
  upperArmL: ['chest', [0.2, 0.17, 0]],
  foreArmL: ['upperArmL', [0, -DIM.upperArm, 0]],
  handL: ['foreArmL', [0, -DIM.foreArm, 0]],
  upperArmR: ['chest', [-0.2, 0.17, 0]],
  foreArmR: ['upperArmR', [0, -DIM.upperArm, 0]],
  handR: ['foreArmR', [0, -DIM.foreArm, 0]],
  upperLegL: ['hips', [0.1, -0.02, 0]],
  lowerLegL: ['upperLegL', [0, -DIM.thigh, 0]],
  footL: ['lowerLegL', [0, -DIM.shin, 0]],
  toeL: ['footL', [0, -0.045, 0.17]],
  upperLegR: ['hips', [-0.1, -0.02, 0]],
  lowerLegR: ['upperLegR', [0, -DIM.thigh, 0]],
  footR: ['lowerLegR', [0, -DIM.shin, 0]],
  toeR: ['footR', [0, -0.045, 0.17]],
};

/** Rest-pose world position of a bone (root at the origin). */
export function restPosition(name: BoneName): THREE.Vector3 {
  const v = new THREE.Vector3();
  for (let n: BoneName | null = name; n; n = REST[n][0]) v.add(new THREE.Vector3(...REST[n][1]));
  return v;
}

/* ------------------------------------------------------------------------------------- *
 * Geometry
 * ------------------------------------------------------------------------------------- */
export const Region = {
  SKIN: 0,
  SHIRT: 1,
  SHORTS: 2,
  SOCK: 3,
  BOOT: 4,
  HAIR: 5,
  GLOVE: 6,
  FOREARM: 7,
} as const;
type RegionId = (typeof Region)[keyof typeof Region];
type Weights = Array<[BoneName, number]>;
interface Ring {
  c: V3;
  rx: number;
  rz: number;
  region: RegionId | ((theta: number) => RegionId);
  w: Weights;
}

class Builder {
  position: number[] = [];
  skinIndex: number[] = [];
  skinWeight: number[] = [];
  region: number[] = [];
  uvShirt: number[] = [];
  theta: number[] = [];
  index: number[] = [];
  ringStarts: number[][] = [];

  loft(rings: Ring[], segments: number, axis: 'y' | 'z') {
    const base = this.position.length / 3;
    const starts: number[] = [];
    for (const ring of rings) {
      starts.push(this.position.length / 3);
      const weights = normalise(ring.w);
      for (let j = 0; j <= segments; j++) {
        const theta = (j / segments) * Math.PI * 2;
        const dx = Math.cos(theta) * ring.rx;
        const dz = Math.sin(theta) * ring.rz;
        const [x, y, z] = ring.c;
        this.position.push(...(axis === 'y' ? [x + dx, y, z + dz] : [x + dx, y + dz, z]));
        for (let k = 0; k < 4; k++) {
          this.skinIndex.push(weights[k] ? BONES.indexOf(weights[k][0]) : 0);
          this.skinWeight.push(weights[k] ? weights[k][1] : 0);
        }
        this.region.push(typeof ring.region === 'function' ? ring.region(theta) : ring.region);
        // Shirt texture: u around the body, v by height between waist and shoulders.
        this.uvShirt.push(1 - j / segments, 0.5 + 0.5 * clamp01((y_of(ring, axis) - 0.95) / 0.57));
        this.theta.push(theta);
      }
    }
    this.ringStarts.push(starts);
    for (let i = 0; i < rings.length - 1; i++)
      for (let j = 0; j < segments; j++) {
        const a = base + i * (segments + 1) + j;
        const b = a + 1;
        const d = a + (segments + 1);
        const c = d + 1;
        if (axis === 'y') this.index.push(a, d, b, b, d, c);
        else this.index.push(a, b, d, b, c, d);
      }
  }
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const y_of = (ring: Ring, axis: 'y' | 'z') => (axis === 'y' ? ring.c[1] : ring.c[1] + 0.0);
function normalise(w: Weights): Weights {
  const sorted = [...w].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = sorted.reduce((s, [, x]) => s + x, 0) || 1;
  return sorted.map(([n, x]) => [n, x / sum]);
}
const blend = (a: BoneName, b: BoneName, t: number): Weights => [
  [a, 1 - clamp01(t)],
  [b, clamp01(t)],
];
const ease = (t: number) => clamp01(t) * clamp01(t) * (3 - 2 * clamp01(t));

function buildTorso(b: Builder) {
  const shirtShorts = (y: number): RegionId => (y >= 0.96 ? Region.SHIRT : Region.SHORTS);
  const rows: Array<[number, number, number]> = [
    [0.84, 0.15, 0.1],
    [0.92, 0.17, 0.108],
    [0.96, 0.168, 0.106],
    [0.96, 0.168, 0.106],
    [1.04, 0.158, 0.101],
    [1.14, 0.158, 0.1],
    [1.26, 0.176, 0.113],
    [1.37, 0.197, 0.118],
    [1.44, 0.202, 0.114],
    [1.49, 0.155, 0.092],
    [1.53, 0.075, 0.072],
    [1.545, 0.052, 0.052],
  ];
  const rings: Ring[] = rows.map(([y, rx, rz], i) => {
    const w: Weights =
      y <= 0.95
        ? [['hips', 1]]
        : y <= 1.05
          ? blend('hips', 'spine', ease((y - 0.95) / 0.1))
          : y <= 1.2
            ? [['spine', 1]]
            : y <= 1.32
              ? blend('spine', 'chest', ease((y - 1.2) / 0.12))
              : y <= 1.48
                ? [['chest', 1]]
                : blend('chest', 'neck', ease((y - 1.48) / 0.07));
    // The duplicated ring at 0.96 gives a crisp shirt/shorts boundary.
    const region: RegionId =
      i === 2 ? Region.SHORTS : i === 3 ? Region.SHIRT : y > 1.5 ? Region.SKIN : shirtShorts(y);
    return { c: [0, y, 0], rx, rz, region, w };
  });
  b.loft(rings, 20, 'y');
}

function buildLeg(b: Builder, side: Side) {
  const sx = side === 'L' ? 1 : -1;
  const upper: BoneName = `upperLeg${side}`;
  const lower: BoneName = `lowerLeg${side}`;
  const foot: BoneName = `foot${side}`;
  const rows: Array<[number, number, number, RegionId]> = [
    [0.94, 0.112, 0.108, Region.SHORTS],
    [0.84, 0.1, 0.098, Region.SHORTS],
    [0.7, 0.087, 0.085, Region.SHORTS],
    [0.68, 0.083, 0.082, Region.SHORTS],
    [0.68, 0.083, 0.082, Region.SKIN],
    [0.58, 0.07, 0.072, Region.SKIN],
    [0.5, 0.062, 0.066, Region.SKIN],
    [0.44, 0.064, 0.07, Region.SKIN],
    [0.44, 0.064, 0.07, Region.SOCK],
    [0.36, 0.063, 0.072, Region.SOCK],
    [0.24, 0.05, 0.054, Region.SOCK],
    [0.14, 0.04, 0.043, Region.SOCK],
    [0.1, 0.038, 0.04, Region.SOCK],
    [0.085, 0.034, 0.036, Region.SOCK],
  ];
  const rings: Ring[] = rows.map(([y, rx, rz, region]) => ({
    c: [0.1 * sx, y, 0],
    rx,
    rz,
    region,
    w:
      y >= 0.58
        ? [[upper, 1]]
        : y >= 0.44
          ? blend(upper, lower, ease((0.58 - y) / 0.14))
          : y >= 0.14
            ? [[lower, 1]]
            : blend(lower, foot, ease((0.14 - y) / 0.06)),
  }));
  b.loft(rings, 14, 'y');
  // Boot: a lofted shoe along +Z, skinned to the foot bone.
  const ankle = restPosition(foot);
  const shoe: Array<[number, number, number, number]> = [
    [-0.07, 0.02, 0.036, 0.04],
    [-0.06, 0.0, 0.045, 0.062],
    [-0.02, -0.005, 0.05, 0.068],
    [0.06, -0.012, 0.05, 0.05],
    [0.13, -0.025, 0.047, 0.036],
    [0.2, -0.04, 0.04, 0.026],
    [0.24, -0.052, 0.022, 0.014],
  ];
  b.loft(
    shoe.map(([z, y, rx, ry]) => ({
      c: [ankle.x, ankle.y + y, ankle.z + z] as V3,
      rx,
      rz: ry,
      region: Region.BOOT,
      w: [[foot, 1]] as Weights,
    })),
    12,
    'z'
  );
}

function buildArm(b: Builder, side: Side) {
  const sx = side === 'L' ? 1 : -1;
  const upper: BoneName = `upperArm${side}`;
  const fore: BoneName = `foreArm${side}`;
  const hand: BoneName = `hand${side}`;
  const rows: Array<[number, number, RegionId]> = [
    [1.47, 0.04, Region.SHIRT],
    [1.44, 0.062, Region.SHIRT],
    [1.36, 0.057, Region.SHIRT],
    [1.27, 0.05, Region.SHIRT],
    [1.255, 0.05, Region.SKIN],
    [1.18, 0.045, Region.SKIN],
    [1.15, 0.043, Region.FOREARM],
    [1.06, 0.04, Region.FOREARM],
    [0.95, 0.034, Region.FOREARM],
    [0.9, 0.029, Region.FOREARM],
    [0.89, 0.034, Region.GLOVE],
    [0.83, 0.04, Region.GLOVE],
    [0.78, 0.034, Region.GLOVE],
    [0.74, 0.012, Region.GLOVE],
  ];
  const rings: Ring[] = rows.map(([y, r, region]) => ({
    c: [0.235 * sx + (1.44 - y) * 0.02 * sx, y, 0],
    rx: r,
    rz: r * 0.92,
    region,
    w:
      y >= 1.2
        ? [[upper, 1]]
        : y >= 1.1
          ? blend(upper, fore, ease((1.2 - y) / 0.1))
          : y >= 0.92
            ? [[fore, 1]]
            : y >= 0.86
              ? blend(fore, hand, ease((0.92 - y) / 0.06))
              : [[hand, 1]],
  }));
  b.loft(rings, 12, 'y');
}

function buildHead(b: Builder) {
  const cy = 1.69;
  const rings: Ring[] = [];
  const steps = 11;
  for (let i = 0; i <= steps; i++) {
    const phi = (i / steps) * Math.PI;
    const y = cy - Math.cos(phi) * 0.118;
    const k = Math.max(0.0001, Math.sin(phi));
    rings.push({
      c: [0, y, 0.004 + Math.sin(phi) * 0.004],
      rx: 0.086 * k,
      rz: 0.1 * k,
      region: (theta) =>
        y > cy + 0.025 && Math.sin(theta) < 0.55
          ? Region.HAIR
          : y > cy - 0.01 && Math.sin(theta) < -0.35
            ? Region.HAIR
            : Region.SKIN,
      w: [['head', 1]],
    });
  }
  b.loft(rings, 16, 'y');
  // neck
  b.loft(
    [1.5, 1.56, 1.62].map((y, i) => ({
      c: [0, y, 0] as V3,
      rx: 0.052 - i * 0.003,
      rz: 0.054 - i * 0.003,
      region: Region.SKIN,
      w: (i === 0 ? blend('chest', 'neck', 0.8) : [['neck', 1]]) as Weights,
    })),
    12,
    'y'
  );
}

export interface HumanGeometry {
  geometry: THREE.BufferGeometry;
  region: Float32Array;
  uvShirt: Float32Array;
  theta: Float32Array;
  positions: Float32Array;
}

let sharedGeometry: HumanGeometry | undefined;
/** The one shared skinned body. Vertices are in the standing bind pose. */
export function humanGeometry(): HumanGeometry {
  if (sharedGeometry) return sharedGeometry;
  const b = new Builder();
  buildTorso(b);
  buildLeg(b, 'L');
  buildLeg(b, 'R');
  buildArm(b, 'L');
  buildArm(b, 'R');
  buildHead(b);
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(b.position);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(b.skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(b.skinWeight, 4));
  geometry.setIndex(b.index);
  geometry.computeVertexNormals();
  sharedGeometry = {
    geometry,
    region: new Float32Array(b.region),
    uvShirt: new Float32Array(b.uvShirt),
    theta: new Float32Array(b.theta),
    positions,
  };
  return sharedGeometry;
}

/* ------------------------------------------------------------------------------------- *
 * Looks: kit, skin, hair. A look only owns a colour + uv attribute pair; position, skin
 * weights and index buffers are shared by every player.
 * ------------------------------------------------------------------------------------- */
export type KitPattern = 'solid' | 'stripes' | 'hoops' | 'halves' | 'sash';
export interface KitLook {
  primary: string;
  secondary: string;
  pattern: KitPattern;
  shorts: string;
  socks: string;
  /** Long, solid-colour sleeves and gloves for goalkeepers. */
  keeper?: boolean;
  glove?: string;
}
export interface Look {
  kit: KitLook;
  skin: string;
  hair: string;
}
export const SKIN_TONES = ['#f2c7a0', '#d99c73', '#a86b45', '#6f4328', '#f5d6b8'];
export const HAIR_TONES = ['#1d1a18', '#4a2f1d', '#a9783b', '#d8c079', '#0f0e10'];

export function kitFromClub(kit: {
  primary: string;
  secondary: string;
  pattern: KitPattern;
}): KitLook {
  return { ...kit, shorts: kit.secondary, socks: kit.primary };
}

const c3 = (hex: string) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b] as const;
};

export interface LookGeometry {
  geometry: THREE.BufferGeometry;
  dispose(): void;
}
export function lookGeometry(look: Look): LookGeometry {
  const base = humanGeometry();
  const geometry = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'skinIndex', 'skinWeight'] as const)
    geometry.setAttribute(name, base.geometry.getAttribute(name));
  geometry.setIndex(base.geometry.getIndex());
  const count = base.region.length;
  const color = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const kit = look.kit;
  const table: Record<number, readonly [number, number, number]> = {
    [Region.SKIN]: c3(look.skin),
    [Region.SHORTS]: c3(kit.shorts),
    [Region.SOCK]: c3(kit.socks),
    [Region.BOOT]: c3('#15171c'),
    [Region.HAIR]: c3(look.hair),
    [Region.GLOVE]: c3(kit.glove ?? look.skin),
    [Region.FOREARM]: kit.keeper ? ([1, 1, 1] as const) : c3(look.skin),
    [Region.SHIRT]: [1, 1, 1],
  };
  for (let i = 0; i < count; i++) {
    const region = base.region[i];
    const textured = region === Region.SHIRT || (region === Region.FOREARM && kit.keeper);
    const rgb = table[region];
    color.set(rgb, i * 3);
    uv[i * 2] = textured ? base.uvShirt[i * 2] : 0.02;
    uv[i * 2 + 1] = textured ? base.uvShirt[i * 2 + 1] : 0.02;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return {
    geometry,
    // dispose() releases the GPU buffers of this geometry, including its own colour/uv pair.
    // Position, normal and skin buffers are shared and are simply re-uploaded if still used.
    dispose() {
      geometry.dispose();
      geometry.deleteAttribute('color');
      geometry.deleteAttribute('uv');
    },
  };
}

/** Canvas texture for the shirt (top half) with a white swatch for everything else. */
export function kitTexture(kit: KitLook): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 256, 256);
  const h = 128; // top half of the canvas is v in [0.5, 1]
  ctx.fillStyle = kit.primary;
  ctx.fillRect(0, 0, 256, h);
  ctx.fillStyle = kit.secondary;
  if (kit.pattern === 'stripes')
    for (let i = 0; i < 12; i += 2) ctx.fillRect((i * 256) / 12, 0, 256 / 12, h);
  else if (kit.pattern === 'hoops')
    for (let i = 0; i < 8; i += 2) ctx.fillRect(0, (i * h) / 8, 256, h / 8);
  else if (kit.pattern === 'halves')
    ctx.fillRect(64, 0, 128, h); // the character's right half
  else if (kit.pattern === 'sash') {
    // Front centre is u = 0.75, back centre u = 0.25 (u runs against the heading angle).
    for (const [a, b, c, d] of [
      [150, 186, 236, 200],
      [22, 58, 108, 72],
    ]) {
      ctx.beginPath();
      ctx.moveTo(a, 0);
      ctx.lineTo(b, 0);
      ctx.lineTo(c, h);
      ctx.lineTo(d, h);
      ctx.closePath();
      ctx.fill();
    }
  }
  if (!kit.keeper) {
    ctx.fillStyle = kit.pattern === 'solid' ? kit.secondary : 'rgba(255,255,255,0.85)';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PQ', 192, 44);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 2;
  return texture;
}

/* ------------------------------------------------------------------------------------- *
 * Rig instance
 * ------------------------------------------------------------------------------------- */
export interface Rig {
  /** Place this in the world: position the feet, rotate.y is the heading. */
  root: THREE.Group;
  bones: Record<BoneName, THREE.Bone>;
  mesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  plate: THREE.Mesh | null;
  /** Releases only per-instance GPU resources (the skeleton's bone texture). */
  dispose(): void;
}

export function createRig(material: THREE.Material, lookGeo: THREE.BufferGeometry): Rig {
  const root = new THREE.Group();
  const bones = {} as Record<BoneName, THREE.Bone>;
  for (const name of BONES) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(...REST[name][1]);
    bones[name] = bone;
    const parent = REST[name][0];
    (parent ? bones[parent] : root).add(bone);
  }
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(BONES.map((n) => bones[n]));
  const mesh = new THREE.SkinnedMesh(lookGeo, material);
  mesh.frustumCulled = false; // bounds are the bind pose; limbs move well outside them
  mesh.castShadow = true;
  root.add(mesh);
  mesh.bind(skeleton, mesh.matrixWorld);
  return {
    root,
    bones,
    mesh,
    skeleton,
    plate: null,
    dispose() {
      skeleton.dispose();
      root.removeFromParent();
    },
  };
}
