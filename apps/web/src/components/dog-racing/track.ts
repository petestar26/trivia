import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RACING_DOGS } from '@socialplay/shared';

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
/** Half-width of the sand between the rails, in metres from the centre lane. */
export const TRACK_HALF_WIDTH = 5.1;
/** Lateral offset of runner `index` in a field of `field`, centred on the 23 m lane. */
export const laneOffset = (index: number, field: number) => (index - (field - 1) / 2) * 0.87;
/** Start traps straddle the line; doors sit just ahead of a standing runner's nose. */
const TRAP_FRONT = -47.04;
/** After the break the unit rolls forward clear of the finish post, then onto the infield. */
const TRAP_ROLL = 2.2,
  TRAP_PARK = 13;

type Detail = 'high' | 'balanced' | 'low';
function seeded(seed: number) {
  return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
}
function canvas(width: number, height: number) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return { c, ctx: c.getContext('2d') };
}
/** Raked sand: fine harrow lines along the running direction over warm, uneven grain. */
function sandTexture(size: number) {
  const { c, ctx } = canvas(size, size);
  if (!ctx) return null;
  const rand = seeded(85);
  ctx.fillStyle = '#c7a679';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size * size * 0.35; i++) {
    const n = Math.floor(rand() * 70);
    ctx.fillStyle = `rgba(${110 + n},${84 + n},${54 + n},.28)`;
    ctx.fillRect(rand() * size, rand() * size, 1, 1);
  }
  // Harrow lines run along u (the lap direction).
  for (let y = 0; y < size; y += 3 + Math.floor(rand() * 3)) {
    ctx.fillStyle = `rgba(${rand() < 0.5 ? '96,72,46' : '232,210,174'},${0.08 + rand() * 0.08})`;
    ctx.fillRect(0, y, size, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
/** Mown grass with broad alternating stripes, in world units. */
function grassTexture(size: number, stripes: boolean) {
  const { c, ctx } = canvas(size, size);
  if (!ctx) return null;
  const rand = seeded(stripes ? 11 : 23);
  ctx.fillStyle = '#5f7a43';
  ctx.fillRect(0, 0, size, size);
  if (stripes) {
    ctx.fillStyle = 'rgba(160,190,110,.16)';
    ctx.fillRect(0, 0, size / 2, size);
  }
  for (let i = 0; i < size * size * 0.5; i++) {
    const n = Math.floor(rand() * 60);
    ctx.fillStyle = `rgba(${40 + n},${70 + n},${28 + n * 0.6},.3)`;
    ctx.fillRect(rand() * size, rand() * size, 1, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function trapFace(index: number) {
  const dog = RACING_DOGS[index];
  const { c, ctx } = canvas(64, 64);
  if (!ctx) return null;
  ctx.fillStyle = dog.color;
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = dog.ink;
  ctx.font = 'bold 44px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(index + 1), 32, 35);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

type Surface = THREE.MeshStandardMaterial | THREE.MeshLambertMaterial;
type SurfaceParameters = THREE.MeshStandardMaterialParameters & THREE.MeshLambertMaterialParameters;

export function createTrack(scene: THREE.Scene, detail: Detail = 'balanced') {
  const resources: { dispose(): void }[] = [];
  const materials = new Map<string, Surface>();
  const own = <T extends { dispose(): void }>(r: T) => (resources.push(r), r);
  /**
   * Scenery is matte, so below High it uses Lambert shading: no per-pixel PBR or
   * sky-reflection lookups over the large sand, grass and stand surfaces, which a
   * frame-cost study showed to be most of the Balanced shading cost. The runners keep
   * full PBR. High keeps PBR everywhere.
   */
  function surface(parameters: SurfaceParameters): Surface {
    if (detail === 'high') return new THREE.MeshStandardMaterial(parameters);
    const lambert = { ...parameters };
    delete lambert.roughness;
    delete lambert.metalness;
    return new THREE.MeshLambertMaterial(lambert);
  }
  function mat(color: string, roughness = 0.86, emissive?: string) {
    const key = color + roughness + (emissive ?? '');
    let m = materials.get(key);
    if (!m) {
      m = own(surface({ color, roughness, metalness: 0 }));
      if (emissive) {
        m.emissive.set(emissive);
        m.emissiveIntensity = 1.4;
      }
      materials.set(key, m);
    }
    return m;
  }
  const texSize = detail === 'low' ? 128 : 256;
  const sand = own(surface({ vertexColors: true, roughness: 0.96, metalness: 0 }));
  const sandMap = sandTexture(texSize);
  if (sandMap) sand.map = own(sandMap);
  const grassMap = grassTexture(texSize, false),
    infieldMap = grassTexture(texSize, true);
  const ground = own(surface({ color: '#ffffff', roughness: 0.95 }));
  if (grassMap) {
    ground.map = own(grassMap);
    grassMap.repeat.set(70, 70);
  }
  const infield = own(surface({ color: '#ffffff', roughness: 0.93 }));
  if (infieldMap) {
    infield.map = own(infieldMap);
    infieldMap.repeat.set(1 / 8, 1 / 8);
  }
  const rail = mat('#f1ede4', 0.5),
    dark = mat('#24302b', 0.7),
    hareCover = mat('#56705a', 0.85);

  function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, cast = false) {
    own(g);
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    o.castShadow = cast;
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
    m: THREE.Material,
    cast = false
  ) {
    return mesh(new THREE.BoxGeometry(w, h, d), m, x, y, z, cast);
  }

  // Outer ground.
  const grass = mesh(new THREE.PlaneGeometry(700, 700), ground, 0, -0.04, 0);
  grass.rotation.x = -Math.PI / 2;
  // Infield inside the hare rail, stripes laid in world space.
  const inner = new THREE.Shape();
  const r0 = 23 - TRACK_HALF_WIDTH - 0.25;
  inner.moveTo(-48, r0);
  inner.lineTo(48, r0);
  inner.absarc(48, 0, r0, Math.PI / 2, -Math.PI / 2, true);
  inner.lineTo(-48, -r0);
  inner.absarc(-48, 0, r0, -Math.PI / 2, Math.PI / 2, true);
  const field = mesh(new THREE.ShapeGeometry(inner, 48), infield, 0, -0.01, 0);
  field.rotation.x = -Math.PI / 2;

  // Racing surface as a ribbon around the lap: u along the run, v across it.
  {
    const steps = detail === 'low' ? 240 : 480,
      across = [-5.4, -4.6, -3.2, -1.2, 0, 1.2, 3.2, 4.6, 5.4];
    const pos: number[] = [],
      uv: number[] = [],
      col: number[] = [],
      idx: number[] = [];
    const tint = new THREE.Color();
    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      across.forEach((offset) => {
        const p = trackPoint(progress, offset);
        pos.push(p.x, 0, p.z);
        uv.push((progress * TRACK_LENGTH) / 9, (offset + 5.4) / 4.5);
        // Compacted, slightly darker running lanes; looser, paler sand banked at the rails.
        const edge = Math.max(0, Math.abs(offset) - 3.6) / 1.8;
        const worn = Math.exp(-((offset + 1.4) ** 2) / 5) * 0.08;
        tint.setRGB(1, 1, 1).offsetHSL(0, -0.02 * edge, 0.07 * edge - worn);
        col.push(tint.r, tint.g, tint.b);
      });
    }
    const row = across.length;
    for (let i = 0; i < steps; i++)
      for (let j = 0; j < row - 1; j++) {
        const a = i * row + j;
        idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    mesh(g, sand);
  }

  // Running rails. The inner rail carries the green hare-rail cover; a gap near the
  // traps lets the start unit be wheeled onto the infield after the break.
  const gap = (p: { x: number; z: number }) =>
    p.z > 0 && p.x > TRAP_FRONT - 2.2 + TRAP_ROLL - 0.3 && p.x < TRAP_FRONT + TRAP_ROLL + 0.5;
  for (const offset of [-TRACK_HALF_WIDTH - 0.15, TRACK_HALF_WIDTH + 0.15]) {
    const insideRail = offset < 0;
    const count = Math.round(TRACK_LENGTH / 0.75);
    let run: THREE.Vector3[] = [];
    const flush = () => {
      if (run.length > 1) {
        const curve = new THREE.CatmullRomCurve3(run);
        mesh(new THREE.TubeGeometry(curve, run.length, 0.05, 5, false), rail, 0, 0, 0);
        if (insideRail) {
          const cover = new THREE.CatmullRomCurve3(
            run.map((v) => new THREE.Vector3(v.x, 0.11, v.z))
          );
          mesh(new THREE.TubeGeometry(cover, run.length, 0.12, 4, false), hareCover);
        }
      }
      run = [];
    };
    for (let i = 0; i <= count; i++) {
      const p = trackPoint(i / count, offset);
      if (insideRail && gap(p)) {
        flush();
        continue;
      }
      run.push(new THREE.Vector3(p.x, insideRail ? 0.62 : 0.86, p.z));
    }
    flush();
    for (let i = 0; i < Math.round(TRACK_LENGTH / 3); i++) {
      const p = trackPoint(i / Math.round(TRACK_LENGTH / 3), offset);
      if (insideRail && gap(p)) continue;
      const h = insideRail ? 0.62 : 0.86;
      box(p.x, h / 2, p.z, 0.07, h, 0.07, rail);
    }
    // Low kickboard on the outside keeps the course readable against the grass.
    if (!insideRail) {
      const pts = Array.from({ length: 241 }, (_, i) => {
        const p = trackPoint(i / 240, offset + 0.05);
        return new THREE.Vector3(p.x, 0.16, p.z);
      });
      mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 480, 0.16, 4, true),
        mat('#e6e1d6', 0.8)
      );
    }
  }

  // Finish: a crisp line across the sand, a slim post with the red disc on the inner rail
  // (seen across the course from the rail camera) and the photo-finish tower set back.
  box(-48, 0.012, 23, 0.26, 0.012, 10.6, mat('#fbfaf6', 0.7));
  box(-48, 1.5, 17.45, 0.12, 3.0, 0.12, rail, true);
  {
    const disc = mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 0.04, 24),
      mat('#c4252f', 0.6),
      -48,
      3.05,
      17.45,
      true
    );
    disc.rotation.x = Math.PI / 2;
  }
  box(-41.5, 2.2, 12.2, 2.4, 4.4, 2.2, mat('#d9d4c8', 0.8), true);
  box(-41.5, 4.5, 12.2, 2.8, 0.2, 2.6, dark);
  box(-41.5, 3.4, 13.32, 1.6, 0.8, 0.02, mat('#1b2a30', 0.25));
  // Start traps: eight numbered boxes with lifting grille doors.
  const traps = new THREE.Group();
  const gates: THREE.Mesh[] = [];
  const trapBody = mat('#d6d0c2', 0.75),
    trapTop = mat('#3b5646', 0.7);
  // Grille doors: bars cut out with an alpha mask, so the runners show through.
  const grille = own(
    surface({
      color: '#262b2a',
      roughness: 0.45,
      metalness: 0.5,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    })
  );
  {
    const { c, ctx } = canvas(64, 64);
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#fff';
      for (let x = 2; x < 64; x += 8) ctx.fillRect(x, 0, 3, 64);
      ctx.fillRect(0, 0, 64, 5);
      ctx.fillRect(0, 59, 64, 5);
      ctx.fillRect(0, 0, 4, 64);
      ctx.fillRect(60, 0, 4, 64);
      grille.alphaMap = own(new THREE.CanvasTexture(c));
    }
  }
  // Eight bays, each holding one numbered runner; positioned per field size so box n
  // always holds runner n (a six-dog race uses six centred bays).
  const bays: THREE.Group[] = [];
  for (let i = 0; i < 8; i++) {
    const bay = new THREE.Group();
    const shell = new THREE.Mesh(own(new THREE.BoxGeometry(2.0, 1.3, 0.08)), trapBody);
    shell.position.set(TRAP_FRONT - 1.0, 0.65, -0.435);
    const roof = new THREE.Mesh(own(new THREE.BoxGeometry(2.05, 0.08, 0.88)), trapTop);
    roof.position.set(TRAP_FRONT - 1.0, 1.32, 0);
    const map = trapFace(i);
    const faceMat = own(surface({ map: map ? own(map) : null, roughness: 0.7 }));
    const face = new THREE.Mesh(own(new THREE.PlaneGeometry(0.62, 0.32)), faceMat);
    face.position.set(TRAP_FRONT + 0.01, 1.13, 0);
    face.rotation.y = Math.PI / 2;
    const door = new THREE.Mesh(own(new THREE.BoxGeometry(0.04, 0.9, 0.8)), grille);
    door.position.set(TRAP_FRONT + 0.02, 0.47, 0);
    door.castShadow = true;
    shell.castShadow = roof.castShadow = true;
    bay.add(shell, roof, face, door);
    bay.position.z = 23 + laneOffset(i, 8);
    traps.add(bay);
    bays.push(bay);
    gates.push(door);
  }
  const endWall = new THREE.Mesh(own(new THREE.BoxGeometry(2.0, 1.3, 0.08)), trapBody);
  endWall.castShadow = true;
  endWall.position.set(TRAP_FRONT - 1.0, 0.65, 23 + laneOffset(7, 8) + 0.435);
  traps.add(endWall);
  scene.add(traps);

  // Grandstand along the back straight, set back so a rail camera passes in front of it.
  for (let row = 0; row < 7; row++) {
    box(0, 0.35 + row * 0.55, -38 - row * 0.95, 104, 0.3, 1.1, mat('#a9aaa2'));
    for (let col = 0; col < 78; col++) {
      if (col % 13 === 0) continue;
      box(
        -50 + col * 1.3,
        0.7 + row * 0.55,
        -38 - row * 0.95,
        0.9,
        0.5,
        0.65,
        mat((col * 7 + row * 3) % 5 ? '#3f5449' : '#6e3540')
      );
    }
  }
  box(0, 4.5, -45.2, 108, 9, 0.4, mat('#27322d'));
  for (let x = -50; x <= 50; x += 10) box(x, 4.8, -44.6, 0.25, 9.6, 0.25, dark);
  const roof = box(0, 9.4, -41.5, 111, 0.25, 9, dark);
  roof.rotation.x = 0.08;
  // Sponsor-free boards along the outside of the back straight.
  for (let x = -45; x <= 45; x += 15) box(x, 0.75, -30.2, 14, 1.0, 0.12, mat('#4a2a33'));
  // Floodlight towers with lamp heads.
  for (const x of [-65, 0, 65])
    for (const z of [-54, 50]) {
      box(x, 9, z, 0.3, 18, 0.3, dark);
      box(x, 18.4, z, 3.4, 1.1, 0.5, mat('#30363a', 0.6));
      box(x, 18.4, z + (z > 0 ? -0.27 : 0.27), 3.0, 0.8, 0.04, mat('#fff4d8', 0.4, '#fff1cc'));
    }
  // A low, distant tree line: depth and a soft horizon on every camera, not scenery to look at.
  {
    const parts: THREE.BufferGeometry[] = [];
    const rand = seeded(5);
    const count = detail === 'low' ? 90 : 200;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand() * 0.02,
        rx = 200 + rand() * 30,
        rz = 150 + rand() * 25;
      const h = 5 + rand() * 4,
        r = 4.5 + rand() * 2.5;
      const g = new THREE.IcosahedronGeometry(1, detail === 'high' ? 1 : 0);
      g.scale(r, h * 0.55, r);
      g.translate(Math.cos(a) * rx, h * 0.45, Math.sin(a) * rz);
      parts.push(g);
    }
    const merged = mergeGeometries(parts);
    parts.forEach((p) => p.dispose());
    if (merged) mesh(merged, mat('#3f5340', 1));
  }
  // Static meshes grouped by material; keeps the detailed course inexpensive on phones.
  scene.updateMatrixWorld(true);
  const groups = new Map<THREE.Material, THREE.Mesh[]>();
  for (const o of scene.children) {
    if (o instanceof THREE.Mesh && !Array.isArray(o.material) && !o.castShadow) {
      const list = groups.get(o.material) || [];
      list.push(o);
      groups.set(o.material, list);
    }
  }
  for (const [m, list] of groups) {
    if (list.length < 2) continue;
    // The vertex-coloured sand ribbon keeps its own draw; everything else shares
    // position/normal/uv and merges per material.
    if (list.some((o) => o.geometry.getAttribute('color'))) continue;
    const parts = list.map((o) => o.geometry.clone().applyMatrix4(o.matrixWorld));
    const g = mergeGeometries(parts);
    parts.forEach((p) => p.dispose());
    if (g) {
      own(g);
      const merged = new THREE.Mesh(g, m);
      merged.receiveShadow = true;
      scene.add(merged);
      list.forEach((o) => scene.remove(o));
    }
  }
  const trapHome = traps.position.clone();
  return {
    gates,
    traps,
    bays,
    /**
     * Doors lift when the race starts; after the field has broken clear the unit is
     * wheeled sideways through the rail gap so the finish is open. Pure function of
     * the published lead, so replay and reload reproduce it.
     */
    setStart(open: boolean, lead: number, field = 8) {
      const lift = open ? 1 : 0;
      bays.forEach((bay, i) => {
        bay.visible = i < field;
        bay.position.z = 23 + laneOffset(i, field);
      });
      endWall.position.z = 23 + laneOffset(field - 1, field) + 0.435;
      gates.forEach((door) => {
        door.position.y = 0.47 + lift * 0.86;
      });
      const away = THREE.MathUtils.smoothstep(lead, 0.025, 0.09);
      traps.position.set(
        trapHome.x + TRAP_ROLL * THREE.MathUtils.smoothstep(away, 0, 0.3),
        trapHome.y,
        trapHome.z - TRAP_PARK * THREE.MathUtils.smoothstep(away, 0.25, 1)
      );
      traps.visible = away < 0.999;
    },
    dispose: () => resources.forEach((r) => r.dispose()),
  };
}
