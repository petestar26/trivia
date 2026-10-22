import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { createContinuousKit } from './continuous-kit';
import { BONES, createRig, kitFromClub, type Look } from './rig';

const look: Look = {
  skin: '#b97c57',
  hair: '#241d19',
  kit: kitFromClub({ primary: '#7a253d', secondary: '#14151a', pattern: 'solid' }),
};

describe('anatomical returned sock cuffs', () => {
  it('fits both source leg sections and follows their field under deep flexion without changing the shaft or boots', async () => {
    const gltf = await new GLTFLoader().parseAsync(
      Uint8Array.from(readFileSync('public/models/football/continuous-body.glb')).buffer,
      ''
    );
    const anatomy = (gltf.scene.getObjectByName('continuous-body') as THREE.SkinnedMesh).geometry,
      before = anatomy.clone(),
      kit = createContinuousKit(look, anatomy),
      legacy = createContinuousKit(look),
      g = kit.geometries.socks,
      p = g.getAttribute('position'),
      j = g.getAttribute('skinIndex'),
      w = g.getAttribute('skinWeight'),
      bp = anatomy.getAttribute('position'),
      bj = anatomy.getAttribute('skinIndex'),
      bw = anatomy.getAttribute('skinWeight'),
      oldP = legacy.geometries.socks.getAttribute('position'),
      oldJ = legacy.geometries.socks.getAttribute('skinIndex'),
      oldW = legacy.geometries.socks.getAttribute('skinWeight'),
      records = g.userData.garmentFit.records as {
        vertex: number;
        sourceTriangle: number[];
        barycentric: number[];
      }[];
    expect(records.length).toBe(264);
    for (const name of ['position', 'skinIndex', 'skinWeight'])
      expect(Array.from(anatomy.getAttribute(name).array)).toEqual(
        Array.from(before.getAttribute(name).array)
      );
    expect(Array.from(kit.geometries.boots.getAttribute('position').array)).toEqual(
      Array.from(legacy.geometries.boots.getAttribute('position').array)
    );
    for (let i = 0; i < p.count; i++) {
      if (oldP.getY(i) <= 0.4) {
        for (let c = 0; c < 3; c++) expect(p.getComponent(i, c)).toBe(oldP.getComponent(i, c));
        for (let c = 0; c < 4; c++) {
          expect(j.getComponent(i, c)).toBe(oldJ.getComponent(i, c));
          expect(w.getComponent(i, c)).toBe(oldW.getComponent(i, c));
        }
      }
      if (i % 33 === 0) {
        for (let c = 0; c < 3; c++)
          expect(p.getComponent(i, c)).toBeCloseTo(p.getComponent(i + 32, c), 7);
        for (let c = 0; c < 4; c++) {
          expect(j.getComponent(i, c)).toBe(j.getComponent(i + 32, c));
          expect(w.getComponent(i, c)).toBe(w.getComponent(i + 32, c));
        }
      }
    }
    const surfacePoint = new THREE.Vector3(),
      scratch = new THREE.Vector3();
    for (const record of records) {
      surfacePoint.set(0, 0, 0);
      const merged = new Map<number, number>();
      record.sourceTriangle.forEach((id, n) => {
        surfacePoint.addScaledVector(scratch.fromBufferAttribute(bp, id), record.barycentric[n]);
        for (let c = 0; c < 4; c++) {
          const joint = bj.getComponent(id, c);
          merged.set(
            joint,
            (merged.get(joint) ?? 0) + bw.getComponent(id, c) * record.barycentric[n]
          );
        }
      });
      const gap = scratch.fromBufferAttribute(p, record.vertex).distanceTo(surfacePoint);
      expect(gap).toBeGreaterThan(0.0054);
      expect(gap).toBeLessThan(0.0096);
      const selected = [...merged.entries()]
          .filter(([, mass]) => mass > 1e-8)
          .sort((a, b) => b[1] - a[1] || a[0] - b[0])
          .slice(0, 4),
        total = selected.reduce((sum, [, mass]) => sum + mass, 0);
      let normalized = 0,
        sameLegMass = 0;
      for (let c = 0; c < 4; c++) {
        const mass = w.getComponent(record.vertex, c),
          bone = BONES[j.getComponent(record.vertex, c)];
        expect(mass).toBeGreaterThanOrEqual(0);
        normalized += mass;
        if (/Leg/.test(bone) && bone.endsWith(p.getX(record.vertex) > 0 ? 'L' : 'R'))
          sameLegMass += mass;
        if (c < selected.length) {
          expect(j.getComponent(record.vertex, c)).toBe(selected[c][0]);
          expect(mass).toBeCloseTo(selected[c][1] / total, 6);
        }
      }
      expect(normalized).toBeCloseTo(1, 6);
      // Two retained source vertices carry 0.5% opposite-leg mass. Preserve
      // their exact field above while requiring the selected leg to dominate.
      expect(sameLegMass).toBeGreaterThan(0.99);
    }
    const material = new THREE.MeshStandardMaterial(),
      rig = createRig(material, new THREE.BufferGeometry()),
      skin = new THREE.SkinnedMesh(anatomy, material),
      cuff = new THREE.SkinnedMesh(g, kit.materials.socks),
      oldCuff = new THREE.SkinnedMesh(legacy.geometries.socks, legacy.materials.socks);
    rig.root.add(skin, cuff, oldCuff);
    for (const mesh of [skin, cuff, oldCuff]) mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
    const report = [];
    for (const side of ['L', 'R'] as const)
      for (const angle of [0.6, 1.2, 2]) {
        rig.bones.lowerLegL.quaternion.identity();
        rig.bones.lowerLegR.quaternion.identity();
        rig.bones[`lowerLeg${side}`].rotation.x = angle;
        rig.root.updateMatrixWorld(true);
        rig.skeleton.update();
        let fitted = 0,
          rigid = 0,
          count = 0;
        for (const record of records) {
          if (p.getX(record.vertex) > 0 !== (side === 'L')) continue;
          surfacePoint.set(0, 0, 0);
          record.sourceTriangle.forEach((id, n) => {
            scratch.fromBufferAttribute(bp, id);
            skin.applyBoneTransform(id, scratch);
            surfacePoint.addScaledVector(scratch, record.barycentric[n]);
          });
          scratch.fromBufferAttribute(p, record.vertex);
          cuff.applyBoneTransform(record.vertex, scratch);
          fitted += scratch.distanceTo(surfacePoint);
          scratch.fromBufferAttribute(oldP, record.vertex);
          oldCuff.applyBoneTransform(record.vertex, scratch);
          rigid += scratch.distanceTo(surfacePoint);
          count++;
        }
        expect(fitted / count).toBeLessThan(rigid / count);
        report.push({
          side,
          kneeRadians: angle,
          fittedMeanMetres: fitted / count,
          rigidMeanMetres: rigid / count,
        });
      }
    console.log(
      'sock source-field fit (excludes body hinge-volume correction and full collision)',
      report
    );
    skin.removeFromParent();
    cuff.removeFromParent();
    oldCuff.removeFromParent();
    rig.dispose();
    material.dispose();
    kit.dispose();
    legacy.dispose();
    before.dispose();
    anatomy.dispose();
  });
});
