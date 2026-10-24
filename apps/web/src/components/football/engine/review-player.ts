import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BONES, type Rig, type HumanGeometry } from './rig';
import { headGeometry } from './player-assets';
import { createContinuousPlayerLod } from './continuous-player-lod';
import {
  attachPlayerHead,
  disposeHairAssets,
  type HeadVisual,
  type PlayerIdentity,
  type PlayerDetail,
  type appearanceTextures,
} from './player-appearance';

/** One home outfield display actor, never selected from a score or future event. */
export const REVIEW_PLAYER_SLOT = 1;
export interface ReviewPlayerAssets {
  head: THREE.BufferGeometry;
  continuousHead?: THREE.BufferGeometry;
  continuousLowHead?: THREE.BufferGeometry;
  hair: THREE.BufferGeometry;
  brows: THREE.BufferGeometry;
  skin: THREE.Texture;
  hairMap: THREE.Texture;
  browMap: THREE.Texture;
  environment: THREE.Texture;
  dispose(): void;
}
function disposeGLTF(gltf: GLTF) {
  const owned = new Set<{ dispose(): void }>();
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      owned.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        owned.add(m);
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) owned.add(v);
      }
    }
    if (o instanceof THREE.SkinnedMesh) owned.add(o.skeleton);
  });
  owned.forEach((o) => o.dispose());
}
/** Validate both sides of the review-only clipping step. Empty or non-finite
 * inputs can otherwise clip to zero vertices while retaining eight empty morphs. */
function validateReviewHead(source: THREE.BufferGeometry) {
  const positions = source.getAttribute('position');
  if (!positions || !Number.isInteger(positions.count) || positions.count < 3)
    throw new Error('Review head surface is empty');
  const aligned = (
    attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    size: number,
    label: string
  ) => {
    if (
      !Number.isInteger(size) ||
      size < 1 ||
      attribute.itemSize !== size ||
      attribute.count !== positions.count
    )
      throw new Error(`Invalid review head ${label}`);
    for (let i = 0; i < attribute.count; i++)
      for (let k = 0; k < size; k++)
        if (!Number.isFinite(attribute.getComponent(i, k)))
          throw new Error(`Non-finite review head ${label}`);
  };
  for (const [name, size] of [
    ['position', 3],
    ['normal', 3],
    ['uv', 2],
    ['uv1', 2],
    ['_part', 1],
  ] as const) {
    const attribute = source.getAttribute(name);
    if (!attribute || attribute.itemSize !== size) throw new Error(`Missing review head ${name}`);
  }
  for (const [name, attribute] of Object.entries(source.attributes))
    aligned(attribute, attribute.itemSize, name);
  for (const name of ['position', 'normal'] as const)
    if (source.morphAttributes[name]?.length !== 8)
      throw new Error(`Incomplete review head ${name} morphs`);
  for (const [name, targets] of Object.entries(source.morphAttributes)) {
    const base = source.getAttribute(name);
    if (!base || !targets || targets.length !== 8)
      throw new Error(`Invalid review head ${name} morphs`);
    targets.forEach((attribute) => aligned(attribute, base.itemSize, `${name} morph`));
  }
  const index = source.getIndex();
  if (!index || index.itemSize !== 1 || !index.count || index.count % 3 !== 0)
    throw new Error('Review head triangles are empty or incomplete');
  for (let i = 0; i < index.count; i++) {
    const vertex = index.getX(i);
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= positions.count)
      throw new Error('Invalid review head index');
  }
}
function headBoundGeometry(source: THREE.BufferGeometry) {
  const positions = source.getAttribute('position');
  for (const [name, size] of [
    ['position', 3],
    ['normal', 3],
    ['uv', 2],
  ] as const) {
    const attribute = source.getAttribute(name);
    if (
      !positions ||
      !attribute ||
      !attribute.count ||
      attribute.itemSize !== size ||
      attribute.count !== positions.count ||
      Array.from(attribute.array).some((v) => !Number.isFinite(v))
    )
      throw new Error('Invalid review accessory surface');
  }
  if (!source.index || !source.index.count || source.index.count % 3 !== 0)
    throw new Error('Incomplete review accessory');
  for (let i = 0; i < source.index.count; i++) {
    const index = source.index.getX(i);
    if (!Number.isInteger(index) || index < 0 || index >= positions.count)
      throw new Error('Invalid review accessory index');
  }
  const g = source.clone(),
    n = g.getAttribute('position').count;
  const joints = new Uint16Array(n * 4),
    weights = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    joints[i * 4] = BONES.indexOf('head');
    weights[i * 4] = 1;
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(joints, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4));
  return g;
}
/** Original neutral sky/field reflection, not a photographic stadium backdrop. */
function reflection() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d')!,
    sky = ctx.createLinearGradient(0, 0, 0, 128);
  sky.addColorStop(0, '#6a8caa');
  sky.addColorStop(0.48, '#e4e7e0');
  sky.addColorStop(0.53, '#586851');
  sky.addColorStop(1, '#2c352b');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 256, 128);
  const sun = ctx.createRadialGradient(58, 27, 0, 58, 27, 8);
  sun.addColorStop(0, '#ffffff');
  sun.addColorStop(0.2, '#fff6df');
  sun.addColorStop(1, 'rgba(255,248,225,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(45, 14, 27, 27);
  const texture = new THREE.CanvasTexture(c);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
/** The review upgrade is optional and atomic. Every fulfilled sibling is released on failure. */
export async function loadReviewPlayerAssets(): Promise<ReviewPlayerAssets> {
  const loader = new GLTFLoader(),
    images = new THREE.TextureLoader();
  const results = await Promise.allSettled([
    loader.loadAsync('/models/football/review-head-high.glb'),
    loader.loadAsync('/models/football/review-player-hair.glb'),
    images.loadAsync('/models/football/review-skin-basecolor.webp'),
    images.loadAsync('/models/football/review-hair.webp'),
    images.loadAsync('/models/football/review-brows.webp'),
  ]);
  const prepared: THREE.BufferGeometry[] = [];
  const releaseInputs = () =>
    results.forEach((r) => {
      if (r.status === 'fulfilled') {
        if (r.value instanceof THREE.Texture) r.value.dispose();
        else disposeGLTF(r.value as GLTF);
      }
    });
  try {
    if (results.some((r) => r.status === 'rejected'))
      throw new Error('Review character unavailable');
    const headInput = (results[0] as PromiseFulfilledResult<GLTF>).value;
    let headSource: THREE.BufferGeometry | undefined;
    headInput.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) headSource = object.geometry;
    });
    if (!headSource) throw new Error('Review head surface missing');
    validateReviewHead(headSource);
    const head = headGeometry(results[0] as PromiseFulfilledResult<GLTF>, true);
    prepared.push(head);
    validateReviewHead(head);
    const continuousHead = headGeometry(results[0] as PromiseFulfilledResult<GLTF>, 'continuous');
    prepared.push(continuousHead);
    validateReviewHead(continuousHead);
    const continuousLowHead = createContinuousPlayerLod(continuousHead, {
      protectNeck: false,
      cellSize: 0.016,
      fineCellSize: 0.008,
    });
    prepared.push(continuousLowHead);
    validateReviewHead(continuousLowHead);
    const gltf = (results[1] as PromiseFulfilledResult<GLTF>).value;
    const find = (name: string) => {
      const mesh = gltf.scene.getObjectByName(name);
      if (!(mesh instanceof THREE.Mesh)) throw new Error('Review hair surface missing');
      const g = headBoundGeometry(mesh.geometry);
      prepared.push(g);
      return g;
    };
    const hair = find('review-hair'),
      brows = find('review-brows');
    const textures = results
      .slice(2)
      .map((r) => (r as PromiseFulfilledResult<THREE.Texture>).value);
    textures.forEach((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;
      t.anisotropy = 4;
    });
    const [skin, hairMap, browMap] = textures;
    skin.channel = 1;
    const environment = reflection();
    // Parsed preview meshes/materials are never kept alive by the runtime.
    disposeGLTF((results[0] as PromiseFulfilledResult<GLTF>).value);
    disposeGLTF(gltf);
    let disposed = false;
    return {
      head,
      continuousHead,
      continuousLowHead,
      hair,
      brows,
      skin,
      hairMap,
      browMap,
      environment,
      dispose() {
        if (disposed) return;
        disposed = true;
        disposeHairAssets({ high: head, mid: continuousHead, low: continuousLowHead });
        prepared.forEach((g) => g.dispose());
        textures.forEach((t) => t.dispose());
        environment.dispose();
      },
    };
  } catch (error) {
    prepared.forEach((g) => g.dispose());
    releaseInputs();
    throw error;
  }
}
export function reviewSkinMaterial(
  assets: ReviewPlayerAssets,
  maps: ReturnType<typeof appearanceTextures>
) {
  const material = new THREE.MeshPhysicalMaterial({
    side: THREE.DoubleSide,
    vertexColors: true,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(0.18, 0.18),
    roughnessMap: maps.roughness,
    roughness: 0.67,
    metalness: 0,
    specularIntensity: 0.32,
    clearcoat: 1,
    clearcoatRoughness: 0.2,
    envMap: assets.environment,
    envMapIntensity: 0.32,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.reviewSkin = { value: assets.skin };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float part; attribute vec2 uv1; varying float vPart; varying vec2 vReviewUv;'
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPart=part; vReviewUv=uv1;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D reviewSkin; varying float vPart; varying vec2 vReviewUv;'
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\nif(vPart>5.5 && vPart<6.5) discard;\nif(vPart<2.5) diffuseColor.rgb *= texture2D(reviewSkin,vReviewUv).rgb;'
      )
      .replace(
        '#include <roughnessmap_fragment>',
        // Borrow the existing shared pore roughness. Bound its response rather
        // than turning a low-valued map into an oily full-body specular layer.
        // Head, neck and hands use this same material/UV contract.
        '#include <roughnessmap_fragment>\nfloat reviewSkinGrain=clamp(roughnessFactor/0.67,0.0,1.0);\nroughnessFactor=(vPart>2.5 && vPart<5.5)?0.12:(vPart>0.5 && vPart<1.5?0.48:0.59+0.12*reviewSkinGrain);'
      )
      .replace(
        '#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\nmaterial.clearcoat=(vPart>2.5 && vPart<5.5)?0.85:0.006;'
      );
  };
  material.customProgramCacheKey = () => 'playqube-single-review-skin-v2';
  return material;
}
/** Same fictional identity and contact rig; no production close-up or result camera is added. */
export function attachReviewHead(
  rig: Rig,
  base: NonNullable<HumanGeometry['heads']>,
  identity: PlayerIdentity,
  fallbackMaterial: THREE.Material,
  assets: ReviewPlayerAssets,
  maps: ReturnType<typeof appearanceTextures>,
  continuous = false
): HeadVisual {
  const material = reviewSkinMaterial(assets, maps);
  const visual = attachPlayerHead(
    rig,
    {
      high: continuous && assets.continuousHead ? assets.continuousHead : assets.head,
      mid: continuous && assets.continuousHead ? assets.continuousHead : assets.head,
      low: continuous
        ? (assets.continuousLowHead ?? assets.continuousHead ?? assets.head)
        : base.low,
    },
    identity,
    material
  );
  // Licensed diffuse carries pigmentation; the existing fictional color supplies a bounded tint.
  const reference = new THREE.Color('#e9ba97'),
    tint = new THREE.Color(identity.skin);
  tint.r /= reference.r;
  tint.g /= reference.g;
  tint.b /= reference.b;
  const colored = new Set<THREE.BufferGeometry>();
  function prepareLook() {
    const g = visual.mesh.geometry;
    if (colored.has(g) || !g.getAttribute('uv1')) return;
    colored.add(g);
    const part = g.getAttribute('part'),
      color = g.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < color.count; i++)
      if (part.getX(i) < 2.5) color.setXYZ(i, tint.r, tint.g, tint.b);
    color.needsUpdate = true;
  }
  const make = (g: THREE.BufferGeometry, map: THREE.Texture, color: string) => {
    const m = new THREE.MeshStandardMaterial({
      map,
      color,
      alphaTest: 0.3,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
      roughness: 0.84,
      envMap: assets.environment,
      envMapIntensity: 0.16,
    });
    const mesh = new THREE.SkinnedMesh(g, m);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    rig.root.add(mesh);
    mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
    return mesh;
  };
  const hair = make(assets.hair, assets.hairMap, '#ffffff'),
    brows = make(assets.brows, assets.browMap, '#ffffff');
  let detail: PlayerDetail = 'mid';
  function setDetail(next: PlayerDetail) {
    detail = next;
    visual.setDetail(next);
    prepareLook();
    const close = next !== 'low';
    const reviewSurface = close || continuous;
    visual.mesh.material = reviewSurface ? material : fallbackMaterial;
    visual.hair.visible = !reviewSurface;
    hair.visible = brows.visible = reviewSurface;
  }
  setDetail('mid');
  return {
    mesh: visual.mesh,
    hair: visual.hair,
    setDetail,
    animate(time, kind, moving) {
      visual.animate(time, kind, moving);
      const index = visual.mesh.morphTargetDictionary?.browRaise;
      brows.position.y =
        detail !== 'low' && index !== undefined
          ? (visual.mesh.morphTargetInfluences?.[index] ?? 0) * 0.003
          : 0;
    },
    dispose() {
      visual.dispose();
      material.dispose();
      for (const mesh of [hair, brows]) {
        mesh.removeFromParent();
        (mesh.material as THREE.Material).dispose();
      }
    },
  };
}
