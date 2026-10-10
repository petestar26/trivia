import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Seated anatomical silhouette, +Z toward the pitch. Three instanced material groups.
 * Rounded torso, bent legs, shoulders, forearms, neck, face and hair; no per-fan skeleton.
 */
export function spectatorGeometry() {
  const clothes: THREE.BufferGeometry[] = [],
    skin: THREE.BufferGeometry[] = [],
    dark: THREE.BufferGeometry[] = [];
  function oval(
    parts: THREE.BufferGeometry[],
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    segments = 5,
    rings = 3
  ) {
    parts.push(new THREE.SphereGeometry(1, segments, rings).scale(sx, sy, sz).translate(x, y, z));
  }
  function limb(parts: THREE.BufferGeometry[], a: number[], b: number[], radius: number) {
    const from = new THREE.Vector3(...a),
      to = new THREE.Vector3(...b),
      delta = to.clone().sub(from);
    const g = new THREE.CylinderGeometry(radius * 0.85, radius, delta.length(), 5);
    g.applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize())
    );
    g.translate(...from.add(to).multiplyScalar(0.5).toArray());
    parts.push(g);
  }
  oval(clothes, 0, 0.31, 0, 0.23, 0.31, 0.13);
  oval(dark, 0, 0.025, 0.015, 0.205, 0.13, 0.15);
  for (const side of [-1, 1]) {
    limb(dark, [side * 0.12, 0.025, 0.02], [side * 0.14, -0.015, 0.36], 0.085);
    limb(dark, [side * 0.14, -0.015, 0.36], [side * 0.14, -0.4, 0.4], 0.055);
    oval(dark, side * 0.14, -0.42, 0.46, 0.065, 0.055, 0.12);
    limb(clothes, [side * 0.19, 0.48, 0], [side * 0.25, 0.24, 0.12], 0.065);
    limb(skin, [side * 0.25, 0.24, 0.12], [side * 0.15, 0.1, 0.33], 0.045);
    oval(skin, side * 0.15, 0.1, 0.33, 0.05, 0.035, 0.06);
  }
  limb(skin, [0, 0.52, 0], [0, 0.65, 0], 0.065);
  oval(skin, 0, 0.74, 0.015, 0.115, 0.145, 0.105, 6, 4);
  oval(skin, 0, 0.73, 0.11, 0.032, 0.039, 0.032);
  for (const side of [-1, 1]) oval(skin, side * 0.115, 0.74, 0.01, 0.024, 0.045, 0.023);
  oval(dark, 0, 0.83, -0.008, 0.116, 0.075, 0.102, 6, 3);
  const merge = (parts: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(parts)!;
    parts.forEach((p) => p.dispose());
    return g;
  };
  return { clothes: merge(clothes), skin: merge(skin), dark: merge(dark) };
}
