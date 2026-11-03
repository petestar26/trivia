import * as THREE from 'three';
import { BONES, type Rig } from './rig';

const SEGMENTS = 32;
const STRIDE = SEGMENTS + 1;
const PASSES = 6;
const STRENGTH = 0.35;
const LIMIT = 0.015;

/** Visual-only cyclic fairing of the authored returned sock cuff rows. Owns a
 * private geometry; production bones, bindings, contacts and clocks stay fixed. */
export function createContinuousSockCorrectives(mesh: THREE.SkinnedMesh, rig: Rig) {
  const source = mesh.geometry,
    geometry = source.clone(),
    position = geometry.getAttribute('position') as THREE.BufferAttribute,
    normal = geometry.getAttribute('normal') as THREE.BufferAttribute,
    joints = geometry.getAttribute('skinIndex'),
    weights = geometry.getAttribute('skinWeight');
  if (position.count % STRIDE !== 0) throw new Error('Unexpected authored sock ring layout');
  const rows: { start: number; side: 'L' | 'R' }[] = [],
    canonical = new Int32Array(position.count);
  for (let start = 0; start < position.count; start += STRIDE) {
    const y = position.getY(start),
      side = position.getX(start) > 0 ? 'L' : 'R';
    for (let j = 0; j <= SEGMENTS; j++) {
      const id = start + j;
      if (Math.abs(position.getY(id) - y) > 1e-6)
        throw new Error('Unexpected authored sock cuff row');
      canonical[id] = start + (j % SEGMENTS);
    }
    // The seam is a UV duplicate, not another angular fairing sample.
    position.setXYZ(start + SEGMENTS, position.getX(start), y, position.getZ(start));
    if (y >= 0.4 - 1e-6) rows.push({ start, side });
  }
  mesh.geometry = geometry;
  position.setUsage(THREE.DynamicDrawUsage);
  normal.setUsage(THREE.DynamicDrawUsage);
  const neutral = new Float32Array(position.array),
    neutralNormals = new Float32Array(normal.array),
    areaNormals = new Float64Array(position.count * 3),
    posedBase = new Float64Array(position.count * 3),
    fair = new Float64Array(position.count * 3),
    next = new Float64Array(position.count * 3),
    index = geometry.index!;
  const computeNormals = () => {
    areaNormals.fill(0);
    for (let k = 0; k < index.count; k += 3) {
      const a = index.getX(k),
        b = index.getX(k + 1),
        c = index.getX(k + 2),
        ux = position.getX(b) - position.getX(a),
        uy = position.getY(b) - position.getY(a),
        uz = position.getZ(b) - position.getZ(a),
        vx = position.getX(c) - position.getX(a),
        vy = position.getY(c) - position.getY(a),
        vz = position.getZ(c) - position.getZ(a),
        x = uy * vz - uz * vy,
        y = uz * vx - ux * vz,
        z = ux * vy - uy * vx;
      for (let corner = 0; corner < 3; corner++) {
        const at = canonical[index.getX(k + corner)] * 3;
        areaNormals[at] += x;
        areaNormals[at + 1] += y;
        areaNormals[at + 2] += z;
      }
    }
    for (let id = 0; id < position.count; id++) {
      const at = canonical[id] * 3,
        x = areaNormals[at],
        y = areaNormals[at + 1],
        z = areaNormals[at + 2],
        length = Math.hypot(x, y, z);
      if (length > 1e-15) normal.setXYZ(id, x / length, y / length, z / length);
    }
  };
  computeNormals();
  neutralNormals.set(normal.array);
  const transforms = BONES.map(() => new THREE.Matrix4()),
    previous = BONES.map(() => new THREE.Matrix4().makeScale(0, 0, 0)),
    rootInverse = new THREE.Matrix4(),
    blended = new THREE.Matrix4(),
    inverse = new THREE.Matrix4(),
    point = new THREE.Vector3(),
    direction = new THREE.Vector3(),
    delta = new THREE.Vector3(),
    activation = { L: 0, R: 0 };
  let disposed = false,
    wasActive = false,
    previousEnabled: boolean | undefined;
  const blend = (id: number) => {
    blended.elements.fill(0);
    for (let k = 0; k < 4; k++) {
      const weight = weights.getComponent(id, k),
        matrix = transforms[joints.getComponent(id, k)];
      for (let j = 0; j < 16; j++) blended.elements[j] += matrix.elements[j] * weight;
    }
  };
  return {
    ringCount: rows.length,
    update(enabled = true) {
      if (disposed) return;
      rig.root.updateWorldMatrix(true, true);
      rootInverse.copy(rig.root.matrixWorld).invert();
      let changed = enabled !== previousEnabled;
      rig.skeleton.bones.forEach((bone, i) => {
        transforms[i]
          .multiplyMatrices(rootInverse, bone.matrixWorld)
          .multiply(rig.skeleton.boneInverses[i]);
        if (
          transforms[i].elements.some(
            (value, k) => Math.abs(value - previous[i].elements[k]) > 1e-10
          )
        )
          changed = true;
      });
      if (!changed) return;
      previousEnabled = enabled;
      transforms.forEach((matrix, i) => previous[i].copy(matrix));
      for (const side of ['L', 'R'] as const) {
        direction.set(0, -1, 0).applyQuaternion(rig.bones[`lowerLeg${side}`].quaternion);
        const angle = Math.acos(THREE.MathUtils.clamp(-direction.y, -1, 1));
        activation[side] = enabled ? THREE.MathUtils.smoothstep(angle, 0.35, 1.4) : 0;
      }
      const active = activation.L > 0 || activation.R > 0;
      if (!active && !wasActive) return;
      position.array.set(neutral);
      let maximum = 0,
        skippedSingular = 0;
      if (active) {
        for (const { start } of rows)
          for (let j = 0; j < SEGMENTS; j++) {
            const id = start + j;
            blend(id);
            point.fromArray(neutral, id * 3).applyMatrix4(blended);
            const at = id * 3;
            posedBase[at] = fair[at] = point.x;
            posedBase[at + 1] = fair[at + 1] = point.y;
            posedBase[at + 2] = fair[at + 2] = point.z;
          }
        // Every returned row gets the same angular recipe; never mix rows or
        // collapse the authored radial/vertical separation of the cuff folds.
        for (let pass = 0; pass < PASSES; pass++) {
          next.set(fair);
          for (const { start, side } of rows) {
            const amount = STRENGTH * activation[side];
            if (!amount) continue;
            for (let j = 0; j < SEGMENTS; j++) {
              const at = (start + j) * 3,
                before = (start + ((j + SEGMENTS - 1) % SEGMENTS)) * 3,
                after = (start + ((j + 1) % SEGMENTS)) * 3;
              for (let k = 0; k < 3; k++)
                next[at + k] =
                  fair[at + k] +
                  amount * ((fair[before + k] + fair[after + k]) * 0.5 - fair[at + k]);
            }
          }
          fair.set(next);
        }
        for (const { start, side } of rows) {
          if (!activation[side]) continue;
          for (let j = 0; j < SEGMENTS; j++) {
            const id = start + j,
              at = id * 3;
            delta.set(
              fair[at] - posedBase[at],
              fair[at + 1] - posedBase[at + 1],
              fair[at + 2] - posedBase[at + 2]
            );
            if (delta.length() > LIMIT) delta.setLength(LIMIT);
            blend(id);
            if (Math.abs(blended.determinant()) < 0.05) {
              skippedSingular++;
              continue;
            }
            point.fromArray(posedBase, at).add(delta).applyMatrix4(inverse.copy(blended).invert());
            position.setXYZ(id, point.x, point.y, point.z);
            maximum = Math.max(maximum, delta.length());
          }
          position.setXYZ(
            start + SEGMENTS,
            position.getX(start),
            position.getY(start),
            position.getZ(start)
          );
        }
        computeNormals();
      } else normal.array.set(neutralNormals);
      position.needsUpdate = true;
      normal.needsUpdate = true;
      geometry.computeBoundingSphere();
      wasActive = active;
      geometry.userData.sockCorrective = {
        ringCount: rows.length,
        maxPosedDisplacementMetres: maximum,
        limitMetres: LIMIT,
        skippedSingularVertices: skippedSingular,
        recipe:
          'original cyclic posed cuff fairing; inverse production49 LBS; no contact authority',
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
