import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachContinuousPlayer, type ContinuousPlayerAssets } from './continuous-player';
import * as kit from './continuous-kit';
import { createRig, humanGeometry, type Look } from './rig';
import type { HeadVisual } from './player-appearance';
import type { ReviewPlayerAssets } from './review-player';

const parsed: GLTF[] = [];
let assets: ContinuousPlayerAssets;
beforeAll(async () => {
  const load = async (part: 'body' | 'jersey') => {
    const gltf = await new GLTFLoader().parseAsync(
      Uint8Array.from(readFileSync(`public/models/football/continuous-${part}.glb`)).buffer,
      ''
    );
    parsed.push(gltf);
    const mesh = gltf.scene.getObjectByName(`continuous-${part}`) as THREE.SkinnedMesh;
    // Match loadContinuousPlayerAssets' accepted morph-name adapter.
    if (part === 'body') mesh.geometry.userData.morphNames = { ...mesh.morphTargetDictionary };
    return mesh.geometry;
  };
  assets = { body: await load('body'), jersey: await load('jersey'), dispose() {} };
});
afterAll(() => {
  const owned = new Set<{ dispose(): void }>();
  for (const gltf of parsed)
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        owned.add(o.geometry);
        for (const material of Array.isArray(o.material) ? o.material : [o.material])
          owned.add(material);
      }
      if (o instanceof THREE.SkinnedMesh) owned.add(o.skeleton);
    });
  owned.forEach((o) => o.dispose());
});

function fixture() {
  const material = new THREE.MeshStandardMaterial(),
    source = humanGeometry();
  const rig = createRig(material, source.geometry);
  const texture = () => new THREE.CanvasTexture(document.createElement('canvas'));
  const skin = texture(),
    hairMap = texture(),
    browMap = texture(),
    environment = texture();
  const maps = {
    normal: texture(),
    roughness: texture(),
    dispose() {
      this.normal.dispose();
      this.roughness.dispose();
    },
  };
  const review: ReviewPlayerAssets = {
    head: assets.body,
    continuousHead: assets.body,
    hair: assets.body,
    brows: assets.body,
    skin,
    hairMap,
    browMap,
    environment,
    dispose() {},
  };
  // A real Three mesh supplies facial input to this adapter-level test. Full
  // head/detail/expression integration is independently covered by pool tests.
  const mesh = new THREE.SkinnedMesh(assets.body, material);
  mesh.morphTargetDictionary = { jawOpen: 2 };
  mesh.morphTargetInfluences = new Array(8).fill(0);
  const head: HeadVisual = { mesh, hair: mesh, setDetail() {}, animate() {}, dispose() {} };
  const look: Look = {
    skin: '#e9ba97',
    hair: '#241d19',
    kit: {
      primary: '#7a253d',
      secondary: '#d7b08b',
      shorts: '#181824',
      socks: '#7a253d',
      pattern: 'solid',
    },
  };
  const actor = attachContinuousPlayer(rig, source, look, material, assets, review, maps, head);
  return {
    actor,
    head,
    dispose() {
      actor.dispose();
      rig.dispose();
      material.dispose();
      maps.dispose();
      [skin, hairMap, browMap, environment].forEach((t) => t.dispose());
    },
  };
}

describe('continuous actor construction and detail work', () => {
  it('does not repeat deformation after an unchanged-detail selection in the same frame', () => {
    const boot = vi.spyOn(kit, 'syncContinuousBootFlex'),
      f = fixture();
    try {
      f.actor.setDetail('low');
      expect(boot).toHaveBeenCalledTimes(1);
      f.head.mesh.morphTargetInfluences![2] = 0.42;
      f.actor.syncFace(); // The released frame apply path still synchronizes the latest input.
      f.actor.setDetail('low'); // Production selects detail again after pose application.
      expect(boot).toHaveBeenCalledTimes(2);
      expect(f.actor.meshes.body.morphTargetInfluences![2]).toBe(0.42);
      expect(f.actor.meshes.lowBody.morphTargetInfluences![2]).toBe(0.42);
      expect(f.actor.meshes.lowBody.visible).toBe(true);
      f.head.mesh.morphTargetInfluences![2] = 0;
      f.actor.setDetail('mid'); // A real detail transition must restore this frame's face immediately.
      expect(boot).toHaveBeenCalledTimes(3);
      expect(f.actor.meshes.body.morphTargetInfluences![2]).toBe(0);
      expect(f.actor.meshes.body.visible).toBe(true);
      f.head.mesh.morphTargetInfluences![2] = 0.31;
      f.actor.setDetail('mid'); // Direct head animation must mirror at unchanged detail too.
      expect(f.actor.meshes.body.morphTargetInfluences![2]).toBe(0.31);
      expect(f.actor.meshes.lowBody.morphTargetInfluences![2]).toBe(0.31);
      expect(boot).toHaveBeenCalledTimes(3);
    } finally {
      f.dispose();
      boot.mockRestore();
    }
  });

  it('passes the untouched source body to construction-time kit fitting exactly once', () => {
    const build = vi.spyOn(kit, 'createContinuousKit');
    const before = assets.body.getAttribute('position').array.slice();
    const f = fixture();
    try {
      expect(build).toHaveBeenCalledTimes(1);
      expect(build.mock.calls[0][1] === assets.body).toBe(true);
      for (const detail of ['low', 'mid', 'high', 'low'] as const) {
        f.actor.setDetail(detail);
        f.actor.syncFace();
      }
      expect(build).toHaveBeenCalledTimes(1);
      expect(assets.body.getAttribute('position').array).toEqual(before);
    } finally {
      f.dispose();
      build.mockRestore();
    }
  });
});
