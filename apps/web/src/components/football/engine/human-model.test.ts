import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { retargetHuman } from './human-model';
import { BONES, createRig, lookGeometry, kitFromClub } from './rig';
import { poseRun, poseIdle } from './poses';
import { spectatorGeometry } from './spectator';
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
