import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { retargetHuman } from './human-model';
import { BONES, createRig, lookGeometry, kitFromClub } from './rig';
import { poseRun, poseIdle } from './poses';
import { spectatorGeometry } from './spectator';
import { poseFingers } from './player-appearance';
async function base() {
  const loader = new GLTFLoader();
  loader.register(() => ({
    name: 'TEST_TEXTURE',
    loadTexture: () => Promise.resolve(new THREE.Texture()),
  }));
  const gltf = await loader.parseAsync(
    Uint8Array.from(readFileSync('public/models/derby/jockey.glb')).buffer,
    ''
  );
  let mesh: THREE.SkinnedMesh | undefined;
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) mesh = o;
  });
  const facial = await loader.parseAsync(
    Uint8Array.from(readFileSync('public/models/football/face.glb')).buffer,
    ''
  );
  let face: THREE.BufferGeometry | undefined;
  facial.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) face = o.geometry;
  });
  return retargetHuman(mesh!, face!);
}
describe('anatomical football human', () => {
  it('retargets the shipped CC0 surface into normalized independent football skeletons', async () => {
    const b = await base(),
      g = b.geometry;
    expect(g.getIndex()!.count / 3).toBeGreaterThan(10000);
    expect(g.getIndex()!.count / 3).toBeLessThan(18000);
    const weights = g.getAttribute('skinWeight'),
      indices = g.getAttribute('skinIndex');
    for (let i = 0; i < weights.count; i++) {
      expect([0, 1, 2, 3].reduce((s, k) => s + weights.getComponent(i, k), 0)).toBeCloseTo(1, 5);
      for (let k = 0; k < 4; k++) expect(indices.getComponent(i, k)).toBeLessThan(BONES.length);
    }
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeGreaterThan(-0.06);
    expect(g.boundingBox!.max.y).toBeGreaterThan(1.7);
    expect(g.boundingBox!.max.x).toBeLessThan(0.5);
    const look = lookGeometry(
      {
        kit: kitFromClub({ primary: '#c8102e', secondary: '#ffffff', pattern: 'solid' }),
        skin: '#b67d55',
        hair: '#222222',
      },
      b
    );
    const a = createRig(new THREE.MeshBasicMaterial(), look.geometry),
      other = createRig(new THREE.MeshBasicMaterial(), look.geometry);
    poseIdle(other, 0);
    const before = other.bones.footL.matrixWorld.clone();
    for (let n = 0; n < 40; n++) {
      poseRun(a, n / 40, 6);
      a.root.updateMatrixWorld(true);
      a.skeleton.update();
      for (let i = 0; i < g.getAttribute('position').count; i += 79) {
        const v = a.mesh.getVertexPosition(i, new THREE.Vector3());
        expect(v.toArray().every(Number.isFinite)).toBe(true);
        expect(v.length()).toBeLessThan(3);
      }
    }
    expect(other.bones.footL.matrixWorld.equals(before)).toBe(true);
    a.dispose();
    other.dispose();
    look.dispose();
    g.dispose();
  });
  it('articulates real weighted finger surfaces without moving the hand contact or another rig', async () => {
    const b = await base(), material = new THREE.MeshBasicMaterial();
    const a = createRig(material, b.geometry), other = createRig(material, b.geometry);
    const skin = b.geometry.getAttribute('skinIndex'), weights = b.geometry.getAttribute('skinWeight');
    const fingerVertices: number[] = [];
    for (let i = 0; i < skin.count; i++)
      if ([0, 1, 2, 3].some(k => weights.getComponent(i, k) > .5 && /^(index|middle|ring|pinky|thumb)/.test(BONES[skin.getComponent(i, k)]))) fingerVertices.push(i);
    expect(fingerVertices.length).toBeGreaterThan(100);
    poseIdle(other, 0); other.root.updateMatrixWorld(true);
    const independent = other.bones.handL.matrixWorld.clone();
    for (const scale of [.96, 1.04]) for (const direction of [-1, 1]) {
      a.root.scale.setScalar(scale); a.root.rotation.y = direction * Math.PI / 2;
      poseRun(a, .37, 5); poseFingers(a, 'run', true, [0, 0, 0]);
      a.root.updateMatrixWorld(true); a.skeleton.update();
      const palms = (['handL', 'handR'] as const).map(name => a.bones[name].matrixWorld.clone());
      const before = fingerVertices.map(i => a.mesh.getVertexPosition(i, new THREE.Vector3()));
      poseFingers(a, 'celebrate', true, [.8, .8, .12]);
      a.root.updateMatrixWorld(true); a.skeleton.update();
      (['handL', 'handR'] as const).forEach((name, i) => expect(a.bones[name].matrixWorld.equals(palms[i])).toBe(true));
      const displacement = fingerVertices.map((i, k) => a.mesh.getVertexPosition(i, new THREE.Vector3()).distanceTo(before[k]));
      expect(Math.max(...displacement)).toBeGreaterThan(.01);
      expect(displacement.every(Number.isFinite)).toBe(true);
      expect(Math.max(...displacement)).toBeLessThan(.15);
      expect(other.bones.handL.matrixWorld.equals(independent)).toBe(true);
    }
    a.dispose(); other.dispose(); material.dispose(); b.geometry.dispose();
  });
  it('builds seated spectators with separated skin/clothing and bounded geometry', () => {
    const parts = spectatorGeometry();
    const triangles = Object.values(parts).reduce((sum, g) => sum + g.getIndex()!.count / 3, 0);
    expect(triangles).toBeLessThan(450);
    for (const g of Object.values(parts)) {
      g.computeBoundingBox();
      expect(g.boundingBox!.max.y).toBeLessThan(1);
      expect(Array.from(g.getAttribute('position').array).every(Number.isFinite)).toBe(true);
      g.dispose();
    }
  });
});
