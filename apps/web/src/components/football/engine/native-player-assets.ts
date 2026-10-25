import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import contract from '../../../../public/models/football/native-player-v5-provenance.json';
import type { ContinuousPlayerAssets } from './continuous-player';

export const NATIVE_PLAYER_MODE = 'native-authored-v5' as const;
export type NativePlayerSurfaces = Record<
  'body' | 'jersey' | 'shorts' | 'socks',
  THREE.BufferGeometry
>;
export const nativePlayerContract = contract;

/** Additional checks are deliberately separate from the strict historical loader.
 * UV-split source IDs are vertex identity, never MakeHuman's 19,158 native IDs. */
export function validateNativePlayer(
  gltf: GLTF,
  validate: (gltf: GLTF, name: string) => THREE.BufferGeometry
): NativePlayerSurfaces {
  const expectedNames = Object.keys(contract.surfaces);
  const visibleMeshes: THREE.Mesh[] = [];
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) visibleMeshes.push(o);
  });
  if (visibleMeshes.length !== 8 || visibleMeshes.some((o) => !expectedNames.includes(o.name)))
    throw new Error('Native player surface allowlist mismatch');
  const result = {} as NativePlayerSurfaces;
  for (const [name, expected] of Object.entries(contract.surfaces)) {
    const g = validate(gltf, name);
    const mesh = gltf.scene.getObjectByName(name) as THREE.SkinnedMesh;
    const ids = g.getAttribute('_runtimesourceid');
    if (
      g.getAttribute('position').count !== expected.vertices ||
      g.index!.count !== expected.triangles * 3 ||
      !ids ||
      ids.itemSize !== 1 ||
      ids.count !== expected.vertices ||
      Array.from({ length: ids.count }, (_, i) => ids.getX(i)).some((v, i) => v !== i)
    )
      throw new Error('Native player source ID/topology mismatch');
    const dictionary = mesh.morphTargetDictionary ?? {};
    if (
      Object.keys(dictionary).length !== expected.morphNames.length ||
      expected.morphNames.some((key, i) => dictionary[key] !== i) ||
      (g.morphAttributes.position?.length ?? 0) !== expected.morphNames.length ||
      (g.morphAttributes.normal?.length ?? 0) !== expected.morphNames.length
    )
      throw new Error('Native player corrective ownership mismatch');
    g.userData.morphNames = { ...dictionary };
    g.userData.nativeAuthored = NATIVE_PLAYER_MODE;
    // glTF custom attributes are deliberately lowercased by GLTFLoader.
    for (const key of ['part', 'outfit'])
      if (g.hasAttribute(`_${key}`)) g.setAttribute(key, g.getAttribute(`_${key}`));
    const part = name.slice(5);
    if (part === 'body' || part === 'jersey' || part === 'shorts' || part === 'socks')
      result[part] = g;
  }
  return result;
}

/** Verify immutable bytes before parsing and adopt all four geometry surfaces
 * atomically. No preview materials, face copies or boot sample morphs survive. */
export async function loadNativePlayerAssets(
  validate: (gltf: GLTF, name: string) => THREE.BufferGeometry
): Promise<ContinuousPlayerAssets> {
  const response = await fetch('/models/football/native-player-v5.glb');
  if (!response.ok) throw new Error('Native player unavailable');
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
  if (hash !== contract.assetSHA256) throw new Error('Native player asset identity mismatch');
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  const resources = new Set<{ dispose(): void }>();
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      resources.add(o.geometry);
      for (const material of Array.isArray(o.material) ? o.material : [o.material])
        resources.add(material);
    }
    if (o instanceof THREE.SkinnedMesh) resources.add(o.skeleton);
  });
  const owned: THREE.BufferGeometry[] = [];
  try {
    const source = validateNativePlayer(gltf, validate);
    const clone = (g: THREE.BufferGeometry) => {
      const copy = g.clone();
      owned.push(copy);
      return copy;
    };
    const body = clone(source.body),
      jersey = clone(source.jersey);
    const nativeAuthored = {
      mode: NATIVE_PLAYER_MODE,
      shorts: clone(source.shorts),
      socks: clone(source.socks),
    };
    let disposed = false;
    return {
      body,
      jersey,
      nativeAuthored,
      dispose() {
        if (disposed) return;
        disposed = true;
        owned.forEach((g) => g.dispose());
      },
    };
  } catch (error) {
    owned.forEach((g) => g.dispose());
    throw error;
  } finally {
    resources.forEach((resource) => resource.dispose());
  }
}
