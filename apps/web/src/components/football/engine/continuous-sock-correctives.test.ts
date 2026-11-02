import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { createContinuousKit } from './continuous-kit';
import { createContinuousSockCorrectives } from './continuous-sock-correctives';
import { createRig, kitFromClub, type Look } from './rig';

async function fixture() {
  const raw = readFileSync('public/models/football/continuous-body.glb'),
    gltf = await new GLTFLoader().parseAsync(Uint8Array.from(raw).buffer, '');
  let body!: THREE.BufferGeometry;
  gltf.scene.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) body = object.geometry;
  });
  const look = {
      skin: '#b97c57',
      kit: kitFromClub({ primary: '#7a253d', secondary: '#eee9e2', pattern: 'solid' }),
    } as Look,
    kit = createContinuousKit(look, body),
    material = new THREE.MeshStandardMaterial(),
    rig = createRig(material, new THREE.BufferGeometry()),
    source = kit.geometries.socks,
    mesh = new THREE.SkinnedMesh(source, kit.materials.socks);
  rig.root.add(mesh);
  mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
  const adapter = createContinuousSockCorrectives(mesh, rig);
  return {
    source,
    mesh,
    rig,
    adapter,
    dispose() {
      adapter.dispose();
      mesh.removeFromParent();
      rig.dispose();
      material.dispose();
      kit.dispose();
      body.dispose();
    },
  };
}
function posed(mesh: THREE.SkinnedMesh, attribute: THREE.BufferAttribute) {
  return Array.from({ length: attribute.count }, (_, i) =>
    mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(attribute, i))
  );
}
function curvature(points: THREE.Vector3[], source: THREE.BufferAttribute) {
  let error = 0;
  for (let start = 0; start < source.count; start += 33) {
    if (source.getY(start) < 0.4 - 1e-6) continue;
    for (let j = 0; j < 32; j++) {
      const mean = points[start + ((j + 31) % 32)]
        .clone()
        .add(points[start + ((j + 1) % 32)])
        .multiplyScalar(0.5);
      error += points[start + j].distanceToSquared(mean);
    }
  }
  return error;
}
describe('continuous sock cuff pose corrective', () => {
  it('rounds the fitted cuff rings at 120 degrees with bounded displacement and unchanged authority', async () => {
    const f = await fixture(),
      sourcePosition = f.source.getAttribute('position') as THREE.BufferAttribute,
      original = Array.from(sourcePosition.array),
      neutral = Array.from(f.mesh.geometry.getAttribute('position').array),
      bindings = ['skinIndex', 'skinWeight'].map((name) =>
        Array.from(f.source.getAttribute(name).array)
      );
    f.rig.bones.lowerLegL.rotation.x = (2 * Math.PI) / 3;
    f.rig.bones.lowerLegR.rotation.x = (2 * Math.PI) / 3;
    const bones = f.rig.skeleton.bones.map(
      (bone) => [bone.position.clone(), bone.quaternion.clone()] as const
    );
    f.rig.root.updateWorldMatrix(true, true);
    const before = posed(f.mesh, sourcePosition);
    f.adapter.update();
    const p = f.mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
      after = posed(f.mesh, p),
      normals = f.mesh.geometry.getAttribute('normal');
    expect(f.adapter.ringCount).toBe(10);
    expect(curvature(after, sourcePosition)).toBeLessThan(curvature(before, sourcePosition) * 0.8);
    let maximum = 0,
      inversions = 0;
    for (let i = 0; i < p.count; i++) {
      maximum = Math.max(maximum, before[i].distanceTo(after[i]));
      expect([p.getX(i), p.getY(i), p.getZ(i)].every(Number.isFinite)).toBe(true);
      expect(new THREE.Vector3().fromBufferAttribute(normals, i).length()).toBeCloseTo(1, 5);
      const weight = f.mesh.geometry.getAttribute('skinWeight');
      expect(weight.getX(i) + weight.getY(i) + weight.getZ(i) + weight.getW(i)).toBeCloseTo(1, 5);
      for (let k = 0; k < 4; k++) expect(weight.getComponent(i, k)).toBeGreaterThanOrEqual(0);
      if (sourcePosition.getY(i) < 0.4 - 1e-6)
        expect(Array.from(p.array.slice(i * 3, i * 3 + 3))).toEqual(
          neutral.slice(i * 3, i * 3 + 3)
        );
    }
    for (let start = 0; start < p.count; start += 33) {
      expect(p.getX(start)).toBe(p.getX(start + 32));
      expect(p.getY(start)).toBe(p.getY(start + 32));
      expect(p.getZ(start)).toBe(p.getZ(start + 32));
      for (let k = 0; k < 3; k++)
        expect(normals.getComponent(start, k)).toBe(normals.getComponent(start + 32, k));
    }
    const index = f.mesh.geometry.index!;
    for (let k = 0; k < index.count; k += 3) {
      const ids = [index.getX(k), index.getX(k + 1), index.getX(k + 2)],
        oldNormal = new THREE.Vector3()
          .subVectors(before[ids[1]], before[ids[0]])
          .cross(new THREE.Vector3().subVectors(before[ids[2]], before[ids[0]])),
        newNormal = new THREE.Vector3()
          .subVectors(after[ids[1]], after[ids[0]])
          .cross(new THREE.Vector3().subVectors(after[ids[2]], after[ids[0]]));
      if (oldNormal.dot(newNormal) <= 0) inversions++;
    }
    console.log({
      sockCuff120Degrees: {
        maximum,
        inversions,
        limitation: 'Sampled pose and orientation only; no triangle collision clearance claim.',
      },
    });
    expect(inversions).toBe(0);
    expect(maximum).toBeLessThanOrEqual(0.0150001);
    expect(f.mesh.geometry.userData.sockCorrective.skippedSingularVertices).toBe(0);
    expect(Array.from(sourcePosition.array)).toEqual(original);
    ['skinIndex', 'skinWeight'].forEach((name, i) =>
      expect(Array.from(f.mesh.geometry.getAttribute(name).array)).toEqual(bindings[i])
    );
    bones.forEach(([position, quaternion], i) => {
      expect(f.rig.skeleton.bones[i].position.equals(position)).toBe(true);
      expect(f.rig.skeleton.bones[i].quaternion.equals(quaternion)).toBe(true);
    });
    f.dispose();
  });
  it('skips idle/repeated uploads, restores once on disable, and repeats exact random access', async () => {
    const f = await fixture(),
      p = f.mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
      n = f.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute,
      neutral = Array.from(p.array),
      normal = Array.from(n.array),
      initial = [p.version, n.version];
    for (let i = 0; i < 20; i++) {
      f.rig.bones.upperLegL.rotation.x = Math.sin(i) * 0.05;
      f.adapter.update();
      expect([p.version, n.version]).toEqual(initial);
    }
    f.rig.bones.lowerLegL.rotation.x = 2;
    f.adapter.update();
    const raised = Array.from(p.array),
      versions = [p.version, n.version];
    expect(raised).not.toEqual(neutral);
    f.adapter.update();
    expect([p.version, n.version]).toEqual(versions);
    f.adapter.update(false);
    expect(Array.from(p.array)).toEqual(neutral);
    expect(Array.from(n.array)).toEqual(normal);
    const reset = [p.version, n.version];
    f.adapter.update(false);
    expect([p.version, n.version]).toEqual(reset);
    f.adapter.update();
    expect(Array.from(p.array)).toEqual(raised);
    f.rig.bones.lowerLegL.quaternion.identity();
    f.adapter.update();
    expect(Array.from(p.array)).toEqual(neutral);
    expect(Array.from(n.array)).toEqual(normal);
    f.dispose();
  });
  it('owns stable private buffers and disposes once without disposing the source', async () => {
    const f = await fixture(),
      geometry = f.mesh.geometry,
      p = geometry.getAttribute('position'),
      array = p.array,
      dispose = vi.spyOn(geometry, 'dispose'),
      sourceDispose = vi.spyOn(f.source, 'dispose');
    expect(geometry).not.toBe(f.source);
    for (const angle of [1.2, 2, 0, 1.5]) {
      f.rig.bones.lowerLegL.rotation.x = angle;
      f.adapter.update();
      expect(f.mesh.geometry).toBe(geometry);
      expect(geometry.getAttribute('position')).toBe(p);
      expect(p.array).toBe(array);
    }
    f.adapter.dispose();
    f.adapter.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(sourceDispose).not.toHaveBeenCalled();
    expect(f.mesh.geometry).toBe(f.source);
    f.dispose();
  });
});
