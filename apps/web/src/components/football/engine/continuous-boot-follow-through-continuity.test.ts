import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createContinuousKit, syncContinuousBootFlex } from './continuous-kit';
import { createRig, kitFromClub, type Look } from './rig';
import { kickGeometry, poseKick } from './poses';

const look = {
  skin: '#b97c57',
  kit: kitFromClub({ primary: '#7a253d', secondary: '#14151a', pattern: 'solid' }),
} as Look;

function gap(mesh: THREE.SkinnedMesh, points: THREE.Vector3[], center: THREE.Vector3) {
  const index = mesh.geometry.index!,
    triangle = new THREE.Triangle(),
    q = new THREE.Vector3(),
    edge = new THREE.Line3();
  let minimum = Infinity;
  for (let i = 0; i < index.count; i += 3) {
    const a = points[index.getX(i)],
      b = points[index.getX(i + 1)],
      c = points[index.getX(i + 2)];
    triangle.set(a, b, c);
    let distance = triangle.closestPointToPoint(center, q).distanceTo(center);
    if (triangle.getArea() < 1e-13 || !Number.isFinite(distance)) {
      distance = Infinity;
      for (const [start, end] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const d = edge.set(start, end).closestPointToPoint(center, true, q).distanceTo(center);
        distance = Math.min(
          distance,
          Number.isFinite(d) ? d : Infinity,
          start.distanceTo(center),
          end.distanceTo(center)
        );
      }
    }
    if (!Number.isFinite(distance)) throw Error(`Invalid visible boot triangle ${i / 3}`);
    minimum = Math.min(minimum, distance);
  }
  return minimum - 0.11;
}

describe('visible boot contact fitting through the complete diagnostic overlap interval', () => {
  it.each(['L', 'R'] as const)(
    '%s keeps clearance without a new surface pop at ordinary millisecond inputs',
    (foot) => {
      const kit = createContinuousKit(look),
        material = new THREE.MeshBasicMaterial(),
        rig = createRig(material, new THREE.BufferGeometry());
      const mesh = new THREE.SkinnedMesh(kit.geometries.boots, material);
      rig.root.add(mesh);
      mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
      const spec = {
        foot,
        power: 0.75,
        loft: 0.2,
        ball: new THREE.Vector3(0, 0.11, 0),
        dir: new THREE.Vector3(0, 0, 1),
      };
      const facts = JSON.stringify(spec);
      const rows: {
        time: number;
        gap: number;
        largestWorldStep: number;
        maximumBind: number;
        floor: number;
      }[] = [];
      let previous: THREE.Vector3[] | undefined;
      try {
        for (let i = 0; i <= 210; i++) {
          // Keep ordinary floating-point timestamps, including .33999999999999997.
          const time = 0.29 + i * 0.001;
          rig.root.position.copy(kickGeometry(spec).root);
          poseKick(rig, time, spec, { reviewFollowThrough: true });
          rig.root.updateMatrixWorld(true);
          rig.skeleton.update();
          const protectedMatrices = [rig.root, ...rig.skeleton.bones].map((o) =>
            o.matrixWorld.toArray()
          );
          const ball = spec.ball.clone();
          if (time > 0.3) {
            ball.addScaledVector(spec.dir, (time - 0.3) * 5);
            ball.y += Math.sin(Math.min(1, (time - 0.3) / 1.5) * Math.PI) * 0.5;
          }
          syncContinuousBootFlex(mesh, rig, { center: ball, radius: 0.11 });
          expect(JSON.stringify(spec)).toBe(facts);
          expect(
            [rig.root, ...rig.skeleton.bones].every((o, j) =>
              o.matrixWorld.elements.every((v, k) => v === protectedMatrices[j][k])
            )
          ).toBe(true);
          const p = mesh.geometry.getAttribute('position');
          const points = Array.from({ length: p.count }, (_, j) =>
            mesh
              .applyBoneTransform(j, new THREE.Vector3().fromBufferAttribute(p, j))
              .applyMatrix4(mesh.matrixWorld)
          );
          rows.push({
            time,
            gap: gap(mesh, points, ball),
            largestWorldStep: previous
              ? Math.max(...points.map((point, j) => point.distanceTo(previous![j])))
              : 0,
            maximumBind: Number(mesh.geometry.userData.maxVisualBootDisplacementMetres),
            floor: Math.min(...points.map((point) => point.y)),
          });
          previous = points;
        }
        const minGap = Math.min(...rows.map((r) => r.gap));
        const maxStep = Math.max(...rows.map((r) => r.largestWorldStep));
        console.info('dense diagnostic fitting', {
          foot,
          samples: rows.length,
          minGap,
          maxStep,
          worstGap: [...rows].sort((a, b) => a.gap - b.gap).slice(0, 3),
          worstStep: [...rows].sort((a, b) => b.largestWorldStep - a.largestWorldStep).slice(0, 3),
        });
        // 15mm at 1ms includes measured baseline swing (12.372mm) with headroom,
        // while rejecting the prototype's 80–110mm on/off fitting impulses.
        expect(maxStep).toBeLessThan(0.015);
        expect(minGap).toBeGreaterThanOrEqual(0.003 - 2e-6);
        expect(Math.max(...rows.map((r) => r.maximumBind))).toBeLessThan(0.18);
        expect(Math.min(...rows.map((r) => r.floor))).toBeGreaterThanOrEqual(0.001 - 1e-6);
      } finally {
        rig.dispose();
        kit.dispose();
        material.dispose();
      }
    },
    30000
  );
});
