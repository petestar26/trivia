import { expect, it } from 'vitest';
import * as THREE from 'three';
import { frameDerbyField } from './field-camera';
it('keeps all eight horse silhouettes and number markers inside phone, landscape and desktop views', () => {
  for (const field of [6, 8])
    for (const aspect of [390 / 290, 390 / 600, 844 / 280, 1354 / 390])
      for (const gap of [0.2, 1.62, 3]) {
        const positions = Array.from({ length: field }, (_, i) => 100 - i * gap);
        const camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 2000);
        frameDerbyField(camera, positions, field);
        positions.forEach((x, i) => {
          const z = (i - (field - 1) / 2) * 2.15;
          for (const dx of [-3.3, 3.3])
            for (const y of [0, 4.6])
              for (const dz of [-0.8, 0.8]) {
                const screen = new THREE.Vector3(x + dx, y, z + dz).project(camera);
                expect(Math.abs(screen.x)).toBeLessThan(1);
                expect(Math.abs(screen.y)).toBeLessThan(1);
              }
        });
      }
});
