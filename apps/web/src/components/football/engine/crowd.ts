import * as THREE from 'three';

/**
 * Original spectator cards for the stadium bowl. Each seat row is one quad strip textured with
 * hand-drawn (canvas) seated supporters; the shader gives every supporter an individual bob
 * and lets a share of them stand with raised arms as excitement rises. One draw call covers
 * every row, replacing roughly half a million crowd triangles with a few hundred, which keeps
 * the bowl full on phones. Seen from the fixed broadcast camera the nearest crowd is more
 * than 60 m away, where a drawn card reads like a person and 3D geometry adds nothing.
 */
export interface CrowdRow {
  /** World position of the left end of the row at seat level. */
  origin: THREE.Vector3;
  /** Unit vector along the row (left to right as seen from the pitch). */
  along: THREE.Vector3;
  length: number;
  /** Horizontal unit vector from the row toward the pitch. */
  facing: THREE.Vector3;
  /** 0..1 brightness of the row (back rows under the roof are darker). */
  shade: number;
  seed: number;
}
export interface Crowd {
  mesh: THREE.Mesh;
  update(time: number, excite: number): void;
  dispose(): void;
}

/** Seat pitch (m) and card height (m). */
export const CROWD_SEAT = 0.5;
export const CROWD_HEIGHT = 1.3;
const PEOPLE_PER_TILE = 32;
const CELL_W = 40;
/** People per camera-facing card segment, and the largest turn away from the row's facing. */
const SEGMENT_PEOPLE = 4;
const MAX_TURN = (60 * Math.PI) / 180;
const CELL_H = 96;

// Evening match: mostly dark jackets and hoodies, with some club colours and light tops.
const SHIRTS = [
  '#16181f',
  '#1d2130',
  '#22252d',
  '#2b2f3a',
  '#323744',
  '#3b404c',
  '#1b2a44',
  '#26324a',
  '#4a4f5a',
  '#5b1a2a',
  '#6e1d30',
  '#8c2b2b',
  '#3f4a36',
  '#b9b4aa',
  '#d6d1c6',
  '#7d6a3a',
];
const SKIN = ['#e5b894', '#c99570', '#b67b56', '#9a6243', '#70452f', '#f0c9a6'];
const HAIR = ['#1c1612', '#2e2018', '#4a3423', '#8a6a3f', '#b9a27a', '#2a2a2e', '#6b6b6b'];

function crowdTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * PEOPLE_PER_TILE;
  canvas.height = CELL_H * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  let seed = 2027;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
  const ellipse = (x: number, y: number, rx: number, ry: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  const rounded = (x: number, y: number, w: number, h: number, r: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();
  };
  for (let i = 0; i < PEOPLE_PER_TILE; i++) {
    const empty = rand() < 0.08;
    const shirt = pick(SHIRTS);
    const skin = pick(SKIN);
    const hair = pick(HAIR);
    const cap = rand() < 0.16 ? pick(['#1b1d24', '#7a1f33', '#dcd6ca', '#2c4f8c']) : null;
    const scarf = rand() < 0.22 ? pick(['#7a1f33', '#9a2a3c', '#e9e4da', '#2c4f8c']) : null;
    const lean = (rand() - 0.5) * 4;
    const build = 0.9 + rand() * 0.22;
    const tall = (rand() - 0.5) * 6;
    for (const standing of [false, true]) {
      if (empty) continue;
      const cx = i * CELL_W + CELL_W / 2 + lean;
      // Canvas top half is v 0.5..1 (seated); the lower half is v 0..0.5 (standing).
      const top = standing ? CELL_H : 0;
      const lift = standing ? 16 : 0;
      const baseY = top + CELL_H; // seat level at the bottom of the cell
      const shoulderY = baseY - 58 - lift + tall;
      const tw = 29 * build;
      // Legs/trousers show between the knees and the row in front.
      rounded(cx - tw * 0.42, baseY - 26 - lift * 0.4, tw * 0.84, 26 + lift * 0.4, 3, '#23242b');
      // Torso and shoulders.
      rounded(cx - tw / 2, shoulderY, tw, baseY - shoulderY - 18, 7, shirt);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(cx - tw / 2, baseY - 26 - lift * 0.4, tw, 4);
      if (standing) {
        // Arms raised: celebrating, applauding or holding a scarf aloft.
        const spread = 6 + rand() * 6;
        for (const s of [-1, 1]) {
          ctx.strokeStyle = shirt;
          ctx.lineWidth = 6;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(cx + s * tw * 0.4, shoulderY + 6);
          ctx.lineTo(cx + s * (tw * 0.4 + spread), shoulderY - 20);
          ctx.stroke();
          ellipse(cx + s * (tw * 0.4 + spread), shoulderY - 23, 3.2, 3.6, skin);
        }
        if (scarf) {
          ctx.fillStyle = scarf;
          ctx.fillRect(cx - tw * 0.4 - spread, shoulderY - 28, tw * 0.8 + spread * 2, 5);
        }
      } else {
        // Forearms resting forward, hands together.
        for (const s of [-1, 1]) {
          ctx.strokeStyle = shirt;
          ctx.lineWidth = 6;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(cx + s * tw * 0.45, shoulderY + 8);
          ctx.lineTo(cx + s * tw * 0.22, shoulderY + 30);
          ctx.stroke();
        }
        ellipse(cx, shoulderY + 31, 5, 3.4, skin);
      }
      if (scarf && !standing) {
        ctx.fillStyle = scarf;
        ctx.fillRect(cx - tw * 0.32, shoulderY - 1, tw * 0.64, 6);
      }
      // Neck, head and hair or cap.
      ctx.fillStyle = skin;
      ctx.fillRect(cx - 3, shoulderY - 6, 6, 8);
      const headY = shoulderY - 14;
      ellipse(cx, headY, 7.4, 9, skin);
      ellipse(cx - 2.6, headY + 1, 1.1, 0.9, 'rgba(30,20,15,0.55)');
      ellipse(cx + 2.6, headY + 1, 1.1, 0.9, 'rgba(30,20,15,0.55)');
      if (cap) {
        ellipse(cx, headY - 5, 8, 5.4, cap);
        ctx.fillStyle = cap;
        ctx.fillRect(cx - 8, headY - 4, 16, 3);
      } else {
        ctx.fillStyle = hair;
        ctx.beginPath();
        ctx.ellipse(cx, headY - 3.5, 7.8, 6.4, 0, Math.PI, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;
  return texture;
}

/**
 * @param viewer Where the fixed broadcast camera stands. Rows are split into short segments that
 * each turn toward it (up to 60 degrees), like venetian blinds, so supporters seen across the
 * pitch at an angle keep their natural width instead of becoming thin slivers.
 */
export function buildCrowd(rows: CrowdRow[], viewer?: { x: number; z: number }): Crowd {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colours: number[] = [];
  const seeds: number[] = [];
  const index: number[] = [];
  const centre = new THREE.Vector3();
  const across = new THREE.Vector3();
  for (const row of rows) {
    const people = row.length / CROWD_SEAT;
    const offset = (row.seed * 7.31) % PEOPLE_PER_TILE;
    const segments = Math.max(1, Math.round(people / SEGMENT_PEOPLE));
    const length = row.length / segments;
    for (let k = 0; k < segments; k++) {
      centre.copy(row.origin).addScaledVector(row.along, (k + 0.5) * length);
      let turn = 0;
      if (viewer) {
        const vx = viewer.x - centre.x;
        const vz = viewer.z - centre.z;
        const cross = row.facing.z * vx - row.facing.x * vz;
        const dot = row.facing.x * vx + row.facing.z * vz;
        turn = THREE.MathUtils.clamp(Math.atan2(cross, dot), -MAX_TURN, MAX_TURN);
      }
      // Rotate the row direction about the vertical axis by the same turn.
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      across.set(row.along.x * c + row.along.z * s, 0, -row.along.x * s + row.along.z * c);
      const base = positions.length / 3;
      const u0 = offset + (k * length) / CROWD_SEAT;
      const u1 = offset + ((k + 1) * length) / CROWD_SEAT;
      for (const [sign, u] of [
        [-0.5, u0],
        [0.5, u1],
      ] as const) {
        const x = centre.x + across.x * length * sign;
        const z = centre.z + across.z * length * sign;
        positions.push(x, centre.y, z, x, centre.y + CROWD_HEIGHT, z);
        uvs.push(u, 0, u, 1);
        for (let n = 0; n < 2; n++) colours.push(row.shade, row.shade, row.shade);
        seeds.push(row.seed, row.seed);
      }
      index.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setAttribute('crowdSeed', new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();

  const texture = crowdTexture();
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    vertexColors: true,
    side: THREE.DoubleSide,
    alphaTest: 0.35,
    alphaToCoverage: true,
  });
  const uniforms = {
    uCrowdTime: { value: 0 },
    uCrowdExcite: { value: 0.25 },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float crowdSeed;\nvarying float vCrowdSeed;'
      )
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvCrowdSeed = crowdSeed;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vCrowdSeed;\nuniform float uCrowdTime;\nuniform float uCrowdExcite;'
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
#ifdef USE_MAP
{
  vec2 cuv = vMapUv;
  float person = floor(cuv.x) + vCrowdSeed * 131.0;
  float h = fract(sin(person * 12.9898 + vCrowdSeed) * 43758.5453);
  float standing = step(h, uCrowdExcite * 0.95 - 0.28);
  float rate = 2.4 + 6.0 * uCrowdExcite;
  float bob = abs(sin(uCrowdTime * rate + h * 6.2831)) * (0.01 + 0.08 * uCrowdExcite * uCrowdExcite);
  float v = cuv.y - bob;
  vec2 suv = vec2(cuv.x / ${PEOPLE_PER_TILE.toFixed(1)}, clamp(v, 0.0, 1.0) * 0.5 + (standing > 0.5 ? 0.0 : 0.5));
  vec2 scale = vec2(1.0 / ${PEOPLE_PER_TILE.toFixed(1)}, 0.5);
  vec4 sampledDiffuseColor = textureGrad(map, suv, dFdx(cuv) * scale, dFdy(cuv) * scale);
  sampledDiffuseColor.a *= step(0.0, v) * step(v, 1.0);
  diffuseColor *= sampledDiffuseColor;
}
#endif`
      );
  };
  material.customProgramCacheKey = () => 'football-crowd-v1';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'crowd';
  return {
    mesh,
    update(time, excite) {
      uniforms.uCrowdTime.value = time;
      uniforms.uCrowdExcite.value = THREE.MathUtils.clamp(excite, 0, 1);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
