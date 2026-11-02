import * as THREE from 'three';
import { BONES, Region, type HumanGeometry } from './rig';

interface Vertex {
  p: number[]; n: number[]; j: number[]; w: number[]; uv: number[];
  theta: number; region: number; sourceY: number;
}
const HEAD = BONES.indexOf('head'), NECK = BONES.indexOf('neck');
function chain(v: Vertex) { return v.w.reduce((sum, weight, i) => sum + ([HEAD, NECK].includes(v.j[i]) ? weight : 0), 0); }
function blend(a: Vertex, b: Vertex, t: number): Vertex {
  const skin = new Map<number, number>();
  for (const [v, factor] of [[a, 1 - t], [b, t]] as const)
    v.w.forEach((weight, i) => skin.set(v.j[i], (skin.get(v.j[i]) ?? 0) + factor * weight));
  const top = [...skin].filter(([, w]) => w > 1e-9).sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 4);
  const total = top.reduce((sum, [, weight]) => sum + weight, 0), j = [0, 0, 0, 0], w = [0, 0, 0, 0];
  top.forEach(([bone, weight], i) => { j[i] = bone; w[i] = weight / total; });
  const vector = (key: 'p' | 'n' | 'uv') => a[key].map((value, k) => value + (b[key][k] - value) * t);
  const n = vector('n'), length = Math.hypot(...n); if (length > 1e-12) n.forEach((_, k) => n[k] /= length);
  return { p: vector('p'), n, uv: vector('uv'), j, w, theta: Math.atan2((1 - t) * Math.sin(a.theta) + t * Math.sin(b.theta), (1 - t) * Math.cos(a.theta) + t * Math.cos(b.theta)), region: a.region,
    sourceY: a.sourceY + (b.sourceY - a.sourceY) * t };
}
function clip(poly: Vertex[], scalar: (v: Vertex) => number, limit: number, lower: boolean) {
  const out: Vertex[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], av = scalar(a), bv = scalar(b);
    const insideA = lower ? av >= limit - 1e-9 : av <= limit + 1e-9;
    const insideB = lower ? bv >= limit - 1e-9 : bv <= limit + 1e-9;
    if (insideA) out.push(a);
    if (insideA !== insideB) out.push(blend(a, b, (limit - av) / (bv - av)));
  }
  return out;
}
/** Anatomical head cut keeps weighted shoulder/jersey triangles. Optional source-Y
 * data gives true plane-split waist/short/sock boundaries in offline exports.
 * The tube is original geometry and flexes between the existing neck/head joints.
 */
export function extractFootballBody(base: HumanGeometry): HumanGeometry {
  const source = base.geometry, p = source.getAttribute('position'), n = source.getAttribute('normal');
  const joints = source.getAttribute('skinIndex'), weights = source.getAttribute('skinWeight');
  const authorY = source.getAttribute('authorY'), index = source.getIndex()!;
  const input: Vertex[] = Array.from({ length: p.count }, (_, i) => ({ p: [p.getX(i), p.getY(i), p.getZ(i)], n: n ? [n.getX(i), n.getY(i), n.getZ(i)] : [0, 1, 0],
    j: Array.from({ length: 4 }, (_, k) => joints.getComponent(i, k)), w: Array.from({ length: 4 }, (_, k) => weights.getComponent(i, k)),
    uv: [base.uvShirt[i * 2], base.uvShirt[i * 2 + 1]], theta: base.theta[i], region: base.region[i], sourceY: authorY?.getX(i) ?? p.getY(i) }));
  const vertices: Vertex[] = [], indices: number[] = [], cache = new Map<string, number>();
  function emit(poly: Vertex[], region?: number) {
    if (poly.length < 3) return;
    const ids = poly.map(v => {
      const part = region ?? v.region;
      const key = [...v.p, ...v.n, part, ...v.j, ...v.w, ...v.uv].map(x => Math.round(x * 1e8)).join(':');
      let id = cache.get(key); if (id === undefined) { id = vertices.length; cache.set(key, id); vertices.push({ ...v, region: part }); }
      return id;
    });
    for (let i = 1; i < ids.length - 1; i++) {
      const a = vertices[ids[0]].p, b = vertices[ids[i]].p, c = vertices[ids[i + 1]].p;
      const ab = new THREE.Vector3(...b as [number, number, number]).sub(new THREE.Vector3(...a as [number, number, number]));
      const ac = new THREE.Vector3(...c as [number, number, number]).sub(new THREE.Vector3(...a as [number, number, number]));
      if (ab.cross(ac).lengthSq() > 1e-18) indices.push(ids[0], ids[i], ids[i + 1]);
    }
  }
  const bands = [
    [-Infinity, .105, Region.BOOT], [.105, .43, Region.SOCK], [.43, .66, Region.SKIN],
    [.66, .96, Region.SHORTS], [.96, Infinity, Region.SHIRT],
  ] as const;
  for (let i = 0; i < index.count; i += 3) {
    let poly = [input[index.getX(i)], input[index.getX(i + 1)], input[index.getX(i + 2)]];
    // Source face attachments are weighted entirely to head; their old clavicle
    // flap is removed as well, without removing real chest/shoulder triangles.
    if (poly.every(v => v.w.reduce((sum, weight, k) => sum + (v.j[k] === HEAD ? weight : 0), 0) > .98) && poly.some(v => Math.abs(v.p[0]) > .065)) continue;
    if (poly.some(v => chain(v) >= .10)) poly = clip(poly, v => v.p[1], 1.515, false);
    const lower = authorY && poly.length && poly.every(v => v.sourceY < 1.08 && [Region.SKIN, Region.SHIRT, Region.SHORTS, Region.SOCK, Region.BOOT].includes(v.region as 0))
      && poly.some(v => v.j.some((joint, k) => v.w[k] > .15 && /^(upperLeg|lowerLeg|foot|toe|hips)/.test(BONES[joint])));
    if (!lower) { emit(poly); continue; }
    for (const [min, max, region] of bands) {
      let part = poly; if (Number.isFinite(min)) part = clip(part, v => v.sourceY, min, true);
      if (Number.isFinite(max)) part = clip(part, v => v.sourceY, max, false); emit(part, region);
    }
  }
  // Source bind clavicles can rise above the production shoulder pivot. Compress
  // only the surviving upper torso surface, keeping hands/forearms untouched.
  for (const v of vertices) {
    const torso = v.w.reduce((sum, weight, k) => sum + (/^(hips|spine|chest|neck|head|upperArm)/.test(BONES[v.j[k]]) ? weight : 0), 0);
    if (v.p[1] > 1.40 && torso > .5) {
      const scale = Math.exp(-(v.p[1] - 1.40) / .085);
      v.p[1] = 1.40 + .085 * (1 - scale); v.n[1] /= scale;
      const length = Math.hypot(...v.n); v.n.forEach((_, k) => v.n[k] /= length);
      // The old neck/clavicle transition outside the new neck is jersey, with
      // chest weights. It cannot rise as a skin-colored flap when head turns.
      if (chain(v) > .10 && Math.hypot(v.p[0], v.p[2] - .01) > .055) {
        v.region = Region.SHIRT; v.j = [BONES.indexOf('chest'), 0, 0, 0]; v.w = [1, 0, 0, 0];
      }
    }
  }
  const seal = new THREE.CylinderGeometry(.056, .062, .14, 20, 4, false).translate(0, 1.525, .01);
  const sp = seal.getAttribute('position'), sn = seal.getAttribute('normal'), si = seal.getIndex()!;
  const tube: Vertex[] = Array.from({ length: sp.count }, (_, i) => {
    const head = Math.min(1, Math.max(0, (sp.getY(i) - 1.455) / .14));
    return { p: [sp.getX(i), sp.getY(i), sp.getZ(i)], n: [sn.getX(i), sn.getY(i), sn.getZ(i)], j: [NECK, HEAD, 0, 0], w: [1 - head, head, 0, 0], uv: [0, 0], theta: Math.atan2(sp.getZ(i), sp.getX(i)), region: Region.SKIN, sourceY: sp.getY(i) };
  });
  for (let i = 0; i < si.count; i += 3) emit([tube[si.getX(i)], tube[si.getX(i + 1)], tube[si.getX(i + 2)]], Region.SKIN);
  seal.dispose();
  // Original annular crew collar overlaps the compressed jersey and neck seal.
  // It follows chest, while the tube above flexes neck-to-head.
  const collar: Vertex[] = [];
  for (let ring = 0; ring < 2; ring++) for (let i = 0; i < 24; i++) {
    const angle = i / 24 * Math.PI * 2, radius = ring ? .18 : .060;
    collar.push({ p: [Math.sin(angle) * radius, ring ? 1.450 : 1.470, .01 + Math.cos(angle) * radius], n: [0, 1, 0], j: [BONES.indexOf('chest'), 0, 0, 0], w: [1, 0, 0, 0], uv: [.5 + Math.sin(angle) * .15, .94 + ring * .03], theta: angle, region: Region.SHIRT, sourceY: 1.47 });
  }
  for (let i = 0; i < 24; i++) { const next = (i + 1) % 24; emit([collar[i], collar[24 + i], collar[next]], Region.SHIRT); emit([collar[next], collar[24 + i], collar[24 + next]], Region.SHIRT); }
  // Fit the visible source shoe surface to the unchanged .08 m ankle and
  // HEEL/BALL sole datum: -.025327 -> .01 m, heel -.073211 -> -.07,
  // toe .241244 -> .20. Shared seam vertices receive the same continuous map.
  const ankle = .08, soleScale = .07 / (.08 + .025327131152153015);
  for (const v of vertices) if (v.p[1] < .15) {
    const y = v.p[1], z = v.p[2], t = Math.min(1, Math.max(0, (y - ankle) / .07));
    const taper = 1 - t * t * (3 - 2 * t), derivative = t > 0 && t < 1 ? -6 * t * (1 - t) / .07 : 0;
    const zScale = z < 0 ? .07 / .07321145385503769 : .20 / .24124445021152496;
    const factor = 1 + (zScale - 1) * taper, yz = z * (zScale - 1) * derivative;
    const yy = y < ankle ? soleScale : 1; v.p[2] *= factor;
    if (y < ankle) v.p[1] = ankle + (y - ankle) * soleScale;
    const nz = v.n[2]; v.n[1] = v.n[1] / yy - yz * nz / (yy * factor); v.n[2] /= factor;
    // The unchanged push-off rotates around BALL at z=.15, up to .85 rad.
    // Lift only the forward sole, leaving heel/ball anchors and rig untouched.
    if (v.p[2] > .15) { v.p[1] += (v.p[2] - .15) * Math.tan(.85); v.n[2] -= Math.tan(.85) * v.n[1]; }
    const length = Math.hypot(...v.n); v.n.forEach((_, k) => v.n[k] /= length);
  }
  const geometry = new THREE.BufferGeometry(), positions = new Float32Array(vertices.flatMap(v => v.p));
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geometry.setAttribute('normal', new THREE.Float32BufferAttribute(vertices.flatMap(v => v.n), 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(vertices.flatMap(v => v.j), 4)); geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(vertices.flatMap(v => v.w), 4));
  geometry.setAttribute('authorY', new THREE.Float32BufferAttribute(vertices.map(v => v.sourceY), 1)); geometry.setIndex(indices); geometry.computeBoundingBox();
  return { ...base, geometry, positions, region: new Float32Array(vertices.map(v => v.region)), uvShirt: new Float32Array(vertices.flatMap(v => v.uv)), theta: new Float32Array(vertices.map(v => v.theta)) };
}
