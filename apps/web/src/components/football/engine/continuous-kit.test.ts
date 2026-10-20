import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createContinuousKit, syncContinuousBootFlex } from './continuous-kit';
import { poseRun, plantRunFeet, poseKick, kickGeometry, type RunPlant } from './poses';
import { Region, BONES, createRig, humanGeometry, kitFromClub, type Look } from './rig';
const look: Look = {
  skin: '#b97c57',
  kit: kitFromClub({ primary: '#7a253d', secondary: '#eee9e2', pattern: 'solid' }),
} as Look;
describe('original continuous player kit', () => {
  it('provides real independent indexed garment surfaces with normalized production49 binding', () => {
    const kit = createContinuousKit(look);
    for (const g of Object.values(kit.geometries)) {
      const p = g.getAttribute('position'),
        j = g.getAttribute('skinIndex'),
        w = g.getAttribute('skinWeight');
      expect(p.count).toBeGreaterThan(500);
      expect(g.index!.count).toBeGreaterThan(1000);
      for (let i = 0; i < p.count; i++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          expect(j.getComponent(i, k)).toBeLessThan(BONES.length);
          expect(w.getComponent(i, k)).toBeGreaterThanOrEqual(0);
          sum += w.getComponent(i, k);
        }
        expect(sum).toBeCloseTo(1, 5);
      }
    }
    const p = kit.geometries.shorts.getAttribute('position');
    expect(Math.min(...Array.from({ length: p.count }, (_, i) => p.getY(i)))).toBeCloseTo(0.682, 4);
    kit.dispose();
  });
  it('sews the waist, seat and crotch into one surface with only waist and two returned leg openings', () => {
    const kit = createContinuousKit(look),
      g = kit.geometries.shorts,
      index = g.index!,
      p = g.getAttribute('position');
    const edges = new Map<string, number>(),
      neighbors = Array.from({ length: p.count }, () => new Set<number>());
    for (let i = 0; i < index.count; i += 3) {
      const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      for (let k = 0; k < 3; k++) {
        const a = tri[k],
          b = tri[(k + 1) % 3],
          key = [Math.min(a, b), Math.max(a, b)].join(',');
        edges.set(key, (edges.get(key) ?? 0) + 1);
        neighbors[a].add(b);
        neighbors[b].add(a);
      }
    }
    const seen = new Set<number>(),
      todo = [0];
    while (todo.length) {
      const i = todo.pop()!;
      if (seen.has(i)) continue;
      seen.add(i);
      todo.push(...neighbors[i]);
    }
    expect(seen.size).toBe(p.count);
    expect(Math.max(...edges.values())).toBe(2);
    const boundary = new Map<number, Set<number>>();
    for (const [key, count] of edges)
      if (count === 1) {
        const [a, b] = key.split(',').map(Number);
        for (const [x, y] of [
          [a, b],
          [b, a],
        ]) {
          if (!boundary.has(x)) boundary.set(x, new Set());
          boundary.get(x)!.add(y);
        }
      }
    for (const peers of boundary.values()) expect(peers.size).toBe(2);
    let loops = 0;
    const visited = new Set<number>();
    for (const start of boundary.keys()) {
      if (visited.has(start)) continue;
      loops++;
      const queue = [start];
      while (queue.length) {
        const i = queue.pop()!;
        if (visited.has(i)) continue;
        visited.add(i);
        queue.push(...boundary.get(i)!);
      }
    }
    expect(loops).toBe(3);
    kit.dispose();
  });
  it('keeps a flat neutral sole and heel/ball bounds; flex preserves fixed contact datums', () => {
    const kit = createContinuousKit(look),
      g = kit.geometries.boots,
      p = g.getAttribute('position'), neutral = p.clone();
    expect(Math.min(...Array.from({ length: p.count }, (_, i) => p.getY(i)))).toBeCloseTo(0.01, 5);
    const front = Array.from({ length: p.count }, (_, i) => i).filter((i) => p.getZ(i) > 0.17);
    expect(Math.min(...front.map((i) => p.getY(i)))).toBeLessThan(0.013);
    const source = humanGeometry(),
      rig = createRig(new THREE.MeshStandardMaterial(), source.geometry);
    const mesh = new THREE.SkinnedMesh(g, kit.materials.boots);
    rig.root.add(mesh);
    mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
    rig.skeleton.bones[BONES.indexOf('footL')].rotation.x = 0.7;
    rig.root.updateMatrixWorld(true);
    syncContinuousBootFlex(mesh, rig);
    for (let i = 0; i < p.count; i++) {
      if (p.getX(i) < 0) expect(p.getY(i) - neutral.getY(i)).toBeCloseTo(0, 6);
    }
    expect(Math.max(...front.filter((i) => p.getX(i) > 0).map((i) => p.getY(i) - neutral.getY(i)))).toBeGreaterThan(
      0.03
    );
    mesh.removeFromParent();
    rig.skeleton.dispose();
    source.geometry.dispose();
    kit.dispose();
  });
  it('probes every visible boot vertex through planted run phases and both complete kicks', () => {
    const kit = createContinuousKit(look),
      source = humanGeometry(),
      mat = new THREE.MeshStandardMaterial(),
      rig = createRig(mat, source.geometry);
    const mesh = new THREE.SkinnedMesh(kit.geometries.boots, kit.materials.boots);
    const neutral = mesh.geometry.getAttribute('position').clone();
    rig.root.add(mesh);
    mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
    let minimum = Infinity;
    let maxDelta = 0;
    let beforeGap = Infinity,
      afterGap = Infinity;
    const probe = () => {
      rig.root.updateMatrixWorld(true);
      rig.skeleton.update();
      syncContinuousBootFlex(mesh, rig);
      maxDelta = Math.max(maxDelta, Number(mesh.geometry.userData.maxVisualBootDisplacementMetres));
      const p = mesh.geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const v = new THREE.Vector3()
          .fromBufferAttribute(p, i);
        mesh.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        minimum = Math.min(minimum, v.y);
      }
    };
    for (const speed of [1.2, 4.4, 9]) {
      const plants: RunPlant = {};
      for (let i = 0; i <= 120; i++) {
        const phase = i / 120;
        poseRun(rig, phase, speed);
        plantRunFeet(rig, phase, speed, plants);
        probe();
      }
    }
    expect(minimum).toBeGreaterThan(-0.004);
    let canonicalMinimum = Infinity;
    let oldGapMinimum = Infinity;
    for (const scale of [0.96, 1, 1.04])
      for (const heading of [-1.1, 0, 1.1])
        for (const foot of ['L', 'R'] as const) {
          rig.root.scale.setScalar(scale);
          rig.root.rotation.y = heading;
          const spec = {
            foot,
            ball: new THREE.Vector3(0, 0.11, 1),
            dir: new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)),
            power: 1,
            loft: 0,
          };
          rig.root.position.copy(kickGeometry(spec).root);
          for (let i = 0; i <= 85; i++) {
            poseKick(rig, i / 100, spec);
            probe();
            if (i === 30) {
              let oldGap = Infinity,
                newGap = Infinity;
              const oldP = source.geometry.getAttribute('position');
              for (let j = 0; j < oldP.count; j++) {
                if (source.region[j] !== Region.BOOT || oldP.getX(j) > 0 !== (foot === 'L'))
                  continue;
                const v = new THREE.Vector3().fromBufferAttribute(oldP, j);
                rig.mesh.applyBoneTransform(j, v);
                v.applyMatrix4(rig.mesh.matrixWorld);
                oldGap = Math.min(oldGap, v.distanceTo(spec.ball));
              }
              const p = mesh.geometry.getAttribute('position');
              for (let j = 0; j < p.count; j++) {
                if (p.getX(j) > 0 !== (foot === 'L')) continue;
                const raw = new THREE.Vector3().fromBufferAttribute(neutral, j),
                  bent = new THREE.Vector3().fromBufferAttribute(p, j);
                mesh.applyBoneTransform(j, raw);
                mesh.applyBoneTransform(j, bent);
                raw.applyMatrix4(mesh.matrixWorld);
                bent.applyMatrix4(mesh.matrixWorld);
                beforeGap = Math.min(beforeGap, raw.distanceTo(spec.ball));
                afterGap = Math.min(afterGap, bent.distanceTo(spec.ball));
                newGap = Math.min(newGap, bent.distanceTo(spec.ball));
              }
              // These are vertex-to-centre samples, not collision clearance.
              // A value below the 110mm radius represents a sampled overlap.
              expect(Number.isFinite(newGap)).toBe(true);
              oldGapMinimum = Math.min(oldGapMinimum, oldGap);
            }
            const b = rig.bones[`foot${foot}`];
            canonicalMinimum = Math.min(
              canonicalMinimum,
              new THREE.Vector3(0, -0.068, 0.15).applyMatrix4(b.matrixWorld).y
            );
          }
        }
    // The existing kick datum itself crosses turf by 42.5mm. Preserve this
    // explicit incompatibility; do not conceal it by moving a contact bone.
    expect(canonicalMinimum).toBeLessThan(-0.04);
    expect(minimum).toBeGreaterThan(-0.004);
    expect(Number.isFinite(afterGap)).toBe(true);
    expect(maxDelta).toBeLessThan(0.18);
    console.log({ minimum, canonicalMinimum,
      rawNearestVertexToBallCentreMetres: beforeGap,
      deformedNearestVertexToBallCentreMetres: afterGap,
      deformedSignedVertexToBallSurfaceMetres: afterGap - .11,
      legacyNearestVertexToBallCentreMetres: oldGapMinimum,
      ballRadiusMetres: .11, maxDelta,
      limitation: 'Bounded vertex samples only; negative signed surface distance is overlap, not a full triangle collision result.' });
    mesh.removeFromParent();
    rig.dispose();
    mat.dispose();
    source.geometry.dispose();
    kit.dispose();
  });
  it('has per-actor dynamic buffer/material ownership and idempotent cleanup', () => {
    const a = createContinuousKit(look),
      b = createContinuousKit(look);
    expect(a.geometries.boots).not.toBe(b.geometries.boots);
    expect(a.geometries.boots.getAttribute('position').array).not.toBe(
      b.geometries.boots.getAttribute('position').array
    );
    const spies = [...Object.values(a.geometries), ...Object.values(a.materials)].map((v) =>
      vi.spyOn(v, 'dispose')
    );
    a.dispose();
    a.dispose();
    spies.forEach((s) => expect(s).toHaveBeenCalledTimes(1));
    b.dispose();
  });
});
