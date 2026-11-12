import * as THREE from 'three';

/**
 * Original floodlit-night lighting environment. A tiny procedural scene (night sky, a ring of
 * bright roof floodlight banks, lit turf and darker stands) is prefiltered once with PMREM so
 * posts, ball, boots, skin and kit fabric pick up plausible stadium reflections and soft
 * image-based fill. It costs one small offscreen render at start-up and no per-frame work.
 */
export interface FloodlitEnvironment {
  texture: THREE.Texture | null;
  dispose(): void;
}

/** Positions of the floodlight banks used by the environment and the decal shadows. */
export const FLOODLIGHT_BANKS: ReadonlyArray<{ x: number; y: number; z: number }> = [
  { x: 0, y: 30, z: 74 }, // main stand roof, behind the broadcast camera
  { x: 0, y: 30, z: -66 }, // opposite stand roof
  { x: -80, y: 28, z: 0 }, // end roofs
  { x: 80, y: 28, z: 0 },
];

function environmentScene() {
  const scene = new THREE.Scene();
  const owned: Array<{ dispose(): void }> = [];
  const own = <T extends { dispose(): void }>(x: T) => (owned.push(x), x);
  // Sky dome with a faint warm light-pollution band at the horizon.
  const domeGeometry = own(new THREE.SphereGeometry(100, 24, 12));
  const colours: number[] = [];
  const position = domeGeometry.getAttribute('position');
  const sky = new THREE.Color('#05080f');
  const horizon = new THREE.Color('#2a2a33');
  const ground = new THREE.Color('#0c1a10');
  const c = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i) / 100;
    if (y >= 0) c.copy(horizon).lerp(sky, Math.min(1, y * 2.4));
    else c.copy(horizon).lerp(ground, Math.min(1, -y * 6));
    colours.push(c.r, c.g, c.b);
  }
  domeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  scene.add(
    new THREE.Mesh(
      domeGeometry,
      own(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }))
    )
  );
  // Lit turf below and the stand bowl around it.
  const turf = new THREE.Mesh(
    own(new THREE.CircleGeometry(60, 24)),
    own(new THREE.MeshBasicMaterial({ color: new THREE.Color('#2f6b2c').multiplyScalar(0.9) }))
  );
  turf.rotation.x = -Math.PI / 2;
  turf.position.y = -6;
  scene.add(turf);
  const bowl = new THREE.Mesh(
    own(new THREE.CylinderGeometry(70, 55, 22, 32, 1, true)),
    own(new THREE.MeshBasicMaterial({ color: '#1d1a20', side: THREE.BackSide }))
  );
  bowl.position.y = 4;
  scene.add(bowl);
  // Floodlight banks: very bright emitters along the roof ring (HDR values > 1).
  const lampGeometry = own(new THREE.BoxGeometry(26, 2.2, 1));
  const lampMaterial = own(
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#f3f6ff').multiplyScalar(14) })
  );
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const lamp = new THREE.Mesh(lampGeometry, lampMaterial);
    lamp.position.set(Math.cos(a) * 62, 26, Math.sin(a) * 62);
    lamp.lookAt(0, 0, 0);
    scene.add(lamp);
  }
  return { scene, dispose: () => owned.forEach((o) => o.dispose()) };
}

/** Builds the prefiltered environment, or returns `null` texture where it is unavailable. */
export function createFloodlitEnvironment(renderer: THREE.WebGLRenderer): FloodlitEnvironment {
  // A mocked or partial renderer (unit tests) cannot run PMREM; the scene stays fully lit by
  // its direct lights and simply has no reflections.
  const capable =
    typeof (renderer as Partial<THREE.WebGLRenderer>).getRenderTarget === 'function' &&
    typeof (renderer as Partial<THREE.WebGLRenderer>).getContext === 'function';
  if (!capable) return { texture: null, dispose() {} };
  let generator: THREE.PMREMGenerator | null = null;
  let target: THREE.WebGLRenderTarget | null = null;
  const built = environmentScene();
  try {
    generator = new THREE.PMREMGenerator(renderer);
    // A 64-texel probe is ample for this soft, low-frequency light: a 336x256 half-float
    // target (about 0.7 MB on the GPU) instead of 768x1024 (about 6 MB) at the default of 256.
    target = generator.fromScene(built.scene, 0.035, 0.5, 200, { size: 64 });
  } catch {
    target?.dispose();
    target = null;
  } finally {
    generator?.dispose();
    built.dispose();
  }
  return {
    texture: target?.texture ?? null,
    dispose() {
      target?.dispose();
    },
  };
}

/**
 * World-aligned night sky (equirectangular: top = zenith, middle = horizon): deep blue
 * overhead and a warm city glow just above the horizon, behind the stand roofs.
 */
export function nightSkyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient?.(0, 0, 0, 256);
  if (g) {
    g.addColorStop(0, '#02040a');
    g.addColorStop(0.3, '#07101e');
    g.addColorStop(0.43, '#142033');
    g.addColorStop(0.49, '#36343f');
    g.addColorStop(0.51, '#1a1c22');
    g.addColorStop(1, '#050608');
    ctx.fillStyle = g;
  } else ctx.fillStyle = '#0b1424';
  ctx.fillRect(0, 0, 4, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}
