import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createLegSurface } from './leg-surface';
import { gallopPose, legJoint, STRIDE_SECONDS } from './gallop';

describe('deforming leg surfaces', () => {
  it('keeps finite, bounded surfaces and outward normals throughout the gallop', () => {
    for (const hind of [true, false]) {
      const skin = createLegSurface(hind);
      for (let t = 0; t < STRIDE_SECONDS; t += 0.02) {
        const foot = gallopPose(t, 0, true).feet[hind ? 0 : 2];
        const knee = legJoint(foot.x, foot.y - 1.68, hind);
        skin.pose(0, 1.68, knee.x, knee.y + 1.68, foot.x, foot.y, 0.285);
        const positions = skin.geometry.getAttribute('position');
        const normals = skin.geometry.getAttribute('normal');
        for (let i = 0; i < positions.count; i++) {
          expect(Number.isFinite(positions.getX(i) + positions.getY(i) + positions.getZ(i))).toBe(
            true
          );
          expect(Math.abs(positions.getX(i))).toBeLessThan(1.4);
          expect(positions.getY(i)).toBeLessThan(2.4);
          expect(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i))).toBeCloseTo(1, 5);
        }
      }
      // Triangle winding must agree with shading normals (otherwise limbs render inside-out).
      const p = skin.geometry.getAttribute('position'),
        n = skin.geometry.getAttribute('normal');
      const ix = skin.geometry.index!;
      for (let i = 0; i < ix.count; i += 3) {
        const a = new Vector3().fromBufferAttribute(p, ix.getX(i));
        const b = new Vector3().fromBufferAttribute(p, ix.getX(i + 1));
        const c = new Vector3().fromBufferAttribute(p, ix.getX(i + 2));
        const normal = new Vector3().fromBufferAttribute(n, ix.getX(i));
        expect(b.sub(a).cross(c.sub(a)).dot(normal)).toBeGreaterThan(0);
      }
      skin.geometry.dispose();
    }
  });
});
