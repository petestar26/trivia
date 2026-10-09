import { expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { backdropSize } from './backdrop-fit';
it.each([0.75, 1, 1.5, 1032 / 390, 3.5])('covers every view corner at aspect %s', (aspect) => {
  for (const lead of [0, 90, 190]) {
    const center = lead - 3;
    const camera = new PerspectiveCamera(40, aspect, 0.1, 2000);
    camera.position.set(center + 13, 5.2, aspect < 1.2 ? 25 : 21);
    camera.lookAt(center, 2.2, 0);
    camera.updateMatrixWorld();
    const plane = new Vector3(center - 35, 16, -65);
    const size = backdropSize(camera, plane);
    for (const x of [-1, 1])
      for (const y of [-1, 1]) {
        const ray = new Vector3(x, y, 0.5).unproject(camera).sub(camera.position);
        const hit = ray.multiplyScalar((plane.z - camera.position.z) / ray.z).add(camera.position);
        expect(hit.distanceTo(camera.position)).toBeLessThan(camera.far);
        expect(Math.abs(hit.x - plane.x)).toBeLessThan(size.width / 2);
        if (hit.y >= 0) expect(Math.abs(hit.y - size.centerY)).toBeLessThan(size.height / 2);
      }
    expect(size.width).toBeGreaterThanOrEqual(200);
    expect(size.height).toBeGreaterThanOrEqual(66.67);
  }
});
