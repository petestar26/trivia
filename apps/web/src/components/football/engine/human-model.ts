import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BONES, Region, restPosition, type BoneName, type HumanGeometry } from './rig';

/** Mesh2Motion CC0 human surface, retargeted to our tested foot-contact skeleton.
 * Reuses the locally hosted, pinned Derby human; no external request or second asset copy.
 * Source bind matrices, not the GLB's preview pose, define the rest geometry.
 */
export function retargetHuman(mesh: THREE.SkinnedMesh, face?: THREE.BufferGeometry): HumanGeometry {
  const source = mesh.geometry;
  const p = source.getAttribute('position'),
    joints = source.getAttribute('skinIndex'),
    weights = source.getAttribute('skinWeight');
  const byName = new Map(mesh.skeleton.bones.map((b, i) => [b.name, i]));
  const anchors = new Map<string, THREE.Vector3>();
  for (const [name, i] of byName)
    anchors.set(
      name,
      new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[i].clone().invert())
    );
  const mapping = (
    name: string
  ): { anchor: string; targets: Array<[BoneName, number]>; angle: number } => {
    const side = name.endsWith('_l') ? 'L' : 'R';
    const suffix = side === 'L' ? 'l' : 'r';
    const angle = side === 'L' ? -Math.PI / 2 : Math.PI / 2;
    if (name.startsWith('upperarm'))
      return { anchor: name, targets: [[`upperArm${side}`, 1]], angle };
    if (name.startsWith('lowerarm'))
      return { anchor: name, targets: [[`foreArm${side}`, 1]], angle };
    if (/^(hand|index|middle|ring|pinky|thumb)/.test(name))
      return { anchor: `hand_${suffix}`, targets: [[`hand${side}`, 1]], angle };
    if (name.startsWith('thigh'))
      return { anchor: name, targets: [[`upperLeg${side}`, 1]], angle: 0 };
    if (name.startsWith('calf'))
      return { anchor: name, targets: [[`lowerLeg${side}`, 1]], angle: 0 };
    if (name.startsWith('foot') || name.startsWith('ball'))
      return { anchor: `foot_${suffix}`, targets: [[`foot${side}`, 1]], angle: 0 };
    if (name.startsWith('head')) return { anchor: 'head', targets: [['head', 1]], angle: 0 };
    if (name.startsWith('neck')) return { anchor: 'neck_01', targets: [['neck', 1]], angle: 0 };
    if (name === 'spine_01') return { anchor: name, targets: [['spine', 1]], angle: 0 };
    if (name === 'spine_02')
      return {
        anchor: name,
        targets: [
          ['spine', 0.44],
          ['chest', 0.56],
        ],
        angle: 0,
      };
    if (name === 'spine_03' || name.startsWith('clavicle'))
      return { anchor: 'spine_03', targets: [['chest', 1]], angle: 0 };
    return { anchor: 'pelvis', targets: [['hips', 1]], angle: 0 };
  };
  const transforms = mesh.skeleton.bones.map((b) => {
    const m = mapping(b.name),
      origin = anchors.get(m.anchor);
    if (!origin) throw new Error(`Missing human bind anchor ${m.anchor}`);
    const target = new THREE.Vector3();
    m.targets.forEach(([name, w]) => target.addScaledVector(restPosition(name), w));
    return {
      ...m,
      origin,
      target,
      rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), m.angle),
    };
  });
  const positions = new Float32Array(p.count * 3),
    indices = new Uint16Array(p.count * 4),
    values = new Float32Array(p.count * 4);
  const region = new Float32Array(p.count),
    uvShirt = new Float32Array(p.count * 2),
    theta = new Float32Array(p.count);
  const v = new THREE.Vector3(),
    out = new THREE.Vector3(),
    tmp = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    out.set(0, 0, 0);
    const combined = new Map<BoneName, number>();
    for (let k = 0; k < 4; k++) {
      const w = weights.getComponent(i, k);
      if (w <= 0) continue;
      const t = transforms[joints.getComponent(i, k)];
      if (!t) throw new Error('Invalid human skin joint');
      out.addScaledVector(tmp.copy(v).sub(t.origin).applyQuaternion(t.rotation).add(t.target), w);
      t.targets.forEach(([name, part]) => combined.set(name, (combined.get(name) ?? 0) + w * part));
    }
    out.toArray(positions, i * 3);
    const skin = [...combined].sort((a, b) => b[1] - a[1]).slice(0, 4),
      total = skin.reduce((sum, [, w]) => sum + w, 0);
    if (total <= 0) throw new Error('Unweighted human vertex');
    skin.forEach(([name, w], k) => {
      indices[i * 4 + k] = BONES.indexOf(name);
      values[i * 4 + k] = w / total;
    });
    const x = Math.abs(v.x),
      y = v.y;
    region[i] =
      y > 1.53 && x < 0.085
        ? y > 1.69 && v.z < 0.045
          ? Region.HAIR
          : Region.SKIN
        : y > 1.5 && x < 0.065
          ? Region.SKIN
          : y < 0.105
            ? Region.BOOT
            : y < 0.43
              ? Region.SOCK
              : y < 0.66
                ? Region.SKIN
                : y < 0.96
                  ? Region.SHORTS
                  : x > 0.69
                    ? Region.GLOVE
                    : x > 0.4
                      ? Region.FOREARM
                      : Region.SHIRT;
    theta[i] = Math.atan2(v.z, v.x);
    uvShirt[i * 2] = 1 - (theta[i] + Math.PI) / (2 * Math.PI);
    uvShirt[i * 2 + 1] = 0.5 + 0.5 * Math.min(1, Math.max(0, (y - 0.95) / 0.57));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(values, 4));
  geometry.setIndex(source.getIndex()!.clone());
  geometry.computeVertexNormals();
  const base = { geometry, positions, region, uvShirt, theta };
  return face ? replaceFace(base, source, face) : base;
}
/** Replace the featureless source head with the CC0 anatomical facial surface. */
export function replaceFace(
  base: HumanGeometry,
  source: THREE.BufferGeometry,
  face: THREE.BufferGeometry
): HumanGeometry {
  const positions = Array.from(base.positions),
    skinIndex = Array.from(base.geometry.getAttribute('skinIndex').array),
    skinWeight = Array.from(base.geometry.getAttribute('skinWeight').array);
  const region = Array.from(base.region),
    uv = Array.from(base.uvShirt),
    theta = Array.from(base.theta),
    indices: number[] = [];
  const original = source.getAttribute('position'),
    index = source.getIndex()!;
  for (let i = 0; i < index.count; i += 3) {
    const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    // Retain the torso/arms and remove the old neck/head surface.
    if (ids.every((n) => original.getY(n) > 1.49 && Math.abs(original.getX(n)) < 0.18)) continue;
    indices.push(...ids);
  }
  const append = (g: THREE.BufferGeometry, part?: number) => {
    const p = g.getAttribute('position'),
      offset = positions.length / 3;
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      skinIndex.push(BONES.indexOf('head'), 0, 0, 0);
      skinWeight.push(1, 0, 0, 0);
      region.push(
        part ??
          (p.getY(i) > 1.755 || (p.getY(i) > 1.735 && p.getZ(i) < 0.055)
            ? Region.HAIR
            : Region.SKIN)
      );
      uv.push(0, 0);
      theta.push(0);
    }
    const ix = g.getIndex();
    for (let i = 0; i < (ix?.count ?? p.count); i++) indices.push(offset + (ix ? ix.getX(i) : i));
  };
  append(face);
  // A flexible neck seals the facial cut against the jersey during head turns.
  const neck = new THREE.CylinderGeometry(0.047, 0.057, 0.13, 12, 3).translate(0, 1.535, -0.005);
  const neckStart = positions.length / 3;
  append(neck, Region.SKIN);
  for (let i = neckStart; i < positions.length / 3; i++) {
    const w = Math.min(1, Math.max(0, (positions[i * 3 + 1] - 1.48) / 0.12));
    skinIndex[i * 4] = BONES.indexOf('neck');
    skinIndex[i * 4 + 1] = BONES.indexOf('head');
    skinWeight[i * 4] = 1 - w;
    skinWeight[i * 4 + 1] = w;
  }
  neck.dispose();
  for (const side of [-1, 1]) {
    const eye = new THREE.SphereGeometry(0.016, 8, 6)
      .scale(1, 0.8, 1)
      .translate(side * 0.037, 1.667, 0.133);
    const iris = new THREE.SphereGeometry(0.007, 8, 5)
      .scale(1, 1, 0.35)
      .translate(side * 0.037, 1.667, 0.148);
    append(eye, Region.EYE_WHITE);
    append(iris, Region.EYE_IRIS);
    eye.dispose();
    iris.dispose();
  }
  const g = new THREE.BufferGeometry(),
    outPositions = new Float32Array(positions);
  g.setAttribute('position', new THREE.BufferAttribute(outPositions, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  g.setIndex(indices);
  g.computeVertexNormals();
  base.geometry.dispose();
  return {
    geometry: g,
    positions: outPositions,
    region: new Float32Array(region),
    uvShirt: new Float32Array(uv),
    theta: new Float32Array(theta),
  };
}
export async function loadPlayerGeometry(): Promise<HumanGeometry> {
  const results = await Promise.allSettled([
    new GLTFLoader().loadAsync('/models/derby/jockey.glb'),
    new GLTFLoader().loadAsync('/models/football/face.glb'),
  ]);
  const owned = new Set<{ dispose(): void }>();
  let human: THREE.SkinnedMesh | undefined, face: THREE.BufferGeometry | undefined;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled')
      result.value.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          owned.add(o.geometry);
          if (i === 1) face = o.geometry;
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            owned.add(m);
            Object.values(m).forEach((v) => {
              if (v instanceof THREE.Texture) owned.add(v);
            });
          }
        }
        if (o instanceof THREE.SkinnedMesh) {
          if (i === 0) human = o;
          owned.add(o.skeleton);
        }
      });
  });
  try {
    if (!human || !face) throw new Error('Human surface unavailable');
    return retargetHuman(human, face);
  } finally {
    owned.forEach((o) => o.dispose());
  }
}
