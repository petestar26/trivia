import * as THREE from 'three';
import {
  BONES,
  Region,
  lookGeometry,
  type HumanGeometry,
  type Look,
  type LookGeometry,
  type Rig,
} from './rig';
import type { PlayerDetail } from './player-appearance';

type Part = 'jersey' | 'sleeves' | 'shorts' | 'neck';
type V3 = [number, number, number];
interface Vertex {
  p: V3;
  n: V3;
  j: number[];
  w: number[];
  uv: number[];
  color: number[];
  region: number;
  protected: boolean;
}
interface Triangle {
  ids: V3;
  part: Part | 'body';
}
const chest = BONES.indexOf('chest'),
  neck = BONES.indexOf('neck'),
  head = BONES.indexOf('head');
const clamp = THREE.MathUtils.clamp;
const gaussian = (x: number) => Math.exp(-x * x);
const weightFor = (v: Vertex, pattern: RegExp) =>
  v.w.reduce((s, w, i) => s + (pattern.test(BONES[v.j[i]]) ? w : 0), 0);
const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const distance = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** These are appearance-only vertices. Contact footwear, palms and all weighted
 * fingers retain their source positions, skin indices and weights exactly. */
function contactProtected(v: Vertex) {
  return (
    v.region === Region.BOOT ||
    v.region === Region.GLOVE ||
    v.p[1] < 0.3 ||
    weightFor(v, /^(foot|toe|hand|thumb|index|middle|ring|pinky)/) > 0.001
  );
}
function jointInfluence(v: Vertex) {
  if (v.protected) return 0;
  const [x, y, z] = v.p;
  const regions = [
    [Math.abs(x) - 0.19, y - 1.425, z, 0.13, 0.095, 0.13],
    [Math.abs(x) - 0.2, y - 1.18, z, 0.09, 0.11, 0.095],
    [Math.abs(x) - 0.1, y - 0.5, z, 0.095, 0.115, 0.1],
  ];
  return Math.max(
    0,
    ...regions.map(([dx, dy, dz, rx, ry, rz]) => 1 - Math.hypot(dx / rx, dy / ry, dz / rz))
  );
}
function mix(a: Vertex, b: Vertex): Vertex {
  const skin = new Map<number, number>();
  for (const v of [a, b])
    v.w.forEach((w, k) => skin.set(v.j[k], (skin.get(v.j[k]) ?? 0) + w * 0.5));
  const top = [...skin]
    .filter(([, w]) => w > 1e-10)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 4);
  const sum = top.reduce((s, [, w]) => s + w, 0);
  const j = [0, 0, 0, 0],
    w = [0, 0, 0, 0];
  top.forEach(([bone, value], i) => {
    j[i] = bone;
    w[i] = value / sum;
  });
  const n = a.n.map((n, k) => (n + b.n[k]) / 2) as V3;
  const len = Math.hypot(...n) || 1;
  n.forEach((_, k) => (n[k] /= len));
  return {
    ...a,
    p: a.p.map((v, k) => (v + b.p[k]) / 2) as V3,
    n,
    j,
    w,
    uv: a.uv.map((v, k) => (v + b.uv[k]) / 2),
    color: a.color.map((v, k) => (v + b.color[k]) / 2),
    protected: false,
  };
}
function sourceVertices(source: HumanGeometry, look: Look): Vertex[] {
  const g = source.geometry,
    p = g.getAttribute('position'),
    n = g.getAttribute('normal');
  const joints = g.getAttribute('skinIndex'),
    weights = g.getAttribute('skinWeight');
  const rgb = (s: string) => new THREE.Color(s).toArray();
  const colors: Record<number, number[]> = {
    [Region.SKIN]: rgb(look.skin),
    [Region.SHIRT]: [1, 1, 1],
    [Region.SHORTS]: rgb(look.kit.shorts),
    [Region.SOCK]: rgb(look.kit.socks),
    [Region.BOOT]: rgb('#15171c'),
    [Region.HAIR]: rgb(look.hair),
    [Region.GLOVE]: rgb(look.kit.glove ?? look.skin),
    [Region.FOREARM]: rgb(look.skin),
  };
  return Array.from({ length: p.count }, (_, i) => {
    const sourceRegion = source.region[i];
    const region = sourceRegion === Region.FOREARM && look.kit.keeper ? Region.SHIRT : sourceRegion;
    const v: Vertex = {
      p: [p.getX(i), p.getY(i), p.getZ(i)],
      n: [n.getX(i), n.getY(i), n.getZ(i)],
      j: Array.from({ length: 4 }, (_, k) => joints.getComponent(i, k)),
      w: Array.from({ length: 4 }, (_, k) => weights.getComponent(i, k)),
      uv:
        region === Region.SHIRT ? [source.uvShirt[i * 2], source.uvShirt[i * 2 + 1]] : [0.02, 0.02],
      color: colors[region] ?? rgb(look.skin),
      region,
      protected: false,
    };
    v.protected = contactProtected(v);
    return v;
  });
}
function oldNeck(v: Vertex) {
  return (
    v.region === Region.SKIN &&
    v.p[1] >= 1.4549 &&
    v.p[1] <= 1.5951 &&
    Math.abs(v.p[0]) < 0.063 &&
    Math.abs(v.p[2] - 0.01) < 0.063 &&
    weightFor(v, /^(neck|head)$/) > 0.99
  );
}
function oldCollar(v: Vertex) {
  const radius = Math.hypot(v.p[0], v.p[2] - 0.01);
  return (
    v.region === Region.SHIRT &&
    v.n[1] > 0.999 &&
    weightFor(v, /^chest$/) > 0.999 &&
    ((Math.abs(v.p[1] - 1.45) < 1e-5 && Math.abs(radius - 0.18) < 1e-5) ||
      (Math.abs(v.p[1] - 1.47) < 1e-5 && Math.abs(radius - 0.06) < 1e-5))
  );
}
function triangles(source: HumanGeometry, vertices: Vertex[]) {
  const ix = source.geometry.getIndex()!,
    output: Triangle[] = [];
  for (let i = 0; i < ix.count; i += 3) {
    const ids: V3 = [ix.getX(i), ix.getX(i + 1), ix.getX(i + 2)],
      vs = ids.map((i) => vertices[i]);
    if (vs.every(oldNeck) || vs.every(oldCollar)) continue;
    let part: Triangle['part'] = 'body';
    if (vs.every((v) => v.region === Region.SHORTS)) part = 'shorts';
    else if (vs.every((v) => v.region === Region.SHIRT)) {
      const arm = vs.reduce((s, v) => s + weightFor(v, /^(upperArm|foreArm)/), 0) / 3;
      part =
        arm > 0.28 && Math.abs(vs.reduce((s, v) => s + v.p[0], 0) / 3) > 0.16
          ? 'sleeves'
          : 'jersey';
    }
    output.push({ ids, part });
  }
  return output;
}

/** One welded Laplacian pass, limited to 2.5 mm, takes hard corners off the
 * source shoulders/elbows/knees without shrinking the contact or finger mesh. */
function soften(vertices: Vertex[], tris: Triangle[]) {
  const groups = new Map<string, number[]>(),
    canonical: number[] = [];
  vertices.forEach((v, i) => {
    const k = `${v.region}:${v.p.map((x) => Math.round(x * 1e6)).join(':')}`;
    const ids = groups.get(k) ?? [];
    ids.push(i);
    groups.set(k, ids);
    canonical[i] = ids[0];
  });
  const adjacent = new Map<number, Set<number>>();
  for (const { ids } of tris)
    for (let k = 0; k < 3; k++) {
      const a = canonical[ids[k]],
        b = canonical[ids[(k + 1) % 3]];
      if (a === b) continue;
      if (!adjacent.has(a)) adjacent.set(a, new Set());
      if (!adjacent.has(b)) adjacent.set(b, new Set());
      adjacent.get(a)!.add(b);
      adjacent.get(b)!.add(a);
    }
  const changes = new Map<number, V3>();
  for (const ids of groups.values()) {
    const v = vertices[ids[0]],
      influence = jointInfluence(v),
      neighbors = adjacent.get(ids[0]);
    if (!influence || ids.some((i) => vertices[i].protected) || !neighbors?.size) continue;
    const average = [0, 0, 0] as V3;
    for (const i of neighbors)
      average.forEach((_, k) => (average[k] += vertices[i].p[k] / neighbors.size));
    const delta = average.map((x, k) => (x - v.p[k]) * 0.24 * influence) as V3;
    const length = Math.hypot(...delta),
      scale = Math.min(1, 0.0025 / (length || 1));
    const p = v.p.map((x, k) => x + delta[k] * scale) as V3;
    for (const i of ids) changes.set(i, p);
  }
  for (const [i, p] of changes) vertices[i].p = [...p];
}
function subdivide(vertices: Vertex[], input: Triangle[], detail: 'high' | 'mid') {
  const candidates = new Map<string, { a: number; b: number; priority: number }>();
  for (const { ids } of input)
    for (let k = 0; k < 3; k++) {
      const a = ids[k],
        b = ids[(k + 1) % 3],
        av = vertices[a],
        bv = vertices[b];
      const influence = Math.min(jointInfluence(av), jointInfluence(bv)),
        length = distance(av.p, bv.p);
      if (influence > 0.12 && length > (detail === 'high' ? 0.022 : 0.032))
        candidates.set(key(a, b), { a, b, priority: influence * length });
    }
  const edges = new Map<string, number>();
  for (const { a, b } of [...candidates.values()]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, detail === 'high' ? 2200 : 900)) {
    edges.set(key(a, b), vertices.length);
    vertices.push(mix(vertices[a], vertices[b]));
  }
  const out: Triangle[] = [];
  for (const {
    ids: [a, b, c],
    part,
  } of input) {
    const ab = edges.get(key(a, b)),
      bc = edges.get(key(b, c)),
      ca = edges.get(key(c, a));
    const emit = (...ids: V3[]) => ids.forEach((ids) => out.push({ ids, part }));
    if (ab !== undefined && bc !== undefined && ca !== undefined)
      emit([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    else if (ab !== undefined && bc !== undefined) emit([b, bc, ab], [a, ab, c], [ab, bc, c]);
    else if (bc !== undefined && ca !== undefined) emit([c, ca, bc], [a, b, ca], [b, bc, ca]);
    else if (ca !== undefined && ab !== undefined) emit([a, ab, ca], [ab, b, c], [ab, c, ca]);
    else if (ab !== undefined) emit([a, ab, c], [ab, b, c]);
    else if (bc !== undefined) emit([b, bc, a], [bc, c, a]);
    else if (ca !== undefined) emit([c, ca, b], [ca, a, b]);
    else emit([a, b, c]);
  }
  return out;
}
function geometry(vertices: Vertex[], indices: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      vertices.flatMap((v) => v.p),
      3
    )
  );
  g.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute(
      vertices.flatMap((v) => v.j),
      4
    )
  );
  g.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute(
      vertices.flatMap((v) => v.w),
      4
    )
  );
  g.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      vertices.flatMap((v) => v.uv),
      2
    )
  );
  g.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(
      vertices.flatMap((v) => v.color),
      3
    )
  );
  g.setAttribute(
    '_region',
    new THREE.Float32BufferAttribute(
      vertices.map((v) => v.region),
      1
    )
  );
  g.setIndex(indices);
  g.computeVertexNormals();
  const normals = g.getAttribute('normal');
  vertices.forEach((v, i) => {
    if (v.protected) normals.setXYZ(i, ...v.n);
  });
  // UV/material seams may duplicate identical skin/cloth points. Smooth shading
  // across those duplicates without changing positions, weights or the sole.
  const weld = new Map<string, { ids: number[]; sum: THREE.Vector3 }>();
  vertices.forEach((v, i) => {
    if (v.region === Region.BOOT) return;
    const k = `${v.region}:${v.p.map((x) => Math.round(x * 1e6)).join(':')}`;
    const group = weld.get(k) ?? { ids: [], sum: new THREE.Vector3() };
    group.ids.push(i);
    group.sum.add(new THREE.Vector3(normals.getX(i), normals.getY(i), normals.getZ(i)));
    weld.set(k, group);
  });
  for (const { ids, sum } of weld.values())
    if (sum.lengthSq() > 1e-12) {
      sum.normalize();
      for (const i of ids) normals.setXYZ(i, sum.x, sum.y, sum.z);
    }

  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
function clothShell(vertices: Vertex[], tris: Triangle[], part: Exclude<Part, 'neck'>) {
  const output: Vertex[] = [],
    indices: number[] = [],
    remap = new Map<number, number>();
  const boundary = new Map<string, { a: number; b: number; count: number }>();
  const vertex = (i: number) => {
    if (remap.has(i)) return remap.get(i)!;
    const v = vertices[i],
      [x, y, z] = v.p;
    const theta = Math.atan2(x, z),
      front = Math.max(0, Math.cos(theta));
    const envelope =
      part === 'shorts'
        ? gaussian((y - 0.76) / 0.16)
        : gaussian((y - 1.04) / 0.1) + 0.55 * gaussian((Math.abs(x) - 0.22) / 0.06);
    const fold =
      0.0022 * Math.sin(y * 87 + theta * 9) * envelope +
      0.0007 * Math.sin(y * 165 - theta * 5) * front;
    const clearance = (part === 'shorts' ? 0.0065 : 0.0055) + fold;
    const p = v.p.map((value, k) => value + v.n[k] * clearance) as V3;
    const id = output.length;
    output.push({ ...v, p, protected: false });
    remap.set(i, id);
    return id;
  };
  for (const triangle of tris)
    if (triangle.part === part) {
      const ids = triangle.ids.map(vertex);
      indices.push(...ids);
      for (let k = 0; k < 3; k++) {
        const a = ids[k],
          b = ids[(k + 1) % 3],
          id = key(a, b),
          edge = boundary.get(id);
        if (edge) edge.count++;
        else boundary.set(id, { a, b, count: 1 });
      }
    }
  // A shallow return at cut edges gives hems/cuffs actual thickness instead of
  // a painted stripe. The inner edge is only 1.6 mm behind the fitted shell.
  const inner = new Map<number, number>();
  const inside = (i: number) => {
    if (inner.has(i)) return inner.get(i)!;
    const v = output[i],
      id = output.length;
    output.push({ ...v, p: v.p.map((x, k) => x - v.n[k] * 0.0016) as V3 });
    inner.set(i, id);
    return id;
  };
  for (const { a, b, count } of boundary.values())
    if (count === 1) {
      const ai = inside(a),
        bi = inside(b);
      indices.push(a, ai, b, b, ai, bi);
    }
  return {
    vertices: output,
    indices,
    cutEdges: [...boundary.values()].filter((e) => e.count === 1),
  };
}
function neckSurface(look: Look, detail: 'high' | 'mid') {
  const vertices: Vertex[] = [],
    indices: number[] = [],
    columns = detail === 'high' ? 32 : 24,
    rows = 9;
  const skin = new THREE.Color(look.skin).toArray();
  for (let row = 0; row <= rows; row++)
    for (let col = 0; col <= columns; col++) {
      const t = row / rows,
        angle = (col / columns) * Math.PI * 2;
      const front = Math.cos(angle),
        sx = Math.sin(angle),
        y = 1.449 + t * 0.062;
      const waist = Math.sin(t * Math.PI),
        // This seal bridges the jersey internally; its upper rings must stay
        // inside the textured anatomical neck instead of showing through it.
        inset = 0.004 * THREE.MathUtils.smoothstep(t, 0.65, 1),
        rx = 0.059 - 0.01 * waist - inset,
        rz = 0.052 - 0.008 * waist - inset;
      const tendon =
        0.0024 *
        gaussian((Math.abs(sx) - 0.52) / 0.16) *
        Math.max(0, front) *
        Math.sin(Math.PI * t);
      const apple =
        0.003 * gaussian((y - 1.535) / 0.014) * gaussian(sx / 0.23) * Math.max(0, front);
      const h = clamp((y - 1.49) / 0.11, 0, 1),
        c = 0.3 * (1 - THREE.MathUtils.smoothstep(y, 1.449, 1.49));
      vertices.push({
        p: [sx * (rx + tendon), y, 0.008 + front * (rz + tendon + apple)],
        n: [sx, 0, front],
        j: [chest, neck, head, 0],
        w: [c, (1 - c) * (1 - h), (1 - c) * h, 0],
        uv: [0.02, 0.02],
        color: skin,
        region: Region.SKIN,
        protected: false,
      });
    }
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < columns; col++) {
      const a = row * (columns + 1) + col,
        b = a + 1,
        c = a + columns + 1,
        d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  return geometry(vertices, indices);
}
function addNeckline(shell: ReturnType<typeof clothShell>, detail: 'high' | 'mid') {
  const { vertices, indices } = shell,
    columns = detail === 'high' ? 40 : 28,
    start = vertices.length;
  // A narrow curved crew band follows the neck opening, with a front dip and
  // chest/neck blend, rather than the old flat 36 cm diameter annular plate.
  const rows = 8;
  const opening = shell.cutEdges.filter(({ a, b }) => {
    const va = vertices[a].p,
      vb = vertices[b].p;
    return Math.min(va[1], vb[1]) > 1.38 && Math.max(Math.abs(va[0]), Math.abs(vb[0])) < 0.22;
  });
  const edgeAt = (angle: number) => {
    const dx = Math.sin(angle),
      dz = Math.cos(angle),
      hits: Array<{ r: number; y: number }> = [];
    for (const { a, b } of opening) {
      const av = vertices[a].p,
        bv = vertices[b].p;
      const ex = bv[0] - av[0],
        ez = bv[2] - av[2],
        ax = av[0],
        az = av[2] - 0.008;
      const cross = dx * ez - dz * ex;
      if (Math.abs(cross) < 1e-10) continue;
      const r = (ax * ez - az * ex) / cross,
        t = (ax * dz - az * dx) / cross;
      if (r > 0.058 && r < 0.24 && t >= -0.001 && t <= 1.001)
        hits.push({ r, y: av[1] + t * (bv[1] - av[1]) });
    }
    hits.sort((a, b) => a.r - b.r);
    return hits[0] ?? { r: Math.hypot(0.17 * dx, (dz >= 0 ? 0.103 : 0.154) * dz), y: 1.445 };
  };
  for (let row = 0; row <= rows; row++)
    for (let col = 0; col <= columns; col++) {
      const angle = (col / columns) * Math.PI * 2,
        front = Math.max(0, Math.cos(angle)),
        t = row / rows;
      const trim = Math.min(1, t / 0.18);
      const edge = edgeAt(angle);
      const radius = 0.056 * (1 - t) + (edge.r + 0.003) * t;
      const x = Math.sin(angle) * radius;
      const z = 0.008 + Math.cos(angle) * radius;
      const innerY = 1.468 - front * 0.006;
      const outerY = edge.y + 0.001;
      const y = innerY * (1 - t) + outerY * t - 0.004 * Math.sin(Math.PI * t);
      vertices.push({
        p: [x, y, z],
        n: [0, 1, 0],
        j: [chest, neck, 0, 0],
        w: [0.92 + 0.08 * trim, 0.08 * (1 - trim), 0, 0],
        uv: [0.36 + Math.sin(angle) * 0.08, 0.72 + Math.cos(angle) * 0.05],
        color: [1, 1, 1],
        region: Region.SHIRT,
        protected: false,
      });
    }
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < columns; col++) {
      const a = start + row * (columns + 1) + col,
        b = a + 1,
        c = a + columns + 1,
        d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
}

export interface ReviewBodyGeometry extends LookGeometry {
  shells: Record<Part, THREE.BufferGeometry>;
  triangleCount: number;
  /** Input indices stay stable in geometry for reproducible weighted probes. */
  sourceVertexCount: number;
  protectedVertices: Uint32Array;
}
/** Locally derived CC0 body for one review character; never changes source
 * buffers, the 49-joint bind pose, actor motion or the exported roster assets. */
export function buildReviewBody(
  source: HumanGeometry,
  look: Look,
  detail: 'high' | 'mid' = 'high'
): ReviewBodyGeometry {
  const vertices = sourceVertices(source, look),
    sourceVertexCount = vertices.length;
  const protectedVertices = Uint32Array.from(vertices.flatMap((v, i) => (v.protected ? [i] : [])));
  const original = triangles(source, vertices);
  soften(vertices, original);
  const tris = subdivide(vertices, original, detail);
  const body = geometry(
    vertices,
    tris.filter((t) => t.part === 'body').flatMap((t) => t.ids)
  );
  const jersey = clothShell(vertices, tris, 'jersey');
  addNeckline(jersey, detail);
  const sleeves = clothShell(vertices, tris, 'sleeves'),
    shorts = clothShell(vertices, tris, 'shorts');
  const shells = {
    jersey: geometry(jersey.vertices, jersey.indices),
    sleeves: geometry(sleeves.vertices, sleeves.indices),
    shorts: geometry(shorts.vertices, shorts.indices),
    neck: neckSurface(look, detail),
  };
  const owned = [body, ...Object.values(shells)],
    triangleCount = owned.reduce((s, g) => s + g.index!.count / 3, 0);
  let disposed = false;
  return {
    geometry: body,
    shells,
    triangleCount,
    sourceVertexCount,
    protectedVertices,
    dispose() {
      if (disposed) return;
      disposed = true;
      owned.forEach((g) => g.dispose());
    },
  };
}
export interface ReviewBodyVisual {
  meshes: Record<Part, THREE.SkinnedMesh>;
  setDetail(detail: PlayerDetail): void;
  dispose(): void;
}
/** Caller owns material/skeleton. Call setDetail after the pool's ordinary body
 * assignment so only this selected character receives the fitted review mesh. */
export function attachReviewBody(
  rig: Rig,
  source: HumanGeometry,
  look: Look,
  material: THREE.Material
): ReviewBodyVisual {
  const high = buildReviewBody(source, look, 'high');
  let mid: ReviewBodyGeometry;
  let low: LookGeometry;
  try {
    mid = buildReviewBody(source.bodyLods?.mid ?? source, look, 'mid');
    try {
      low = lookGeometry(look, source.bodyLods?.low ?? source);
    } catch (error) {
      mid.dispose();
      throw error;
    }
  } catch (error) {
    high.dispose();
    throw error;
  }
  const levels = { high, mid },
    previous = rig.mesh.geometry;
  const meshes = {} as ReviewBodyVisual['meshes'];
  for (const part of ['jersey', 'sleeves', 'shorts', 'neck'] as const) {
    const mesh = new THREE.SkinnedMesh(levels.high.shells[part], material);
    mesh.name = `review-player-${part}`;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    rig.root.add(mesh);
    mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
    meshes[part] = mesh;
  }
  let disposed = false;
  const setDetail = (detail: PlayerDetail) => {
    if (disposed) return;
    rig.mesh.geometry = detail === 'low' ? low.geometry : levels[detail].geometry;
    for (const part of Object.keys(meshes) as Part[]) {
      meshes[part].visible = detail !== 'low';
      if (detail !== 'low') meshes[part].geometry = levels[detail].shells[part];
    }
  };
  setDetail('high');
  return {
    meshes,
    setDetail,
    dispose() {
      if (disposed) return;
      disposed = true;
      if ([levels.high.geometry, levels.mid.geometry, low.geometry].includes(rig.mesh.geometry))
        rig.mesh.geometry = previous;
      Object.values(meshes).forEach((mesh) => mesh.removeFromParent());
      levels.high.dispose();
      levels.mid.dispose();
      low.dispose();
    },
  };
}
