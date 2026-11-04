import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
export const TRACK_LENGTH = 192 + 46 * Math.PI;
/** One stadium-shaped lap; finish is on the home straight. Progress is server-published. */
export function trackPoint(progress: number, lane = 0) {
  const s = (((progress % 1) + 1) % 1) * TRACK_LENGTH,
    radius = 23 + lane;
  if (s < 96) return { x: -48 + s, z: radius, heading: 0 };
  if (s < 96 + 23 * Math.PI) {
    const a = (s - 96) / 23;
    return { x: 48 + Math.sin(a) * radius, z: Math.cos(a) * radius, heading: a };
  }
  if (s < 192 + 23 * Math.PI)
    return { x: 48 - (s - 96 - 23 * Math.PI), z: -radius, heading: Math.PI };
  const a = (s - 192 - 23 * Math.PI) / 23;
  return { x: -48 - Math.sin(a) * radius, z: -Math.cos(a) * radius, heading: Math.PI + a };
}
export function createTrack(scene: THREE.Scene) {
  const resources: { dispose(): void }[] = [];
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  function mat(color: string) {
    let m = materials.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.87 });
      materials.set(color, m);
      resources.push(m);
    }
    return m;
  }
  const ground = mat('#677752'),
    sand = mat('#c6aa82'),
    rail = mat('#f2ece0'),
    dark = mat('#28332e'),
    wine = mat('#532d38');
  function grain(grass: boolean) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = grass ? '#72825b' : '#c6af8c';
    ctx.fillRect(0, 0, 256, 256);
    let seed = 85;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < 18000; i++) {
      const n = Math.floor(rand() * 90);
      ctx.fillStyle = grass
        ? `rgba(${40 + n},${65 + n},${30 + n},.36)`
        : `rgba(${100 + n},${80 + n},${55 + n},.3)`;
      ctx.fillRect(rand() * 256, rand() * 256, 1, grass ? 3 : 1);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(0.6, 0.6);
    t.colorSpace = THREE.SRGBColorSpace;
    resources.push(t);
    return t;
  }
  ground.map = grain(true);
  sand.map = grain(false);
  function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) {
    resources.push(g);
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    o.castShadow = true;
    o.receiveShadow = true;
    scene.add(o);
    return o;
  }
  function box(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    m: THREE.Material
  ) {
    return mesh(new THREE.BoxGeometry(w, h, d), m, x, y, z);
  }
  const grass = mesh(new THREE.PlaneGeometry(700, 700), ground, 0, -0.03, 0);
  grass.rotation.x = -Math.PI / 2;
  function oval(radius: number) {
    const s = new THREE.Shape();
    s.moveTo(-48, radius);
    s.lineTo(48, radius);
    s.absarc(48, 0, radius, Math.PI / 2, -Math.PI / 2, true);
    s.lineTo(-48, -radius);
    s.absarc(-48, 0, radius, -Math.PI / 2, Math.PI / 2, true);
    return s;
  }
  const shape = oval(28);
  shape.holes.push(oval(18));
  const surface = mesh(new THREE.ShapeGeometry(shape, 80), sand);
  surface.rotation.x = -Math.PI / 2;
  for (const offset of [-5.1, 5.1]) {
    const pts = Array.from({ length: 193 }, (_, i) => {
      const p = trackPoint(i / 192, offset);
      return new THREE.Vector3(p.x, 0.73, p.z);
    });
    mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 384, 0.058, 6, true), rail);
    for (let i = 0; i < 100; i++) {
      const p = trackPoint(i / 100, offset);
      box(p.x, 0.35, p.z, 0.09, 0.7, 0.09, rail);
    }
  }
  // Finish strip at the start/finish tangent, with trackside timing posts.
  for (let i = 0; i < 20; i++)
    box(-48, 0.018, 18.25 + i * 0.5, 0.28, 0.025, 0.5, mat(i % 2 ? '#fcf4e4' : '#454c46'));
  box(-48, 1.7, 29, 0.2, 3.4, 0.2, rail);
  box(-48, 1.7, 17, 0.2, 3.4, 0.2, rail);
  // Open starting traps behind the line. Each door opens together at race start.
  const gates: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    box(-50, 0.48, 19.5 + i, 1.6, 0.96, 0.055, dark);
    const door = box(-49.2, 0.48, 20 + i, 0.06, 0.9, 0.84, rail);
    gates.push(door);
  }
  // Layered roofed grandstand with individually coloured seats and fine stair breaks.
  for (let row = 0; row < 7; row++) {
    box(0, 0.35 + row * 0.55, -36 - row * 0.95, 104, 0.3, 1.1, mat('#b9b8ae'));
    for (let col = 0; col < 78; col++) {
      if (col % 13 === 0) continue;
      box(
        -50 + col * 1.3,
        0.7 + row * 0.55,
        -36 - row * 0.95,
        0.9,
        0.55,
        0.7,
        mat((col + row) % 4 ? '#4f6258' : '#7c3b44')
      );
    }
  }
  for (let x = -50; x <= 50; x += 10) box(x, 4.8, -43, 0.25, 9.6, 0.25, dark);
  const roof = box(0, 8.4, -40, 111, 0.25, 17, dark);
  roof.rotation.x = 0.1;
  // Infield hedges, stadium boards and floodlights provide parallax and scale.
  for (const z of [-14, 14]) box(0, 0.45, z, 70, 0.9, 1.2, mat('#384c34'));
  for (let x = -45; x <= 45; x += 15) {
    box(x, 1.15, -29, 14, 1.8, 0.18, wine);
  }
  for (const x of [-65, 0, 65])
    for (const z of [-52, 49]) {
      box(x, 9, z, 0.2, 18, 0.2, dark);
      box(x, 18, z, 3, 0.85, 0.5, rail);
    }
  // Static meshes grouped by material; keeps the detailed course inexpensive on phones.
  scene.updateMatrixWorld(true);
  const groups = new Map<THREE.Material, THREE.Mesh[]>();
  for (const o of scene.children) {
    if (o instanceof THREE.Mesh && !Array.isArray(o.material) && !gates.includes(o)) {
      const list = groups.get(o.material) || [];
      list.push(o);
      groups.set(o.material, list);
    }
  }
  for (const [m, list] of groups) {
    if (list.length < 2) continue;
    const parts = list.map((o) => o.geometry.clone().applyMatrix4(o.matrixWorld));
    const g = mergeGeometries(parts);
    parts.forEach((p) => p.dispose());
    if (g) {
      resources.push(g);
      const merged = new THREE.Mesh(g, m);
      merged.castShadow = merged.receiveShadow = true;
      scene.add(merged);
      list.forEach((o) => scene.remove(o));
    }
  }
  return { gates, dispose: () => resources.forEach((r) => r.dispose()) };
}
