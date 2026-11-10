import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BROADCAST_RIG, PITCH } from './director';
import { buildTurf } from './turf';
import { buildCrowd, type CrowdRow } from './crowd';

/**
 * Original procedural floodlit stadium: analytic turf and markings, goals with stanchions and
 * deformable mesh netting, LED perimeter boards that rotate between fictional sponsors, a
 * two-tier bowl with aisles, an LED ribbon fascia, roofs with floodlight banks and glare, and a
 * full crowd of animated spectator cards. No external textures or models: every texture is
 * generated here and disposed with the stadium. Static structure shares one material and one
 * draw call; the whole stadium is about twenty draw calls.
 */
export interface Net {
  group: THREE.Group;
  /** Starts a ripple at a world point. */
  impact(x: number, y: number, z: number): void;
  update(dt: number): void;
}
export interface Stadium {
  group: THREE.Group;
  nets: Record<'-1' | '1', Net>;
  update(dt: number, crowdExcite: number): void;
  dispose(): void;
}
export interface StadiumOptions {
  /** Maximum anisotropic filtering the renderer supports (turf detail at grazing angles). */
  anisotropy?: number;
}

/** Stand cross-section in metres, local frame: x along the stand, z away from the pitch. */
export const STAND = Object.freeze({
  frontWall: 1.2,
  rowDepth: 0.82,
  lowerRows: 18,
  lowerRise: 0.4,
  upperFront: 11.2,
  upperBase: 11.2,
  upperSoffit: 9.0,
  upperRows: 18,
  upperRise: 0.56,
  back: 26,
  roofBack: 25.2,
  roofFront: 2.2,
  roofFrontY: 23.2,
  aisleEvery: 14,
  aisleWidth: 1.2,
});
/** Distance from the touch/goal lines to the front of each stand. */
export const STAND_SETBACK = 5.5;

const BRANDS: Array<[string, string, string]> = [
  ['SALEM BET', '#3b0a17', '#f2c6a8'],
  ['NORTHQUAY AIR', '#f2f2f2', '#c61f2b'],
  ['EMBER BANK', '#ffb81c', '#2a1500'],
  ['HIGHCREST LABS', '#0f6b4f', '#eafff6'],
  ['TIDEWELL FOODS', '#1a3ea8', '#ffffff'],
  ['MERIDIAN TELECOM', '#2b2d31', '#ffd23f'],
];

/** Fictional sponsors on an LED surface: brand panels with a fine pixel grid. */
function ledTexture(height = 64): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width / BRANDS.length;
  BRANDS.forEach(([text, bg, fg], i) => {
    ctx.fillStyle = bg;
    ctx.fillRect(i * w, 0, w, height);
    ctx.fillStyle = fg;
    ctx.font = `800 ${Math.round(height * 0.5)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, i * w + w / 2, height * 0.54);
  });
  // LED pixel pitch: thin dark rows and columns.
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  for (let y = 0; y < height; y += 4) ctx.fillRect(0, y, canvas.width, 1);
  for (let x = 0; x < canvas.width; x += 4) ctx.fillRect(x, 0, 1, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

/** Square knotted mesh: one cell per texture tile. */
function netTexture(): THREE.CanvasTexture {
  const n = 64;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, n, n);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, n, 6);
  ctx.fillRect(0, 0, 6, n);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Soft additive floodlight glare. */
function glareTexture(): THREE.DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const r = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) * 2;
      const core = Math.exp(-r * r * 30);
      const halo = Math.max(0, 1 - r) ** 2 * 0.35;
      const v = Math.min(255, Math.round(255 * (core + halo)));
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = v;
    }
  const texture = new THREE.DataTexture(data, n, n);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/* ----------------------------------------------------------------------------------------- *
 * Goal netting: a subdivided mesh (back, roof, sides) that ripples when the ball arrives.
 * ----------------------------------------------------------------------------------------- */
class NetImpl implements Net {
  group = new THREE.Group();
  geometry: THREE.BufferGeometry;
  private base: Float32Array;
  private energy = 0;
  private origin = new THREE.Vector3();
  private time = 0;
  constructor(
    private side: 1 | -1,
    material: THREE.Material
  ) {
    const gw = PITCH.goalHalfWidth;
    const gh = PITCH.goalHeight;
    const gd = PITCH.goalDepth;
    const cell = 0.13;
    const panels: THREE.BufferGeometry[] = [];
    // Local frame: +x is out of the goal (behind the line), +y up, z across.
    const panel = (
      width: number,
      height: number,
      sx: number,
      sy: number,
      place: (u: number, v: number) => [number, number, number]
    ) => {
      const g = new THREE.PlaneGeometry(width, height, sx, sy);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const u = pos.getX(i) / width + 0.5;
        const v = pos.getY(i) / height + 0.5;
        pos.setXYZ(i, ...place(u, v));
        uv.setXY(i, (u * width) / cell, (v * height) / cell);
      }
      panels.push(g);
    };
    panel(gw * 2, gh, 18, 7, (u, v) => [gd, v * gh, -gw + u * 2 * gw]); // back
    panel(gw * 2, gd, 18, 5, (u, v) => [v * gd, gh, -gw + u * 2 * gw]); // roof
    for (const zz of [-gw, gw]) panel(gd, gh, 5, 7, (u, v) => [u * gd, v * gh, zz]); // sides
    this.geometry = mergeGeometries(panels)!;
    panels.forEach((p) => p.dispose());
    this.geometry.deleteAttribute('normal');
    this.base = new Float32Array(this.geometry.getAttribute('position').array);
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.group.position.x = side * PITCH.halfLength;
    this.group.scale.x = side;
  }
  impact(x: number, y: number, z: number) {
    this.origin.set(Math.abs(x - this.side * PITCH.halfLength), y, z);
    this.energy = 1;
    this.time = 0;
  }
  update(dt: number) {
    if (this.energy <= 0.002) return;
    this.time += dt;
    this.energy *= Math.exp(-dt * 2.1);
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const bx = this.base[i];
      const by = this.base[i + 1];
      const bz = this.base[i + 2];
      const d = Math.hypot(by - this.origin.y, bz - this.origin.z);
      const wave = Math.cos(this.time * 22 - d * 3.2) * Math.exp(-d * d * 0.28);
      // Bulge outwards (away from the pitch), strongest at the back netting.
      const depth = bx / PITCH.goalDepth;
      arr[i] = bx + wave * this.energy * 0.55 * (0.25 + 0.75 * depth);
      arr[i + 1] = by + wave * this.energy * 0.12 * depth;
      arr[i + 2] = bz + wave * this.energy * 0.1 * Math.sign(bz - this.origin.z) * depth;
    }
    pos.needsUpdate = true;
  }
}

/* ----------------------------------------------------------------------------------------- *
 * Stand bowl geometry (vertex coloured, merged)
 * ----------------------------------------------------------------------------------------- */
const SEAT = new THREE.Color('#4a1624');
const SEAT_ALT = new THREE.Color('#2a2c33');
const STEP = new THREE.Color('#6a6d73');
const CONCRETE = new THREE.Color('#4b4f57');
const DARK = new THREE.Color('#1c1e23');
const ROOF = new THREE.Color('#2c3037');
const ROOF_EDGE = new THREE.Color('#41464f');

class Builder {
  positions: number[] = [];
  colours: number[] = [];
  /** Axis-aligned quad in the stand's local frame given four corners (counter-clockwise). */
  quad(a: number[], b: number[], c: number[], d: number[], colour: THREE.Color) {
    for (const p of [a, b, c, a, c, d]) {
      this.positions.push(p[0], p[1], p[2]);
      this.colours.push(colour.r, colour.g, colour.b);
    }
  }
  /** Box from min to max corner (all six faces). */
  box(min: number[], max: number[], colour: THREE.Color) {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], colour); // front (-z)
    this.quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], colour); // back
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], colour); // top
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], colour); // bottom
    this.quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], colour); // left
    this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], colour); // right
  }
  geometry(transform: THREE.Matrix4) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colours, 3));
    g.applyMatrix4(transform);
    g.computeVertexNormals();
    return g;
  }
}

interface StandBuild {
  geometry: THREE.BufferGeometry;
  rows: CrowdRow[];
  ribbon: THREE.BufferGeometry;
  lamps: THREE.BufferGeometry;
  glare: number[];
}

/**
 * One stand: lower tier, fascia with an LED ribbon, upper tier, back wall and roof. The stand is
 * built in a local frame (front edge along local x at z = 0, rising toward +z) and placed with
 * `transform`. Crowd rows and floodlight positions are returned in world space.
 */
function buildStand(length: number, transform: THREE.Matrix4, seed: number): StandBuild {
  const s = STAND;
  const b = new Builder();
  const half = length / 2;
  const rows: CrowdRow[] = [];
  const along = new THREE.Vector3(1, 0, 0).transformDirection(transform);
  const facing = new THREE.Vector3(0, 0, -1).transformDirection(transform);
  const aisleSet: Array<[number, number]> = [];
  for (let x = -half + s.aisleEvery; x < half - 4; x += s.aisleEvery)
    aisleSet.push([x - s.aisleWidth / 2, x + s.aisleWidth / 2]);
  // Seat blocks between aisles along the stand.
  const blocks: Array<[number, number]> = [];
  let cursor = -half;
  for (const [a0, a1] of aisleSet) {
    blocks.push([cursor, a0]);
    cursor = a1;
  }
  blocks.push([cursor, half]);

  b.box([-half, 0, -0.3], [half, s.frontWall, 0], DARK); // front wall
  const tier = (
    rowsN: number,
    rise: number,
    y0: number,
    z0: number,
    shadeFront: number,
    shadeBack: number,
    tierIndex: number
  ) => {
    for (let r = 0; r < rowsN; r++) {
      const y = y0 + r * rise;
      const prevY = r === 0 ? y0 - rise : y - rise;
      const za = z0 + r * s.rowDepth;
      const zb = za + s.rowDepth;
      const shade = shadeFront + (shadeBack - shadeFront) * (r / Math.max(1, rowsN - 1));
      for (const [x0, x1] of blocks) {
        const seat =
          (Math.floor((x0 + half) / s.aisleEvery) + tierIndex) % 5 === 4 ? SEAT_ALT : SEAT;
        b.quad([x0, y, za], [x1, y, za], [x1, y, zb], [x0, y, zb], seat); // tread
        b.quad([x0, prevY, za], [x1, prevY, za], [x1, y, za], [x0, y, za], DARK); // riser
        rows.push({
          origin: new THREE.Vector3(x0 + 0.05, y - 0.08, za + 0.5).applyMatrix4(transform),
          along,
          facing,
          length: x1 - x0 - 0.1,
          shade,
          seed: seed * 1000 + tierIndex * 100 + r + x0 * 0.01,
        });
      }
      for (const [x0, x1] of aisleSet) {
        b.quad([x0, y, za], [x1, y, za], [x1, y, zb], [x0, y, zb], STEP);
        b.quad([x0, prevY, za], [x1, prevY, za], [x1, y, za], [x0, y, za], CONCRETE);
      }
    }
  };
  // Lower tier.
  tier(s.lowerRows, s.lowerRise, s.frontWall, 0, 0.68, 0.5, 0);
  const lowerBack = s.lowerRows * s.rowDepth;
  b.box([-half, 0, lowerBack], [half, s.upperSoffit, lowerBack + 0.4], DARK); // concourse wall
  // Upper tier: fascia (with the LED ribbon in front), soffit and seating.
  const upperY0 = s.upperBase;
  b.box([-half, s.upperSoffit, s.upperFront - 0.4], [half, upperY0, s.upperFront], CONCRETE);
  b.quad(
    [-half, s.upperSoffit, s.back],
    [half, s.upperSoffit, s.back],
    [half, s.upperSoffit, s.upperFront],
    [-half, s.upperSoffit, s.upperFront],
    DARK
  ); // soffit, facing down
  tier(s.upperRows, s.upperRise, upperY0, s.upperFront, 0.56, 0.4, 1);
  const upperTop = upperY0 + (s.upperRows - 1) * s.upperRise;
  // Back wall, and end caps that follow the rake of both tiers (not a full-height slab).
  b.box([-half, 0, s.back], [half, s.roofBack + 0.4, s.back + 0.6], CONCRETE);
  const profile = (d: number) =>
    d < s.upperFront
      ? s.frontWall + 0.9 + (d / s.rowDepth) * s.lowerRise
      : s.upperBase + 0.9 + ((d - s.upperFront) / s.rowDepth) * s.upperRise;
  const stops = [0, s.upperFront - 1e-3, s.upperFront, s.back];
  for (const x of [-half - 0.3, half + 0.3])
    for (let i = 0; i < stops.length - 1; i++) {
      const [d0, d1] = [stops[i], stops[i + 1]];
      const [y0, y1] = [profile(d0), Math.min(upperTop + 1.5, profile(d1))];
      b.quad([x, 0, d0], [x, 0, d1], [x, y1, d1], [x, y0, d0], DARK);
    }
  // Roof: sloping slab from the back wall to the front edge, with a deeper front fascia.
  const roofT = 0.6;
  b.quad(
    [-half, s.roofBack, s.back + 0.6],
    [half, s.roofBack, s.back + 0.6],
    [half, s.roofFrontY, s.roofFront],
    [-half, s.roofFrontY, s.roofFront],
    ROOF
  ); // top
  b.quad(
    [-half, s.roofFrontY - roofT, s.roofFront],
    [half, s.roofFrontY - roofT, s.roofFront],
    [half, s.roofBack - roofT, s.back + 0.6],
    [-half, s.roofBack - roofT, s.back + 0.6],
    ROOF
  ); // underside
  b.box(
    [-half, s.roofFrontY - 1.5, s.roofFront - 0.5],
    [half, s.roofFrontY + 0.3, s.roofFront],
    ROOF_EDGE
  ); // front edge truss
  const geometry = b.geometry(transform);

  // LED ribbon on the upper-tier fascia (UVs run along the stand).
  const ribbonHeight = 1.0;
  const ribbon = new THREE.PlaneGeometry(length, ribbonHeight);
  ribbon.rotateY(Math.PI); // face the pitch (local -z)
  ribbon.translate(0, s.upperSoffit + 0.95, s.upperFront - 0.42);
  const ruv = ribbon.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < ruv.count; i++) ruv.setX(i, ruv.getX(i) * (length / 48));
  ribbon.applyMatrix4(transform);

  // Floodlight banks under the roof front edge, with glare points.
  const lampParts: THREE.BufferGeometry[] = [];
  const glare: number[] = [];
  const lampY = s.roofFrontY - 1.8;
  for (let x = -half + 3; x <= half - 3; x += 3.2) {
    const lamp = new THREE.BoxGeometry(1.7, 0.7, 0.5);
    lamp.rotateX(0.5);
    lamp.translate(x, lampY, s.roofFront + 0.2);
    lampParts.push(lamp);
    if (Math.round((x + half) / 3.2) % 3 === 0) {
      const p = new THREE.Vector3(x, lampY - 0.2, s.roofFront - 0.4).applyMatrix4(transform);
      glare.push(p.x, p.y, p.z);
    }
  }
  const lamps = mergeGeometries(lampParts)!;
  lampParts.forEach((g) => g.dispose());
  lamps.applyMatrix4(transform);
  return { geometry, rows, ribbon, lamps, glare };
}

export function buildStadium(options: StadiumOptions = {}): Stadium {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T) => (geometries.push(g), g);
  const mat = <T extends THREE.Material>(m: T) => (materials.push(m), m);
  const tex = <T extends THREE.Texture>(t: T) => (textures.push(t), t);

  // --- turf and surround -----------------------------------------------------------------
  const turf = buildTurf({ anisotropy: options.anisotropy });
  group.add(turf.mesh);
  const apron = new THREE.Mesh(
    track(new THREE.PlaneGeometry(420, 320)),
    mat(new THREE.MeshStandardMaterial({ color: '#1d2126', roughness: 1 }))
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.02;
  apron.receiveShadow = true;
  group.add(apron);

  // --- goals ------------------------------------------------------------------------------
  const post = mat(
    new THREE.MeshStandardMaterial({ color: '#f7f7f4', roughness: 0.3, metalness: 0.15 })
  );
  const support = mat(
    new THREE.MeshStandardMaterial({ color: '#c9ccd1', roughness: 0.45, metalness: 0.4 })
  );
  const netMap = tex(netTexture());
  const netMaterial = mat(
    new THREE.MeshStandardMaterial({
      color: '#f4f6f2',
      alphaMap: netMap,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: THREE.DoubleSide,
      roughness: 0.85,
    })
  );
  const nets = {} as Record<'-1' | '1', NetImpl>;
  const gw = PITCH.goalHalfWidth;
  const gh = PITCH.goalHeight;
  const gd = PITCH.goalDepth;
  const upright = track(new THREE.CylinderGeometry(0.06, 0.06, gh, 12));
  const bar = track(new THREE.CylinderGeometry(0.06, 0.06, gw * 2 + 0.12, 12));
  const tube = track(new THREE.CylinderGeometry(0.022, 0.022, 1, 6));
  const pipe = (frame: THREE.Group, a: THREE.Vector3, b: THREE.Vector3) => {
    const m = new THREE.Mesh(tube, support);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.scale.y = a.distanceTo(b);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    frame.add(m);
  };
  for (const s of [-1, 1] as const) {
    const frame = new THREE.Group();
    for (const z of [-1, 1]) {
      const p = new THREE.Mesh(upright, post);
      p.position.set(0, gh / 2, z * gw);
      p.castShadow = true;
      frame.add(p);
      // Stanchions holding the net box: top-side, rear vertical and ground bars.
      pipe(frame, new THREE.Vector3(0, gh, z * gw), new THREE.Vector3(gd, gh, z * gw));
      pipe(frame, new THREE.Vector3(gd, 0, z * gw), new THREE.Vector3(gd, gh, z * gw));
      pipe(frame, new THREE.Vector3(0, 0.02, z * gw), new THREE.Vector3(gd, 0.02, z * gw));
    }
    pipe(frame, new THREE.Vector3(gd, gh, -gw), new THREE.Vector3(gd, gh, gw));
    pipe(frame, new THREE.Vector3(gd, 0.02, -gw), new THREE.Vector3(gd, 0.02, gw));
    const b = new THREE.Mesh(bar, post);
    b.rotation.x = Math.PI / 2;
    b.position.set(0, gh, 0);
    b.castShadow = true;
    frame.add(b);
    frame.position.x = s * PITCH.halfLength;
    frame.scale.x = s;
    group.add(frame);
    const net = new NetImpl(s, netMaterial);
    geometries.push(net.geometry);
    group.add(net.group);
    nets[String(s) as '-1' | '1'] = net;
  }
  // Corner flags
  const flagPole = track(new THREE.CylinderGeometry(0.02, 0.02, 1.6, 6));
  const flagCloth = track(new THREE.PlaneGeometry(0.4, 0.28));
  const clothMat = mat(
    new THREE.MeshStandardMaterial({ color: '#ffd23f', side: THREE.DoubleSide, roughness: 0.8 })
  );
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const pole = new THREE.Mesh(flagPole, post);
      pole.position.set(sx * PITCH.halfLength, 0.8, sz * PITCH.halfWidth);
      group.add(pole);
      const cloth = new THREE.Mesh(flagCloth, clothMat);
      cloth.position.set(sx * PITCH.halfLength - sx * 0.2, 1.45, sz * PITCH.halfWidth);
      cloth.rotation.y = Math.PI / 2;
      group.add(cloth);
    }

  // --- LED perimeter boards -----------------------------------------------------------------
  const boardTexture = tex(ledTexture());
  boardTexture.repeat.set(2, 1);
  // LEDs emit: unlit and slightly over unity so they read as bright screens under tone mapping.
  const screen = mat(
    new THREE.MeshBasicMaterial({ map: boardTexture, color: new THREE.Color(1.25, 1.25, 1.25) })
  );
  const body = mat(new THREE.MeshStandardMaterial({ color: '#16181c', roughness: 0.7 }));
  const boardLong = track(new THREE.BoxGeometry(PITCH.halfLength * 2 + 6, 0.9, 0.18));
  const boardEnd = track(new THREE.BoxGeometry(0.18, 0.9, PITCH.halfWidth * 2 + 6));
  for (const sz of [-1, 1]) {
    const m = new THREE.Mesh(boardLong, [body, body, body, body, screen, screen]);
    m.position.set(0, 0.45, sz * (PITCH.halfWidth + 3.2));
    group.add(m);
  }
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(boardEnd, [screen, screen, body, body, body, body]);
    m.position.set(sx * (PITCH.halfLength + 4.2), 0.45, 0);
    group.add(m);
  }

  // --- stand bowl ---------------------------------------------------------------------------
  const front = (side: 'far' | 'left' | 'right') =>
    side === 'far' ? PITCH.halfWidth + STAND_SETBACK : PITCH.halfLength + STAND_SETBACK;
  const endBack = front('left') + STAND.back + 0.6;
  const farLength = endBack * 2 + 1.2;
  const nearExtent = PITCH.halfWidth + 13; // end stands wrap toward the camera side
  const endLength = nearExtent + front('far');
  const endCentre = (nearExtent - front('far')) / 2;
  const stands = [
    buildStand(
      farLength,
      new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, 0, -front('far')),
      1
    ),
    buildStand(
      endLength,
      new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(-front('left'), 0, endCentre),
      2
    ),
    buildStand(
      endLength,
      new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(front('right'), 0, endCentre),
      3
    ),
  ];
  const structure = new THREE.Mesh(
    track(mergeGeometries(stands.map((s) => s.geometry))!),
    mat(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.92,
        metalness: 0,
        side: THREE.DoubleSide,
      })
    )
  );
  stands.forEach((s) => s.geometry.dispose());
  structure.name = 'stands';
  group.add(structure);

  const ribbonTexture = tex(ledTexture(48));
  const ribbon = new THREE.Mesh(
    track(mergeGeometries(stands.map((s) => s.ribbon))!),
    mat(
      new THREE.MeshBasicMaterial({
        map: ribbonTexture,
        color: new THREE.Color(1.1, 1.1, 1.1),
        side: THREE.DoubleSide,
      })
    )
  );
  stands.forEach((s) => s.ribbon.dispose());
  group.add(ribbon);

  const lamps = new THREE.Mesh(
    track(mergeGeometries(stands.map((s) => s.lamps))!),
    mat(new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff9ee').multiplyScalar(2.2) }))
  );
  stands.forEach((s) => s.lamps.dispose());
  group.add(lamps);
  const glareGeometry = track(new THREE.BufferGeometry());
  glareGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      stands.flatMap((s) => s.glare),
      3
    )
  );
  const glare = new THREE.Points(
    glareGeometry,
    mat(
      new THREE.PointsMaterial({
        map: tex(glareTexture()),
        color: '#fff2da',
        size: 7,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      })
    )
  );
  glare.renderOrder = 3;
  group.add(glare);

  // --- crowd --------------------------------------------------------------------------------
  const crowd = buildCrowd(
    stands.flatMap((s) => s.rows),
    { x: BROADCAST_RIG.x, z: BROADCAST_RIG.z }
  );
  group.add(crowd.mesh);

  // --- distant skyline ------------------------------------------------------------------------
  const skylineParts: THREE.BufferGeometry[] = [];
  const farBack = -(front('far') + STAND.back);
  for (let i = 0; i < 40; i++) {
    const h = 18 + ((i * 53) % 41);
    const w = 7 + ((i * 29) % 8);
    const g = new THREE.BoxGeometry(w, h, w);
    g.translate(-230 + i * 11.8, h / 2 - 2, farBack - 110 - ((i * 17) % 50));
    skylineParts.push(g);
  }
  const skyline = new THREE.Mesh(
    track(mergeGeometries(skylineParts)!),
    mat(
      new THREE.MeshStandardMaterial({
        color: '#0d1422',
        emissive: '#1d2a44',
        emissiveIntensity: 0.55,
        roughness: 1,
      })
    )
  );
  skylineParts.forEach((g) => g.dispose());
  group.add(skyline);

  // LED content rotates between sponsors with a quick slide, as stadium boards do.
  const slot = 1 / BRANDS.length;
  let clock = 0;
  let crowdTime = 0;
  const boardOffset = () => {
    const step = clock / 8;
    const k = Math.floor(step);
    const f = THREE.MathUtils.smoothstep(step - k, 0.9, 1);
    return (k + f) * slot;
  };

  return {
    group,
    nets: nets as unknown as Stadium['nets'],
    update(dt, excite) {
      nets['-1'].update(dt);
      nets['1'].update(dt);
      clock += dt;
      crowdTime += dt;
      boardTexture.offset.x = boardOffset();
      ribbonTexture.offset.x = -boardOffset() * 0.5;
      crowd.update(crowdTime, excite);
    },
    dispose() {
      turf.dispose();
      crowd.dispose();
      geometries.forEach((g) => g.dispose());
      materials.forEach((x) => x.dispose());
      textures.forEach((x) => x.dispose());
    },
  };
}
