import * as THREE from 'three';

/** Fit the complete published field, including horse silhouettes and number markers. */
export function frameDerbyField(
  camera: THREE.PerspectiveCamera,
  positions: number[],
  field: number
) {
  const left = Math.min(...positions) - 3.3,
    right = Math.max(...positions) + 3.3;
  const center = new THREE.Vector3((left + right) / 2, 2.3, 0);
  const direction = new THREE.Vector3(0.34, 0.19, 1).normalize();
  const side = new THREE.Vector3(direction.z, 0, -direction.x).normalize();
  const up = new THREE.Vector3().crossVectors(direction, side).normalize();
  const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const horizontal = vertical * camera.aspect;
  const laneDepth = (field - 1) * 1.075 + 0.8;
  let distance = 15;
  for (const x of [left, right])
    for (const y of [0, 4.6])
      for (const z of [-laneDepth, laneDepth]) {
        const offset = new THREE.Vector3(x, y, z).sub(center);
        distance = Math.max(
          distance,
          offset.dot(direction) +
            Math.max(Math.abs(offset.dot(side)) / horizontal, Math.abs(offset.dot(up)) / vertical) *
              1.12
        );
      }
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  return center.x;
}
