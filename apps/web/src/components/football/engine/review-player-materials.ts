import * as THREE from 'three';

/** Reuse the pool-owned fabric maps on the review kit. Materials borrow these
 * samplers; neither this helper nor material disposal owns their textures.
 * Construction-only: no geometry, UV, texture transform or per-frame work. */
export function borrowReviewFabric(
  target: THREE.MeshStandardMaterial,
  source: THREE.MeshStandardMaterial
) {
  target.normalMap = source.normalMap;
  target.roughnessMap = source.roughnessMap;
  target.normalScale.set(0.08, 0.08);
  target.roughness = 0.98;
}
