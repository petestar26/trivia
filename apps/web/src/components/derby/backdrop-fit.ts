import { PerspectiveCamera, Vector3 } from 'three';
/** Cover every camera corner at the backdrop plane, including oblique wide views. */
export function backdropSize(camera: PerspectiveCamera, center: Vector3) {
  camera.updateMatrixWorld();
  let halfWidth = 100,
    top = 50;
  for (const x of [-1, 1])
    for (const y of [-1, 1]) {
      const ray = new Vector3(x, y, 0.5).unproject(camera).sub(camera.position);
      const distance = (center.z - camera.position.z) / ray.z;
      const hit = ray.multiplyScalar(distance).add(camera.position);
      halfWidth = Math.max(halfWidth, Math.abs(hit.x - center.x) * 1.05);
      top = Math.max(top, hit.y * 1.05);
    }
  // The opaque ground hides the lower view rays. Keep the artwork's turf
  // horizon at ground level instead of enlarging its hidden lower half.
  // The authored panorama is 2172×724 (3:1). Cover wide expanded views by
  // enlarging both axes together, keeping the turf horizon at ground level.
  const artworkAspect = 3;
  const height = Math.max(66.67, top / 0.75, (halfWidth * 2) / artworkAspect);
  return { width: height * artworkAspect, height, centerY: height * 0.25 };
}
