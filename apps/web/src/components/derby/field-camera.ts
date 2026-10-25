import * as THREE from 'three';

export const DERBY_FIELD_BOUNDS = Object.freeze({
  halfLength: 3.0,
  halfWidth: 0.85,
  bottom: 0,
  top: 3.65,
});

/** Fit every published horse silhouette. Pixel-sized number badges are laid out
 * separately, so their old five-metre envelope no longer wastes half the view. */
export function frameDerbyField(
  camera: THREE.PerspectiveCamera,
  positions: number[],
  field: number,
  dt = 0
) {
  const left = Math.min(...positions) - DERBY_FIELD_BOUNDS.halfLength,
    right = Math.max(...positions) + DERBY_FIELD_BOUNDS.halfLength;
  const center = new THREE.Vector3(
    (left + right) / 2,
    (DERBY_FIELD_BOUNDS.bottom + DERBY_FIELD_BOUNDS.top) / 2,
    0
  );
  // A tall canvas needs a clearer view across lanes, with a near-profile horse
  // silhouette. Wide stages retain a lower three-quarter broadcast view.
  const portrait = THREE.MathUtils.clamp((1.75 - camera.aspect) / 1.15, 0, 1);
  const direction = new THREE.Vector3(
    -0.35 + 0.375 * portrait,
    0.55 + 0.5 * portrait,
    1
  ).normalize();
  const side = new THREE.Vector3(direction.z, 0, -direction.x).normalize();
  const up = new THREE.Vector3().crossVectors(direction, side).normalize();
  const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const horizontal = vertical * camera.aspect;
  let distance = 15;
  // Fit each actual lane/position pair, not a Cartesian box combining one
  // runner's progress with another runner's lane. Those phantom corners made
  // a bunched field unnecessarily small, especially on short/wide stages.
  for (let i = 0; i < positions.length; i++)
    for (const x of [
      positions[i] - DERBY_FIELD_BOUNDS.halfLength,
      positions[i] + DERBY_FIELD_BOUNDS.halfLength,
    ])
      for (const y of [DERBY_FIELD_BOUNDS.bottom, DERBY_FIELD_BOUNDS.top])
        for (const z of [
          (i - (field - 1) / 2) * 2.15 - DERBY_FIELD_BOUNDS.halfWidth,
          (i - (field - 1) / 2) * 2.15 + DERBY_FIELD_BOUNDS.halfWidth,
        ]) {
          const offset = new THREE.Vector3(x, y, z).sub(center);
          distance = Math.max(
            distance,
            offset.dot(direction) +
              Math.max(
                Math.abs(offset.dot(side)) / horizontal,
                Math.abs(offset.dot(up)) / vertical
              ) *
                1.12
          );
        }
  // Zoom out immediately to contain every runner; ease contraction to avoid a pumping lens.
  if (dt > 0) {
    const priorDistance = camera.position.clone().sub(center).dot(direction);
    if (priorDistance > distance)
      distance += (priorDistance - distance) * Math.exp(-Math.min(dt, 0.25) * 2.5);
  }
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  return center.x;
}
