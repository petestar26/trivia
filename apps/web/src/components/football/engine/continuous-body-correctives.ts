import * as THREE from 'three';

/** Inverse of the transverse shrink produced by blending two rigid rotations.
 * Capped to avoid explosive geometry at folded/singular 180-degree hinges. */
export function hingeVolumeScale(angle: number, distalWeight: number) {
  const w = THREE.MathUtils.clamp(distalWeight, 0, 1);
  const contraction = Math.sqrt(Math.max(0.01, 1 - 4 * w * (1 - w) * Math.sin(angle / 2) ** 2));
  return Math.min(1.8, 1 / contraction);
}

/** Owns a private position buffer; never mutates shared assets, skeletons, facial
 * morphs or contact targets. Call update after animation, before rendering. */
export function createContinuousBodyCorrectives(mesh: THREE.SkinnedMesh) {
  const source = mesh.geometry;
  const geometry = source.clone();
  mesh.geometry = geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const neutral = new Float32Array(position.array);
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const neutralNormals = new Float32Array(normals.array);
  const corrected = new Set<number>();
  const indices = geometry.getAttribute('skinIndex');
  const weights = geometry.getAttribute('skinWeight');
  const bones = mesh.skeleton.bones;
  const hinges: {
    bone: THREE.Bone;
    samples: { index: number; delta: THREE.Vector3; weight: number; fade: number }[];
  }[] = [];
  for (const side of ['L', 'R'])
    for (const [proximal, distal, tail, radius] of [
      ['upperArm', 'foreArm', 'hand', 0.085],
      ['upperLeg', 'lowerLeg', 'foot', 0.1],
    ] as const) {
      const parentIndex = bones.findIndex((b) => b.name === proximal + side);
      const jointIndex = bones.findIndex((b) => b.name === distal + side);
      const tailIndex = bones.findIndex((b) => b.name === tail + side);
      if (parentIndex < 0 || jointIndex < 0 || tailIndex < 0) continue;
      const pivot = new THREE.Vector3().setFromMatrixPosition(
        mesh.skeleton.boneInverses[jointIndex].clone().invert()
      );
      const end = new THREE.Vector3().setFromMatrixPosition(
        mesh.skeleton.boneInverses[tailIndex].clone().invert()
      );
      const longitudinal = end.sub(pivot).normalize();
      const samples: (typeof hinges)[number]['samples'] = [];
      for (let i = 0; i < position.count; i++) {
        let proximalWeight = 0,
          distalWeight = 0;
        for (let k = 0; k < 4; k++) {
          const j = indices.getComponent(i, k),
            w = weights.getComponent(i, k);
          if (j === parentIndex) proximalWeight += w;
          if (j === jointIndex) distalWeight += w;
        }
        if (proximalWeight + distalWeight < 0.95 || distalWeight < 0.02 || proximalWeight < 0.02)
          continue;
        const delta = new THREE.Vector3().fromBufferAttribute(position, i).sub(pivot);
        const axial = delta.dot(longitudinal);
        if (Math.abs(axial) > radius) continue;
        // Only restore cross-sectional volume; longitudinal placement stays fixed.
        delta.addScaledVector(longitudinal, -axial);
        const t = Math.min(1, Math.abs(axial) / radius);
        const fade = 1 - t * t * (3 - 2 * t);
        samples.push({
          index: i,
          delta,
          weight: distalWeight / (distalWeight + proximalWeight),
          fade,
        });
        corrected.add(i);
      }
      hinges.push({ bone: bones[jointIndex], samples });
    }
  const axis = new THREE.Vector3(),
    offset = new THREE.Vector3();
  // A moved vertex changes every incident face, including its unmodified
  // neighbours. UV corners with identical bind position/weights must receive
  // the same area normal; recomputing each UV island independently draws a
  // lighting seam through a continuous knee/elbow. Preserve authored creases
  // by also requiring the neutral normal to agree at the seam.
  const representative = new Uint32Array(position.count);
  const canonical = new Map<string, number>();
  for (let i = 0; i < position.count; i++) {
    const key = [
      ...neutral.subarray(i * 3, i * 3 + 3),
      ...Array.from({ length: 4 }, (_, k) => indices.getComponent(i, k)),
      ...Array.from({ length: 4 }, (_, k) => weights.getComponent(i, k)),
      ...Array.from({ length: 3 }, (_, k) => Math.round(neutralNormals[i * 3 + k] * 1e4)),
    ].join(',');
    if (!canonical.has(key)) canonical.set(key, i);
    representative[i] = canonical.get(key)!;
  }
  const triangleIndex = geometry.index;
  const normalAffected = new Set([...corrected].map((i) => representative[i]));
  if (triangleIndex)
    for (let k = 0; k < triangleIndex.count; k += 3) {
      const ids = [0, 1, 2].map((c) => triangleIndex.getX(k + c));
      if (ids.some((i) => corrected.has(i)))
        ids.forEach((i) => normalAffected.add(representative[i]));
    }
  const areaNormals = new Float64Array(position.count * 3);
  function updateNormals() {
    if (!triangleIndex) {
      geometry.computeVertexNormals();
      for (let i = 0; i < normals.count; i++)
        if (!corrected.has(i))
          normals.setXYZ(
            i,
            neutralNormals[i * 3],
            neutralNormals[i * 3 + 1],
            neutralNormals[i * 3 + 2]
          );
      return;
    }
    areaNormals.fill(0);
    for (let k = 0; k < triangleIndex.count; k += 3) {
      const a = triangleIndex.getX(k),
        b = triangleIndex.getX(k + 1),
        c = triangleIndex.getX(k + 2);
      const abX = position.getX(b) - position.getX(a),
        abY = position.getY(b) - position.getY(a),
        abZ = position.getZ(b) - position.getZ(a);
      const acX = position.getX(c) - position.getX(a),
        acY = position.getY(c) - position.getY(a),
        acZ = position.getZ(c) - position.getZ(a);
      const nx = abY * acZ - abZ * acY,
        ny = abZ * acX - abX * acZ,
        nz = abX * acY - abY * acX;
      for (let corner = 0; corner < 3; corner++) {
        const id = representative[triangleIndex.getX(k + corner)];
        if (!normalAffected.has(id)) continue;
        areaNormals[id * 3] += nx;
        areaNormals[id * 3 + 1] += ny;
        areaNormals[id * 3 + 2] += nz;
      }
    }
    normals.array.set(neutralNormals);
    for (let i = 0; i < normals.count; i++) {
      const id = representative[i];
      if (!normalAffected.has(id)) continue;
      const x = areaNormals[id * 3],
        y = areaNormals[id * 3 + 1],
        z = areaNormals[id * 3 + 2];
      const length = Math.hypot(x, y, z);
      if (length > 1e-15) normals.setXYZ(i, x / length, y / length, z / length);
    }
  }
  const previous = hinges.map(() => new THREE.Quaternion());
  let disposed = false;
  let wasCorrected = false;
  return {
    sampleCount: hinges.reduce((n, h) => n + h.samples.length, 0),
    update() {
      if (disposed) return;
      const changed = hinges.some(
        (h, i) => 1 - Math.abs(previous[i].dot(h.bone.quaternion)) > 1e-14
      );
      if (!changed) return;
      hinges.forEach((h, i) => previous[i].copy(h.bone.quaternion));
      const neutralPose = hinges.every((h) => Math.abs(h.bone.quaternion.w) > 1 - 1e-14);
      if (neutralPose && !wasCorrected) return;
      if (neutralPose) {
        position.array.set(neutral);
        normals.array.set(neutralNormals);
        position.needsUpdate = true;
        normals.needsUpdate = true;
        wasCorrected = false;
        return;
      }
      wasCorrected = true;
      // Absolute neutral restoration makes random access/reduced motion stable.
      position.array.set(neutral);
      for (const { bone, samples } of hinges) {
        const q = bone.quaternion;
        const angle = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(q.w), 0, 1));
        axis.set(q.x, q.y, q.z);
        if (axis.lengthSq() < 1e-12) continue;
        axis.normalize();
        for (const { index, delta, weight, fade } of samples) {
          offset.copy(delta).addScaledVector(axis, -delta.dot(axis));
          offset.multiplyScalar((hingeVolumeScale(angle, weight) - 1) * fade);
          // An anatomical guard keeps extreme-fold displacement below 25mm.
          if (offset.lengthSq() > 0.025 ** 2) offset.setLength(0.025);
          position.setXYZ(
            index,
            neutral[index * 3] + offset.x,
            neutral[index * 3 + 1] + offset.y,
            neutral[index * 3 + 2] + offset.z
          );
        }
      }
      position.needsUpdate = true;
      updateNormals();
      normals.needsUpdate = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (mesh.geometry === geometry) mesh.geometry = source;
      geometry.dispose();
    },
  };
}
