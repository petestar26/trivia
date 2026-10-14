import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

export const HOOF_NAMES = [
  'front_leg_foot_l',
  'front_leg_foot_r',
  'back_leg_foot_l',
  'back_leg_foot_r',
] as const;
export type HoofWindow = {
  name: (typeof HOOF_NAMES)[number];
  center: number;
  halfWidth: number;
  position: THREE.Vector3;
  minimum: number;
  soleOffset: number;
  soleHeights: Float32Array;
};
const point = (node: THREE.Object3D, model: THREE.Object3D) =>
  model.worldToLocal(node.getWorldPosition(new THREE.Vector3()));

/** Measure low, backward-moving portions of the actual exported cycle, once per asset set. */
export function measureHoofWindows(model: THREE.Object3D, clip: THREE.AnimationClip): HoofWindow[] {
  model = clone(model);
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(clip).play();
  const count = 192;
  const selections = HOOF_NAMES.map((name) => selectHoofVertices(model, name));
  const soleHeights = HOOF_NAMES.map(() => new Float32Array(count));
  const samples = HOOF_NAMES.map(() => [] as THREE.Vector3[]);
  for (let i = 0; i < count; i++) {
    mixer.setTime((i * clip.duration) / count);
    model.updateMatrixWorld(true);
    HOOF_NAMES.forEach((name, hoof) => {
      samples[hoof].push(point(model.getObjectByName(name)!, model));
      soleHeights[hoof][i] = sampleSelectedSole(model, selections[hoof]);
    });
  }
  const windows = samples.map((poses, hoof) => {
    const minimum = Math.min(...poses.map((p) => p.y));
    const eligible = poses.map((p, i) => {
      const speed =
        (poses[(i + 1) % count].z - poses[(i + count - 1) % count].z) /
        ((2 * clip.duration) / count);
      return p.y < minimum + 0.035 && speed < -7 && speed > -13;
    });
    // Select the longest contiguous low/backward segment, including the loop seam.
    let bestStart = 0,
      bestLength = 0;
    for (let start = 0; start < count; start++) {
      if (!eligible[start] || eligible[(start + count - 1) % count]) continue;
      let length = 0;
      while (length < count && eligible[(start + length) % count]) length++;
      if (length > bestLength) {
        bestStart = start;
        bestLength = length;
      }
    }
    const centerIndex = (bestStart + (bestLength - 1) / 2 + count) % count;
    return {
      name: HOOF_NAMES[hoof],
      center: (centerIndex * clip.duration) / count,
      halfWidth: (Math.max(1, bestLength - 1) * clip.duration) / count / 2,
      position: poses[Math.round(centerIndex) % count].clone(),
      minimum,
      soleOffset: 0,
      soleHeights: soleHeights[hoof],
    };
  });
  for (const window of windows) {
    mixer.setTime(window.center);
    model.updateMatrixWorld(true);
    const foot = point(model.getObjectByName(window.name)!, model);
    const sole = sampledHoofSole(model, window.name);
    window.soleOffset = Number.isFinite(sole) ? sole - foot.y : 0;
    window.position.y = -window.soleOffset;
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  model.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
  });
  return windows;
}

export function stanceOffset(time: number, duration: number, window: HoofWindow) {
  return ((time - window.center + duration * 1.5) % duration) - duration / 2;
}

/** Fixed work bound: three anatomical joints, six passes; no history or frame-delta dependency. */
export function constrainHoof(
  model: THREE.Object3D,
  window: HoofWindow,
  time: number,
  duration: number
) {
  const offset = stanceOffset(time, duration, window);
  if (Math.abs(offset) >= window.halfWidth) {
    // Clearance only: no horizontal planting of slow approach/toe-roll frames.
    const phase =
      ((((time % duration) + duration) % duration) / duration) * window.soleHeights.length;
    const sample = Math.floor(phase),
      next = (sample + 1) % window.soleHeights.length;
    const sole = THREE.MathUtils.lerp(
      window.soleHeights[sample],
      window.soleHeights[next],
      phase - sample
    );
    if (sole >= 0) return; // Preserve positive-height authored poses and suspension exactly.
    const target = point(model.getObjectByName(window.name)!, model);
    target.y += Math.min(0.05, -sole + 0.003);
    solveHoofTarget(model, window.name, target);
    return;
  }
  const foot = model.getObjectByName(window.name)!;
  const current = point(foot, model);
  const weight = THREE.MathUtils.smoothstep(1 - Math.abs(offset) / window.halfWidth, 0, 0.25);
  const target = window.position.clone();
  target.z -= 10 * offset;
  // The measured hoof joint is above the underside of the mesh. Preserve that clearance.
  target.y = -window.soleOffset;
  const correction = target.clone().sub(current);
  correction.clampLength(0, 0.28);
  target.copy(current).addScaledVector(correction, weight);
  solveHoofTarget(model, window.name, target);
}

function solveHoofTarget(model: THREE.Object3D, name: string, target: THREE.Vector3) {
  const foot = model.getObjectByName(name)!;
  const hoofRotation = foot.getWorldQuaternion(new THREE.Quaternion());
  model.localToWorld(target);
  const prefix = name.replace('_foot_', '_');
  const side = name.endsWith('_l') ? 'l' : 'r';
  const family = prefix.startsWith('front') ? 'front' : 'back';
  const joints = ['ankle', 'lower', 'upper'].map((j) =>
    model.getObjectByName(`${family}_leg_${j}_${side}`)!
  );
  for (let pass = 0; pass < 6; pass++)
    for (const joint of joints) {
      const origin = joint.getWorldPosition(new THREE.Vector3());
      const from = foot.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
      const to = target.clone().sub(origin).normalize();
      const world = new THREE.Quaternion()
        .setFromUnitVectors(from, to)
        .multiply(joint.getWorldQuaternion(new THREE.Quaternion()));
      joint.quaternion.copy(
        joint.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world)
      );
      joint.updateMatrixWorld(true);
    }
  foot.quaternion.copy(
    foot.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(hoofRotation)
  );
  foot.updateMatrixWorld(true);
}

type HoofSelection = { mesh: THREE.SkinnedMesh; indices: number[] };
function selectHoofVertices(model: THREE.Object3D, name: string): HoofSelection[] {
  const selection: HoofSelection[] = [];
  model.traverse((o) => {
    if (!(o instanceof THREE.SkinnedMesh)) return;
    const indices = o.geometry.getAttribute('skinIndex');
    const weights = o.geometry.getAttribute('skinWeight');
    const family = name.replace('_foot_', '_').replace(/_[lr]$/, '_');
    const related = new Set(
      o.skeleton.bones.map((b, i) =>
        b.name.startsWith(family) &&
        b.name.endsWith(name.slice(-2)) &&
        /_(foot|leaf|toe|ankle)_/.test(b.name)
          ? i
          : -1
      )
    );
    const vertices: number[] = [];
    for (let i = 0; i < indices.count; i++) {
      let influence = 0;
      for (let k = 0; k < 4; k++)
        if (related.has(indices.getComponent(i, k))) influence += weights.getComponent(i, k);
      if (influence >= 0.5) vertices.push(i);
    }
    if (vertices.length) selection.push({ mesh: o, indices: vertices });
  });
  return selection;
}
function sampleSelectedSole(model: THREE.Object3D, selection: HoofSelection[]) {
  let sole = Infinity;
  for (const { mesh, indices } of selection) {
    mesh.skeleton.update();
    const positions = mesh.geometry.getAttribute('position');
    const meshToModel = new THREE.Matrix4()
      .copy(model.matrixWorld)
      .invert()
      .multiply(mesh.matrixWorld);
    const v = new THREE.Vector3();
    for (const i of indices) {
      v.fromBufferAttribute(positions, i);
      mesh.applyBoneTransform(i, v);
      v.applyMatrix4(meshToModel);
      sole = Math.min(sole, v.y);
    }
  }
  return sole;
}
/** Actual skinned lower envelope of vertices mostly weighted to this hoof chain. */
export function sampledHoofSole(model: THREE.Object3D, name: string) {
  return sampleSelectedSole(model, selectHoofVertices(model, name));
}
