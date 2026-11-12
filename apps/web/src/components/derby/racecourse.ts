import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The Emerald Course: an original straight turf course for the Derby presentation.
 *
 * Published race progress maps linearly onto this course (0 at the stalls, 1 at the
 * winning post). The length is chosen so the authored gallop plays at its natural
 * stride rate (about 2.4 strides/s) instead of slow motion; it carries no outcome
 * information. Everything here is decorative geometry built from code.
 */
export const COURSE_LENGTH = 660;
/** Published progress can exceed 1 while the field pulls up past the post. */
export const COURSE_RUN_OUT = COURSE_LENGTH * 1.08;
export const LANE_SPACING = 2.15;
/** The track box top; the runner's local ground datum sits here. */
export const RUNNER_GROUND_Y = 0.035;
export const RAIL_Z = 15;
export const RAIL_HEIGHT = 1.2;
export function laneZ(index: number, field: number) {
  return (index - (field - 1) / 2) * LANE_SPACING;
}
export function courseX(progress: number) {
  return progress * COURSE_LENGTH;
}

export type CourseQuality = 'high' | 'balanced' | 'low';
export type CourseFrame = {
  /** Centre of the displayed field (world X). */
  center: number;
  /** Displayed distance between the leader and the last runner. */
  spread: number;
  camera: THREE.Camera;
  /** Seconds, for gentle flag movement; frozen in reduced motion. */
  time: number;
  field: number;
  /** Stall doors open once the race is running. */
  gateOpen: boolean;
};

const SUN_DIRECTION = new THREE.Vector3(0.38, 0.78, 0.5).normalize();
const HORIZON = new THREE.Color('#dfe6e3');
const ZENITH = new THREE.Color('#5f93c9');

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
function canvas(width: number, height: number) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return { element, ctx: element.getContext('2d') };
}

export function createRacecourse(
  scene: THREE.Scene,
  {
    quality = 'balanced',
    renderer,
    field = 8,
  }: { quality?: CourseQuality; renderer?: THREE.WebGLRenderer; field?: number } = {}
) {
  const low = quality === 'low',
    high = quality === 'high';
  /**
   * Course scenery is matte. Below High it uses Lambert shading (no per-pixel PBR),
   * which roughly halves full-screen shading cost on phones and software renderers.
   */
  const surface = (
    parameters: THREE.MeshStandardMaterialParameters
  ): THREE.MeshStandardMaterial | THREE.MeshLambertMaterial => {
    if (high) return new THREE.MeshStandardMaterial(parameters);
    const lambert: THREE.MeshLambertMaterialParameters & {
      roughness?: number;
      metalness?: number;
    } = {
      ...(parameters as THREE.MeshLambertMaterialParameters),
    };
    delete lambert.roughness;
    delete lambert.metalness;
    return new THREE.MeshLambertMaterial(lambert);
  };
  const resources = new Set<{ dispose(): void }>();
  const keep = <T extends { dispose(): void }>(r: T) => {
    resources.add(r);
    return r;
  };
  const root = new THREE.Group();
  root.name = 'racecourse';
  scene.add(root);
  scene.background = HORIZON.clone();
  scene.fog = new THREE.Fog(HORIZON.clone(), 140, high ? 900 : 700);

  // ---- Sky -----------------------------------------------------------------
  const skyGeometry = keep(new THREE.SphereGeometry(1400, 32, 16));
  {
    const colors: number[] = [];
    const position = skyGeometry.getAttribute('position');
    const c = new THREE.Color();
    const sun = new THREE.Color('#fff2d6');
    for (let i = 0; i < position.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(position, i).normalize();
      c.copy(HORIZON).lerp(ZENITH, Math.pow(Math.max(0, v.y), 0.5));
      // Warm glow toward the sun.
      c.lerp(sun, Math.pow(Math.max(0, v.dot(SUN_DIRECTION)), 8) * 0.55);
      colors.push(c.r, c.g, c.b);
    }
    skyGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }
  const skyMaterial = keep(
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    })
  );
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.name = 'sky';
  sky.renderOrder = -2;
  sky.frustumCulled = false;
  root.add(sky);
  // Soft fair-weather clouds on a second, slightly smaller dome.
  let clouds: THREE.Mesh | null = null;
  if (!low) {
    const { element, ctx } = canvas(1024, 256);
    if (ctx?.createRadialGradient) {
      const rand = random(91);
      for (let i = 0; i < 70; i++) {
        const x = rand() * 1024,
          y = 60 + rand() * 120,
          r = 18 + rand() * 46;
        for (let k = 0; k < 6; k++) {
          const cx = x + (rand() - 0.5) * r * 2.4,
            cy = y + (rand() - 0.5) * r * 0.5,
            cr = r * (0.5 + rand() * 0.6);
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
          g.addColorStop(0, 'rgba(255,255,255,0.55)');
          g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g;
          ctx.fillRect(cx - cr, cy - cr, cr * 2, cr * 2);
        }
      }
      const texture = keep(new THREE.CanvasTexture(element));
      texture.wrapS = THREE.RepeatWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      const geometry = keep(
        new THREE.SphereGeometry(1300, 32, 8, 0, Math.PI * 2, Math.PI * 0.12, Math.PI * 0.36)
      );
      const material = keep(
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          side: THREE.BackSide,
          fog: false,
          depthWrite: false,
          opacity: 0.9,
        })
      );
      clouds = new THREE.Mesh(geometry, material);
      clouds.name = 'clouds';
      clouds.renderOrder = -1;
      clouds.frustumCulled = false;
      root.add(clouds);
    }
  }

  // ---- Lights --------------------------------------------------------------
  const hemi = new THREE.HemisphereLight('#dbe8f5', '#6b6a45', low ? 1.55 : 1.05);
  const sun = new THREE.DirectionalLight('#fff0d8', low ? 2.4 : 2.75);
  sun.castShadow = !low;
  const shadowSize = high ? 2048 : 1024;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 160;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.03;
  // A cool fill from the camera side keeps far flanks and dark coats readable.
  const fill = new THREE.DirectionalLight('#d6e4f5', 0.45);
  root.add(hemi, sun, sun.target, fill, fill.target);
  let environment: THREE.Texture | null = null;
  if (!low && renderer) {
    let pmrem: THREE.PMREMGenerator | null = null;
    try {
      pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene();
      envScene.add(new THREE.Mesh(skyGeometry, skyMaterial));
      const groundGeometry = new THREE.CircleGeometry(1000, 24).rotateX(-Math.PI / 2);
      const groundMaterial = new THREE.MeshBasicMaterial({
        color: '#5d7040',
        side: THREE.DoubleSide,
      });
      const ground = new THREE.Mesh(groundGeometry, groundMaterial);
      ground.position.y = -4;
      envScene.add(ground);
      try {
        const target = pmrem.fromScene(envScene, 0.04, 0.1, 2000, { size: 64 });
        // Image-based light is reserved for the runners' coats, silks and tack;
        // matte scenery would pay for it on every pixel for little visible gain.
        environment = keep(target).texture;
      } finally {
        groundGeometry.dispose();
        groundMaterial.dispose();
      }
    } catch {
      /* Image-based light is optional. */
    } finally {
      pmrem?.dispose();
    }
  }

  // ---- Materials -----------------------------------------------------------
  const materials = new Map<string, THREE.Material>();
  function mat(key: string, make: () => THREE.Material) {
    let m = materials.get(key);
    if (!m) {
      m = keep(make());
      materials.set(key, m);
    }
    return m;
  }
  const standard = (color: string, roughness = 0.8, metalness = 0) =>
    mat(`${color}:${roughness}:${metalness}`, () => surface({ color, roughness, metalness }));
  // Static pieces are queued per material and merged into one draw each.
  const queue = new Map<THREE.Material, THREE.BufferGeometry[]>();
  function put(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    { rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}
  ) {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(sx, sy, sz)
    );
    const copy = (geometry.index ? geometry.toNonIndexed() : geometry.clone()).applyMatrix4(matrix);
    for (const name of Object.keys(copy.attributes))
      if (!['position', 'normal', 'uv'].includes(name)) copy.deleteAttribute(name);
    if (!copy.getAttribute('uv'))
      copy.setAttribute(
        'uv',
        new THREE.Float32BufferAttribute(
          new Float32Array(copy.getAttribute('position').count * 2),
          2
        )
      );
    const list = queue.get(material) ?? [];
    list.push(copy);
    queue.set(material, list);
  }
  const unitBox = keep(new THREE.BoxGeometry(1, 1, 1));
  const box = (
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    extra: { rx?: number; ry?: number; rz?: number } = {}
  ) => put(unitBox, material, x, y, z, { ...extra, sx: w, sy: h, sz: d });
  const cylinder = (sides: number) => keep(new THREE.CylinderGeometry(1, 1, 1, sides));
  const post = cylinder(6),
    round = cylinder(12);

  // ---- Ground, turf and running rails --------------------------------------
  function grassTexture(base: string, stripes: boolean, seed: number) {
    const { element, ctx } = canvas(256, 256);
    if (ctx) {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 256, 256);
      const rand = random(seed);
      if (stripes) {
        // Mowing bands across the course: alternate halves of the tile.
        ctx.fillStyle = 'rgba(255,255,240,0.075)';
        ctx.fillRect(0, 0, 128, 256);
      }
      for (let i = 0; i < 9000; i++) {
        const shade = Math.floor(rand() * 60);
        ctx.fillStyle = `rgba(${30 + shade},${60 + shade},${20 + shade * 0.6},0.32)`;
        ctx.fillRect(rand() * 256, rand() * 256, 1, 2 + rand() * 3);
      }
    }
    const texture = keep(new THREE.CanvasTexture(element));
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = high ? 8 : 4;
    return texture;
  }
  const groundTexture = grassTexture('#5e7a3c', false, 11);
  groundTexture.repeat.set(300, 160);
  const groundMaterial = keep(surface({ color: '#cfd8bf', map: groundTexture, roughness: 0.97 }));
  const groundGeometry = keep(new THREE.PlaneGeometry(2600, 1400).rotateX(-Math.PI / 2));
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.position.set(COURSE_LENGTH / 2, 0, 0);
  ground.receiveShadow = !low;
  ground.name = 'ground';
  root.add(ground);
  // The racing strip: rails 22 units apart, stripes 12 units long.
  const turfTexture = grassTexture('#4f7a33', true, 23);
  const turfLength = COURSE_RUN_OUT + 260;
  turfTexture.repeat.set(turfLength / 24, 3);
  const turfMaterial = keep(surface({ color: '#d8e6c4', map: turfTexture, roughness: 0.93 }));
  const turfGeometry = keep(
    new THREE.PlaneGeometry(turfLength, RAIL_Z * 2 + 4).rotateX(-Math.PI / 2)
  );
  const turf = new THREE.Mesh(turfGeometry, turfMaterial);
  turf.position.set(-130 + turfLength / 2, RUNNER_GROUND_Y - 0.001, 0);
  turf.receiveShadow = !low;
  turf.name = 'turf';
  root.add(turf);
  // Finish line and the stalls' start line, painted on the turf.
  const lineMaterial = keep(
    surface({ color: '#f4f1e8', roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 })
  );
  const lineGeometry = keep(new THREE.PlaneGeometry(0.5, RAIL_Z * 2).rotateX(-Math.PI / 2));
  const finishLine = new THREE.Mesh(lineGeometry, lineMaterial);
  finishLine.position.set(COURSE_LENGTH, RUNNER_GROUND_Y + 0.004, 0);
  finishLine.receiveShadow = !low;
  root.add(finishLine);

  const railWhite = standard('#f6f4ee', 0.45);
  const railStart = -120,
    railEnd = COURSE_RUN_OUT + 120;
  for (const side of [-1, 1]) {
    const z = side * RAIL_Z;
    // Plastic running rail: a continuous rounded top bar on slim posts.
    for (let x = railStart; x < railEnd; x += 60)
      put(round, railWhite, x + 30, RAIL_HEIGHT, z, {
        rz: Math.PI / 2,
        sx: 0.09,
        sy: 60,
        sz: 0.09,
      });
    for (let x = railStart; x < railEnd; x += 60)
      put(round, railWhite, x + 30, RAIL_HEIGHT - 0.45, z, {
        rz: Math.PI / 2,
        sx: 0.04,
        sy: 60,
        sz: 0.04,
      });
  }
  // Posts are instanced: one draw for both rails.
  const postsPerSide = Math.ceil((railEnd - railStart) / 3);
  const posts = new THREE.InstancedMesh(post, railWhite, postsPerSide * 2);
  {
    const m = new THREE.Matrix4();
    let n = 0;
    for (const side of [-1, 1])
      for (let i = 0; i < postsPerSide; i++)
        posts.setMatrixAt(
          n++,
          m.compose(
            new THREE.Vector3(railStart + i * 3, RAIL_HEIGHT / 2, side * (RAIL_Z + 0.08)),
            new THREE.Quaternion(),
            new THREE.Vector3(0.06, RAIL_HEIGHT, 0.06)
          )
        );
  }
  posts.castShadow = !low;
  posts.name = 'rail-posts';
  root.add(posts);
  // Distance poles on both rails every tenth of the course; the winning post is apart.
  const poleRed = standard('#c8352e', 0.5);
  for (let i = 1; i < 10; i++)
    for (const side of [-1, 1]) {
      const x = (COURSE_LENGTH * i) / 10;
      put(round, railWhite, x, 1.6, side * (RAIL_Z + 0.25), { sx: 0.09, sy: 3.2, sz: 0.09 });
      for (let b = 0; b < 3; b++)
        put(round, poleRed, x, 0.55 + b * 1.05, side * (RAIL_Z + 0.25), {
          sx: 0.1,
          sy: 0.4,
          sz: 0.1,
        });
    }
  // Winning post and judge's box on the far side, never between camera and runners.
  const disc = keep(new THREE.CylinderGeometry(0.7, 0.7, 0.08, 24));
  put(round, railWhite, COURSE_LENGTH, 2.8, -RAIL_Z - 0.4, { sx: 0.12, sy: 5.6, sz: 0.12 });
  put(disc, poleRed, COURSE_LENGTH, 5.7, -RAIL_Z - 0.4, { rx: Math.PI / 2 });
  put(disc, railWhite, COURSE_LENGTH, 5.7, -RAIL_Z - 0.45, { rx: Math.PI / 2, sx: 0.45, sz: 0.45 });
  box(standard('#f1ede2', 0.6), COURSE_LENGTH, 4.2, -RAIL_Z - 4.5, 3.2, 2.2, 3.2);
  box(standard('#2c3b35', 0.4), COURSE_LENGTH, 4.4, -RAIL_Z - 2.89, 2.6, 1.0, 0.05);
  box(standard('#e8e2d4', 0.7), COURSE_LENGTH, 1.55, -RAIL_Z - 4.5, 0.6, 3.1, 0.6);
  box(standard('#7d2a28', 0.6), COURSE_LENGTH, 5.5, -RAIL_Z - 4.5, 3.6, 0.35, 3.6);

  // ---- Sponsor-free course boards on the far side -------------------------
  const boardsTexture = (() => {
    const { element, ctx } = canvas(1024, 128);
    if (ctx) {
      const panels: [string, string, string][] = [
        ['#173a2e', '#f2e6c4', 'SALEM BET'],
        ['#f2eee4', '#173a2e', 'EMERALD COURSE'],
        ['#7a1f2b', '#f6e7c8', 'DERBY'],
        ['#173a2e', '#e9c46a', '★ RACING CLUB ★'],
      ];
      panels.forEach(([background, ink, text], i) => {
        ctx.fillStyle = background;
        ctx.fillRect(i * 256, 0, 256, 128);
        ctx.fillStyle = ink;
        ctx.font = '800 40px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, i * 256 + 128, 66, 236);
      });
    }
    const texture = keep(new THREE.CanvasTexture(element));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  })();
  const boardMaterial = keep(surface({ map: boardsTexture, roughness: 0.55 }));
  {
    const plane = keep(new THREE.PlaneGeometry(14, 1.1));
    let n = 0;
    for (let x = railStart + 20; x < railEnd; x += 16) {
      const panel = n++ % 4;
      const g = plane.clone();
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, (panel + uv.getX(i)) / 4);
      put(g, boardMaterial, x, 0.75, -RAIL_Z - 1.6);
      g.dispose();
    }
    for (let x = railStart + 20; x < railEnd; x += 16)
      box(standard('#2d3a33', 0.7), x, 0.7, -RAIL_Z - 1.66, 14, 1.3, 0.08);
  }

  // A clipped hedge behind the far boards gives a dark mid-ground line on every shot.
  {
    const hedge = surface({ color: '#2f4a26', roughness: 0.95 });
    keep(hedge);
    for (let x = railStart; x < railEnd; x += 60)
      box(hedge, x + 30, 0.9, -RAIL_Z - 5, 60, 1.8, 1.6);
  }

  // ---- Starting stalls --------------------------------------------------------
  const gate = new THREE.Group();
  gate.name = 'starting-stalls';
  root.add(gate);
  const gateGreen = standard('#21463a', 0.55),
    gatePad = standard('#e8e4da', 0.6);
  const doors: { pivot: THREE.Group; side: number }[] = [];
  const stallWidth = LANE_SPACING;
  const halfSpan = (field * stallWidth) / 2 + 0.35;
  const gateFront = 2.75,
    gateBack = -2.8,
    gateTop = 3.85;
  const gateQueue = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const gatePut = (
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number
  ) => {
    const g = unitBox
      .clone()
      .applyMatrix4(
        new THREE.Matrix4().compose(
          new THREE.Vector3(x, y, z),
          new THREE.Quaternion(),
          new THREE.Vector3(w, h, d)
        )
      );
    const list = gateQueue.get(material) ?? [];
    list.push(g);
    gateQueue.set(material, list);
  };
  // End towers, a deep top beam with number boards, and slim posts between stalls.
  for (const side of [-1, 1]) {
    gatePut(
      gateGreen,
      0,
      gateTop / 2,
      side * (halfSpan + 0.35),
      gateFront - gateBack + 0.6,
      gateTop,
      0.7
    );
    gatePut(gatePad, 0, gateTop - 0.4, side * (halfSpan + 0.72), gateFront - gateBack, 0.18, 0.04);
  }
  gatePut(gateGreen, gateFront, gateTop, 0, 0.4, 0.55, halfSpan * 2 + 1.4);
  gatePut(gateGreen, gateBack, gateTop, 0, 0.4, 0.55, halfSpan * 2 + 1.4);
  for (let i = 0; i <= field; i++) {
    const z = (i - field / 2) * stallWidth;
    for (const x of [gateFront, gateBack])
      gatePut(gateGreen, x, gateTop / 2, z, 0.14, gateTop, 0.14);
    // Light rails between stalls at chest height keep the runners visible.
    gatePut(gatePad, 0, 1.55, z, gateFront - gateBack, 0.12, 0.08);
    gatePut(gatePad, 0, 2.45, z, gateFront - gateBack, 0.1, 0.06);
  }
  for (const [material, list] of gateQueue) {
    const merged = mergeGeometries(list);
    list.forEach((g) => g.dispose());
    if (!merged) continue;
    keep(merged);
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = !low;
    mesh.receiveShadow = !low;
    gate.add(mesh);
  }
  // Number boards above each stall, in the runner's order 1..field from the far rail.
  const numberBoards = (() => {
    const { element, ctx } = canvas(128 * field, 128);
    if (ctx) {
      for (let i = 0; i < field; i++) {
        ctx.fillStyle = '#f5f1e6';
        ctx.fillRect(i * 128 + 6, 6, 116, 116);
        ctx.fillStyle = '#163328';
        ctx.font = '900 88px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), i * 128 + 64, 70);
      }
    }
    const texture = keep(new THREE.CanvasTexture(element));
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  })();
  {
    const material = keep(surface({ map: numberBoards, roughness: 0.6 }));
    const boards: THREE.BufferGeometry[] = [];
    for (let i = 0; i < field; i++) {
      const z = laneZ(i, field);
      for (const [x, ry] of [
        [gateFront + 0.21, Math.PI / 2],
        [gateBack - 0.21, -Math.PI / 2],
      ] as const) {
        const g = new THREE.PlaneGeometry(0.9, 0.5);
        const uv = g.getAttribute('uv');
        for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / field);
        g.applyMatrix4(
          new THREE.Matrix4().compose(
            new THREE.Vector3(x, gateTop, z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)),
            new THREE.Vector3(1, 1, 1)
          )
        );
        boards.push(g);
      }
    }
    const merged = mergeGeometries(boards);
    boards.forEach((g) => g.dispose());
    if (merged) {
      keep(merged);
      gate.add(new THREE.Mesh(merged, material));
    }
  }
  // Front doors: a frame and grille per stall, hinged at the stall posts.
  const doorGeometry = (() => {
    const parts = [
      new THREE.BoxGeometry(0.06, 2.1, 0.06).translate(0, 1.55, 0),
      new THREE.BoxGeometry(0.06, 0.08, 1.02).translate(0, 2.55, 0.51),
      new THREE.BoxGeometry(0.06, 0.08, 1.02).translate(0, 0.55, 0.51),
      new THREE.BoxGeometry(0.06, 0.08, 1.02).translate(0, 1.55, 0.51),
      ...[0.25, 0.5, 0.75].map((f) =>
        new THREE.BoxGeometry(0.04, 2.0, 0.04).translate(0, 1.55, f * 1.02)
      ),
    ];
    const merged = mergeGeometries(parts)!;
    parts.forEach((g) => g.dispose());
    return keep(merged);
  })();
  const doorMaterial = standard('#d9d4c6', 0.45, 0.3);
  for (let i = 0; i < field; i++) {
    const z = laneZ(i, field);
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(gateFront + 0.1, 0, z + side * (stallWidth / 2 - 0.04));
      const door = new THREE.Mesh(doorGeometry, doorMaterial);
      door.scale.z = -side;
      door.castShadow = !low;
      pivot.add(door);
      gate.add(pivot);
      doors.push({ pivot, side });
    }
  }

  // ---- Grandstand by the winning post ----------------------------------------
  const standFront = -RAIL_Z - 9,
    standX0 = COURSE_LENGTH - 175,
    standX1 = COURSE_LENGTH + 55;
  const standLength = standX1 - standX0,
    standMid = (standX0 + standX1) / 2;
  const concrete = standard('#d9d3c5', 0.85),
    stoneDark = standard('#9f998b', 0.85),
    roofMaterial = standard('#e9ece9', 0.5, 0.2),
    glass = standard('#5d7684', 0.15, 0.4),
    steelDark = standard('#36403d', 0.5, 0.5);
  const crowdTexture = (() => {
    const { element, ctx } = canvas(512, 128);
    if (ctx) {
      ctx.fillStyle = '#3d3b36';
      ctx.fillRect(0, 0, 512, 128);
      const rand = random(7);
      const shirts = [
        '#d9d4c8',
        '#3b4f6b',
        '#8c4a45',
        '#b8a26a',
        '#4d6650',
        '#26262b',
        '#a8775a',
        '#7d8fa6',
        '#cfc3ae',
        '#5d4a5a',
        '#e6e1d6',
        '#2f3b48',
      ];
      for (let row = 0; row < 8; row++)
        for (let i = 0; i < 60; i++) {
          const x = i * 8.6 + (row % 2) * 4 + rand() * 2,
            y = row * 16 + 4;
          ctx.fillStyle = shirts[Math.floor(rand() * shirts.length)];
          ctx.fillRect(x, y + 5, 6.2, 9);
          ctx.fillStyle = ['#e2b58f', '#8d5a3c', '#c78d63', '#5a3826', '#f0c9a4'][
            Math.floor(rand() * 5)
          ];
          ctx.beginPath();
          ctx.arc(x + 3.1, y + 3.4, 2.6, 0, Math.PI * 2);
          ctx.fill();
          if (rand() < 0.12) {
            ctx.fillStyle = ['#f5f1e6', '#1d1d1d', '#c9a227'][Math.floor(rand() * 3)];
            ctx.fillRect(x - 0.5, y, 7, 2.2);
          }
        }
      // Shade toward the back rows, under the roof.
      const shade = ctx.createLinearGradient?.(0, 0, 0, 128);
      if (shade) {
        shade.addColorStop(0, 'rgba(10,12,10,0.45)');
        shade.addColorStop(1, 'rgba(10,12,10,0)');
        ctx.fillStyle = shade;
        ctx.fillRect(0, 0, 512, 128);
      }
    }
    const texture = keep(new THREE.CanvasTexture(element));
    texture.wrapS = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  })();
  crowdTexture.repeat.set(standLength / 22, 1);
  const crowdMaterial = keep(surface({ map: crowdTexture, roughness: 0.9 }));
  // Three tiers of seating rising away from the course, each a sloped crowd surface.
  const tiers = [
    { y0: 0.6, y1: 5.2, z0: standFront, z1: standFront - 9 },
    { y0: 7.0, y1: 11.6, z0: standFront - 9.5, z1: standFront - 17.5 },
    { y0: 13.2, y1: 17.0, z0: standFront - 18, z1: standFront - 24 },
  ];
  for (const tier of tiers) {
    const depth = tier.z0 - tier.z1,
      rise = tier.y1 - tier.y0;
    const g = new THREE.PlaneGeometry(standLength, Math.hypot(depth, rise));
    put(g, crowdMaterial, standMid, (tier.y0 + tier.y1) / 2, (tier.z0 + tier.z1) / 2, {
      rx: -Math.PI / 2 + Math.atan2(rise, depth),
    });
    g.dispose();
    // Balcony fascia and the deck below each tier.
    box(concrete, standMid, tier.y0 - 0.3, tier.z0 + 0.2, standLength, 1.2, 0.5);
    box(stoneDark, standMid, tier.y0 - 1, (tier.z0 + tier.z1) / 2, standLength, 0.5, depth);
  }
  // Back wall with glazed boxes, columns and a cantilevered roof with fascia.
  box(concrete, standMid, 10, standFront - 25.5, standLength + 4, 20, 2);
  box(glass, standMid, 6.2, standFront - 9.1, standLength - 6, 0.9, 0.2);
  box(glass, standMid, 12.6, standFront - 17.9, standLength - 6, 0.9, 0.2);
  for (let x = standX0; x <= standX1 + 0.1; x += standLength / 10) {
    box(steelDark, x, 10, standFront - 24, 0.5, 20, 0.5);
    box(steelDark, x, 6.1, standFront - 9.3, 0.4, 1.8, 0.4);
  }
  box(roofMaterial, standMid, 21.2, standFront - 13, standLength + 6, 0.6, 26);
  box(standard('#173a2e', 0.5), standMid, 20.4, standFront - 0.2, standLength + 6, 1.8, 0.4);
  box(concrete, standX0 - 2, 10, standFront - 12.5, 4, 22, 27);
  box(concrete, standX1 + 2, 10, standFront - 12.5, 4, 22, 27);
  // The course name on the roof fascia.
  {
    const { element, ctx } = canvas(1024, 64);
    if (ctx) {
      ctx.fillStyle = '#173a2e';
      ctx.fillRect(0, 0, 1024, 64);
      ctx.fillStyle = '#f2e6c4';
      ctx.font = '800 40px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('THE EMERALD COURSE  ·  SALEM BET', 512, 34);
    }
    const texture = keep(new THREE.CanvasTexture(element));
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = keep(surface({ map: texture, roughness: 0.5 }));
    const g = new THREE.PlaneGeometry(80, 1.6);
    put(g, material, standMid, 20.4, standFront + 0.02);
    g.dispose();
  }
  // Lawn crowd standing along the far rail in front of the stands.
  {
    const g = new THREE.PlaneGeometry(standLength - 20, 1.7);
    put(g, crowdMaterial, standMid, 0.85, standFront + 3.2);
    put(g, crowdMaterial, standMid, 1.0, standFront + 1.6);
    g.dispose();
  }
  // Hospitality marquees and a small members' stand along the straight.
  const canvasWhite = standard('#f4f2ec', 0.75);
  const awning = (() => {
    const { element, ctx } = canvas(64, 8);
    if (ctx)
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = i % 2 ? '#f4f2ec' : '#2e5f4b';
        ctx.fillRect(i * 8, 0, 8, 8);
      }
    const texture = keep(new THREE.CanvasTexture(element));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    return keep(surface({ map: texture, roughness: 0.7 }));
  })();
  const peak = keep(new THREE.ConeGeometry(1, 1, 4, 1, true));
  for (const x of [80, 190, 300, 410]) {
    for (let k = 0; k < 3; k++) {
      const mx = x + k * 8;
      box(canvasWhite, mx, 1.3, -RAIL_Z - 14, 7, 2.6, 6);
      put(peak, awning, mx, 3.35, -RAIL_Z - 14, { ry: Math.PI / 4, sx: 5.2, sy: 1.5, sz: 4.5 });
      box(standard('#c9c3b5', 0.8), mx + 3.55, 1.5, -RAIL_Z - 14, 0.08, 3, 0.08);
    }
  }
  box(concrete, 250, 3.2, -RAIL_Z - 24, 40, 6.4, 8);
  box(roofMaterial, 250, 6.8, -RAIL_Z - 23, 44, 0.4, 10);
  // A big screen faces the stands from across the straight's far end.
  box(steelDark, COURSE_LENGTH - 260, 9, -RAIL_Z - 28, 26, 13, 1);
  box(standard('#0d1513', 0.3), COURSE_LENGTH - 260, 9.6, -RAIL_Z - 27.45, 24, 10.5, 0.1);
  box(steelDark, COURSE_LENGTH - 266, 2.5, -RAIL_Z - 28, 0.8, 5, 0.8);
  box(steelDark, COURSE_LENGTH - 254, 2.5, -RAIL_Z - 28, 0.8, 5, 0.8);

  // ---- Trees and hills ------------------------------------------------------
  const treeGeometry = (() => {
    const trunk = new THREE.CylinderGeometry(0.25, 0.35, 3, 6).translate(0, 1.5, 0);
    const crownA = new THREE.IcosahedronGeometry(2.6, 1).translate(0, 4.6, 0);
    const crownB = new THREE.IcosahedronGeometry(1.9, 0).translate(1.1, 5.9, 0.4);
    const crownC = new THREE.IcosahedronGeometry(1.7, 0).translate(-1.0, 5.4, -0.6);
    const parts = [trunk, crownA, crownB, crownC].map((g) =>
      g.index ? g.toNonIndexed() : g.clone()
    );
    [trunk, crownA, crownB, crownC].forEach((g) => g.dispose());
    parts.forEach((g, i) => {
      const count = g.getAttribute('position').count;
      const colors = new Float32Array(count * 3);
      const c = new THREE.Color(i === 0 ? '#5a4632' : '#ffffff');
      for (let k = 0; k < count; k++) {
        // Darker underside of the crown.
        const y = g.getAttribute('position').getY(k);
        const shade = i === 0 ? 1 : 0.72 + 0.28 * THREE.MathUtils.clamp((y - 3) / 4, 0, 1);
        colors.set([c.r * shade, c.g * shade, c.b * shade], k * 3);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      g.deleteAttribute('uv');
    });
    const merged = mergeGeometries(parts)!;
    parts.forEach((g) => g.dispose());
    return keep(merged);
  })();
  const treeMaterial = keep(surface({ vertexColors: true, roughness: 0.95 }));
  const treeCount = high ? 440 : low ? 150 : 300;
  // Trees are instanced in chunks along the course so off-screen chunks are culled.
  const treeChunks = 10;
  const chunkLength = (COURSE_RUN_OUT + 520) / treeChunks;
  const placements: { matrix: THREE.Matrix4; color: THREE.Color; chunk: number }[] = [];
  const treeZones: THREE.Box3[] = [];
  {
    const rand = random(4242);
    const greens = ['#3f5a2c', '#36502a', '#4a6633', '#56683a', '#3d5a34', '#4a6a40', '#5a6b3f'];
    for (let i = 0; i < treeCount; i++) {
      // Most trees line the far side; a sparser belt sits well behind the camera side.
      const far = i < treeCount * 0.72;
      const x = -260 + rand() * (COURSE_RUN_OUT + 520);
      let z = far ? -(95 + rand() * 150) : 95 + rand() * 140;
      // Keep the grandstand and marquees clear.
      if (far && x > standX0 - 20 && x < standX1 + 20) z = -(110 + rand() * 120);
      const s = 1.2 + rand() * 1.6;
      placements.push({
        matrix: new THREE.Matrix4().compose(
          new THREE.Vector3(x, 0, z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2),
          new THREE.Vector3(s, s * (0.85 + rand() * 0.4), s)
        ),
        color: new THREE.Color(greens[Math.floor(rand() * greens.length)]),
        chunk: Math.min(treeChunks - 1, Math.floor((x + 260) / chunkLength)),
      });
    }
    treeZones.push(
      new THREE.Box3(
        new THREE.Vector3(-280, 0, -260),
        new THREE.Vector3(COURSE_RUN_OUT + 280, 16, -88)
      ),
      new THREE.Box3(
        new THREE.Vector3(-280, 0, 90),
        new THREE.Vector3(COURSE_RUN_OUT + 280, 16, 250)
      )
    );
  }
  const trees: THREE.InstancedMesh[] = [];
  for (let chunk = 0; chunk < treeChunks; chunk++) {
    const mine = placements.filter((p) => p.chunk === chunk);
    if (!mine.length) continue;
    const mesh = new THREE.InstancedMesh(treeGeometry, treeMaterial, mine.length);
    mine.forEach((p, i) => {
      mesh.setMatrixAt(i, p.matrix);
      mesh.setColorAt(i, p.color);
    });
    mesh.computeBoundingSphere();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = 'trees';
    root.add(mesh);
    trees.push(mesh);
  }
  // Rolling hills on both horizons; vertex-coloured, fogged into the sky.
  const hills = (() => {
    const segments = 160;
    const positions: number[] = [],
      colors: number[] = [],
      indices: number[] = [];
    const rand = random(77);
    const phases = [rand() * 6, rand() * 6, rand() * 6];
    const near = new THREE.Color('#5f7d4c'),
      far = new THREE.Color('#8ea5a0');
    let base = 0;
    for (const side of [-1, 1]) {
      const z = side * 620;
      for (let i = 0; i <= segments; i++) {
        const x = -900 + (i / segments) * (COURSE_LENGTH + 1800);
        const h =
          24 +
          16 * Math.sin(x * 0.004 + phases[0] + side) +
          10 * Math.sin(x * 0.011 + phases[1]) +
          5 * Math.sin(x * 0.031 + phases[2]);
        positions.push(x, -2, z, x, h, z + side * 40);
        colors.push(near.r, near.g, near.b, far.r, far.g, far.b);
        if (i < segments) {
          const a = base + i * 2;
          if (side < 0) indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          else indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      base += (segments + 1) * 2;
    }
    const g = keep(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    const m = keep(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'hills';
    return mesh;
  })();
  root.add(hills);

  // ---- Merge static pieces ----------------------------------------------------
  for (const [material, list] of queue) {
    const merged = mergeGeometries(list);
    list.forEach((g) => g.dispose());
    if (!merged) continue;
    keep(merged);
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = !low && material !== boardMaterial && material !== crowdMaterial;
    mesh.receiveShadow = !low;
    root.add(mesh);
  }
  queue.clear();

  /**
   * Boxes the camera must see past (tested for every runner sightline).
   * The near rail is included so hooves stay visible above it.
   */
  const obstacles: { name: string; box: THREE.Box3; margin?: number }[] = [
    {
      name: 'grandstand',
      box: new THREE.Box3(
        new THREE.Vector3(standX0 - 4, 0, standFront - 27),
        new THREE.Vector3(standX1 + 4, 22, standFront + 3.5)
      ),
    },
    {
      name: 'judge',
      box: new THREE.Box3(
        new THREE.Vector3(COURSE_LENGTH - 2, 0, -RAIL_Z - 6.4),
        new THREE.Vector3(COURSE_LENGTH + 2, 5.8, -RAIL_Z - 2.8)
      ),
    },
    {
      name: 'marquees',
      box: new THREE.Box3(
        new THREE.Vector3(70, 0, -RAIL_Z - 29),
        new THREE.Vector3(440, 7, -RAIL_Z - 9.5)
      ),
    },
    {
      name: 'screen',
      box: new THREE.Box3(
        new THREE.Vector3(COURSE_LENGTH - 274, 0, -RAIL_Z - 29),
        new THREE.Vector3(COURSE_LENGTH - 246, 16, -RAIL_Z - 27)
      ),
    },
    {
      name: 'stalls',
      box: new THREE.Box3(
        new THREE.Vector3(gateBack - 0.4, 0, -halfSpan - 0.8),
        new THREE.Vector3(gateFront + 1.3, gateTop + 0.3, halfSpan + 0.8)
      ),
    },
    {
      name: 'near-rail',
      box: new THREE.Box3(
        new THREE.Vector3(railStart, 0, RAIL_Z - 0.1),
        new THREE.Vector3(railEnd, RAIL_HEIGHT + 0.1, RAIL_Z + 0.2)
      ),
      margin: 0.12,
    },
    {
      name: 'far-rail',
      box: new THREE.Box3(
        new THREE.Vector3(railStart, 0, -RAIL_Z - 1.8),
        new THREE.Vector3(railEnd, RAIL_HEIGHT + 0.1, -RAIL_Z + 0.1)
      ),
    },
    ...treeZones.map((box, i) => ({ name: `trees-${i}`, box })),
  ];

  let doorAngle = 0;
  const sunOffset = SUN_DIRECTION.clone().multiplyScalar(90);
  function update(frame: CourseFrame) {
    const cam = frame.camera.position;
    sky.position.set(cam.x, 0, cam.z);
    if (clouds) {
      clouds.position.set(cam.x, 0, cam.z);
      clouds.rotation.y = frame.time * 0.002;
    }
    // Sun and shadow frustum follow the field; the frustum spans its displayed spread.
    const half = Math.max(16, frame.spread / 2 + 10);
    sun.position.set(frame.center, 0, 0).add(sunOffset);
    sun.target.position.set(frame.center, 0, 0);
    const shadow = sun.shadow.camera;
    if (shadow.right !== half) {
      shadow.left = -half;
      shadow.right = half;
      shadow.top = half * 0.75;
      shadow.bottom = -half * 0.75;
      shadow.updateProjectionMatrix();
    }
    fill.position.set(cam.x, cam.y + 10, cam.z);
    fill.target.position.set(frame.center, 1, 0);
    // Stall doors swing open with the published start; they close for the next race.
    const target = frame.gateOpen ? 1 : 0;
    doorAngle = target;
    for (const { pivot, side } of doors) pivot.rotation.y = -side * doorAngle * 1.7;
    gate.visible = cam.x < 220 || frame.center < 120;
  }

  return {
    root,
    obstacles,
    sun,
    environment,
    update,
    dispose() {
      scene.remove(root);
      resources.forEach((r) => r.dispose());
      sun.shadow.dispose();
      trees.forEach((t) => t.dispose());
      posts.dispose();
    },
  };
}
export type Racecourse = ReturnType<typeof createRacecourse>;
