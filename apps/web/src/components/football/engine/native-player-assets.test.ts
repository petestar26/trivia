import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  validateContinuousMesh,
  loadContinuousPlayerAssets,
  attachContinuousPlayer,
} from './continuous-player';
import {
  validateNativePlayer,
  nativePlayerContract,
  loadNativePlayerAssets,
} from './native-player-assets';
import {
  nativeCorrectiveAngle,
  nativeCorrectiveWeight,
  createNativePlayerCorrectives,
} from './native-player-correctives';
import { createAuthoredContinuousShirtSource } from './continuous-shirt-authoring';
import { createContinuousPlayerLod } from './continuous-player-lod';
import { BONES, createRig, humanGeometry, type Look } from './rig';
import type { HeadVisual } from './player-appearance';
import type { ReviewPlayerAssets } from './review-player';
import * as legacyBody from './continuous-body-correctives';
import * as legacyShirt from './continuous-shirt-correctives';
import * as legacySocks from './continuous-sock-correctives';
import * as kit from './continuous-kit';

const bytes = Uint8Array.from(readFileSync('public/models/football/native-player-v5.glb'));
const authored = JSON.parse(
  readFileSync('../../scripts/assets/native-player/deformation-authoring-source.json', 'utf8')
);
const loaded: GLTF[] = [];
async function parse(input = bytes) {
  const gltf = await new GLTFLoader().parseAsync(input.buffer, '');
  loaded.push(gltf);
  return gltf;
}
const mesh = (g: GLTF, name: string) => g.scene.getObjectByName(name) as THREE.SkinnedMesh;
let source: GLTF;
beforeAll(async () => {
  source = await parse();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => {
  const resources = new Set<{ dispose(): void }>();
  for (const g of loaded)
    g.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        resources.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => resources.add(m));
      }
      if (o instanceof THREE.SkinnedMesh) resources.add(o.skeleton);
    });
  resources.forEach((r) => r.dispose());
});

describe('pinned native source-ID export', () => {
  it('has exact 8-surface native baseline and canonical49 without preview helpers', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(nativePlayerContract.assetSHA256);
    const surfaces = validateNativePlayer(source, validateContinuousMesh);
    expect(surfaces.body.getAttribute('position').count).toBe(10212);
    const all = Object.entries(nativePlayerContract.surfaces);
    expect(all.reduce((s, [, v]) => s + v.vertices, 0)).toBe(25599);
    expect(all.reduce((s, [, v]) => s + v.triangles, 0)).toBe(34007);
    expect(source.animations).toEqual([]);
    expect(source.scene.children.filter((o) => o instanceof THREE.Bone)).toHaveLength(1);
    for (const [name] of all)
      expect(mesh(source, name).skeleton.bones.map((b) => b.name)).toEqual(BONES);
  });

  it('copies actual source weights, twelve native deltas and exact 660+66 sock UV/point mapping', () => {
    for (const [name, edits] of Object.entries(authored.weightEdits) as [string, any[]][]) {
      const g = mesh(source, name).geometry,
        joints = g.getAttribute('skinIndex'),
        weights = g.getAttribute('skinWeight');
      for (const row of edits) {
        const actual: Record<string, number> = {};
        for (let k = 0; k < 4; k++)
          if (weights.getComponent(row.vertex, k) > 0)
            actual[BONES[joints.getComponent(row.vertex, k)]] = weights.getComponent(row.vertex, k);
        expect(Object.keys(actual).sort()).toEqual(Object.keys(row.nativeReadback).sort());
        for (const [b, w] of Object.entries(row.nativeReadback))
          expect(actual[b]).toBeCloseTo(w as number, 7);
      }
    }
    expect(authored.correctives).toHaveLength(12);
    for (const c of authored.correctives) {
      const m = mesh(source, c.mesh),
        a = m.geometry.morphAttributes.position![m.morphTargetDictionary![c.name]];
      const expected = new Float32Array(a.count * 3);
      for (const row of c.deltas) {
        const [x, y, z] = row.deltaNative;
        expected.set([x, z, -y], row.vertex * 3);
      }
      expect(Array.from(a.array)).toEqual(Array.from(expected));
    }
    const top = authored.sockTopology,
      socks = mesh(source, 'niko-socks').geometry;
    expect(top.originalVertexMap).toHaveLength(660);
    expect(top.newVertices).toHaveLength(66);
    expect(Array.from(socks.index!.array)).toEqual(top.indices);
    expect(Array.from(socks.getAttribute('position').array)).toEqual(
      Array.from(new Float32Array(top.neutralPositionsRuntimeMetres.flat()))
    );
    expect(Array.from(socks.getAttribute('uv').array)).toEqual(
      Array.from(new Float32Array(top.uvPerVertex.flat()))
    );
    for (const [sourceName, attribute] of [
      ['RuntimePreviewColor', '_sourcepreviewcolor'],
      ['runtime_normal', '_sourcereferencenormal'],
    ]) {
      const row = top.pointAttributes.find((a: any) => a.name === sourceName);
      expect(Array.from(socks.getAttribute(attribute).array)).toEqual(
        Array.from(new Float32Array(row.values.flat()))
      );
    }
  });

  it('applies each neutral jersey edit once, keeps face8 and restores only the listed102 source triangles', async () => {
    const oldBody = await new GLTFLoader().parseAsync(
      Uint8Array.from(readFileSync('public/models/football/continuous-body.glb')).buffer,
      ''
    );
    loaded.push(oldBody);
    const oldJersey = await new GLTFLoader().parseAsync(
      Uint8Array.from(readFileSync('public/models/football/continuous-jersey.glb')).buffer,
      ''
    );
    loaded.push(oldJersey);
    const rawBody = mesh(oldBody, 'continuous-body').geometry;
    const jersey = createAuthoredContinuousShirtSource(
      mesh(oldJersey, 'continuous-jersey').geometry
    );
    const p = jersey.getAttribute('position'),
      expected = new Float32Array(p.array);
    for (const row of authored.neutralEdits['niko-jersey'])
      for (let k = 0; k < 3; k++) expected[row.vertex * 3 + k] += row.deltaRuntimeMetres[k];
    const result = mesh(source, 'niko-jersey').geometry.getAttribute('position');
    for (let i = 0; i < expected.length; i++) expect(result.array[i]).toBeCloseTo(expected[i], 6);
    const body = mesh(source, 'niko-body').geometry;
    expect(Array.from(body.getAttribute('position').array)).toEqual(
      Array.from(rawBody.getAttribute('position').array)
    );
    for (const channel of ['position', 'normal'] as const)
      for (let i = 0; i < 8; i++)
        expect(Array.from(body.morphAttributes[channel]![i].array)).toEqual(
          Array.from(rawBody.morphAttributes[channel]![i].array)
        );
    const indices = Array.from(body.index!.array),
      raw = new Set<string>();
    const key = (ids: number[]) => [...ids].sort((a, b) => a - b).join(',');
    for (let i = 0; i < rawBody.index!.count; i += 3)
      raw.add(key([0, 1, 2].map((k) => rawBody.index!.getX(i + k))));
    for (const tri of authored.visibleMaskEdit.addedOriginalSourceTriangles)
      expect(raw.has(key(tri))).toBe(true);
    expect(indices.slice(-306)).toEqual(
      authored.visibleMaskEdit.addedOriginalSourceTriangles.flat()
    );
    expect(authored.frontPanelEaseV5.rows).toHaveLength(122);
    jersey.dispose();
  });

  it('rejects wrong source IDs, altered rest and unowned corrective names', async () => {
    const g = await parse();
    mesh(g, 'niko-socks').geometry.getAttribute('_runtimesourceid').setX(132, 99);
    expect(() => validateNativePlayer(g, validateContinuousMesh)).toThrow('source ID/topology');
    const h = await parse();
    mesh(h, 'niko-body').skeleton.bones[11].position.y += 0.001;
    expect(() => validateNativePlayer(h, validateContinuousMesh)).toThrow('rest frame');
    const j = await parse();
    mesh(j, 'niko-jersey').morphTargetDictionary!.BASELINE_SAMPLED = 4;
    expect(() => validateNativePlayer(j, validateContinuousMesh)).toThrow('ownership');
  });

  it('preserves exact source membership and all morphs in reduced distant geometry', () => {
    const surfaces = validateNativePlayer(source, validateContinuousMesh);
    for (const part of ['body', 'jersey'] as const) {
      const g = surfaces[part],
        low = createContinuousPlayerLod(g, { protectNeck: part === 'body' });
      expect(low.index!.count).toBeLessThan(g.index!.count);
      expect(low.userData.continuousLod.fallback).toBe(false);
      expect(low.morphAttributes.position).toHaveLength(g.morphAttributes.position!.length);
      expect(low.hasAttribute('_runtimesourceid')).toBe(false);
      const groups = low.userData.runtimeSourceIDs as number[][];
      expect(groups).toHaveLength(low.getAttribute('position').count);
      expect(
        groups
          .flat()
          .every((id) => Number.isInteger(id) && id >= 0 && id < g.getAttribute('position').count)
      ).toBe(true);
      expect(new Set(groups.flat()).size).toBe(groups.flat().length);
      low.dispose();
    }
  });

  it('atomically loads explicit authored mode and rejects a mutated asset before parsing', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }))
    );
    const assets = await loadContinuousPlayerAssets('native-authored-v5');
    expect(assets.nativeAuthored?.mode).toBe('native-authored-v5');
    expect(assets.nativeAuthored?.socks.getAttribute('position').count).toBe(726);
    assets.dispose();
    assets.dispose();
    const broken = bytes.slice();
    broken[broken.length - 1] ^= 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => broken.buffer }))
    );
    await expect(loadNativePlayerAssets(validateContinuousMesh)).rejects.toThrow('asset identity');
  });
});

describe('native renderer adoption', () => {
  it('falls back to complete strict legacy continuous assets on optional native failure', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const broken = bytes.slice();
    broken[broken.length - 1] ^= 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => broken.buffer }))
    );
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async (url) => {
      const part = String(url).includes('continuous-body') ? 'body' : 'jersey';
      const g = await new GLTFLoader().parseAsync(
        Uint8Array.from(readFileSync(`public/models/football/continuous-${part}.glb`)).buffer,
        ''
      );
      loaded.push(g);
      return g;
    });
    const assets = await loadContinuousPlayerAssets('native-authored-v5');
    expect(assets.nativeAuthored).toBeUndefined();
    expect(assets.body.morphAttributes.position).toHaveLength(8);
    expect(assets.jersey.getAttribute('position').count).toBe(1644);
    assets.dispose();
  });
  it('uses all tiers, owns only source correctives and invokes accepted boot fitting once per sync', () => {
    const surfaces = validateNativePlayer(source, validateContinuousMesh);
    const assets = {
      body: surfaces.body,
      jersey: surfaces.jersey,
      nativeAuthored: {
        mode: 'native-authored-v5' as const,
        shorts: surfaces.shorts,
        socks: surfaces.socks,
      },
      dispose() {},
    };
    const material = new THREE.MeshStandardMaterial(),
      base = humanGeometry(),
      rig = createRig(material, base.geometry);
    const textures = Array.from(
      { length: 6 },
      () => new THREE.CanvasTexture(document.createElement('canvas'))
    );
    const maps = { normal: textures[0], roughness: textures[1], dispose() {} };
    const review: ReviewPlayerAssets = {
      head: assets.body,
      hair: assets.body,
      brows: assets.body,
      skin: textures[2],
      hairMap: textures[3],
      browMap: textures[4],
      environment: textures[5],
      dispose() {},
    };
    const headMesh = new THREE.SkinnedMesh(assets.body, material);
    headMesh.morphTargetDictionary = { jawOpen: 2 };
    headMesh.morphTargetInfluences = new Array(8).fill(0);
    const head: HeadVisual = {
      mesh: headMesh,
      hair: headMesh,
      setDetail() {},
      animate() {},
      dispose() {},
    };
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
    const oldBody = vi.spyOn(legacyBody, 'createContinuousBodyCorrectives'),
      oldShirt = vi.spyOn(legacyShirt, 'createContinuousShirtCorrectives'),
      oldSocks = vi.spyOn(legacySocks, 'createContinuousSockCorrectives');
    const boot = vi.spyOn(kit, 'syncContinuousBootFlex');
    const actor = attachContinuousPlayer(rig, base, look, material, assets, review, maps, head);
    try {
      expect(oldBody).not.toHaveBeenCalled();
      expect(oldShirt).not.toHaveBeenCalled();
      expect(oldSocks).not.toHaveBeenCalled();
      expect(actor.meshes.body.geometry.index!.count).toBe(9131 * 3);
      expect(actor.meshes.socks.geometry.getAttribute('position').count).toBe(726);
      expect(actor.meshes.shorts.geometry.getAttribute('position').array).toEqual(
        surfaces.shorts.getAttribute('position').array
      );
      rig.bones.lowerLegL.quaternion.setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        (2 * Math.PI) / 3
      );
      headMesh.morphTargetInfluences![2] = 0.42;
      for (const detail of ['high', 'mid', 'low'] as const) {
        actor.setDetail(detail);
        const body = detail === 'low' ? actor.meshes.lowBody : actor.meshes.body;
        expect(body.visible).toBe(true);
        expect(body.morphTargetInfluences![2]).toBe(0.42);
        expect(
          body.morphTargetInfluences![body.morphTargetDictionary!.R11_PatellaFold_L_120]
        ).toBeCloseTo(1, 7);
      }
      expect(boot).toHaveBeenCalledTimes(3);
      actor.setDetail('low');
      expect(boot).toHaveBeenCalledTimes(3);
      headMesh.morphTargetInfluences![2] = 0;
      rig.bones.lowerLegL.quaternion.identity();
      actor.syncFace();
      expect(actor.meshes.lowBody.morphTargetInfluences![2]).toBe(0);
      expect(
        actor.meshes.lowBody.morphTargetInfluences![
          actor.meshes.lowBody.morphTargetDictionary!.R11_PatellaFold_L_120
        ]
      ).toBe(0);
      expect(boot).toHaveBeenCalledTimes(4);
    } finally {
      actor.dispose();
      rig.dispose();
      material.dispose();
      base.geometry.dispose();
      textures.forEach((t) => t.dispose());
    }
  });
});

describe('native semantic corrective ownership', () => {
  it('uses true side elevation, geometric knee flex and bounded crossfade', () => {
    const q = (axis: THREE.Vector3, a: number) => new THREE.Quaternion().setFromAxisAngle(axis, a);
    const x = new THREE.Vector3(1, 0, 0),
      z = new THREE.Vector3(0, 0, 1);
    expect(nativeCorrectiveAngle(q(x, 1), 'shoulder', 'L')).toBeCloseTo(0, 12);
    expect(nativeCorrectiveAngle(q(z, Math.PI / 4), 'shoulder', 'L')).toBeCloseTo(Math.PI / 4, 12);
    expect(nativeCorrectiveAngle(q(z, -Math.PI / 4), 'shoulder', 'R')).toBeCloseTo(Math.PI / 4, 12);
    expect(nativeCorrectiveAngle(q(x, (2 * Math.PI) / 3), 'knee', 'L')).toBeCloseTo(
      (2 * Math.PI) / 3,
      12
    );
    expect(nativeCorrectiveAngle(q(new THREE.Vector3(0, 1, 0), 1), 'knee', 'L')).toBeCloseTo(0, 12);
    for (const d of nativePlayerContract.drivers) {
      expect(
        nativeCorrectiveWeight(d.peakRadians, d.onsetRadians, d.peakRadians, d.adjacentPeakRadians)
      ).toBe(1);
      expect(nativeCorrectiveWeight(0, d.onsetRadians, d.peakRadians, d.adjacentPeakRadians)).toBe(
        0
      );
    }
  });
  it('random-access resets only source-owned keys and leaves facial morphs and skeleton unchanged', async () => {
    const g = await parse();
    validateNativePlayer(g, validateContinuousMesh);
    const m = mesh(g, 'niko-body'),
      c = createNativePlayerCorrectives(m, 'niko-body');
    m.morphTargetInfluences![2] = 0.37;
    const bone = m.skeleton.bones.find((b) => b.name === 'lowerLegL')!;
    bone.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (2 * Math.PI) / 3);
    const before = bone.quaternion.toArray();
    c.update();
    expect(m.morphTargetInfluences![m.morphTargetDictionary!.R11_PatellaFold_L_120]).toBeCloseTo(
      1,
      7
    );
    expect(m.morphTargetInfluences![2]).toBe(0.37);
    expect(bone.quaternion.toArray()).toEqual(before);
    bone.quaternion.identity();
    c.update();
    expect(m.morphTargetInfluences![m.morphTargetDictionary!.R11_PatellaFold_L_120]).toBe(0);
    expect(m.morphTargetInfluences![2]).toBe(0.37);
  });
});
