import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachContinuousPlayer,
  loadContinuousPlayerAssets,
  validateContinuousMesh,
} from './continuous-player';
import { attachReviewHead, type ReviewPlayerAssets } from './review-player';
import {
  BONES,
  boneParent,
  createRig,
  humanGeometry,
  kitFromClub,
  kitTexture,
  restLocalPosition,
  type HumanGeometry,
  type Look,
} from './rig';
import { disposeHairAssets, playerIdentity } from './player-appearance';
import { headGeometry } from './player-assets';

const cleanups: Array<() => void> = [];
const morphNames = [
  'blinkLeft',
  'blinkRight',
  'jawOpen',
  'browRaise',
  'smile',
  'noseWidth',
  'lipFullness',
  'earSize',
];
const own = <T extends { dispose(): void }>(value: T): T => {
  cleanups.push(() => value.dispose());
  return value;
};
beforeEach(() => {
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
    .forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});
function fingerprint(g: THREE.BufferGeometry) {
  const hash = createHash('sha256');
  for (const a of [
    ...Object.values(g.attributes),
    ...Object.values(g.morphAttributes).flat(),
    g.index!,
  ])
    if (a) hash.update(Buffer.from(a.array.buffer, a.array.byteOffset, a.array.byteLength));
  return hash.digest('hex');
}
async function raw(part: 'body' | 'jersey' | 'head'): Promise<GLTF> {
  const name = part === 'head' ? 'review-head-high' : `continuous-${part}`;
  return new GLTFLoader().parseAsync(
    Uint8Array.from(readFileSync(`public/models/football/${name}.glb`)).buffer,
    ''
  );
}
function mesh(value: GLTF, part: 'body' | 'jersey') {
  return value.scene.getObjectByName(`continuous-${part}`) as THREE.SkinnedMesh;
}
function resources(value: GLTF) {
  const found = new Set<{ dispose(): void }>();
  value.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      found.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        found.add(m);
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) found.add(v);
      }
    }
    if (o instanceof THREE.SkinnedMesh) found.add(o.skeleton);
  });
  return [...found];
}
function track(value: GLTF) {
  return resources(value).map((resource) => {
    const dispose = vi.spyOn(resource, 'dispose');
    cleanups.push(() => {
      if (!dispose.mock.calls.length) resource.dispose();
    });
    return { resource, dispose };
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
async function fixture(mutate?: (value: GLTF, part: 'body' | 'jersey') => void) {
  const values = { body: await raw('body'), jersey: await raw('jersey') };
  const tracked = Object.values(values).flatMap((value) => {
    const m = value.scene.children.find((o) => o instanceof THREE.SkinnedMesh) as THREE.SkinnedMesh;
    const material = m.material as THREE.MeshStandardMaterial;
    // A shared preview texture must be released once even when present twice.
    material.map = material.roughnessMap = new THREE.Texture();
    return track(value);
  });
  for (const part of ['body', 'jersey'] as const) mutate?.(values[part], part);
  const load = vi
    .spyOn(GLTFLoader.prototype, 'loadAsync')
    .mockImplementation(async (url) =>
      String(url).includes('continuous-body') ? values.body : values.jersey
    );
  return { values, tracked, load };
}

describe('actual continuous-player GLB contract', () => {
  it('matches all49 local rest frames and inverse binds and retains the complete eight neck morphs', async () => {
    for (const part of ['body', 'jersey'] as const) {
      const value = await raw(part);
      track(value);
      const m = mesh(value, part),
        geometry = validateContinuousMesh(value, `continuous-${part}`);
      expect(m.bindMatrix.equals(new THREE.Matrix4())).toBe(true);
      expect(m.skeleton.bones.map((b) => b.name)).toEqual(BONES);
      value.scene.updateMatrixWorld(true);
      m.skeleton.update();
      m.skeleton.bones.forEach((b, i) => {
        expect(b.position.distanceTo(restLocalPosition(BONES[i]))).toBeLessThan(1e-8);
        expect(b.parent instanceof THREE.Bone ? b.parent.name : null).toBe(boneParent(BONES[i]));
      });
      let restError = 0;
      const p = geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++)
        restError = Math.max(
          restError,
          m
            .getVertexPosition(i, new THREE.Vector3())
            .distanceTo(new THREE.Vector3().fromBufferAttribute(p, i))
        );
      expect(restError).toBeLessThan(2e-7);
      if (part === 'body') {
        expect(Object.keys(m.morphTargetDictionary!)).toEqual(morphNames);
        for (const kind of ['position', 'normal'] as const) {
          expect(geometry.morphAttributes[kind]).toHaveLength(8);
          expect(
            geometry.morphAttributes[kind]!.every(
              (a: THREE.BufferAttribute) => a.count === p.count && a.itemSize === 3
            )
          ).toBe(true);
        }
      }
    }
  });

  it('rejects changed anatomical rest even when recalculated inverse binds keep neutral skin visually fixed', async () => {
    const value = await raw('body');
    track(value);
    const m = mesh(value, 'body');
    m.skeleton.bones[BONES.indexOf('foreArmL')].position.y -= 0.025;
    value.scene.updateMatrixWorld(true);
    m.skeleton.calculateInverses();
    m.skeleton.update();
    const p = m.geometry.getAttribute('position');
    const i = Math.floor(p.count / 2);
    expect(
      m
        .getVertexPosition(i, new THREE.Vector3())
        .distanceTo(new THREE.Vector3().fromBufferAttribute(p, i))
    ).toBeLessThan(2e-7);
    expect(() => validateContinuousMesh(value, 'continuous-body')).toThrow('rest frame mismatch');
  });

  it('rejects a hidden scene-parent rest offset even when inverse binds compensate it', async () => {
    const value = await raw('body');
    track(value);
    const m = mesh(value, 'body');
    const hiddenParent = new THREE.Group();
    hiddenParent.position.set(0.035, 0.02, -0.015);
    value.scene.add(hiddenParent);
    hiddenParent.add(m.skeleton.bones[0]);
    value.scene.updateMatrixWorld(true);
    m.skeleton.calculateInverses();
    m.skeleton.update();
    // All49 local rest offsets and the neutral skin remain valid. The hidden
    // world offset would be discarded when attaching to the canonical rig.
    m.skeleton.bones.forEach((bone, i) =>
      expect(bone.position.distanceTo(restLocalPosition(BONES[i]))).toBeLessThan(1e-8)
    );
    const p = m.geometry.getAttribute('position'),
      i = Math.floor(p.count / 2);
    expect(
      m
        .getVertexPosition(i, new THREE.Vector3())
        .distanceTo(new THREE.Vector3().fromBufferAttribute(p, i))
    ).toBeLessThan(2e-7);
    expect(() => validateContinuousMesh(value, 'continuous-body')).toThrow(/rest|world/i);
  });

  const malformed: Array<[string, (m: THREE.SkinnedMesh) => void]> = [
    ['nonidentity mesh bind', (m) => m.bindMatrix.makeTranslation(0.01, 0, 0)],
    [
      'joint name',
      (m) => {
        m.skeleton.bones[5].name = 'unreviewed-helper';
      },
    ],
    [
      'inverse bind',
      (m) => {
        m.skeleton.boneInverses[5].elements[12] += 0.01;
      },
    ],
    ['position NaN', (m) => m.geometry.getAttribute('position').setX(0, NaN)],
    [
      'normal count',
      (m) => m.geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1], 3)),
    ],
    ['UV count', (m) => m.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0], 2))],
    [
      'invalid index',
      (m) => m.geometry.setIndex([0, 1, m.geometry.getAttribute('position').count]),
    ],
    ['partial triangle', (m) => m.geometry.setIndex([0, 1])],
    ['joint range', (m) => m.geometry.getAttribute('skinIndex').setX(0, 49)],
    ['negative weight', (m) => m.geometry.getAttribute('skinWeight').setX(0, -0.1)],
    ['nonfinite weight', (m) => m.geometry.getAttribute('skinWeight').setX(0, NaN)],
    ['unbound vertex', (m) => m.geometry.getAttribute('skinWeight').setXYZW(0, 0, 0, 0, 0)],
    [
      'renamed jaw target',
      (m) => {
        delete m.morphTargetDictionary!.jawOpen;
        m.morphTargetDictionary!.jawWrong = 2;
      },
    ],
    [
      'missing normal morph',
      (m) => {
        m.geometry.morphAttributes.normal!.pop();
      },
    ],
    [
      'morph count',
      (m) => {
        m.geometry.morphAttributes.position![2] = new THREE.Float32BufferAttribute([0, 0, 0], 3);
      },
    ],
    [
      'normal morph component width',
      (m) => {
        const count = m.geometry.getAttribute('position').count;
        m.geometry.morphAttributes.normal![2] = new THREE.Float32BufferAttribute(
          new Float32Array(count * 2),
          2
        );
      },
    ],
    ['morph NaN', (m) => m.geometry.morphAttributes.position![2].setX(0, NaN)],
  ];
  for (const [label, corrupt] of malformed)
    it(`rejects ${label} and releases both atomic inputs`, async () => {
      const f = await fixture((v, part) => {
        if (part === 'body') corrupt(mesh(v, part));
      });
      const outcome = await loadContinuousPlayerAssets().then(
        (accepted) => {
          own(accepted);
          return 'accepted';
        },
        () => 'rejected'
      );
      expect(outcome).toBe('rejected');
      f.tracked.forEach(({ dispose }) => expect(dispose).toHaveBeenCalledOnce());
    });
});

describe('atomic loading and ownership', () => {
  for (const part of ['body', 'jersey'] as const)
    it(`waits for and releases fulfilled sibling when ${part} rejects`, async () => {
      const f = await fixture(),
        late = deferred<GLTF>();
      f.load.mockImplementation((url) =>
        String(url).includes(`continuous-${part}`)
          ? Promise.reject(new Error('missing fixture'))
          : late.promise
      );
      const result = loadContinuousPlayerAssets();
      const rejection = expect(result).rejects.toThrow('Continuous player unavailable');
      await Promise.resolve();
      f.tracked.forEach(({ dispose }) => expect(dispose).not.toHaveBeenCalled());
      const sibling = part === 'body' ? 'jersey' : 'body';
      late.resolve(f.values[sibling]);
      await rejection;
      const siblingResources = new Set(resources(f.values[sibling]));
      f.tracked.forEach(({ resource, dispose }) => {
        if (siblingResources.has(resource)) expect(dispose).toHaveBeenCalledOnce();
        else expect(dispose).not.toHaveBeenCalled();
      });
    });

  it('cleans a prepared body clone if malformed jersey fails after preparation', async () => {
    const f = await fixture((v, part) => {
      if (part === 'jersey') mesh(v, part).geometry.setIndex([0, 1, 999999]);
    });
    const disposed = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    await expect(loadContinuousPlayerAssets()).rejects.toThrow('index out of range');
    const input = new Set<unknown>(f.tracked.map((r) => r.resource));
    const prepared = disposed.mock.instances.filter((g) => !input.has(g));
    expect(prepared).toHaveLength(1);
    f.tracked.forEach(({ dispose }) => expect(dispose).toHaveBeenCalledOnce());
  });

  it('returns independently owned arrays after late completion and disposes returned clones exactly once', async () => {
    const f = await fixture(),
      late = deferred<GLTF>();
    f.load.mockImplementation((url) =>
      String(url).includes('continuous-body') ? Promise.resolve(f.values.body) : late.promise
    );
    const pending = loadContinuousPlayerAssets();
    await Promise.resolve();
    late.resolve(f.values.jersey);
    const assets = own(await pending);
    f.tracked.forEach(({ dispose }) => expect(dispose).toHaveBeenCalledOnce());
    for (const part of ['body', 'jersey'] as const) {
      const input = mesh(f.values[part], part).geometry;
      expect(assets[part]).not.toBe(input);
      expect(assets[part].getAttribute('position').array).not.toBe(
        input.getAttribute('position').array
      );
      const before = assets[part].getAttribute('position').getX(0);
      input.getAttribute('position').setX(0, before + 1);
      expect(assets[part].getAttribute('position').getX(0)).toBe(before);
    }
    const disposals = [assets.body, assets.jersey].map((g) => vi.spyOn(g, 'dispose'));
    assets.dispose();
    assets.dispose();
    disposals.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
  });
});

async function characterFixture(kitMap?: THREE.Texture) {
  await fixture();
  const assets = own(await loadContinuousPlayerAssets());
  const original = await raw('head');
  track(original);
  const head = own(headGeometry({ status: 'fulfilled', value: original }, true));
  const continuousHead = own(headGeometry({ status: 'fulfilled', value: original }, 'continuous'));
  const base = {} as NonNullable<HumanGeometry['heads']>;
  for (const detail of ['high', 'mid', 'low'] as const) {
    const value = await new GLTFLoader().parseAsync(
      Uint8Array.from(readFileSync(`public/models/football/player-head-${detail}.glb`)).buffer,
      ''
    );
    track(value);
    base[detail] = own(headGeometry({ status: 'fulfilled', value }));
  }
  cleanups.push(() => disposeHairAssets(base));
  const accessory = new THREE.BufferGeometry().copy(head);
  own(accessory);
  const review: ReviewPlayerAssets = {
    head,
    continuousHead,
    hair: accessory,
    brows: accessory,
    skin: own(new THREE.Texture()),
    hairMap: own(new THREE.Texture()),
    browMap: own(new THREE.Texture()),
    environment: own(new THREE.Texture()),
    dispose() {},
  };
  const maps = {
    normal: own(new THREE.CanvasTexture(document.createElement('canvas'))),
    roughness: own(new THREE.CanvasTexture(document.createElement('canvas'))),
    dispose() {},
  };
  const look: Look = {
    kit: kitFromClub({ primary: '#7a253d', secondary: '#d7b08b', pattern: 'solid' }),
    skin: '#a86b45',
    hair: '#201a18',
  };
  const material = own(new THREE.MeshStandardMaterial({ map: kitMap ?? null })),
    source = humanGeometry();
  const rig = own(createRig(material, source.geometry));
  const identity = { ...playerIdentity(1, 1), seed: 0, nose: 0.2, lips: 0.15, ears: 0.1 };
  const face = own(attachReviewHead(rig, base, identity, material, review, maps, true));
  const body = own(attachContinuousPlayer(rig, source, look, material, assets, review, maps, face));
  return { assets, review, maps, look, material, source, rig, identity, face, body };
}

describe('same-person continuous body/head adapter', () => {
  it('borrows the original kit atlas without tinting it or replacing authored garment UVs', async () => {
    const atlas = own(
      kitTexture(kitFromClub({ primary: '#f2cf12', secondary: '#111111', pattern: 'stripes' }))
    );
    const atlasDisposed = vi.spyOn(atlas, 'dispose');
    const f = await characterFixture(atlas);
    const jersey = f.body.meshes.jersey;
    const material = jersey.material as THREE.MeshStandardMaterial;
    const uv = f.assets.jersey.getAttribute('uv');
    const before = fingerprint(f.assets.jersey);
    expect(material.map).toBe(atlas);
    expect(material.color.getHex()).toBe(0xffffff);
    expect(material.vertexColors).toBe(false);
    expect(material.map!.wrapS).toBe(THREE.RepeatWrapping);
    expect(material.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(jersey.geometry.getAttribute('uv')).toBe(uv);
    expect(fingerprint(f.assets.jersey)).toBe(before);
    f.body.dispose();
    expect(atlasDisposed).not.toHaveBeenCalled();
    expect(f.material.map).toBe(atlas);
    expect(fingerprint(f.assets.jersey)).toBe(before);
  });

  it('projects the diffuse atlas once per fragment and paints white number ink after the real Three map chunk', async () => {
    const atlas = own(
      kitTexture(kitFromClub({ primary: '#f2cf12', secondary: '#111111', pattern: 'stripes' }))
    );
    const f = await characterFixture(atlas);
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as Parameters<THREE.Material['onBeforeCompile']>[0];
    const material = f.body.meshes.jersey.material as THREE.MeshStandardMaterial;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    const atlasChunk = THREE.ShaderChunk.map_fragment
      .replaceAll('vMapUv', 'computedKitUv')
      .replace(
        'texture2D( map, computedKitUv )',
        'textureGrad( map, computedKitUv, kitUvDx, kitUvDy )'
      );
    expect(shader.fragmentShader).toContain(atlasChunk);
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
    expect(shader.fragmentShader.match(/vec2 computedKitUv=/g)).toHaveLength(1);
    expect(shader.vertexShader).not.toContain('computedKitUv');
    expect(shader.fragmentShader.indexOf('diffuseColor *= sampledDiffuseColor')).toBeLessThan(
      shader.fragmentShader.indexOf('vec4 numberInk=')
    );
    expect(shader.fragmentShader).toContain('dFdx(vNumberBindPosition)');
    expect(shader.fragmentShader).toContain('dFdy(vNumberBindPosition)');
    expect(shader.fragmentShader).not.toContain('dFdx(computedKitUv)');
    expect(material.customProgramCacheKey()).toBe('playqube-continuous-shirt-atlas-number-v3');
    const repeat = (u: number) => ((u % 1) + 1) % 1;
    const projectedU = (x: number, z: number) => repeat(0.75 + Math.atan2(x, z) / (2 * Math.PI));
    // Builder uses x=cos(theta), z=sin(theta), u=1-theta/(2PI).
    // This also locks the direction of the original front PQ badge at u=.75.
    for (const theta of [0, 0.1, 0.5, 1, 1.49, 1.51, 1.9].map((v) => v * Math.PI))
      expect(projectedU(Math.cos(theta), Math.sin(theta))).toBeCloseTo(
        repeat(1 - theta / (2 * Math.PI)),
        12
      );
    expect(projectedU(0, 1)).toBe(0.75);
    // The back angular branch differs by one full texture repeat. Computing it
    // from position in the fragment avoids interpolating a source UV wrap seam.
    expect(Math.abs(projectedU(-1e-7, -1) - projectedU(1e-7, -1))).toBeLessThan(1e-7);
  });

  it('keeps analytic atlas gradients continuous across the back wrap and zero outside the height clamp', () => {
    type Point = [number, number, number];
    const uv = ([x, y, z]: Point) => [
      0.75 + Math.atan2(x, z) / (2 * Math.PI),
      0.5 + 0.5 * THREE.MathUtils.clamp((y - 0.95) / 0.57, 0.0001, 0.9999),
    ];
    const gradient = ([x, y, z]: Point, [dx, dy, dz]: Point) => {
      const height = (y - 0.95) / 0.57;
      return [
        (z * dx - x * dz) / (2 * Math.PI * Math.max(x * x + z * z, 1e-8)),
        height > 0.0001 && height < 0.9999 ? (0.5 / 0.57) * dy : 0,
      ];
    };
    const difference = (point: Point, delta: Point) => {
      const epsilon = 1e-3;
      const a = uv(point.map((v, i) => v - epsilon * delta[i]) as Point);
      const b = uv(point.map((v, i) => v + epsilon * delta[i]) as Point);
      const rawU = b[0] - a[0];
      return [(rawU - Math.round(rawU)) / (2 * epsilon), (b[1] - a[1]) / (2 * epsilon)];
    };
    const back: Point = [0, 1.3, -0.08],
      screenX: Point = [0.001, 0, 0];
    const rawPixelDelta = uv([0.001, 1.3, -0.08])[0] - uv([-0.001, 1.3, -0.08])[0];
    expect(Math.abs(rawPixelDelta)).toBeGreaterThan(0.99);
    expect(Math.abs(gradient(back, screenX)[0])).toBeLessThan(0.0021);
    const samples: Array<[Point, Point]> = [
      [back, screenX],
      [back, [0.0002, 0.001, -0.0001]],
      [
        [0.03, 1.23, 0.08],
        [0.004, 0.003, -0.002],
      ],
      [
        [-0.12, 1.4, -0.04],
        [-0.002, -0.001, 0.003],
      ],
      [
        [0.03, 0.94, 0.08],
        [0.001, 0.001, -0.001],
      ],
      [
        [0.03, 1.53, 0.08],
        [0.001, 0.001, -0.001],
      ],
    ];
    for (const [point, delta] of samples) {
      const analytic = gradient(point, delta),
        measured = difference(point, delta);
      analytic.forEach((value, i) => {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeCloseTo(measured[i], 8);
      });
    }
    expect(gradient([0, 0.94, -0.08], [0, 1, 0])[1]).toBe(0);
    expect(gradient([0, 1.53, -0.08], [0, 1, 0])[1]).toBe(0);
    expect(gradient([0, 1.235, -0.08], [0, 1, 0])[1]).toBeCloseTo(0.5 / 0.57, 12);
    expect(gradient([0, 1.3, 0], [1, 1, 1]).every(Number.isFinite)).toBe(true);
  });

  it('paints the borrowed number on the existing skinned shirt and updates the compiled material without new geometry', async () => {
    const f = await characterFixture();
    const garment = f.body.meshes.jersey.geometry;
    const original = fingerprint(garment),
      vertexCount = garment.getAttribute('position').count;
    const number = own(new THREE.CanvasTexture(document.createElement('canvas')));
    const disposeNumber = vi.spyOn(number, 'dispose');
    const material = f.body.meshes.jersey.material as THREE.MeshStandardMaterial;
    expect(material.map).toBeNull();
    expect(material.color.equals(new THREE.Color(f.look.kit.primary))).toBe(true);
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <color_fragment>',
    } as Parameters<THREE.Material['onBeforeCompile']>[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.continuousNumberEnabled.value).toBe(0);
    f.body.setNumberTexture(number);
    expect(shader.uniforms.continuousNumberMap.value).toBe(number);
    expect(shader.uniforms.continuousNumberEnabled.value).toBe(1);
    // Bind-space coordinates interpolate on the shirt itself; the normal gate
    // keeps the same projected canvas from appearing through the front panel.
    expect(shader.vertexShader).toContain('vNumberBindPosition=position');
    expect(shader.vertexShader).toContain('vNumberBack=-normal.z');
    expect(shader.fragmentShader).toContain('vNumberBack>0.25');
    expect(shader.fragmentShader).toContain('numberInk.a');
    expect(garment).toBe(f.assets.jersey);
    expect(garment.getAttribute('position').count).toBe(vertexCount);
    expect(fingerprint(garment)).toBe(original);
    f.body.dispose();
    expect(disposeNumber).not.toHaveBeenCalled();
    f.body.setNumberTexture(own(new THREE.Texture()));
    expect(shader.uniforms.continuousNumberMap.value).toBe(number);
  });

  it('synchronizes the jaw boundary immediately in normal/reduced motion and every high/low transition', async () => {
    const f = await characterFixture();
    const before = fingerprint(f.assets.body),
      jerseyBefore = fingerprint(f.assets.jersey);
    const body = f.body.meshes.body;
    const boundary = Array.from(
      { length: body.geometry.getAttribute('position').count },
      (_, i) => i
    ).filter((i) => Math.abs(body.geometry.getAttribute('position').getY(i) - 1.53) < 1e-6);
    expect(boundary.length).toBeGreaterThan(80);
    f.face.setDetail('high');
    f.body.setDetail('high');
    const headPositions = f.face.mesh.geometry.getAttribute('position');
    const pairs = boundary.map((i) => {
      const p = new THREE.Vector3().fromBufferAttribute(body.geometry.getAttribute('position'), i);
      let closest = -1,
        distance = Infinity;
      for (let j = 0; j < headPositions.count; j++) {
        const d = p.distanceToSquared(new THREE.Vector3().fromBufferAttribute(headPositions, j));
        if (d < distance) {
          closest = j;
          distance = d;
        }
      }
      expect(Math.sqrt(distance)).toBeLessThan(2e-7);
      return [i, closest];
    });
    function maxGap() {
      f.rig.root.updateMatrixWorld(true);
      f.rig.skeleton.update();
      return Math.max(
        ...pairs.map(([a, b]) =>
          body
            .getVertexPosition(a, new THREE.Vector3())
            .distanceTo(f.face.mesh.getVertexPosition(b, new THREE.Vector3()))
        )
      );
    }
    for (const m of [body, f.face.mesh]) m.morphTargetInfluences!.fill(0);
    f.face.mesh.morphTargetInfluences![f.face.mesh.morphTargetDictionary!.jawOpen] = 1;
    expect(maxGap()).toBeGreaterThan(0.02); // Reproduces the visible ~3cm unsynchronized jaw seam.
    f.body.syncFace();
    expect(maxGap()).toBeLessThan(2e-7);
    for (const moving of [true, false])
      for (const detail of ['high', 'low', 'high', 'mid', 'low', 'high'] as const) {
        f.face.animate(0.1, 'run', moving);
        f.face.setDetail(detail);
        f.body.setDetail(detail);
        expect(body.visible).toBe(detail !== 'low');
        expect(f.body.meshes.jersey.visible).toBe(detail !== 'low');
        expect(f.rig.mesh.visible).toBe(detail === 'low');
        for (const [name, target] of Object.entries(body.morphTargetDictionary!))
          expect(body.morphTargetInfluences![target]).toBe(
            f.face.mesh.morphTargetInfluences![f.face.mesh.morphTargetDictionary![name]]
          );
        expect(body.morphTargetInfluences![body.morphTargetDictionary!.noseWidth]).toBe(
          f.identity.nose
        );
        expect(body.morphTargetInfluences![body.morphTargetDictionary!.jawOpen]).toBe(
          moving && detail !== 'low' ? 0.08 : 0
        );
        if (detail !== 'low') expect(maxGap()).toBeLessThan(2e-7);
      }
    expect(fingerprint(f.assets.body)).toBe(before);
    expect(fingerprint(f.assets.jersey)).toBe(jerseyBefore);
  });

  it('keeps separate actor skeleton/morph state, borrows source assets and releases only owned surfaces once', async () => {
    const f = await characterFixture();
    const other = own(createRig(f.material, f.source.geometry));
    const otherFace = own(
      attachReviewHead(
        other,
        { high: f.review.continuousHead!, mid: f.review.continuousHead!, low: f.review.head },
        f.identity,
        f.material,
        f.review,
        f.maps,
        true
      )
    );
    const otherBody = own(
      attachContinuousPlayer(
        other,
        f.source,
        f.look,
        f.material,
        f.assets,
        f.review,
        f.maps,
        otherFace
      )
    );
    const inputBody = fingerprint(f.assets.body),
      sourceBefore = fingerprint(f.source.geometry);
    expect(otherBody.meshes.body.skeleton).toBe(other.skeleton);
    expect(f.body.meshes.body.skeleton).toBe(f.rig.skeleton);
    expect(f.body.meshes.body.skeleton).not.toBe(otherBody.meshes.body.skeleton);
    f.rig.bones.upperArmL.rotation.z = 1;
    f.face.mesh.morphTargetInfluences![f.face.mesh.morphTargetDictionary!.jawOpen] = 0.7;
    f.body.syncFace();
    expect(other.bones.upperArmL.rotation.z).toBe(0);
    expect(otherBody.meshes.body.morphTargetInfluences![2]).toBe(0);
    const borrowed = [
      f.assets.body,
      f.assets.jersey,
      f.material,
      f.source.geometry,
      f.review.skin,
      f.maps.normal,
      f.rig.skeleton,
    ].map((resource) => vi.spyOn(resource, 'dispose'));
    const ownedResources = new Set<{ dispose(): void }>([
      f.body.meshes.body.geometry,
      f.body.meshes.body.material as THREE.Material,
      f.body.meshes.jersey.material as THREE.Material,
      f.body.meshes.boots.geometry,
    ]);
    const disposed = [...ownedResources].map((resource) => vi.spyOn(resource, 'dispose'));
    f.body.dispose();
    f.body.dispose();
    f.body.setDetail('high');
    f.body.syncFace();
    expect(Object.values(f.body.meshes).every((m) => m.parent === null)).toBe(true);
    expect(f.rig.mesh.visible).toBe(true);
    disposed.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
    borrowed.forEach((dispose) => expect(dispose).not.toHaveBeenCalled());
    expect(otherBody.meshes.body.parent).toBe(other.root);
    expect(fingerprint(f.assets.body)).toBe(inputBody);
    expect(fingerprint(f.source.geometry)).toBe(sourceBefore);
  });
});
