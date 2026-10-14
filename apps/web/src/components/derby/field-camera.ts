import * as THREE from 'three';

/** Fit the complete published field, including horse silhouettes and number markers. */
export function frameDerbyField(
  camera: THREE.PerspectiveCamera,
  positions: number[],
  field: number,
  dt = 0
) {
  const left = Math.min(...positions) - 3.3,
    right = Math.max(...positions) + 3.3;
  const center = new THREE.Vector3((left + right) / 2, 2.3, 0);
  const direction = new THREE.Vector3(0.25, 0.32, 1).normalize();
  const side = new THREE.Vector3(direction.z, 0, -direction.x).normalize();
  const up = new THREE.Vector3().crossVectors(direction, side).normalize();
  const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const horizontal = vertical * camera.aspect;
  const laneDepth = (field - 1) * 1.075 + 0.8;
  let distance = 15;
  for (const x of [left, right])
    for (const y of [0, 5])
      for (const z of [-laneDepth, laneDepth]) {
        const offset = new THREE.Vector3(x, y, z).sub(center);
        distance = Math.max(
          distance,
          offset.dot(direction) +
            Math.max(Math.abs(offset.dot(side)) / horizontal, Math.abs(offset.dot(up)) / vertical) *
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
