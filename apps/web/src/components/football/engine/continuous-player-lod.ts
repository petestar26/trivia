import * as THREE from 'three';

export interface ContinuousLodOptions {
  cellSize?: number;
  fineCellSize?: number;
  /** Omit/false for a garment without the accepted anatomical neck seam. */
  protectNeck?: boolean;
}
/** Load-time only. The caller owns the returned geometry, including fallback clones.
 * Boundary preservation keeps existing garment/collar/cuff openings. A topology audit
 * rejects unsafe clusters rather than repairing holes by deleting arbitrary faces.
 */
export function createContinuousPlayerLod(
  source: THREE.BufferGeometry,
  options: ContinuousLodOptions = {}
): THREE.BufferGeometry {
  return buildLod(source, options, new Set(), 0);
}

function buildLod(
  source: THREE.BufferGeometry,
  options: ContinuousLodOptions,
  locked: Set<number>,
  attempt: number
): THREE.BufferGeometry {
  const p = source.getAttribute('position'),
    skin = source.getAttribute('skinIndex'),
    weights = source.getAttribute('skinWeight'),
    uv = source.getAttribute('uv');
  if (!source.index || !p || !skin || !weights)
    throw new Error('Indexed skinned geometry required');
  const n = p.count,
    index = source.index;
  const active = new Set(index.array);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const edges = new Map<string, number>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const regions = Array.from({ length: n }, () => new Set<number>());
  for (let i = 0; i < index.count; i += 3) {
    const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    const material =
      source.groups.find((g) => i >= g.start && i < g.start + g.count)?.materialIndex ?? 0;
    for (let k = 0; k < 3; k++) {
      const a = ids[k],
        b = ids[(k + 1) % 3],
        key = edgeKey(a, b);
      edges.set(key, (edges.get(key) ?? 0) + 1);
      parent[find(a)] = find(b);
      regions[a].add(material);
    }
  }
  const fixed = new Uint8Array(n);
  for (const i of locked) fixed[i] = 1;
  for (const [key, count] of edges)
    if (count !== 2) {
      const [a, b] = key.split(':').map(Number);
      fixed[a] = fixed[b] = 1;
    }
  const clusters = new Map<string, number>(),
    members: number[][] = [],
    remap: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!active.has(i) && !((options.protectNeck ?? true) && p.getY(i) >= 1.45)) continue;
    if ((options.protectNeck ?? true) && p.getY(i) >= 1.45) fixed[i] = 1;
    const influences = [0, 1, 2, 3]
      .filter((k) => weights.getComponent(i, k) > 1e-7)
      .map((k) => skin.getComponent(i, k))
      .sort((a, b) => a - b);
    // Production joints 19..48 are fingers; hand joints are identified by dominant
    // distal skin regions too, using fine cells on both arms below the elbow.
    const fine =
      influences.some((b) => b >= 19 || b === 7 || b === 10) ||
      (Math.abs(p.getX(i)) > 0.28 && p.getY(i) < 1.1);
    const cell = fine ? (options.fineCellSize ?? 0.008) : (options.cellSize ?? 0.055);
    const key = fixed[i]
      ? `fixed:${i}`
      : [
          find(i),
          [...regions[i]].sort().join(','),
          source.getAttribute('part')?.getX(i) ?? source.getAttribute('_part')?.getX(i) ?? 0,
          Math.sign(p.getX(i)),
          influences.join(','),
          Math.floor(p.getX(i) / cell),
          Math.floor(p.getY(i) / cell),
          Math.floor(p.getZ(i) / cell),
          uv ? Math.floor(uv.getX(i) * 8) : 0,
          uv ? Math.floor(uv.getY(i) * 8) : 0,
        ].join('|');
    let cluster = clusters.get(key);
    if (cluster === undefined) {
      cluster = members.length;
      clusters.set(key, cluster);
      members.push([]);
    }
    members[cluster].push(i);
    remap[i] = cluster;
  }
  const result = new THREE.BufferGeometry();
  const average = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
    const output = new Float32Array(members.length * attribute.itemSize);
    members.forEach((ids, j) => {
      for (let k = 0; k < attribute.itemSize; k++)
        output[j * attribute.itemSize + k] =
          ids.length === 1
            ? attribute.getComponent(ids[0], k)
            : ids.reduce((sum, i) => sum + attribute.getComponent(i, k), 0) / ids.length;
    });
    return new THREE.BufferAttribute(output, attribute.itemSize);
  };
  for (const [name, attribute] of Object.entries(source.attributes))
    if (name !== 'skinIndex' && name !== 'skinWeight' && name !== '_runtimesourceid')
      result.setAttribute(name, average(attribute));
  const joints = new Uint16Array(members.length * 4),
    outputWeights = new Float32Array(members.length * 4);
  members.forEach((ids, j) => {
    if (ids.length === 1 && fixed[ids[0]]) {
      for (let k = 0; k < 4; k++) {
        joints[j * 4 + k] = skin.getComponent(ids[0], k);
        outputWeights[j * 4 + k] = weights.getComponent(ids[0], k);
      }
      return;
    }
    const combined = new Map<number, number>();
    ids.forEach((i) => {
      for (let k = 0; k < 4; k++) {
        const bone = skin.getComponent(i, k);
        combined.set(bone, (combined.get(bone) ?? 0) + weights.getComponent(i, k));
      }
    });
    const sorted = [...combined]
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    const sum = sorted.reduce((v, [, w]) => v + w, 0);
    sorted.forEach(([bone, w], k) => {
      joints[j * 4 + k] = bone;
      outputWeights[j * 4 + k] = w / sum;
    });
  });
  result.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4));
  result.setAttribute('skinWeight', new THREE.Float32BufferAttribute(outputWeights, 4));
  for (const [name, attributes] of Object.entries(source.morphAttributes))
    result.morphAttributes[name as 'position' | 'normal' | 'color'] = attributes!.map(average);
  result.morphTargetsRelative = source.morphTargetsRelative;
  result.userData = { ...source.userData };
  const sourceIds = source.getAttribute('_runtimesourceid');
  if (sourceIds)
    result.userData.runtimeSourceIDs = members.map((ids) => ids.map((id) => sourceIds.getX(id)));
  const triangles: number[] = [],
    outputEdges = new Map<string, number>();
  for (let i = 0; i < index.count; i += 3) {
    const ids = [remap[index.getX(i)], remap[index.getX(i + 1)], remap[index.getX(i + 2)]];
    if (new Set(ids).size !== 3) continue;
    const material =
      source.groups.find((g) => i >= g.start && i < g.start + g.count)?.materialIndex ?? 0;
    const last = result.groups[result.groups.length - 1];
    if (last?.materialIndex === material) last.count += 3;
    else result.addGroup(triangles.length, 3, material);
    triangles.push(...ids);
    ids.forEach((a, k) => {
      const key = edgeKey(a, ids[(k + 1) % 3]);
      outputEdges.set(key, (outputEdges.get(key) ?? 0) + 1);
    });
  }
  let safe = true;
  for (const [key, count] of outputEdges)
    if (count !== 2) {
      const [a, b] = key.split(':').map(Number),
        aa = members[a],
        bb = members[b];
      if (aa.length !== 1 || bb.length !== 1 || edges.get(edgeKey(aa[0], bb[0])) !== count) {
        safe = false;
        for (const ids of [aa, bb]) if (ids.length > 1) ids.forEach((i) => locked.add(i));
      }
    }
  if (!safe) {
    result.dispose();
    if (attempt < 3) return buildLod(source, options, locked, attempt + 1);
    const fallback = source.clone();
    fallback.userData.continuousLod = { fallback: true, reason: 'topology audit' };
    return fallback;
  }
  result.setIndex(triangles);
  result.computeVertexNormals();
  const normals = result.getAttribute('normal'),
    originalNormals = source.getAttribute('normal');
  if (originalNormals)
    members.forEach((ids, i) => {
      if (ids.length === 1 && fixed[ids[0]])
        normals.setXYZ(
          i,
          originalNormals.getX(ids[0]),
          originalNormals.getY(ids[0]),
          originalNormals.getZ(ids[0])
        );
    });
  result.computeBoundingBox();
  result.computeBoundingSphere();
  result.userData.continuousLod = {
    fallback: false,
    sourceVertices: n,
    sourceTriangles: index.count / 3,
    vertices: members.length,
    triangles: triangles.length / 3,
  };
  return result;
}
