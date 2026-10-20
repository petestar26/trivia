import * as THREE from 'three';
import { BONES, type Rig } from './rig';

const smooth = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);
/** Original edge tailoring; every original preferred-source vertex/UV corner
 * remains present. Derived edge points retain explicit interpolation records. */
function tailoredEdges(source: THREE.BufferGeometry) {
  const g = source.clone(),
    p = source.getAttribute('position'),
    joints = source.getAttribute('skinIndex'),
    weights = source.getAttribute('skinWeight');
  const attributes = Object.fromEntries(
    Object.entries(source.attributes).map(([name, a]) => [
      name,
      { size: a.itemSize, values: Array.from(a.array) as number[], integer: name === 'skinIndex' },
    ])
  );
  const positions = attributes.position.values,
    canonical = new Map<string, number>(),
    representative: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const key =
      [x, y, z].map((v) => Math.round(v * 1e7)).join(',') +
      '|' +
      Array.from(
        { length: 4 },
        (_, k) => joints.getComponent(i, k) + ':' + weights.getComponent(i, k)
      ).join(',');
    if (!canonical.has(key)) canonical.set(key, i);
    representative.push(canonical.get(key)!);
  }
  const edgeCounts = new Map<string, { count: number; a: number; b: number }>(),
    sourceIndex = source.index!;
  for (let k = 0; k < sourceIndex.count; k += 3) {
    const tri = [sourceIndex.getX(k), sourceIndex.getX(k + 1), sourceIndex.getX(k + 2)];
    for (let e = 0; e < 3; e++) {
      const a = tri[e],
        b = tri[(e + 1) % 3],
        ca = representative[a],
        cb = representative[b],
        key = [Math.min(ca, cb), Math.max(ca, cb)].join(',');
      const entry = edgeCounts.get(key);
      if (entry) entry.count++;
      else edgeCounts.set(key, { count: 1, a, b });
    }
  }
  const next = new Map<number, { a: number; b: number }>();
  for (const e of edgeCounts.values()) if (e.count === 1) next.set(representative[e.a], e);
  const visited = new Set<number>(),
    loops: number[][] = [];
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    let at = start;
    while (!visited.has(at) && next.has(at)) {
      visited.add(at);
      const e = next.get(at)!;
      loop.push(e.a);
      at = representative[e.b];
    }
    if (at === start && loop.length > 4) loops.push(loop);
  }
  const originalPositionDeltas = Array.from({ length: p.count }, (_, i) => [
    positions[i * 3] - p.getX(i),
    positions[i * 3 + 1] - p.getY(i),
    positions[i * 3 + 2] - p.getZ(i),
  ]);
  const derived: Array<{
    vertex: number;
    positionSourceVertices: number[];
    positionCoefficients: number[];
    positionOffset: number[];
    linearUVWeightSourceVertices: number[];
    linearUVWeightCoefficients: number[];
    operation: string;
  }> = [];
  const append = (
    a: number,
    b: number,
    point: THREE.Vector3,
    operation: string,
    positionSourceVertices = [a, b],
    positionCoefficients = [0.5, 0.5],
    positionOffset = [0, 0, 0]
  ) => {
    const id = positions.length / 3;
    for (const [name, attr] of Object.entries(attributes)) {
      if (name === 'position') attr.values.push(point.x, point.y, point.z);
      else if (name === 'skinIndex' || name === 'skinWeight') continue;
      else
        for (let k = 0; k < attr.size; k++)
          attr.values.push((attr.values[a * attr.size + k] + attr.values[b * attr.size + k]) / 2);
    }
    const merged = new Map<number, number>();
    for (const v of [a, b])
      for (let k = 0; k < 4; k++) {
        const j = attributes.skinIndex.values[v * 4 + k],
          w = attributes.skinWeight.values[v * 4 + k] / 2;
        merged.set(j, (merged.get(j) ?? 0) + w);
      }
    const selected = [...merged.entries()]
        .filter(([, w]) => w > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4),
      sum = selected.reduce((s, [, w]) => s + w, 0);
    for (let k = 0; k < 4; k++) {
      attributes.skinIndex.values.push(selected[k]?.[0] ?? 0);
      attributes.skinWeight.values.push((selected[k]?.[1] ?? 0) / sum);
    }
    derived.push({
      vertex: id,
      positionSourceVertices,
      positionCoefficients,
      positionOffset,
      linearUVWeightSourceVertices: [a, b],
      linearUVWeightCoefficients: [0.5, 0.5],
      operation,
    });
    return id;
  };
  const read = (id: number) =>
    new THREE.Vector3(positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]);
  const midpointByEdge = new Map<string, number>(),
    returns: number[] = [];
  for (const loop of loops) {
    const meanY = loop.reduce((s, i) => s + positions[i * 3 + 1], 0) / loop.length;
    if (meanY < 1.22) continue; // Keep the existing tucked waist opening.
    const collar = meanY > 1.43,
      refined: number[] = [];
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k],
        b = loop[(k + 1) % loop.length],
        before = read(loop[(k + loop.length - 1) % loop.length]),
        start = read(a),
        end = read(b),
        after = read(loop[(k + 2) % loop.length]);
      // Catmull midpoint rounds the coarse 12-point cuff / 26-point neckline.
      const mid = before
        .multiplyScalar(-1 / 16)
        .addScaledVector(start, 9 / 16)
        .addScaledVector(end, 9 / 16)
        .addScaledVector(after, -1 / 16);
      const id = append(
        a,
        b,
        mid,
        'original Catmull edge midpoint; linear UV/weight interpolation',
        [loop[(k + loop.length - 1) % loop.length], a, b, loop[(k + 2) % loop.length]],
        [-1 / 16, 9 / 16, 9 / 16, -1 / 16]
      );
      midpointByEdge.set(
        [
          Math.min(representative[a], representative[b]),
          Math.max(representative[a], representative[b]),
        ].join(','),
        id
      );
      refined.push(a, id);
    }
    const inside: number[] = [];
    for (const a of refined) {
      const point = read(a),
        centreX = collar ? 0 : point.x > 0 ? 0.195 : -0.195;
      const radial = new THREE.Vector3(point.x - centreX, 0, point.z)
        .normalize()
        .multiplyScalar(-0.0015);
      point.add(radial);
      point.y += collar ? -0.002 : 0.002;
      inside.push(
        append(
          a,
          a,
          point,
          collar ? '2mm connected collar cloth return' : '2mm connected fitted cuff return',
          [a],
          [1],
          [radial.x, collar ? -0.002 : 0.002, radial.z]
        )
      );
    }
    for (let k = 0; k < refined.length; k++) {
      const j = (k + 1) % refined.length;
      returns.push(refined[k], inside[k], refined[j], refined[j], inside[k], inside[j]);
    }
  }
  const index: number[] = [];
  for (let k = 0; k < sourceIndex.count; k += 3) {
    const tri = [sourceIndex.getX(k), sourceIndex.getX(k + 1), sourceIndex.getX(k + 2)];
    let split = false;
    for (let e = 0; e < 3; e++) {
      const a = tri[e],
        b = tri[(e + 1) % 3],
        c = tri[(e + 2) % 3],
        mid = midpointByEdge.get(
          [
            Math.min(representative[a], representative[b]),
            Math.max(representative[a], representative[b]),
          ].join(',')
        );
      if (mid !== undefined) {
        index.push(a, mid, c, mid, b, c);
        split = true;
        break;
      }
    }
    if (!split) index.push(...tri);
  }
  for (const [name, attr] of Object.entries(attributes))
    g.setAttribute(
      name,
      attr.integer
        ? new THREE.Uint16BufferAttribute(attr.values, attr.size)
        : new THREE.Float32BufferAttribute(attr.values, attr.size)
    );
  g.setIndex([...index, ...returns]);
  g.computeVertexNormals();
  // Accepted source neck normals are preserved; new sewn return has its own.
  const normals = g.getAttribute('normal'),
    originalNormals = source.getAttribute('normal');
  for (let i = 0; i < p.count; i++)
    if (Math.abs(p.getX(i)) < 0.1 && p.getY(i) > 1.43)
      normals.setXYZ(i, originalNormals.getX(i), originalNormals.getY(i), originalNormals.getZ(i));
  g.userData.garmentTailoring = {
    originalVertices: p.count,
    originalSourceVerticesRetained: true,
    originalPositionDeltas,
    referenceSpace:
      'Tailored vertex dependency graph; original IDs begin at source position plus originalPositionDeltas',
    cuffTaper: 0,
    returnThicknessMetres: 0.0015,
    returnDepthMetres: 0.002,
    derived,
  };
  return g;
}
/** Original visual-only pose adapter on the retained preferred MHCLO shirt.
 * Owns a private geometry clone, including normals. Never edits the supplied
 * asset, skeleton, contact targets or clocks. update after final pose solving. */
export function createContinuousShirtCorrectives(mesh: THREE.SkinnedMesh, rig: Rig) {
  const source = mesh.geometry,
    geometry = tailoredEdges(source);
  mesh.geometry = geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const neutral = new Float32Array(position.array),
    normal = geometry.getAttribute('normal') as THREE.BufferAttribute,
    neutralNormal = new Float32Array(normal.array);
  const indices = geometry.getAttribute('skinIndex'),
    weights = geometry.getAttribute('skinWeight');
  const samples: Array<{ id: number; side: 'L' | 'R'; fade: number }> = [];
  for (let id = 0; id < position.count; id++) {
    const x = position.getX(id),
      y = position.getY(id);
    const fade = smooth(0.105, 0.17, Math.abs(x)) * smooth(1.265, 1.36, y);
    if (fade > 0) samples.push({ id, side: x > 0 ? 'L' : 'R', fade });
  }
  const seamMap = new Map<string, number[]>();
  for (let i = 0; i < position.count; i++) {
    const key =
      Array.from(neutral.slice(i * 3, i * 3 + 3))
        .map((v) => Math.round(v * 1e7))
        .join(',') +
      '|' +
      Array.from(
        { length: 4 },
        (_, k) => indices.getComponent(i, k) + ':' + weights.getComponent(i, k)
      ).join(',');
    const group = seamMap.get(key) ?? [];
    group.push(i);
    seamMap.set(key, group);
  }
  const seams = [...seamMap.values()].filter((g) => g.length > 1),
    corrected = new Set<number>();
  const representative = new Int32Array(position.count);
  for (const group of seamMap.values()) for (const i of group) representative[i] = group[0];
  const adjacency = Array.from({ length: position.count }, () => new Set<number>());
  const triangleIndex = geometry.index!;
  for (let i = 0; i < triangleIndex.count; i += 3) {
    const tri = [triangleIndex.getX(i), triangleIndex.getX(i + 1), triangleIndex.getX(i + 2)].map(
      (v) => representative[v]
    );
    for (let k = 0; k < 3; k++) {
      adjacency[tri[k]].add(tri[(k + 1) % 3]);
      adjacency[tri[(k + 1) % 3]].add(tri[k]);
    }
  }
  const posedBase = new Float64Array(position.count * 3),
    fair = new Float64Array(position.count * 3),
    next = new Float64Array(position.count * 3);
  const transforms = BONES.map(() => new THREE.Matrix4()),
    previous = BONES.map(() => new THREE.Matrix4().makeScale(0, 0, 0));
  const blended = new THREE.Matrix4(),
    inverse = new THREE.Matrix4(),
    p = new THREE.Vector3(),
    posed = new THREE.Vector3(),
    radial = new THREE.Vector3(),
    target = new THREE.Vector3(),
    delta = new THREE.Vector3();
  let disposed = false,
    wasActive = false;
  const arms = {
    L: { origin: new THREE.Vector3(), axis: new THREE.Vector3(), activation: 0 },
    R: { origin: new THREE.Vector3(), axis: new THREE.Vector3(), activation: 0 },
  };
  return {
    sampleCount: samples.length,
    update() {
      if (disposed) return;
      rig.root.updateWorldMatrix(true, true);
      const rootInverse = rig.root.matrixWorld.clone().invert();
      let changed = false;
      rig.skeleton.bones.forEach((bone, i) => {
        transforms[i]
          .multiplyMatrices(rootInverse, bone.matrixWorld)
          .multiply(rig.skeleton.boneInverses[i]);
        if (transforms[i].elements.some((v, k) => Math.abs(v - previous[i].elements[k]) > 1e-10))
          changed = true;
      });
      if (!changed) return;
      transforms.forEach((m, i) => previous[i].copy(m));
      for (const side of ['L', 'R'] as const) {
        const arm = arms[side],
          bone = rig.bones[`upperArm${side}`];
        arm.origin.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(rootInverse);
        arm.axis
          .setFromMatrixPosition(rig.bones[`foreArm${side}`].matrixWorld)
          .applyMatrix4(rootInverse)
          .sub(arm.origin)
          .normalize();
        // Shoulder elevation relative to its chest frame, independent of root
        // heading/scale. Measured resting breathing stays below 0.26 radians,
        // avoiding idle skinning, fairing and geometry uploads.
        const direction = new THREE.Vector3(0, -1, 0).applyQuaternion(bone.quaternion);
        arm.activation = smooth(0.26, 1.1, Math.acos(THREE.MathUtils.clamp(-direction.y, -1, 1)));
      }
      const active = arms.L.activation > 0 || arms.R.activation > 0;
      if (!active && !wasActive) return;
      position.array.set(neutral);
      corrected.clear();
      let maximum = 0,
        maxBind = 0;
      const blendVertex = (id: number) => {
        blended.elements.fill(0);
        for (let k = 0; k < 4; k++) {
          const w = weights.getComponent(id, k),
            m = transforms[indices.getComponent(id, k)];
          for (let j = 0; j < 16; j++) blended.elements[j] += m.elements[j] * w;
        }
      };
      if (active) {
        for (let id = 0; id < position.count; id++) {
          blendVertex(id);
          p.set(neutral[id * 3], neutral[id * 3 + 1], neutral[id * 3 + 2]).applyMatrix4(blended);
          posedBase[id * 3] = fair[id * 3] = p.x;
          posedBase[id * 3 + 1] = fair[id * 3 + 1] = p.y;
          posedBase[id * 3 + 2] = fair[id * 3 + 2] = p.z;
        }
        // Fair the actual connected posed surface. UV split vertices share the
        // same adjacency and corrected coordinate, so no opening/flap is made.
        // Never inflate an inside radius out onto a cylinder: that inverted
        // concave source folds and produced cap flaps in actual capture.
        for (let pass = 0; pass < 8; pass++) {
          next.set(fair);
          for (const { id, side, fade } of samples) {
            if (representative[id] !== id) continue;
            const arm = arms[side],
              peers = adjacency[id];
            if (!peers.size) continue;
            posed.set(fair[id * 3], fair[id * 3 + 1], fair[id * 3 + 2]);
            radial.copy(posed).sub(arm.origin);
            const axial = radial.dot(arm.axis);
            const envelope = smooth(-0.13, -0.06, axial) * (1 - smooth(0.1, 0.23, axial));
            const amount = (pass % 2 === 0 ? 0.45 : -0.47) * fade * arm.activation * envelope;
            if (amount === 0) continue;
            target.set(0, 0, 0);
            for (const j of peers) {
              target.x += fair[j * 3];
              target.y += fair[j * 3 + 1];
              target.z += fair[j * 3 + 2];
            }
            target.multiplyScalar(1 / peers.size);
            // Local continuity resolves the source fold without radial inflation.
            target.lerp(posed, 1 - amount);
            next[id * 3] = target.x;
            next[id * 3 + 1] = target.y;
            next[id * 3 + 2] = target.z;
          }
          for (const group of seams)
            for (const i of group)
              if (i !== group[0]) {
                next[i * 3] = next[group[0] * 3];
                next[i * 3 + 1] = next[group[0] * 3 + 1];
                next[i * 3 + 2] = next[group[0] * 3 + 2];
              }
          fair.set(next);
        }
        for (const { id, side } of samples) {
          if (!arms[side].activation) continue;
          posed.set(posedBase[id * 3], posedBase[id * 3 + 1], posedBase[id * 3 + 2]);
          target.set(fair[id * 3], fair[id * 3 + 1], fair[id * 3 + 2]);
          delta.copy(target).sub(posed);
          if (delta.length() > 0.045) delta.setLength(0.045);
          maximum = Math.max(maximum, delta.length());
          if (delta.lengthSq() > 1e-14) corrected.add(id);
          blendVertex(id);
          if (Math.abs(blended.determinant()) < 0.05) continue;
          p.set(neutral[id * 3], neutral[id * 3 + 1], neutral[id * 3 + 2]);
          target.copy(posed).add(delta).applyMatrix4(inverse.copy(blended).invert());
          maxBind = Math.max(maxBind, target.distanceTo(p));
          position.setXYZ(id, target.x, target.y, target.z);
        }
      }
      position.needsUpdate = true;
      if (active) geometry.computeVertexNormals();
      else normal.array.set(neutralNormal);
      const seamNormal = new THREE.Vector3();
      for (const group of seams) {
        if (!group.some((i) => corrected.has(i))) continue;
        seamNormal.set(0, 0, 0);
        for (const i of group) seamNormal.add(p.fromBufferAttribute(normal, i));
        seamNormal.normalize();
        for (const i of group) normal.setXYZ(i, seamNormal.x, seamNormal.y, seamNormal.z);
      }
      for (let i = 0; i < position.count; i++)
        if (!corrected.has(i))
          normal.setXYZ(
            i,
            neutralNormal[i * 3],
            neutralNormal[i * 3 + 1],
            neutralNormal[i * 3 + 2]
          );
      // Preserve exact original neckline normals and source torso/cuff normals.
      for (let i = 0; i < position.count; i++)
        if (Math.abs(neutral[i * 3]) < 0.1 && neutral[i * 3 + 1] > 1.43)
          normal.setXYZ(
            i,
            neutralNormal[i * 3],
            neutralNormal[i * 3 + 1],
            neutralNormal[i * 3 + 2]
          );
      normal.needsUpdate = true;
      wasActive = active;
      geometry.userData.shirtCorrective = {
        sampleCount: samples.length,
        maxPosedDisplacementMetres: maximum,
        maxBindDisplacementMetres: maxBind,
        limitMetres: 0.045,
        recipe:
          'original connected posed shoulder fairing; inverse production49 LBS; pinned neckline',
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (mesh.geometry === geometry) mesh.geometry = source;
      geometry.dispose();
    },
  };
}
