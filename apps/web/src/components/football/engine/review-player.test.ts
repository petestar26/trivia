import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewPlayerAssets } from './review-player';
import { createPlayerPool } from './players';
import { BONES, createRig, humanGeometry, type HumanGeometry } from './rig';
import {
  disposeHairAssets,
  playerIdentity,
  type HeadVisual,
  type PlayerDetail,
  type PlayerIdentity,
} from './player-appearance';
import { headGeometry } from './player-assets';
import { directorFrame } from './director';

const hooks = vi.hoisted(() => ({
  review: vi.fn(),
  legacy: vi.fn(),
  upgrade: vi.fn(),
  body: vi.fn(),
}));
vi.mock('./review-player', async (original) => ({
  ...(await original<typeof import('./review-player')>()),
  loadReviewPlayerAssets: () => hooks.review(),
}));
vi.mock('./human-model', () => ({ loadPlayerGeometry: () => hooks.legacy() }));
vi.mock('./player-assets', async (original) => ({
  ...(await original<typeof import('./player-assets')>()),
  loadPlayerUpgrade: () => hooks.upgrade(),
}));
vi.mock('./review-player-body', () => ({
  attachReviewBody: (...args: unknown[]) => hooks.body(...args),
}));
const real = await vi.importActual<typeof import('./review-player')>('./review-player');
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.clearAllMocks();
  hooks.review.mockRejectedValue(new Error('No review fixture'));
  hooks.legacy.mockRejectedValue(new Error('No legacy fixture'));
  hooks.upgrade.mockRejectedValue(new Error('No upgrade fixture'));
  hooks.body.mockImplementation(() => ({ setDetail: vi.fn(), dispose: vi.fn(), meshes: {} }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      new Proxy(
        {},
        {
          get: (_target, name) =>
            name === 'createImageData'
              ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
              : name === 'createLinearGradient' || name === 'createRadialGradient'
                ? () => ({ addColorStop: vi.fn() })
                : () => {},
          set: () => true,
        }
      ) as ReturnType<HTMLCanvasElement['getContext']>
  );
});
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((f) => f());
  vi.restoreAllMocks();
});
function own<T extends { dispose(): void }>(value: T): T {
  cleanups.push(() => value.dispose());
  return value;
}
function fingerprint(g: THREE.BufferGeometry) {
  const hash = createHash('sha256');
  for (const a of [
    ...Object.values(g.attributes),
    ...Object.values(g.morphAttributes).flat(),
    g.index!,
  ])
    hash.update(Buffer.from(a!.array.buffer, a!.array.byteOffset, a!.array.byteLength));
  return hash.digest('hex');
}
interface Tracked {
  kind: string;
  resource: { dispose(): void };
  dispose: { mock: { calls: unknown[][] } };
}
function tracking() {
  const resources: Tracked[] = [],
    seen = new Set<object>();
  const track = (kind: string, resource: { dispose(): void }) => {
    if (seen.has(resource)) return;
    seen.add(resource);
    const dispose = vi.spyOn(resource, 'dispose');
    resources.push({ kind, resource, dispose });
    cleanups.push(() => {
      if (!dispose.mock.calls.length) resource.dispose();
    });
  };
  const gltf = (value: GLTF) =>
    value.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        track('raw geometry', o.geometry);
        for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
          track('raw material', material);
          for (const v of Object.values(material))
            if (v instanceof THREE.Texture) track('raw preview texture', v);
        }
      }
      if (o instanceof THREE.SkinnedMesh) track('raw skeleton', o.skeleton);
    });
  return { resources, track, gltf };
}
async function rawHead(): Promise<GLTF> {
  return new GLTFLoader().parseAsync(
    Uint8Array.from(readFileSync('public/models/football/review-head-high.glb')).buffer,
    ''
  );
}
function rawHair(): GLTF {
  const scene = new THREE.Group(),
    preview = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: preview, roughnessMap: preview });
  const geometry = new THREE.PlaneGeometry(0.14, 0.08).translate(0, 1.77, 0.035);
  geometry.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute(new Uint16Array(geometry.getAttribute('position').count * 4), 4)
  );
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute(
      Array.from({ length: geometry.getAttribute('position').count }, () => [1, 0, 0, 0]).flat(),
      4
    )
  );
  const hair = new THREE.SkinnedMesh(geometry, material),
    bone = new THREE.Bone();
  hair.name = 'review-hair';
  scene.add(bone, hair);
  scene.updateMatrixWorld(true);
  hair.bind(new THREE.Skeleton([bone]), new THREE.Matrix4());
  const brows = new THREE.Mesh(
    new THREE.PlaneGeometry(0.11, 0.014).translate(0, 1.68, 0.14),
    material
  );
  brows.name = 'review-brows';
  scene.add(brows);
  return {
    scene,
    scenes: [scene],
    animations: [],
    cameras: [],
    asset: { version: '2.0' },
    parser: undefined!,
    userData: {},
  };
}
interface Options {
  fail?: string;
  malformed?:
    | 'missing-brows'
    | 'hair-no-position'
    | 'head-no-morphs'
    | 'head-no-uv1'
    | 'hair-nan'
    | 'hair-index-oob'
    | 'hair-normal-count'
    | 'hair-uv-count'
    | 'hair-partial-triangle'
    | 'head-all-nan'
    | 'head-empty-position'
    | 'head-position-size'
    | 'head-normal-count'
    | 'head-uv1-size'
    | 'head-empty-index'
    | 'head-index-oob'
    | 'head-partial-triangle'
    | 'head-position-morph-count'
    | 'head-position-morph-nan'
    | 'head-normal-morph-count'
    | 'head-normal-morph-nan'
    | 'head-no-normal-morphs'
    | 'head-fully-clipped';
}
function localAssets(options: Options = {}) {
  const monitor = tracking(),
    inputs: GLTF[] = [],
    textures: THREE.Texture[] = [];
  vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async function (url) {
    if (String(url).includes(options.fail ?? 'never-fail')) throw new Error('Injected missing GLB');
    const value = String(url).includes('review-head') ? await rawHead() : rawHair();
    const head = value.scene.children.find((o) => o instanceof THREE.Mesh) as
      THREE.Mesh | undefined;
    if (String(url).includes('review-head') && head) {
      const preview = new THREE.Texture();
      const material = Array.isArray(head.material) ? head.material[0] : head.material;
      (material as THREE.MeshStandardMaterial).map = preview;
      (material as THREE.MeshStandardMaterial).roughnessMap = preview;
      if (options.malformed === 'head-no-morphs') head.geometry.morphAttributes = {};
      if (options.malformed === 'head-no-uv1') head.geometry.deleteAttribute('uv1');
      const g = head.geometry;
      if (options.malformed === 'head-all-nan')
        (g.getAttribute('position').array as Float32Array).fill(Number.NaN);
      if (options.malformed === 'head-empty-position')
        g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      if (options.malformed === 'head-position-size')
        g.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(
            new Float32Array(g.getAttribute('position').count * 2),
            2
          )
        );
      if (options.malformed === 'head-normal-count')
        g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1], 3));
      if (options.malformed === 'head-uv1-size')
        g.setAttribute(
          'uv1',
          new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count), 1)
        );
      if (options.malformed === 'head-empty-index') g.setIndex([]);
      if (options.malformed === 'head-index-oob') g.setIndex([0, 1, 99999]);
      if (options.malformed === 'head-partial-triangle') g.setIndex([0, 1]);
      if (options.malformed === 'head-position-morph-count')
        g.morphAttributes.position![0] = new THREE.Float32BufferAttribute([0, 0, 0], 3);
      if (options.malformed === 'head-position-morph-nan')
        g.morphAttributes.position![0].setX(0, Number.NaN);
      if (options.malformed === 'head-normal-morph-count')
        g.morphAttributes.normal![0] = new THREE.Float32BufferAttribute([0, 0, 0], 3);
      if (options.malformed === 'head-normal-morph-nan')
        g.morphAttributes.normal![0].setX(0, Number.NaN);
      if (options.malformed === 'head-no-normal-morphs') delete g.morphAttributes.normal;
      if (options.malformed === 'head-fully-clipped') {
        const p = g.getAttribute('position');
        for (let i = 0; i < p.count; i++) p.setY(i, 1.2);
      }
    }
    if (String(url).includes('review-player-hair')) {
      if (options.malformed === 'missing-brows')
        value.scene.getObjectByName('review-brows')!.name = 'wrong-name';
      const mesh = value.scene.getObjectByName('review-hair') as THREE.Mesh;
      if (options.malformed === 'hair-no-position') mesh.geometry.deleteAttribute('position');
      if (options.malformed === 'hair-nan')
        mesh.geometry.getAttribute('position').setX(0, Number.NaN);
      if (options.malformed === 'hair-index-oob') mesh.geometry.setIndex([0, 1, 9999]);
      if (options.malformed === 'hair-normal-count')
        mesh.geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1], 3));
      if (options.malformed === 'hair-uv-count')
        mesh.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0], 2));
      if (options.malformed === 'hair-partial-triangle') mesh.geometry.setIndex([0, 1]);
    }
    monitor.gltf(value);
    inputs.push(value);
    return value;
  });
  vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation(async (url) => {
    if (String(url).includes(options.fail ?? 'never-fail'))
      throw new Error('Injected missing texture');
    const texture = new THREE.Texture();
    texture.name = String(url);
    textures.push(texture);
    monitor.track('input texture', texture);
    return texture;
  });
  return { ...monitor, inputs, textures };
}
function expectReleased(resources: Tracked[]) {
  expect(resources.length).toBeGreaterThan(0);
  for (const { kind, dispose } of resources) expect(dispose, kind).toHaveBeenCalledOnce();
}
function morphs(visual: HeadVisual) {
  return Object.fromEntries(
    Object.entries(visual.mesh.morphTargetDictionary!).map(([name, i]) => [
      name,
      visual.mesh.morphTargetInfluences![i],
    ])
  );
}
function expectFacial(
  visual: HeadVisual,
  identity: PlayerIdentity,
  detail: PlayerDetail,
  moving: boolean
) {
  const actual = morphs(visual),
    active = moving && detail !== 'low';
  expect(actual.noseWidth).toBeCloseTo(identity.nose, 12);
  expect(actual.lipFullness).toBeCloseTo(identity.lips, 12);
  expect(actual.earSize).toBeCloseTo(identity.ears, 12);
  expect(actual.blinkLeft).toBeCloseTo(active ? 1 : 0, 10);
  expect(actual.blinkRight).toBeCloseTo(active ? 1 : 0, 10);
  expect(actual.jawOpen).toBeCloseTo(active ? 0.08 : 0, 12);
}
async function baseHeads() {
  const levels = {} as NonNullable<HumanGeometry['heads']>;
  for (const detail of ['high', 'mid', 'low'] as const) {
    const parsed = await new GLTFLoader().parseAsync(
      Uint8Array.from(readFileSync(`public/models/football/player-head-${detail}.glb`)).buffer,
      ''
    );
    levels[detail] = headGeometry({ status: 'fulfilled', value: parsed });
    parsed.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
  }
  cleanups.push(() => {
    disposeHairAssets(levels);
    Object.values(levels).forEach((g) => g.dispose());
  });
  return levels;
}

describe('optional single review player assets', () => {
  for (const fail of [
    'review-head',
    'review-player-hair',
    'review-skin',
    'review-hair.webp',
    'review-brows.webp',
  ])
    it(`releases every fulfilled sibling and raw preview resource when ${fail} fails`, async () => {
      const fixture = localAssets({ fail });
      await expect(real.loadReviewPlayerAssets()).rejects.toThrow('Review character unavailable');
      expectReleased(fixture.resources);
      expect(fixture.resources.some((r) => r.kind === 'raw preview texture')).toBe(true);
    });

  for (const malformed of [
    'missing-brows',
    'hair-no-position',
    'head-no-morphs',
    'head-no-uv1',
    'hair-nan',
    'hair-index-oob',
    'hair-normal-count',
    'hair-uv-count',
    'hair-partial-triangle',
    'head-all-nan',
    'head-empty-position',
    'head-position-size',
    'head-normal-count',
    'head-uv1-size',
    'head-empty-index',
    'head-index-oob',
    'head-partial-triangle',
    'head-position-morph-count',
    'head-position-morph-nan',
    'head-normal-morph-count',
    'head-normal-morph-nan',
    'head-no-normal-morphs',
  ] as const)
    it(`rejects ${malformed} and cleans both prepared and raw siblings`, async () => {
      const fixture = localAssets({ malformed });
      let accepted: ReviewPlayerAssets | undefined;
      try {
        accepted = await real.loadReviewPlayerAssets();
      } catch {
        /* required rejection */
      }
      if (accepted) {
        own(accepted);
        throw new Error(`Malformed ${malformed} was accepted`);
      }
      expectReleased(fixture.resources);
    });

  it('rejects a finite head clipped to an empty surface and releases its prepared geometry', async () => {
    const fixture = localAssets({ malformed: 'head-fully-clipped' });
    const dispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    await expect(real.loadReviewPlayerAssets()).rejects.toThrow('Review head surface is empty');
    expectReleased(fixture.resources);
    const prepared = dispose.mock.instances.filter(
      (g) => !fixture.resources.some((r) => r.resource === (g as unknown))
    );
    expect(prepared).toHaveLength(1);
  });

  it('releases prepared surfaces and every raw asset if environment creation fails', async () => {
    const fixture = localAssets();
    const dispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementationOnce(() => {
      throw new Error('Injected canvas unavailable');
    });
    await expect(real.loadReviewPlayerAssets()).rejects.toThrow('Injected canvas unavailable');
    expectReleased(fixture.resources);
    const prepared = dispose.mock.instances.filter(
      (g) => !fixture.resources.some((r) => r.resource === (g as unknown))
    );
    expect(prepared).toHaveLength(3);
    expect(new Set(prepared).size).toBe(3);
  });

  it('loads real source UV/morph data, discards raw preview assets and releases successful assets exactly once', async () => {
    const fixture = localAssets(),
      assets = own(await real.loadReviewPlayerAssets());
    const raw = fixture.resources.filter((r) => r.kind !== 'input texture');
    expectReleased(raw);
    for (const resource of fixture.resources.filter((r) => r.kind === 'input texture'))
      expect(resource.dispose).not.toHaveBeenCalled();
    expect(assets.head.getAttribute('uv1').count).toBe(assets.head.getAttribute('position').count);
    expect(assets.head.morphAttributes.position).toHaveLength(8);
    expect(assets.head.index!.count / 3).toBeGreaterThan(9000);
    expect(assets.head.userData.morphNames.blinkLeft).toBe(0);
    expect(assets.skin.channel).toBe(1);
    expect(
      [assets.skin, assets.hairMap, assets.browMap].every(
        (t) => t.colorSpace === THREE.SRGBColorSpace && !t.flipY
      )
    ).toBe(true);
    for (const g of [assets.hair, assets.brows]) {
      const joints = g.getAttribute('skinIndex'),
        weights = g.getAttribute('skinWeight');
      for (let i = 0; i < joints.count; i++) {
        expect(joints.getX(i)).toBe(BONES.indexOf('head'));
        expect(weights.getX(i)).toBe(1);
      }
    }
    const prepared = [assets.head, assets.hair, assets.brows, assets.environment].map((g) =>
      vi.spyOn(g, 'dispose')
    );
    assets.dispose();
    assets.dispose();
    prepared.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
    expectReleased(fixture.resources);
  });

  it('preserves live/reduced facial state and borrowed surfaces/maps across all review LOD transitions', async () => {
    localAssets();
    const assets = own(await real.loadReviewPlayerAssets()),
      base = await baseHeads();
    const baseline = Object.values(base).map(fingerprint),
      reviewBefore = fingerprint(assets.head);
    const material = own(new THREE.MeshBasicMaterial()),
      normal = own(new THREE.CanvasTexture(document.createElement('canvas'))),
      roughness = own(new THREE.CanvasTexture(document.createElement('canvas')));
    const maps = {
      normal,
      roughness,
      dispose() {
        normal.dispose();
        roughness.dispose();
      },
    };
    const rig = own(createRig(material, humanGeometry().geometry)),
      identity = { ...playerIdentity(1, 1), seed: 0 };
    const other = own(createRig(material, humanGeometry().geometry));
    const visual = real.attachReviewHead(rig, base, identity, material, assets, maps);
    let disposed = false;
    cleanups.push(() => {
      if (!disposed) visual.dispose();
    });
    const extra = rig.root.children.filter(
      (o) =>
        o instanceof THREE.SkinnedMesh && o !== rig.mesh && o !== visual.mesh && o !== visual.hair
    ) as THREE.SkinnedMesh[];
    expect(extra).toHaveLength(2);
    const ownedMaterials = new Set<THREE.Material>([
      visual.mesh.material as THREE.Material,
      ...extra.map((m) => m.material as THREE.Material),
    ]);
    const materialDisposed = [...ownedMaterials].map((m) => vi.spyOn(m, 'dispose'));
    const borrowed = [
      assets.head,
      assets.hair,
      assets.brows,
      assets.skin,
      assets.hairMap,
      assets.browMap,
      assets.environment,
      normal,
      roughness,
      material,
      ...Object.values(base),
    ].map((o) => vi.spyOn(o, 'dispose'));
    const otherBones = other.bones.head.matrixWorld.clone();
    for (const moving of [true, false]) {
      visual.animate(0.1, 'run', moving);
      for (const detail of ['high', 'mid', 'low', 'high', 'low', 'mid'] as const) {
        visual.setDetail(detail);
        expectFacial(visual, identity, detail, moving);
        expect(extra.every((mesh) => mesh.visible === (detail !== 'low'))).toBe(true);
        expect(visual.hair.visible).toBe(detail === 'low');
        expect(visual.mesh.material === material).toBe(detail === 'low');
        expect(visual.mesh.geometry.getAttribute('position')).toBe(
          detail === 'low'
            ? base.low.getAttribute('position')
            : assets.head.getAttribute('position')
        );
        if (detail !== 'low')
          expect(visual.mesh.geometry.getAttribute('uv1')).toBe(assets.head.getAttribute('uv1'));
      }
    }
    expect(fingerprint(assets.head)).toBe(reviewBefore);
    expect(Object.values(base).map(fingerprint)).toEqual(baseline);
    expect(other.bones.head.matrixWorld.equals(otherBones)).toBe(true);
    const wrappers = [visual.mesh.geometry, visual.hair.geometry];
    visual.dispose();
    disposed = true;
    expect([visual.mesh, visual.hair, ...extra].every((mesh) => mesh.parent === null)).toBe(true);
    materialDisposed.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
    borrowed.forEach((dispose) => expect(dispose).not.toHaveBeenCalled());
    expect(wrappers[0]).not.toBe(assets.head);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
function minimalHead() {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.03, 1.76, 0.08, 0.03, 1.76, 0.08, 0, 1.82, 0.07], 3)
  );
  g.setAttribute('_part', new THREE.Float32BufferAttribute([0, 0, 0], 1));
  g.setIndex([0, 1, 2]);
  g.computeVertexNormals();
  g.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute([4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0], 4)
  );
  g.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4)
  );
  return g;
}
function baselineAsset(): HumanGeometry {
  const g = humanGeometry();
  return {
    ...g,
    geometry: g.geometry.clone(),
    bodyLods: {
      mid: { ...g, geometry: g.geometry.clone() },
      low: { ...g, geometry: g.geometry.clone() },
    },
    heads: { high: minimalHead(), mid: minimalHead(), low: minimalHead() },
  };
}
describe('review roster adoption boundaries', () => {
  it('adopts only fixed home outfield slot 1 after the optional load and leaves released frame facts untouched', async () => {
    localAssets();
    const assets = own(await real.loadReviewPlayerAssets()),
      pending = deferred<ReviewPlayerAssets>();
    hooks.review.mockReturnValue(pending.promise);
    hooks.upgrade.mockResolvedValue(baselineAsset());
    const pool = own(createPlayerPool());
    pool.setTeams(1, 6);
    await settled();
    expect(pool.rigs.every((r) => !r.root.userData.reviewPlayer)).toBe(true);
    const names = pool.rigs.map((r) => r.root.userData.playerIdentity.name);
    pending.resolve(assets);
    await settled();
    expect(
      pool.rigs.map((r, i) => (r.root.userData.reviewPlayer ? i : -1)).filter((i) => i >= 0)
    ).toEqual([real.REVIEW_PLAYER_SLOT]);
    expect(hooks.body).toHaveBeenCalledOnce();
    expect(hooks.body.mock.calls[0][0]).toBe(pool.rigs[1]);
    expect(pool.rigs.map((r) => r.root.userData.playerIdentity.name)).toEqual(names);
    const frame = directorFrame({
      matchKey: 'review-boundary',
      elapsedMs: 4000,
      status: 'FIRST_HALF',
      goals: [],
      fullTime: null,
    });
    const facts = JSON.stringify(frame);
    pool.apply(frame, 1 / 30, 4, true);
    expect(JSON.stringify(frame)).toBe(facts);
    expect(
      pool.rigs.map((r, i) => (r.root.userData.reviewPlayer ? i : -1)).filter((i) => i >= 0)
    ).toEqual([1]);
    expect(pool.rigs.every((r) => r.root.position.toArray().every(Number.isFinite))).toBe(true);
  });

  it('releases late optional assets after disposal without attaching them to dead rigs', async () => {
    localAssets();
    const assets = await real.loadReviewPlayerAssets(),
      pending = deferred<ReviewPlayerAssets>();
    const dispose = vi.spyOn(assets, 'dispose');
    cleanups.push(() => {
      if (!dispose.mock.calls.length) assets.dispose();
    });
    hooks.review.mockReturnValue(pending.promise);
    hooks.upgrade.mockResolvedValue(baselineAsset());
    const pool = createPlayerPool();
    pool.setTeams(1, 6);
    await settled();
    pool.dispose();
    pending.resolve(assets);
    await settled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(hooks.body).not.toHaveBeenCalled();
    expect(pool.group.children).toHaveLength(0);
  });

  it('keeps the complete baseline roster when optional review assets reject', async () => {
    const pending = deferred<ReviewPlayerAssets>();
    hooks.review.mockReturnValue(pending.promise);
    hooks.upgrade.mockResolvedValue(baselineAsset());
    const pool = own(createPlayerPool());
    pool.setTeams(1, 6);
    await settled();
    const bodyPositions = pool.rigs.map((r) => r.mesh.geometry.getAttribute('position'));
    pending.reject(new Error('optional asset unavailable'));
    await settled();
    expect(hooks.body).not.toHaveBeenCalled();
    expect(pool.rigs.every((r) => !r.root.userData.reviewPlayer)).toBe(true);
    expect(pool.rigs.map((r) => r.mesh.geometry.getAttribute('position'))).toEqual(bodyPositions);
    expect(
      pool.rigs.every(
        (r) => r.root.children.filter((o) => o instanceof THREE.SkinnedMesh).length >= 3
      )
    ).toBe(true);
  });
});
