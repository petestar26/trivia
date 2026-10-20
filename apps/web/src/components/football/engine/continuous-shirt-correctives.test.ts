import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, it, expect, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createRig, BONES } from './rig';
import { createContinuousShirtCorrectives } from './continuous-shirt-correctives';
import { poseIdle } from './poses';
import { applyReviewPlayerMotion } from './review-player-motion';

async function fixture() {
  const raw = readFileSync('public/models/football/continuous-jersey.glb');
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(raw).buffer, '');
  const source = (gltf.scene.getObjectByName('continuous-jersey') as THREE.SkinnedMesh).geometry;
  const material = new THREE.MeshStandardMaterial(),
    rig = createRig(material, new THREE.BufferGeometry());
  const mesh = new THREE.SkinnedMesh(source, material);
  rig.root.add(mesh);
  mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
  return {
    source,
    material,
    rig,
    mesh,
    dispose() {
      source.dispose();
      material.dispose();
      rig.dispose();
    },
  };
}
describe('preferred shirt original shoulder corrective', () => {
  it('retains source UV corners and records original fitted cuff/collar edge construction', async () => {
    const f = await fixture(),
      originalCount = f.source.getAttribute('position').count,
      adapter = createContinuousShirtCorrectives(f.mesh, f.rig),
      g = f.mesh.geometry,
      p = g.getAttribute('position'),
      w = g.getAttribute('skinWeight');
    expect(g.userData.garmentTailoring.originalVertices).toBe(originalCount);
    expect(g.userData.garmentTailoring.originalSourceVerticesRetained).toBe(true);
    expect(g.userData.garmentTailoring.derived.length).toBeGreaterThan(100);
    expect(p.count).toBeGreaterThan(originalCount);
    for (let i = 0; i < p.count; i++) {
      expect(w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i)).toBeCloseTo(1, 5);
      expect([p.getX(i), p.getY(i), p.getZ(i)].every(Number.isFinite)).toBe(true);
      if (i < originalCount) {
        expect(g.getAttribute('uv').getX(i)).toBe(f.source.getAttribute('uv').getX(i));
        expect(g.getAttribute('uv').getY(i)).toBe(f.source.getAttribute('uv').getY(i));
      }
    }
    const original = f.source.getAttribute('position');
    const reconstructed: THREE.Vector3[] = Array.from({ length: originalCount }, (_, i) =>
      new THREE.Vector3()
        .fromBufferAttribute(original, i)
        .add(new THREE.Vector3().fromArray(g.userData.garmentTailoring.originalPositionDeltas[i]))
    );
    for (const record of g.userData.garmentTailoring.derived) {
      const point = new THREE.Vector3().fromArray(record.positionOffset);
      record.positionSourceVertices.forEach((id: number, k: number) =>
        point.addScaledVector(reconstructed[id], record.positionCoefficients[k])
      );
      reconstructed[record.vertex] = point;
      expect(
        point.distanceTo(new THREE.Vector3().fromBufferAttribute(p, record.vertex))
      ).toBeLessThan(2e-7);
      const uv = g.getAttribute('uv');
      for (let k = 0; k < 2; k++) {
        const expected = record.linearUVWeightSourceVertices.reduce(
          (sum: number, id: number, at: number) =>
            sum + uv.getComponent(id, k) * record.linearUVWeightCoefficients[at],
          0
        );
        expect(uv.getComponent(record.vertex, k)).toBeCloseTo(expected, 6);
      }
    }
    let beforeRadius = 0,
      afterRadius = 0,
      count = 0;
    for (let i = 0; i < originalCount; i++)
      if (original.getY(i) > 1.24 && original.getY(i) < 1.26 && Math.abs(original.getX(i)) > 0.12) {
        const centre = original.getX(i) > 0 ? 0.195 : -0.195;
        beforeRadius += Math.hypot(original.getX(i) - centre, original.getZ(i));
        afterRadius += Math.hypot(p.getX(i) - centre, p.getZ(i));
        count++;
      }
    expect(count).toBeGreaterThan(15);
    expect(afterRadius / beforeRadius).toBeCloseTo(1, 6);
    adapter.dispose();
    f.dispose();
  });
  it('rounds raised caps with bounded private geometry while pinning collar and all bones', async () => {
    const f = await fixture(),
      original = new Float32Array(f.source.getAttribute('position').array),
      adapter = createContinuousShirtCorrectives(f.mesh, f.rig),
      source = new Float32Array(f.mesh.geometry.getAttribute('position').array);
    f.rig.bones.upperArmL.rotation.z = Math.PI / 2;
    f.rig.bones.upperArmR.rotation.z = -Math.PI / 2;
    const bones = f.rig.skeleton.bones.map((b) => ({
      p: b.position.clone(),
      q: b.quaternion.clone(),
    }));
    adapter.update();
    const g = f.mesh.geometry,
      p = g.getAttribute('position') as THREE.BufferAttribute;
    let changed = 0;
    expect(g).not.toBe(f.source);
    expect(adapter.sampleCount).toBeGreaterThan(100);
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(source[i * 3]) < 0.1 && source[i * 3 + 1] > 1.43) {
        expect(p.getX(i)).toBe(source[i * 3]);
        expect(p.getY(i)).toBe(source[i * 3 + 1]);
        expect(p.getZ(i)).toBe(source[i * 3 + 2]);
      }
      if (
        Math.hypot(
          p.getX(i) - source[i * 3],
          p.getY(i) - source[i * 3 + 1],
          p.getZ(i) - source[i * 3 + 2]
        ) > 0.0001
      )
        changed++;
    }
    expect(changed).toBeGreaterThan(100);
    expect(g.userData.shirtCorrective.maxPosedDisplacementMetres).toBeLessThanOrEqual(0.04500001);
    bones.forEach((b, i) => {
      expect(f.rig.skeleton.bones[i].position.equals(b.p)).toBe(true);
      expect(f.rig.skeleton.bones[i].quaternion.equals(b.q)).toBe(true);
    });
    expect(Array.from(f.source.getAttribute('position').array)).toEqual(Array.from(original));
    const beforePoints: THREE.Vector3[] = [],
      afterPoints: THREE.Vector3[] = [],
      peers = Array.from({ length: p.count }, () => new Set<number>());
    for (let i = 0; i < p.count; i++) {
      const before = new THREE.Vector3(source[i * 3], source[i * 3 + 1], source[i * 3 + 2]),
        after = new THREE.Vector3().fromBufferAttribute(p, i);
      f.mesh.applyBoneTransform(i, before);
      f.mesh.applyBoneTransform(i, after);
      beforePoints.push(before);
      afterPoints.push(after);
    }
    for (let k = 0; k < g.index!.count; k += 3) {
      const tri = [g.index!.getX(k), g.index!.getX(k + 1), g.index!.getX(k + 2)];
      for (let j = 0; j < 3; j++) {
        peers[tri[j]].add(tri[(j + 1) % 3]);
        peers[tri[(j + 1) % 3]].add(tri[j]);
      }
    }
    let beforeError = 0,
      afterError = 0,
      count = 0;
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(source[i * 3]) < 0.15 || source[i * 3 + 1] < 1.34 || !peers[i].size) continue;
      const beforeMean = new THREE.Vector3(),
        afterMean = new THREE.Vector3();
      for (const j of peers[i]) {
        beforeMean.add(beforePoints[j]);
        afterMean.add(afterPoints[j]);
      }
      beforeMean.multiplyScalar(1 / peers[i].size);
      afterMean.multiplyScalar(1 / peers[i].size);
      beforeError += beforeMean.distanceToSquared(beforePoints[i]);
      afterError += afterMean.distanceToSquared(afterPoints[i]);
      count++;
    }
    expect(count).toBeGreaterThan(50);
    expect(afterError).toBeLessThan(beforeError * 0.85);
    const version = p.version;
    adapter.update();
    expect(p.version).toBe(version);
    const ownedDispose = vi.spyOn(g, 'dispose'),
      sourceDispose = vi.spyOn(f.source, 'dispose');
    adapter.dispose();
    adapter.dispose();
    expect(ownedDispose).toHaveBeenCalledTimes(1);
    expect(sourceDispose).not.toHaveBeenCalled();
    expect(f.mesh.geometry).toBe(f.source);
    f.dispose();
  });
  it('leaves idle breathing buffers untouched and resets once after raised arms', async () => {
    const f = await fixture(),
      adapter = createContinuousShirtCorrectives(f.mesh, f.rig);
    const p = f.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = f.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const neutral = Array.from(p.array),
      neutralNormals = Array.from(n.array);
    let maxAngle = 0;
    const idle = (time: number) => {
      poseIdle(f.rig, time, 0.37);
      applyReviewPlayerMotion(f.rig, { kind: 'idle', time, phase: 0, speed: 0 });
      adapter.update();
    };
    const sweep = () => {
      const pv = p.version,
        nv = n.version;
      for (let step = 0; step <= 400; step++) {
        idle(step / 20);
        for (const side of ['L', 'R'] as const) {
          const direction = new THREE.Vector3(0, -1, 0).applyQuaternion(
            f.rig.bones[`upperArm${side}`].quaternion
          );
          maxAngle = Math.max(maxAngle, Math.acos(THREE.MathUtils.clamp(-direction.y, -1, 1)));
        }
        expect(p.version).toBe(pv);
        expect(n.version).toBe(nv);
      }
    };
    sweep();
    expect(maxAngle).toBeLessThan(0.26);
    f.rig.bones.upperArmL.rotation.z = 1.3;
    adapter.update();
    expect(Array.from(p.array)).not.toEqual(neutral);
    idle(0);
    expect(Array.from(p.array)).toEqual(neutral);
    expect(Array.from(n.array)).toEqual(neutralNormals);
    sweep();
    adapter.dispose();
    f.dispose();
  });
  it('restores exact source for neutral/reduced motion and gives repeatable random access', async () => {
    const f = await fixture(),
      adapter = createContinuousShirtCorrectives(f.mesh, f.rig);
    const neutral = Array.from(f.mesh.geometry.getAttribute('position').array);
    f.rig.bones.upperArmL.rotation.z = 1.3;
    adapter.update();
    const raised = Array.from(f.mesh.geometry.getAttribute('position').array);
    f.rig.bones.upperArmL.quaternion.identity();
    adapter.update();
    expect(Array.from(f.mesh.geometry.getAttribute('position').array)).toEqual(neutral);
    f.rig.bones.upperArmL.rotation.z = 1.3;
    adapter.update();
    expect(Array.from(f.mesh.geometry.getAttribute('position').array)).toEqual(raised);
    const joints = f.mesh.geometry.getAttribute('skinIndex');
    for (let i = 0; i < joints.count; i++)
      for (let k = 0; k < 4; k++) expect(joints.getComponent(i, k)).toBeLessThan(BONES.length);
    adapter.dispose();
    f.dispose();
  });
});
