import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BONES, type HumanGeometry } from './rig';
import { disposeHairAssets } from './player-appearance';

const LEVELS = ['high', 'mid', 'low'] as const;
/** Register every fulfilled load before validating. A partial failure must also
 * release the successful siblings, including their materials and preview skins. */
function ownLoaded(results: PromiseSettledResult<GLTF>[]) {
  const owned = new Set<{ dispose(): void }>();
  for (const result of results)
    if (result.status === 'fulfilled') {
      result.value.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          owned.add(o.geometry);
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            owned.add(m);
            for (const v of Object.values(m)) if (v instanceof THREE.Texture) owned.add(v);
          }
        }
        if (o instanceof THREE.SkinnedMesh) owned.add(o.skeleton);
      });
    }
  return () => owned.forEach((o) => o.dispose());
}
function meshGeometry(result: PromiseSettledResult<GLTF>) {
  if (result.status === 'rejected') throw new Error('Player detail unavailable');
  let mesh: THREE.Mesh | undefined;
  result.value.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) mesh = o;
  });
  if (!mesh) throw new Error('Player surface missing');
  return mesh;
}
/** Clip the source's clavicle extraction to the under-jaw/neck seam once per
 * shared asset. Interpolate every relative morph as well as the neutral surface. */
function trimClavicles(source: THREE.BufferGeometry, anatomicalNeck = false) {
  const attributes = Object.entries(source.attributes),
    morphs = Object.entries(source.morphAttributes);
  const p = source.getAttribute('position'),
    ix = source.getIndex()!;
  const output: Record<string, number[]> = {};
  for (const [name] of attributes) output[name] = [];
  for (const [name, list] of morphs) list.forEach((_, i) => (output[`morph:${name}:${i}`] = []));
  type V = { key: string; values: Record<string, number[]> };
  const vertex = (id: number): V => {
    const values: Record<string, number[]> = {};
    for (const [name, a] of attributes)
      values[name] = Array.from({ length: a.itemSize }, (_, i) => a.getComponent(id, i));
    for (const [name, list] of morphs)
      list.forEach(
        (a, i) =>
          (values[`morph:${name}:${i}`] = Array.from({ length: a.itemSize }, (_, k) =>
            a.getComponent(id, k)
          ))
      );
    return { key: `v${id}`, values };
  };
  const scalar = (v: V) => {
    const [x, y, z] = v.values.position;
    if (anatomicalNeck) {
      const width = 0.065 + Math.max(0, y - 1.535) * 4;
      return Math.min(y - 1.485, width - Math.abs(x));
    }
    const underJaw = THREE.MathUtils.smoothstep(z, 0.005, 0.1);
    return y - (1.585 - underJaw * 0.052);
  };
  const blend = (a: V, b: V, t: number): V => {
    const values: Record<string, number[]> = {};
    for (const key of Object.keys(a.values)) {
      values[key] = a.values[key].map((v, i) => v + (b.values[key][i] - v) * t);
      if (key === '_part') values[key] = t < 0.5 ? a.values[key] : b.values[key];
    }
    return {
      key:
        a.key < b.key
          ? `${a.key}:${b.key}:${t.toFixed(8)}`
          : `${b.key}:${a.key}:${(1 - t).toFixed(8)}`,
      values,
    };
  };
  const index: number[] = [];
  let count = 0;
  const cache = new Map<string, number>();
  for (let i = 0; i < ix.count; i += 3) {
    const poly = [vertex(ix.getX(i)), vertex(ix.getX(i + 1)), vertex(ix.getX(i + 2))],
      out: V[] = [];
    for (let j = 0; j < 3; j++) {
      const a = poly[j],
        b = poly[(j + 1) % 3],
        da = scalar(a),
        db = scalar(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) out.push(blend(a, b, da / (da - db)));
    }
    if (out.length < 3) continue;
    const ids = out.map((v) => {
      let id = cache.get(v.key);
      if (id === undefined) {
        id = count++;
        cache.set(v.key, id);
        for (const [key, values] of Object.entries(v.values)) output[key].push(...values);
      }
      return id;
    });
    for (let j = 1; j < out.length - 1; j++) index.push(ids[0], ids[j], ids[j + 1]);
  }
  const g = new THREE.BufferGeometry();
  for (const [name, a] of attributes)
    g.setAttribute(name, new THREE.Float32BufferAttribute(output[name], a.itemSize));
  for (const [name, list] of morphs)
    g.morphAttributes[name as 'position' | 'normal' | 'color'] = list.map(
      (a, i) => new THREE.Float32BufferAttribute(output[`morph:${name}:${i}`], a.itemSize)
    );
  g.setIndex(index);
  g.morphTargetsRelative = source.morphTargetsRelative;
  g.userData = { ...source.userData };
  return g;
}
export function headGeometry(result: PromiseSettledResult<GLTF>, anatomicalNeck = false) {
  const mesh = meshGeometry(result),
    g = trimClavicles(mesh.geometry, anatomicalNeck),
    p = g.getAttribute('position');
  try {
    if (!p || !g.getAttribute('_part') || (g.morphAttributes.position?.length ?? 0) !== 8)
      throw new Error('Incomplete player head');
    if (anatomicalNeck) {
      // Fit the textured core neck into the review jersey rather than keeping its clavicle apron.
      const fit = (x: number, y: number, z: number) => {
        const t = THREE.MathUtils.smoothstep(y, 1.485, 1.53);
        const radius = Math.hypot(x / 0.058, (z - 0.008) / 0.052);
        const scale = 1 + (Math.min(1, 1 / Math.max(radius, 1e-8)) - 1) * (1 - t);
        return new THREE.Vector3(x * scale, y - 0.022 * (1 - t), 0.008 + (z - 0.008) * scale);
      };
      const morphs = g.morphAttributes.position ?? [],
        normalMorphs = g.morphAttributes.normal ?? [],
        normal = g.getAttribute('normal');
      const fitNormal = (x: number, y: number, z: number, n: THREE.Vector3) => {
        const axis = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const u = axis.cross(n).normalize(),
          v = n.clone().cross(u).normalize(),
          eps = 0.00001;
        const derivative = (t: THREE.Vector3) =>
          fit(x + eps * t.x, y + eps * t.y, z + eps * t.z).sub(
            fit(x - eps * t.x, y - eps * t.y, z - eps * t.z)
          );
        const transformed = derivative(u).cross(derivative(v)).normalize();
        return transformed.lengthSq() > 0.5 ? transformed : n.clone();
      };
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i),
          y = p.getY(i),
          z = p.getZ(i);
        if (y >= 1.53) continue;
        const neutral = fit(x, y, z),
          beforeNormal = new THREE.Vector3(normal.getX(i), normal.getY(i), normal.getZ(i));
        const nextNormal = fitNormal(x, y, z, beforeNormal);
        morphs.forEach((m, k) => {
          const tx = x + m.getX(i),
            ty = y + m.getY(i),
            tz = z + m.getZ(i),
            target = fit(tx, ty, tz),
            nm = normalMorphs[k];
          if (nm) {
            const posedNormal = beforeNormal
              .clone()
              .add(new THREE.Vector3(nm.getX(i), nm.getY(i), nm.getZ(i)));
            const result = fitNormal(tx, ty, tz, posedNormal).sub(nextNormal);
            nm.setXYZ(i, result.x, result.y, result.z);
          }
          m.setXYZ(i, target.x - neutral.x, target.y - neutral.y, target.z - neutral.z);
        });
        p.setXYZ(i, neutral.x, neutral.y, neutral.z);
        normal.setXYZ(i, nextNormal.x, nextNormal.y, nextNormal.z);
      }
    }
    const ix = new Uint16Array(p.count * 4),
      w = new Float32Array(p.count * 4);
    for (let n = 0; n < p.count; n++) {
      const head = THREE.MathUtils.clamp((p.getY(n) - 1.49) / 0.11, 0, 1);
      ix[n * 4] = BONES.indexOf('head');
      ix[n * 4 + 1] = BONES.indexOf('neck');
      w[n * 4] = head;
      w[n * 4 + 1] = 1 - head;
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(ix, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    g.userData.morphNames = { ...mesh.morphTargetDictionary };
    return g;
  } catch (error) {
    g.dispose();
    throw error;
  }
}
function bodyGeometry(result: PromiseSettledResult<GLTF>): HumanGeometry {
  const mesh = meshGeometry(result),
    g = mesh.geometry.clone();
  try {
    const p = g.getAttribute('position'),
      region = g.getAttribute('_region'),
      theta = g.getAttribute('_theta'),
      uv = g.getAttribute('uv');
    const skin = g.getAttribute('skinIndex'),
      weights = g.getAttribute('skinWeight');
    if (!p || !region || !theta || !uv || !skin || !weights || region.count !== p.count || !g.index)
      throw new Error('Incomplete player body');
    for (let i = 0; i < p.count; i++) {
      let total = 0;
      for (let k = 0; k < 4; k++) {
        const joint = skin.getComponent(i, k),
          weight = weights.getComponent(i, k);
        if (
          !Number.isInteger(joint) ||
          joint < 0 ||
          joint >= BONES.length ||
          !Number.isFinite(weight) ||
          weight < 0
        )
          throw new Error('Invalid player skin');
        total += weight;
      }
      if (Math.abs(total - 1) > 0.0001) throw new Error('Invalid player weights');
    }
    return {
      geometry: g,
      positions: p.array as Float32Array,
      region: region.array as Float32Array,
      theta: theta.array as Float32Array,
      uvShirt: uv.array as Float32Array,
    };
  } catch (error) {
    g.dispose();
    throw error;
  }
}
/** Separate surfaces preserve their morphs. The returned asset set owns buffers;
 * roster look wrappers share them and own only identity colors/UVs. */
export async function loadHeadAssets(): Promise<NonNullable<HumanGeometry['heads']>> {
  const results = await Promise.allSettled(
    LEVELS.map((level) => new GLTFLoader().loadAsync(`/models/football/player-head-${level}.glb`))
  );
  const release = ownLoaded(results),
    heads = {} as NonNullable<HumanGeometry['heads']>;
  try {
    results.forEach((result, i) => {
      heads[LEVELS[i]] = headGeometry(result);
    });
    return heads;
  } catch (error) {
    Object.values(heads).forEach((g) => g.dispose());
    throw error;
  } finally {
    release();
  }
}
/** Upgrade is atomic: a missing level keeps the already mounted legacy player.
 * No asset availability, identity or camera choice enters the match director. */
export async function loadPlayerUpgrade(): Promise<HumanGeometry> {
  const results = await Promise.allSettled(
    ['body', 'head'].flatMap((kind) =>
      LEVELS.map((level) =>
        new GLTFLoader().loadAsync(`/models/football/player-${kind}-${level}.glb`)
      )
    )
  );
  const release = ownLoaded(results),
    bodies: HumanGeometry[] = [],
    heads = {} as NonNullable<HumanGeometry['heads']>;
  try {
    for (let i = 0; i < 3; i++) bodies.push(bodyGeometry(results[i]));
    for (let i = 0; i < 3; i++) heads[LEVELS[i]] = headGeometry(results[i + 3]);
    bodies[0].heads = heads;
    bodies[0].bodyLods = { mid: bodies[1], low: bodies[2] };
    return bodies[0];
  } catch (error) {
    bodies.forEach((b) => b.geometry.dispose());
    Object.values(heads).forEach((g) => g.dispose());
    throw error;
  } finally {
    release();
  }
}
export function disposePlayerGeometry(base: HumanGeometry) {
  if (base.heads) disposeHairAssets(base.heads);
  const geometries = new Set([
    base.geometry,
    ...Object.values(base.heads ?? {}),
    ...Object.values(base.bodyLods ?? {}).map((body) => body.geometry),
  ]);
  geometries.forEach((g) => g.dispose());
}
