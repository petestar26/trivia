import * as THREE from 'three';
import { nativePlayerContract } from './native-player-assets';

/** Convert runtime +Y-up quaternion to the source's C=(x,-z,y) frame.
 * Both semantic measurements are homogeneous and ignore axial limb twist. */
export function nativeCorrectiveAngle(
  q: THREE.Quaternion,
  kind: 'shoulder' | 'knee',
  side: string
) {
  const qw = q.w,
    qx = q.x,
    qy = -q.z,
    qz = q.y;
  const norm = Math.max(1e-12, qw * qw + qx * qx + qy * qy + qz * qz);
  return kind === 'shoulder'
    ? Math.asin(
        THREE.MathUtils.clamp(((side === 'L' ? -2 : 2) * (qx * qz + qy * qw)) / norm, -1, 1)
      )
    : Math.acos(THREE.MathUtils.clamp((qw * qw + qz * qz - qx * qx - qy * qy) / norm, -1, 1));
}
export function nativeCorrectiveWeight(
  angle: number,
  onset: number,
  peak: number,
  adjacent: number
) {
  const clamp = (v: number) => THREE.MathUtils.clamp(v, 0, 1);
  return peak < adjacent
    ? clamp((angle - onset) / (peak - onset)) * clamp((adjacent - angle) / (adjacent - peak))
    : clamp((angle - adjacent) / (peak - adjacent));
}

/** Only the twelve explicitly exported source keys are owned here. Facial
 * inputs are copied independently; random access always recomputes absolute weights.
 * GPU morph targets survive distant LOD, without a per-frame CPU fairing pass. */
export function createNativePlayerCorrectives(mesh: THREE.SkinnedMesh, sourceName: string) {
  const entries = nativePlayerContract.drivers
    .filter((d) => d.mesh === sourceName)
    .map((d) => {
      const index = mesh.morphTargetDictionary?.[d.key];
      const bone = mesh.skeleton.bones.find((b) => b.name === d.bone);
      if (index === undefined || !bone) throw new Error('Native corrective binding missing');
      return { d, index, bone };
    });
  return {
    update() {
      for (const { d, index, bone } of entries)
        mesh.morphTargetInfluences![index] = nativeCorrectiveWeight(
          nativeCorrectiveAngle(bone.quaternion, d.kind as 'shoulder' | 'knee', d.side),
          d.onsetRadians,
          d.peakRadians,
          d.adjacentPeakRadians
        );
    },
    dispose() {},
  };
}
