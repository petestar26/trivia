import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BONES, type HumanGeometry, type Rig } from './rig';

export type PlayerDetail = 'high' | 'mid' | 'low';
export interface PlayerIdentity {
  name: string;
  seed: number;
  skin: string;
  hair: string;
  eye: string;
  style: number;
  nose: number;
  lips: number;
  ears: number;
}
const NAMES = [
  'Ari Vale',
  'Niko Arden',
  'Tari Morrow',
  'Mateo Quinn',
  'Luca Ash',
  'Kian Solis',
  'Amir Rowan',
  'Jules West',
  'Noah Reed',
  'Davi Bell',
  'Theo Lane',
];
const SURNAMES = [
  'Vale',
  'Arden',
  'Morrow',
  'Quinn',
  'Ash',
  'Solis',
  'Rowan',
  'West',
  'Reed',
  'Bell',
  'Lane',
  'Linden',
  'Hart',
  'Oakley',
  'Raven',
  'Brook',
  'Finch',
  'Cove',
  'Kestrel',
  'Hale',
  'Marin',
  'Dale',
  'Alder',
];
const SKINS = ['#e9ba97', '#c38a65', '#99633f', '#613e2d', '#edcbb0', '#b67b58'];
const HAIR = ['#161311', '#38271e', '#795636', '#b89a60', '#241d19'];
const EYES = ['#597260', '#705237', '#526373', '#422f23', '#6f7b67'];
/** Original fictional identities depend on stable display IDs and slots, never outcomes. */
export function playerIdentity(club: number, slot: number): PlayerIdentity {
  const seed = (club * 1664525 + slot * 1013904223) >>> 0;
  return {
    name: `${NAMES[slot % NAMES.length].split(' ')[0]} ${SURNAMES[(club + slot * 3) % SURNAMES.length]}`,
    seed,
    skin: SKINS[(club + slot * 5) % SKINS.length],
    hair: HAIR[(club * 3 + slot) % HAIR.length],
    eye: EYES[(club + slot * 7) % EYES.length],
    style: (club + slot) % 3,
    nose: ((seed % 7) - 3) / 12,
    lips: (((seed >>> 5) % 7) - 3) / 14,
    ears: (((seed >>> 11) % 7) - 3) / 16,
  };
}
function noise(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 4294967296;
  };
}
/** Original shared pore/weave maps: no photograph, scan or vendor texture. */
export function appearanceTextures(kind: 'skin' | 'fabric') {
  const size = 512,
    normalCanvas = document.createElement('canvas'),
    roughCanvas = document.createElement('canvas');
  normalCanvas.width = roughCanvas.width = size;
  normalCanvas.height = roughCanvas.height = size;
  const n = normalCanvas.getContext('2d')!,
    r = roughCanvas.getContext('2d')!;
  const image = n.createImageData(size, size),
    rough = r.createImageData(size, size),
    rand = noise(kind === 'skin' ? 781 : 317);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4,
        active = y < size * 0.8;
      const weave =
        kind === 'fabric'
          ? (Math.sin((x * Math.PI) / 3) + Math.sin((y * Math.PI) / 3)) * 0.5
          : rand() - 0.5;
      const amp = active ? (kind === 'fabric' ? 9 : 5) : 0;
      image.data[i] = 128 + amp * weave;
      image.data[i + 1] = 128 + amp * (rand() - 0.5);
      image.data[i + 2] = 255;
      image.data[i + 3] = 255;
      const value = active
        ? (kind === 'fabric' ? 215 : 135) + (rand() - 0.5) * 12
        : kind === 'fabric'
          ? 180
          : 36;
      rough.data[i] = rough.data[i + 1] = rough.data[i + 2] = value;
      rough.data[i + 3] = 255;
    }
  n.putImageData(image, 0, 0);
  r.putImageData(rough, 0, 0);
  const normal = new THREE.CanvasTexture(normalCanvas),
    roughness = new THREE.CanvasTexture(roughCanvas);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  roughness.wrapS = roughness.wrapT = THREE.RepeatWrapping;
  return {
    normal,
    roughness,
    dispose() {
      normal.dispose();
      roughness.dispose();
    },
  };
}
export function headMaterial(maps: ReturnType<typeof appearanceTextures>) {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(0.22, 0.22),
    roughnessMap: maps.roughness,
    roughness: 1,
    metalness: 0,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float part; varying float vPart;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPart=part;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPart;')
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nif(vPart>2.5 && vPart<5.5) roughnessFactor=0.16; else if(vPart>5.5) roughnessFactor=0.83; else if(vPart>0.5 && vPart<1.5) roughnessFactor=0.38;'
      );
  };
  m.customProgramCacheKey = () => 'playqube-anatomical-surface-v1';
  return m;
}
/** Each look owns colors/UVs; all positions, normals, skins and morph buffers stay shared. */
export function headLook(base: THREE.BufferGeometry, identity: PlayerIdentity) {
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(base.attributes)) g.setAttribute(name, base.getAttribute(name));
  g.setIndex(base.getIndex());
  g.morphAttributes = base.morphAttributes;
  g.morphTargetsRelative = base.morphTargetsRelative;
  g.userData = { ...base.userData };
  const p = base.getAttribute('position'),
    part = base.getAttribute('_part') ?? base.getAttribute('part');
  const c = new Float32Array(p.count * 3),
    uv = new Float32Array(p.count * 2),
    sourceUv = base.getAttribute('uv');
  const skin = new THREE.Color(identity.skin),
    lip = skin.clone().lerp(new THREE.Color('#a46965'), 0.34);
  const table = [
    skin,
    lip,
    skin.clone().multiplyScalar(0.83),
    new THREE.Color('#e7e5d9'),
    new THREE.Color(identity.eye),
    new THREE.Color('#070807'),
    new THREE.Color(identity.hair),
    new THREE.Color('#3a181a'),
  ];
  for (let i = 0; i < p.count; i++) {
    const region = Math.round(part?.getX(i) ?? 0),
      color = (table[region] ?? skin).clone();
    if (region === 4) color.multiplyScalar(base.getAttribute('_iris')?.getX(i) ?? 1);
    if (region === 0) {
      // Restrained original cheek/nose circulation and fine pigment, not a scan texture.
      const x = p.getX(i),
        y = p.getY(i),
        z = p.getZ(i);
      const cheek =
        Math.exp(-((Math.abs(x) - 0.05) ** 2 / 0.0005 + (y - 1.638) ** 2 / 0.0006)) *
        Math.max(0, z / 0.15);
      color.lerp(new THREE.Color('#b57769'), cheek * 0.12);
      color.multiplyScalar(1 + Math.sin(x * 812 + y * 573) * Math.sin(z * 797) * 0.018);
    }
    color.toArray(c, i * 3);
    uv[i * 2] = (sourceUv?.getX(i) ?? 0.5) * 0.78 + 0.1;
    uv[i * 2 + 1] = region >= 3 ? 0.05 : (sourceUv?.getY(i) ?? 0.5) * 0.72 + 0.24;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (part) g.setAttribute('part', part);
  return g;
}
const hairCache = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();
/** A clipped anatomical scalp gives a continuous hairline. Original short swept
 * strands sit tangentially on the cap; distant caps retain every identity's hair. */
function hairGeometry(base: THREE.BufferGeometry, style: number, detail: PlayerDetail) {
  let cache = hairCache.get(base);
  if (!cache) {
    cache = new Map();
    hairCache.set(base, cache);
  }
  const key = `${style}:${detail}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const p = base.getAttribute('position'),
    n = base.getAttribute('normal'),
    part = base.getAttribute('_part'),
    ix = base.getIndex()!;
  type V = { p: THREE.Vector3; n: THREE.Vector3 };
  const cut = (v: V) => {
    const front = THREE.MathUtils.smoothstep(v.p.z, -0.015, 0.09);
    const temple = Math.min(1, Math.abs(v.p.x) / 0.07);
    return v.p.y - (1.71 + front * (0.05 - temple * 0.015));
  };
  const positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [];
  for (let i = 0; i < ix.count; i += 3) {
    const ids = [ix.getX(i), ix.getX(i + 1), ix.getX(i + 2)];
    if (ids.some((v) => (part?.getX(v) ?? 0) !== 0)) continue;
    let poly: V[] = ids.map((v) => ({
      p: new THREE.Vector3().fromBufferAttribute(p, v),
      n: new THREE.Vector3().fromBufferAttribute(n, v),
    }));
    const out: V[] = [];
    for (let v = 0; v < poly.length; v++) {
      const a = poly[v],
        b = poly[(v + 1) % poly.length],
        da = cut(a),
        db = cut(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push({ p: a.p.clone().lerp(b.p, t), n: a.n.clone().lerp(b.n, t).normalize() });
      }
    }
    poly = out;
    if (poly.length < 3) continue;
    const start = positions.length / 3;
    for (const v of poly) {
      const swell = style === 1 ? 0.004 * (1 + Math.max(0, v.p.z / 0.1)) : 0.002;
      v.p.addScaledVector(v.n, swell);
      positions.push(...v.p.toArray());
      normals.push(...v.n.toArray());
    }
    for (let t = 1; t < poly.length - 1; t++) indices.push(start, start + t, start + t + 1);
  }
  const cap = new THREE.BufferGeometry();
  cap.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  cap.setIndex(indices);
  cap.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  cap.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      positions.flatMap((_, i) => (i % 3 === 0 ? [positions[i] * 8, positions[i + 2] * 8] : [])),
      2
    )
  );
  const pieces = [cap];
  if (detail === 'high') {
    const cp = cap.getAttribute('position'),
      cn = cap.getAttribute('normal'),
      rand = noise(704 + style),
      roots = new Set<string>();
    for (let i = 0; i < cp.count; i += 11) {
      const root = new THREE.Vector3().fromBufferAttribute(cp, i),
        normal = new THREE.Vector3().fromBufferAttribute(cn, i);
      const bucket = root
        .toArray()
        .map((v) => Math.round(v * 160))
        .join(',');
      if (roots.has(bucket)) continue;
      roots.add(bucket);
      const tangent = new THREE.Vector3(style === 2 ? -0.008 : 0.006, 0.002, -0.007);
      tangent.addScaledVector(normal, -tangent.dot(normal));
      const length = style === 1 ? 0.0025 : 0.001;
      const points = [
        root,
        root.clone().addScaledVector(tangent, 0.5).addScaledVector(normal, length),
        root
          .clone()
          .add(tangent)
          .addScaledVector(normal, length * 0.35),
      ];
      pieces.push(
        new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3(points),
          2,
          0.0006 + rand() * 0.0002,
          3,
          false
        )
      );
    }
  }
  const g = mergeGeometries(pieces)!;
  pieces.forEach((x) => x.dispose());
  const count = g.getAttribute('position').count,
    skin = new Uint16Array(count * 4),
    weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    skin[i * 4] = BONES.indexOf('head');
    weights[i * 4] = 1;
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(skin, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4));
  cache.set(key, g);
  return g;
}
/** Called once when the shared asset set is no longer rendered. */
export function disposeHairAssets(heads: NonNullable<HumanGeometry['heads']>) {
  for (const base of Object.values(heads)) {
    hairCache.get(base)?.forEach((g) => g.dispose());
    hairCache.delete(base);
  }
}
const hairMaterials = new Map<string, { material: THREE.MeshStandardMaterial; refs: number }>();
function ownHairMaterial(color: string) {
  let shared = hairMaterials.get(color);
  if (!shared) {
    shared = { material: new THREE.MeshStandardMaterial({ color, roughness: 0.85 }), refs: 0 };
    hairMaterials.set(color, shared);
  }
  shared.refs++;
  return {
    material: shared.material,
    dispose() {
      if (--shared!.refs === 0) {
        shared!.material.dispose();
        hairMaterials.delete(color);
      }
    },
  };
}
export interface HeadVisual {
  mesh: THREE.SkinnedMesh;
  hair: THREE.SkinnedMesh;
  setDetail(detail: PlayerDetail): void;
  animate(time: number, kind: string, moving: boolean): void;
  dispose(): void;
}
export function attachPlayerHead(
  rig: Rig,
  assets: NonNullable<HumanGeometry['heads']>,
  identity: PlayerIdentity,
  material: THREE.Material
): HeadVisual {
  const looks = {
    high: headLook(assets.high, identity),
    mid: headLook(assets.mid, identity),
    low: headLook(assets.low, identity),
  };
  const mesh = new THREE.SkinnedMesh(looks.mid, material);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  rig.root.add(mesh);
  mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
  const hairs = {
    high: hairGeometry(assets.high, identity.style, 'high'),
    mid: hairGeometry(assets.mid, identity.style, 'mid'),
    low: hairGeometry(assets.low, identity.style, 'low'),
  };
  const hairLook = ownHairMaterial(identity.hair);
  const hair = new THREE.SkinnedMesh(hairs.mid, hairLook.material);
  hair.frustumCulled = false;
  hair.castShadow = true;
  rig.root.add(hair);
  hair.bind(rig.skeleton, rig.mesh.bindMatrix);
  let detail: PlayerDetail = 'mid';
  function morphs() {
    mesh.updateMorphTargets();
    const names = assets.high.userData.morphNames as Record<string, number> | undefined;
    if (names) mesh.morphTargetDictionary = { ...names };
  }
  morphs();
  function set(name: string, value: number) {
    const i = mesh.morphTargetDictionary?.[name];
    if (i !== undefined && mesh.morphTargetInfluences) mesh.morphTargetInfluences[i] = value;
  }
  function animate(time: number, kind: string, moving: boolean) {
    set('noseWidth', identity.nose);
    set('lipFullness', identity.lips);
    set('earSize', identity.ears);
    const clock = (((time + (identity.seed % 997) * 0.007) % 4.7) + 4.7) % 4.7;
    const blink = moving && detail !== 'low' && clock < 0.2 ? Math.sin((clock / 0.2) * Math.PI) : 0;
    set('blinkLeft', blink);
    set('blinkRight', blink);
    set('jawOpen', moving && kind === 'run' ? 0.08 : 0);
    set('browRaise', moving && kind === 'celebrate' ? 0.2 : 0);
    set('smile', moving && kind === 'celebrate' ? 0.28 : 0);
  }
  return {
    mesh,
    hair,
    setDetail(next) {
      if (detail === next) return;
      detail = next;
      mesh.geometry = looks[next];
      morphs();
      hair.geometry = hairs[next];
    },
    animate,
    dispose() {
      mesh.removeFromParent();
      hair.removeFromParent();
      Object.values(looks).forEach((x) => x.dispose());
      hairLook.dispose();
    },
  };
}
const fingerEuler = new THREE.Euler();
/** Finger joint poses preserve the authored palm/wrist and world hand-contact target. */
export function poseFingers(rig: Rig, kind: string, moving: boolean, control?: number[]) {
  const curl = !moving
    ? 0.1
    : kind === 'keeperDive'
      ? 0.05
      : kind === 'celebrate'
        ? 0.48
        : kind === 'run'
          ? 0.22
          : 0.14;
  for (const side of ['L', 'R'] as const)
    for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky'] as const)
      for (let joint = 1; joint <= 3; joint++) {
        const b = rig.bones[`${f}${joint}${side}` as keyof typeof rig.bones];
        const handCurl =
          control && moving ? THREE.MathUtils.clamp(control[side === 'L' ? 0 : 1], 0, 0.85) : curl;
        const spread = control && moving ? THREE.MathUtils.clamp(control[2], -0.2, 0.2) : 0;
        b.quaternion.setFromEuler(
          fingerEuler.set(
            -(f === 'thumb' ? 0.35 : 1) *
              (handCurl + (f === 'pinky' ? 0.04 : 0)) *
              (joint === 1 ? 0.7 : 1),
            0,
            f === 'thumb'
              ? side === 'L'
                ? 0.12
                : -0.12
              : joint === 1
                ? spread * (f === 'pinky' ? 1 : f === 'ring' ? 0.5 : f === 'index' ? -0.5 : 0)
                : 0
          )
        );
      }
}

/** Original boot overlays follow the existing ankle/contact frame. They appear
 * only on close players; the shared anatomical boot remains at all other LODs. */
function createBootResources() {
  const pieces: THREE.BufferGeometry[] = [];
  const sole = new THREE.CylinderGeometry(1, 1, 0.007, 12)
    .scale(0.055, 1, 0.138)
    .translate(0, -0.059, 0.068);
  const solePosition = sole.getAttribute('position');
  for (let i = 0; i < solePosition.count; i++)
    solePosition.setY(
      i,
      solePosition.getY(i) + Math.max(0, solePosition.getZ(i) - 0.15) * Math.tan(0.85)
    );
  sole.computeVertexNormals();
  pieces.push(sole);
  for (const x of [-0.034, 0.034])
    for (const z of [-0.026, 0.058, 0.169]) {
      const stud = new THREE.CylinderGeometry(0.006, 0.005, 0.007, 5).translate(x, -0.0665, z),
        vertices = stud.getAttribute('position');
      for (let i = 0; i < vertices.count; i++)
        vertices.setY(i, vertices.getY(i) + Math.max(0, vertices.getZ(i) - 0.15) * Math.tan(0.85));
      stud.computeVertexNormals();
      pieces.push(stud);
    }
  const soleGeometry = mergeGeometries(pieces)!;
  pieces.forEach((g) => g.dispose());
  const lacePieces: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const z = 0.042 + i * 0.021;
    lacePieces.push(
      new THREE.TubeGeometry(
        new THREE.LineCurve3(
          new THREE.Vector3(-0.026, 0.002, z),
          new THREE.Vector3(0.026, 0.002, z + 0.008)
        ),
        1,
        0.0016,
        3,
        false
      )
    );
  }
  const laceGeometry = mergeGeometries(lacePieces)!;
  lacePieces.forEach((g) => g.dispose());
  const soleMaterial = new THREE.MeshStandardMaterial({ color: '#202329', roughness: 0.7 }),
    laceMaterial = new THREE.MeshStandardMaterial({ color: '#d1c4b8', roughness: 0.85 });
  return { soleGeometry, laceGeometry, soleMaterial, laceMaterial };
}
let bootResources: ReturnType<typeof createBootResources> | undefined,
  bootUsers = 0;
export function attachBootDetails(rig: Rig) {
  const resource = (bootResources ??= createBootResources());
  bootUsers++;
  const { soleGeometry, laceGeometry, soleMaterial, laceMaterial } = resource;
  const groups = ['L', 'R'].map((side) => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(soleGeometry, soleMaterial), new THREE.Mesh(laceGeometry, laceMaterial));
    rig.bones[`foot${side}` as 'footL' | 'footR'].add(g);
    g.visible = false;
    return g;
  });
  return {
    setDetail(detail: PlayerDetail) {
      groups.forEach((g) => (g.visible = detail === 'high'));
    },
    dispose() {
      groups.forEach((g) => g.removeFromParent());
      if (--bootUsers === 0) {
        soleGeometry.dispose();
        laceGeometry.dispose();
        soleMaterial.dispose();
        laceMaterial.dispose();
        bootResources = undefined;
      }
    },
  };
}
