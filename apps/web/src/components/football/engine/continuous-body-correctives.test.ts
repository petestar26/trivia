import { describe, expect, it } from 'vitest';
import { hingeVolumeScale } from './continuous-body-correctives';

describe('bounded hinge volume inverse', () => {
  it('leaves neutral and rigid endpoints exact', () => {
    for (const w of [0, 0.25, 0.5, 0.75, 1]) expect(hingeVolumeScale(0, w)).toBe(1);
    for (const angle of [0, 1, 2, Math.PI]) {
      expect(hingeVolumeScale(angle, 0)).toBe(1);
      expect(hingeVolumeScale(angle, 1)).toBe(1);
    }
  });
  it('restores blended transverse length before the extreme guard', () => {
    for (const w of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const angle = Math.PI / 2;
      const shrink = Math.sqrt(1 - 4 * w * (1 - w) * Math.sin(angle / 2) ** 2);
      expect(hingeVolumeScale(angle, w) * shrink).toBeCloseTo(1, 12);
    }
  });
  it('is symmetric and bounded through the singular fold', () => {
    for (let i = 0; i <= 100; i++) {
      const w = i / 100;
      expect(hingeVolumeScale(Math.PI, w)).toBeCloseTo(hingeVolumeScale(Math.PI, 1 - w), 12);
      expect(hingeVolumeScale(Math.PI, w)).toBeLessThanOrEqual(1.8);
    }
  });
});

import * as THREE from 'three';
import { createContinuousBodyCorrectives } from './continuous-body-correctives';

it('owns private buffers, preserves seam/morphs and restores neutral on random access', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0.03, 0.02, 0, 0.03, 0, 1.53, 0], 3)
  );
  geometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0.2, 0.9, 0.1], 3)
  );
  geometry.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0], 4)
  );
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0], 4)
  );
  geometry.morphAttributes.position = [
    new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0.001, 0, 0], 3),
  ];
  const bones = ['upperArmL', 'foreArmL', 'handL'].map((name) => {
    const b = new THREE.Bone();
    b.name = name;
    return b;
  });
  const skeleton = new THREE.Skeleton(bones, [
    new THREE.Matrix4(),
    new THREE.Matrix4(),
    new THREE.Matrix4().makeTranslation(0, 0.3, 0),
  ]);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.bind(skeleton, new THREE.Matrix4());
  const corrective = createContinuousBodyCorrectives(mesh);
  expect(corrective.sampleCount).toBe(2);
  bones[1].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (Math.PI * 2) / 3);
  const pose = bones[1].quaternion.clone();
  corrective.update();
  expect(mesh.geometry.getAttribute('position').getZ(0)).toBeGreaterThan(0.03);
  expect(geometry.getAttribute('position').getZ(0)).toBeCloseTo(0.03);
  expect(mesh.geometry.getAttribute('position').getY(2)).toBeCloseTo(1.53);
  expect(mesh.geometry.getAttribute('normal').getX(2)).toBeCloseTo(0.2);
  expect(mesh.geometry.morphAttributes.position![0].array).toEqual(
    geometry.morphAttributes.position![0].array
  );
  expect(bones[1].quaternion.equals(pose)).toBe(true);
  bones[1].quaternion.identity();
  corrective.update();
  expect(mesh.geometry.getAttribute('position').array).toEqual(
    geometry.getAttribute('position').array
  );
  const owned = mesh.geometry;
  let disposals = 0;
  owned.addEventListener('dispose', () => {
    disposals++;
  });
  const version = (owned.getAttribute('position') as THREE.BufferAttribute).version;
  corrective.update();
  expect((owned.getAttribute('position') as THREE.BufferAttribute).version).toBe(version);
  corrective.dispose();
  corrective.dispose();
  corrective.update();
  expect(disposals).toBe(1);
  expect(mesh.geometry).toBe(geometry);
});

it('restores actual skinned hinge section area at 60/90 and bounds 120-degree correction', () => {
  const count = 32,
    radius = 0.03;
  const positions = Array.from({ length: count }, (_, i) => [
    radius * Math.cos((i * 2 * Math.PI) / count),
    0,
    radius * Math.sin((i * 2 * Math.PI) / count),
  ]).flat();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute(Array.from({ length: count }, () => [0, 1, 0, 0]).flat(), 4)
  );
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute(
      Array.from({ length: count }, () => [0.5, 0.5, 0, 0]).flat(),
      4
    )
  );
  const bones = ['upperArmL', 'foreArmL', 'handL'].map((name) => {
    const b = new THREE.Bone();
    b.name = name;
    return b;
  });
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.bind(
    new THREE.Skeleton(bones, [
      new THREE.Matrix4(),
      new THREE.Matrix4(),
      new THREE.Matrix4().makeTranslation(0, -0.3, 0),
    ]),
    new THREE.Matrix4()
  );
  const corrective = createContinuousBodyCorrectives(mesh);
  function area(corrected: boolean) {
    const attribute = (corrected ? mesh.geometry : geometry).getAttribute('position');
    const points = Array.from({ length: count }, (_, i) =>
      mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(attribute, i))
    );
    const sum = new THREE.Vector3();
    points.forEach((p, i) => sum.add(new THREE.Vector3().crossVectors(p, points[(i + 1) % count])));
    return sum.length() * 0.5;
  }
  bones.forEach((b) => b.updateMatrixWorld(true));
  mesh.skeleton.update();
  const neutral = area(false);
  for (const degrees of [60, 90, 120]) {
    bones[1].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (degrees * Math.PI) / 180);
    bones.forEach((b) => b.updateMatrixWorld(true));
    mesh.skeleton.update();
    corrective.update();
    const before = area(false) / neutral,
      after = area(true) / neutral;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(degrees === 120 ? 0.9 : 1, 5);
  }
});

it('keeps a bent UV seam continuous and updates its incident normal halo without moving the rig', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        0, 0, 0.03, 0.04, 0, 0.03, 0, 0.12, 0.03, 0, 0, 0.03, -0.04, 0, 0.02, 0, -0.12, 0.03, 0,
        1.53, 0, 0.01, 1.53, 0, 0, 1.54, 0,
      ],
      3
    )
  );
  geometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(
      [
        ...Array.from({ length: 6 }, () => [0, 0, 1]).flat(),
        0.2,
        0.9,
        0.1,
        0.2,
        0.9,
        0.1,
        0.2,
        0.9,
        0.1,
      ],
      3
    )
  );
  geometry.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute(Array.from({ length: 9 }, () => [0, 1, 0, 0]).flat(), 4)
  );
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute(
      Array.from({ length: 9 }, (_, i) =>
        i === 0 || i === 3 ? [0.5, 0.5, 0, 0] : [1, 0, 0, 0]
      ).flat(),
      4
    )
  );
  geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const bones = ['upperArmL', 'foreArmL', 'handL'].map((name) => {
    const bone = new THREE.Bone();
    bone.name = name;
    return bone;
  });
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.bind(
    new THREE.Skeleton(bones, [
      new THREE.Matrix4(),
      new THREE.Matrix4(),
      new THREE.Matrix4().makeTranslation(0, 0.3, 0),
    ]),
    new THREE.Matrix4()
  );
  const corrective = createContinuousBodyCorrectives(mesh);
  bones[1].rotation.x = 1.2;
  const pose = bones.map((b) => b.quaternion.toArray());
  corrective.update();
  const normal = mesh.geometry.getAttribute('normal');
  expect(
    new THREE.Vector3()
      .fromBufferAttribute(normal, 0)
      .distanceTo(new THREE.Vector3().fromBufferAttribute(normal, 3))
  ).toBeLessThan(1e-7);
  const p = mesh.geometry.getAttribute('position');
  const a = new THREE.Vector3().fromBufferAttribute(p, 0),
    b = new THREE.Vector3().fromBufferAttribute(p, 1),
    c = new THREE.Vector3().fromBufferAttribute(p, 2);
  const face = b.sub(a).cross(c.sub(a)).normalize();
  expect(new THREE.Vector3().fromBufferAttribute(normal, 2).distanceTo(face)).toBeLessThan(1e-7);
  expect(normal.getX(6)).toBe(geometry.getAttribute('normal').getX(6));
  expect(bones.map((b) => b.quaternion.toArray())).toEqual(pose);
  expect(geometry.getAttribute('position').getZ(0)).toBeCloseTo(0.03);
  bones[1].quaternion.identity();
  corrective.update();
  expect(mesh.geometry.getAttribute('position').array).toEqual(
    geometry.getAttribute('position').array
  );
  expect(mesh.geometry.getAttribute('normal').array).toEqual(geometry.getAttribute('normal').array);
  corrective.dispose();
  geometry.dispose();
  (mesh.material as THREE.Material).dispose();
});
