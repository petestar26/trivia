import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, it, expect, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createRig, BONES } from './rig';
import { createContinuousShirtCorrectives } from './continuous-shirt-correctives';

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
  it('rounds raised caps with bounded private geometry while pinning collar and all bones', async () => {
    const f = await fixture(),
      source = new Float32Array(f.source.getAttribute('position').array),
      adapter = createContinuousShirtCorrectives(f.mesh, f.rig);
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
    expect(Array.from(f.source.getAttribute('position').array)).toEqual(Array.from(source));
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
  it('restores exact source for neutral/reduced motion and gives repeatable random access', async () => {
    const f = await fixture(),
      adapter = createContinuousShirtCorrectives(f.mesh, f.rig);
    f.rig.bones.upperArmL.rotation.z = 1.3;
    adapter.update();
    const raised = Array.from(f.mesh.geometry.getAttribute('position').array);
    f.rig.bones.upperArmL.quaternion.identity();
    adapter.update();
    expect(Array.from(f.mesh.geometry.getAttribute('position').array)).toEqual(
      Array.from(f.source.getAttribute('position').array)
    );
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
