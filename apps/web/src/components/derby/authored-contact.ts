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
  /** Additional horizontal recovery only, outside the original measured stance. */
  transitionWidth: number;
  /** Actual skinned underside relative to the hoof joint at every authored phase. */
  soleOffsets: Float32Array;
  soleCorrections: Float32Array;
  solveCompensationX: Float32Array;
  solveCompensationZ: Float32Array;
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
      transitionWidth: ((Math.max(1, bestLength - 1) * clip.duration) / count / 2) * 0.75,
      soleOffsets: Float32Array.from(soleHeights[hoof], (sole, phase) => sole - poses[phase].y),
      soleCorrections: new Float32Array(count).fill(0.003),
      solveCompensationX: new Float32Array(count),
      solveCompensationZ: new Float32Array(count),
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
  // Fit the visible skinned underside after the same bounded IK, once per asset
  // set. Mixed ankle/lower-leg weights make a raw joint-to-sole offset insufficient.
  // Staged passes avoid calibration order/history dependence; no runtime vertex scan.
  for (let pass = 0; pass < 5; pass++) {
    const next = windows.map((window) => window.soleCorrections.slice());
    const nextX = windows.map((window) => window.solveCompensationX.slice()),
      nextZ = windows.map((window) => window.solveCompensationZ.slice());
    for (let phase = 0; phase < count; phase++) {
      const time = (phase * clip.duration) / count;
      mixer.setTime(time);
      model.updateMatrixWorld(true);
      for (const window of windows) constrainHoof(model, window, time, clip.duration);
      windows.forEach((window, hoof) => {
        const distance = Math.abs(stanceOffset(time, clip.duration, window));
        if (distance >= window.halfWidth + window.transitionWidth && window.soleHeights[phase] >= 0)
          return;
        const weight = hoofContactWeight(time, clip.duration, window);
        if (weight > 0.25) {
          const foot = point(model.getObjectByName(window.name)!, model),
            offset = stanceOffset(time, clip.duration, window);
          nextX[hoof][phase] = THREE.MathUtils.clamp(
            window.solveCompensationX[phase] + (window.position.x - foot.x) / weight,
            -0.05,
            0.05
          );
          nextZ[hoof][phase] = THREE.MathUtils.clamp(
            window.solveCompensationZ[phase] + (window.position.z - 10 * offset - foot.z) / weight,
            -0.05,
            0.05
          );
        }
        const residual = sampleSelectedSole(model, selections[hoof]);
        next[hoof][phase] = THREE.MathUtils.clamp(
          window.soleCorrections[phase] + THREE.MathUtils.clamp(0.003 - residual, -0.015, 0.015),
          -0.05,
          0.05
        );
      });
    }
    windows.forEach((window, hoof) => {
      window.soleCorrections.set(next[hoof]);
      window.solveCompensationX.set(nextX[hoof]);
      window.solveCompensationZ.set(nextZ[hoof]);
    });
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

/** C1 recovery shoulders, exactly one across the complete original stance window. */
export function hoofContactWeight(time: number, duration: number, window: HoofWindow) {
  const distance = Math.abs(stanceOffset(time, duration, window));
  return (
    1 -
    THREE.MathUtils.smoothstep(
      distance,
      window.halfWidth,
      window.halfWidth + window.transitionWidth
    )
  );
}

function samplePeriodic(values: Float32Array, time: number, duration: number) {
  const phase = ((((time % duration) + duration) % duration) / duration) * values.length;
  const whole = Math.floor(phase),
    index = whole % values.length,
    next = (index + 1) % values.length;
  const previous = (index + values.length - 1) % values.length;
  const after = (index + 2) % values.length;
  const u = phase - whole,
    u2 = u * u,
    u3 = u2 * u;
  const a = values[index],
    b = values[next],
    at = (values[next] - values[previous]) / 2,
    bt = (values[after] - values[index]) / 2;
  return (
    (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * at + (-2 * u3 + 3 * u2) * b + (u3 - u2) * bt
  );
}

/** Decorative phase-only support response, no accumulated history or race inputs. */
export function sampleHoofSupport(time: number, duration: number, windows: readonly HoofWindow[]) {
  const weights = windows.map((window) => hoofContactWeight(time, duration, window));
  const fore = (weights[0] + weights[1]) / 2,
    hind = (weights[2] + weights[3]) / 2;
  return {
    load: Math.min(1, fore + hind),
    pitch: fore - hind,
    roll: (weights[0] + weights[2] - weights[1] - weights[3]) / 2,
  };
}

/** Fixed work bound: three anatomical joints, six passes; no history or frame-delta dependency. */
export function constrainHoof(
  model: THREE.Object3D,
  window: HoofWindow,
  time: number,
  duration: number
) {
  const offset = stanceOffset(time, duration, window);
  if (Math.abs(offset) >= window.halfWidth + window.transitionWidth) {
    // Clearance only: no horizontal planting of slow approach/toe-roll frames.
    const sole = samplePeriodic(window.soleHeights, time, duration);
    if (sole >= 0) return; // Preserve positive-height authored poses and suspension exactly.
    const target = point(model.getObjectByName(window.name)!, model);
    target.y += Math.max(
      0,
      Math.min(
        0.05,
        -sole +
          THREE.MathUtils.clamp(samplePeriodic(window.soleCorrections, time, duration), -0.05, 0.05)
      )
    );
    solveHoofTarget(model, window.name, target);
    return;
  }
  const foot = model.getObjectByName(window.name)!;
  const current = point(foot, model);
  const weight = hoofContactWeight(time, duration, window);
  const target = window.position.clone();
  target.z -= 10 * offset;
  target.x += THREE.MathUtils.clamp(
    samplePeriodic(window.solveCompensationX, time, duration),
    -0.05,
    0.05
  );
  target.z += THREE.MathUtils.clamp(
    samplePeriodic(window.solveCompensationZ, time, duration),
    -0.05,
    0.05
  );
  // The underside changes with the authored hoof rotation, rather than retaining
  // the center pose's offset for the entire landing/loading/lift sequence.
  target.y =
    -samplePeriodic(window.soleOffsets, time, duration) +
    THREE.MathUtils.clamp(samplePeriodic(window.soleCorrections, time, duration), -0.05, 0.05);
  const correction = target.clone().sub(current).multiplyScalar(weight);
  const rawSole = samplePeriodic(window.soleHeights, time, duration);
  if (rawSole < 0)
    correction.y = Math.max(
      correction.y,
      Math.min(
        0.05,
        -rawSole +
          THREE.MathUtils.clamp(samplePeriodic(window.soleCorrections, time, duration), -0.05, 0.05)
      )
    );
  if (Math.abs(offset) > window.halfWidth) correction.y = Math.min(0.05, correction.y);
  correction.clampLength(0, 0.28);
  target.copy(current).add(correction);
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
