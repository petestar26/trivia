import * as THREE from 'three';
import { createGreyhound, createGreyhoundKit, type Greyhound } from './greyhound';
import { createTrack, laneOffset, trackPoint, TRACK_LENGTH } from './track';

export { laneOffset };
import { GREYHOUND_SCALE, smoothstep, strideFor } from './gait';

export type RaceQuality = 'high' | 'balanced' | 'low';
export type RunnerView = {
  index: number;
  visible: boolean;
  x: number;
  z: number;
  heading: number;
  lap: number;
};
export type RaceFrame = {
  /** Display lap fraction per runner, already converted from published progress. */
  laps: number[];
  field: number;
  running: boolean;
  reduced: boolean;
  /** Seconds since the previous frame and a monotonic clock in seconds. */
  dt: number;
  time: number;
};

/** Sun from outside the home straight, high enough that the far straight is not a silhouette. */
const SUN_DIRECTION = new THREE.Vector3(0.42, 0.72, 0.55).normalize();
const HORIZON = new THREE.Color('#e3d9c6'),
  ZENITH = new THREE.Color('#6f9ccf');

function skyDome(resources: { dispose(): void }[]) {
  const g = new THREE.SphereGeometry(420, 32, 16);
  const colors: number[] = [];
  const pos = g.getAttribute('position');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = Math.max(0, pos.getY(i) / 420);
    c.copy(HORIZON).lerp(ZENITH, Math.pow(h, 0.55));
    colors.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const m = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  resources.push(g, m);
  const dome = new THREE.Mesh(g, m);
  dome.renderOrder = -1;
  dome.name = 'sky';
  return dome;
}

function softDisc(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx?.createRadialGradient) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

/** A small pool of sand puffs kicked up by the hind paws. */
function createDust(resources: { dispose(): void }[], map: THREE.Texture | null) {
  const count = 72;
  const position = new Float32Array(count * 3),
    alpha = new Float32Array(count),
    size = new Float32Array(count);
  const velocity = new Float32Array(count * 3),
    age = new Float32Array(count).fill(9);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      map: { value: map },
      scale: { value: 400 },
      tint: { value: new THREE.Color('#cdb08a') },
    },
    vertexShader: `attribute float alpha; attribute float size; varying float vAlpha; uniform float scale;
      void main(){ vAlpha = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0);
      gl_PointSize = size * scale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 tint; varying float vAlpha;
      void main(){ float a = texture2D(map, gl_PointCoord).a * vAlpha; if (a < 0.01) discard;
      gl_FragColor = vec4(tint, a); }`,
  });
  resources.push(g, material);
  const points = new THREE.Points(g, material);
  points.frustumCulled = false;
  points.renderOrder = 2;
  let next = 0,
    seed = 17;
  // Seeded so captures and replays are reproducible.
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return {
    points,
    material,
    spawn(x: number, z: number, heading: number, strength: number) {
      const i = next;
      next = (next + 1) % count;
      const back = 1.4 + random() * 1.6;
      position.set([x, 0.08, z], i * 3);
      velocity.set(
        [
          -Math.cos(heading) * back + (random() - 0.5) * 0.6,
          0.7 + random() * 0.8,
          Math.sin(heading) * back + (random() - 0.5) * 0.6,
        ],
        i * 3
      );
      age[i] = 0;
      size[i] = 0.2 * strength;
    },
    step(dt: number) {
      for (let i = 0; i < count; i++) {
        if (age[i] > 0.7) {
          alpha[i] = 0;
          continue;
        }
        age[i] += dt;
        const t = age[i] / 0.7;
        velocity[i * 3 + 1] -= 2.6 * dt;
        for (let k = 0; k < 3; k++) position[i * 3 + k] += velocity[i * 3 + k] * dt * (1 - t * 0.6);
        position[i * 3 + 1] = Math.max(0.03, position[i * 3 + 1]);
        alpha[i] = 0.32 * (1 - t) * Math.min(1, t * 8);
        size[i] = 0.22 + t * 0.55;
      }
      g.attributes.position.needsUpdate = true;
      g.attributes.alpha.needsUpdate = true;
      g.attributes.size.needsUpdate = true;
    },
    clear() {
      seed = 17;
      age.fill(9);
      alpha.fill(0);
      g.attributes.alpha.needsUpdate = true;
    },
  };
}

function createLure(resources: { dispose(): void }[]) {
  const group = new THREE.Group();
  const arm = new THREE.BoxGeometry(0.06, 0.06, 0.9),
    body = new THREE.SphereGeometry(0.13, 12, 8);
  const metal = new THREE.MeshStandardMaterial({
      color: '#c9c6bd',
      roughness: 0.4,
      metalness: 0.6,
    }),
    fluff = new THREE.MeshStandardMaterial({ color: '#efe7da', roughness: 1 });
  resources.push(arm, body, metal, fluff);
  const a = new THREE.Mesh(arm, metal);
  a.position.set(0, 0.42, 0.45);
  const b = new THREE.Mesh(body, fluff);
  b.scale.set(1.5, 0.9, 0.9);
  b.position.set(0, 0.36, 0.95);
  b.castShadow = true;
  group.add(a, b);
  group.name = 'lure';
  return group;
}

export function createRaceWorld(
  scene: THREE.Scene,
  {
    quality = 'balanced',
    renderer,
    runners = 8,
  }: { quality?: RaceQuality; renderer?: THREE.WebGLRenderer; runners?: number } = {}
) {
  const resources: { dispose(): void }[] = [];
  const low = quality === 'low';
  scene.background = HORIZON.clone();
  scene.fog = new THREE.Fog(HORIZON.clone(), 70, 330);
  scene.add(skyDome(resources));

  const hemi = new THREE.HemisphereLight('#dfe9ff', '#9a7f58', low ? 1.9 : 1.25);
  const sun = new THREE.DirectionalLight('#ffe4bf', low ? 2.6 : 2.9);
  sun.castShadow = !low;
  const shadowSize = quality === 'high' ? 2048 : 1024;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 140;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  // A soft camera-relative fill keeps the shadowed flank readable when the camera faces the sun.
  const fill = new THREE.DirectionalLight('#d9e6ff', 0.55);
  scene.add(hemi, sun, sun.target, fill, fill.target);

  if (!low && renderer) {
    // Image-based light from the same sky, generated once. Optional: skipped if unsupported.
    let pmrem: THREE.PMREMGenerator | null = null;
    try {
      pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene();
      const envResources: { dispose(): void }[] = [];
      envScene.add(skyDome(envResources));
      const groundGeometry = new THREE.CircleGeometry(400, 24).rotateX(-Math.PI / 2),
        groundMaterial = new THREE.MeshBasicMaterial({ color: '#8f7a57', side: THREE.DoubleSide });
      envResources.push(groundGeometry, groundMaterial);
      const ground = new THREE.Mesh(groundGeometry, groundMaterial);
      ground.position.y = -2;
      envScene.add(ground);
      try {
        // A soft gradient sky needs little resolution: 336x256 half-float (~0.7 MB)
        // instead of the 768x1024 default (~6.3 MB).
        const target = pmrem.fromScene(envScene, 0.04, 0.1, 100, { size: 64 });
        scene.environment = target.texture;
        scene.environmentIntensity = 0.7;
        resources.push(target);
      } finally {
        envResources.forEach((r) => r.dispose());
      }
    } catch {
      /* Reflections are optional. */
    } finally {
      pmrem?.dispose();
    }
  }

  const track = createTrack(scene, quality);
  const kit = createGreyhoundKit(quality);
  const dogs: Greyhound[] = Array.from({ length: runners }, (_, i) => createGreyhound(i, kit));
  const disc = softDisc();
  if (disc) resources.push(disc);
  const blobGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const blobMaterial = new THREE.MeshBasicMaterial({
    color: '#2a1d10',
    map: disc,
    transparent: true,
    opacity: low ? 0.5 : 0.32,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  resources.push(blobGeometry, blobMaterial);
  dogs.forEach((dog) => {
    const blob = new THREE.Mesh(blobGeometry, blobMaterial);
    blob.scale.set(1.25 * GREYHOUND_SCALE, 1, 0.42 * GREYHOUND_SCALE);
    blob.position.set(0.12, 0.015, 0);
    blob.renderOrder = 1;
    dog.root.add(blob);
    scene.add(dog.root);
  });
  const dust = low ? null : createDust(resources, disc);
  if (dust) scene.add(dust.points);
  const lure = low ? null : createLure(resources);
  if (lure) scene.add(lure);

  type State = {
    init: boolean;
    x: number;
    z: number;
    heading: number;
    phase: number;
    speed: number;
    yaw: number;
    contact: Record<string, boolean>;
  };
  const states: State[] = dogs.map(() => ({
    init: false,
    x: 0,
    z: 0,
    heading: 0,
    phase: 0,
    speed: 0,
    yaw: 0,
    contact: {},
  }));
  const views: RunnerView[] = dogs.map((_, index) => ({
    index,
    visible: false,
    x: 0,
    z: 0,
    heading: 0,
    lap: 0,
  }));
  const packCentre = new THREE.Vector3();

  function reset() {
    states.forEach((s) => (s.init = false));
    dust?.clear();
  }

  function update(frame: RaceFrame) {
    const dt = Math.max(1 / 240, Math.min(0.25, frame.dt));
    const settle = 1 - Math.exp(-dt / 0.28);
    let lead = -Infinity,
      trail = Infinity;
    for (let i = 0; i < dogs.length; i++) {
      const dog = dogs[i],
        s = states[i],
        view = views[i];
      view.visible = dog.root.visible = i < frame.field;
      if (!view.visible) continue;
      const lap = frame.laps[i] || 0,
        at = trackPoint(lap, laneOffset(i, frame.field));
      dog.root.position.set(at.x, 0.004, at.z);
      dog.root.rotation.y = at.heading;
      Object.assign(view, { x: at.x, z: at.z, heading: at.heading, lap });
      lead = Math.max(lead, lap);
      trail = Math.min(trail, lap);
      if (!s.init) {
        Object.assign(s, { init: true, x: at.x, z: at.z, heading: at.heading, yaw: 0 });
        s.speed = frame.running && lap > 0 ? 10 : 0;
        // Deterministic, distinct starting phase per runner.
        s.phase = (lap * TRACK_LENGTH) / 3.3 + i * 0.37;
      }
      let travel = Math.hypot(at.x - s.x, at.z - s.z);
      let turn = at.heading - s.heading;
      turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
      if (travel > 6) {
        // A rewind, replay or reload: re-anchor instead of sprinting through the gap.
        travel = 0;
        turn = 0;
      }
      s.x = at.x;
      s.z = at.z;
      s.heading = at.heading;
      const moving = frame.running && !frame.reduced;
      s.speed += ((moving ? travel / dt : 0) - s.speed) * settle;
      s.speed = Math.min(20, Math.max(0, s.speed));
      s.yaw += (turn / dt - s.yaw) * settle;
      if (moving) {
        // Stride length follows the actual travel rate, so a resumed feed never makes the
        // legs flail through tiny strides while the smoothed speed catches up.
        const pace = Math.max(s.speed, travel / dt);
        const stride = strideFor(pace / GREYHOUND_SCALE).length * GREYHOUND_SCALE;
        s.phase += travel / stride;
      }
      const run = frame.reduced
        ? frame.running && lap > 0
          ? 1
          : 0
        : smoothstep(0.8, 3.5, s.speed);
      const lean = frame.reduced
        ? 0
        : Math.max(-0.3, Math.min(0.3, 0.55 * Math.atan((s.speed * s.yaw) / 9.81))) * run;
      dog.update({
        // Reduced motion holds one extended-flight frame instead of cycling the legs.
        phase: frame.reduced ? 0.4 : s.phase,
        speed: frame.reduced ? 10 : Math.max(s.speed, 0.5),
        run,
        time: frame.reduced ? 0 : frame.time,
        lean,
      });
      if (dust && moving && s.speed > 4) {
        const contact = dog.contacts();
        if (contact)
          for (const limb of ['leftHind', 'rightHind'] as const) {
            if (s.contact[limb] && !contact[limb]) {
              const side = limb === 'leftHind' ? -1 : 1,
                back = -0.62 * GREYHOUND_SCALE;
              dust.spawn(
                at.x + Math.cos(at.heading) * back + Math.sin(at.heading) * side * 0.08,
                at.z - Math.sin(at.heading) * back + Math.cos(at.heading) * side * 0.08,
                at.heading,
                Math.min(1.2, s.speed / 9)
              );
            }
            s.contact[limb] = contact[limb];
          }
      }
    }
    if (!Number.isFinite(lead)) lead = trail = 0;
    dust?.step(frame.reduced ? 1 : dt);
    track.setStart(frame.running || lead > 0, lead, frame.field);
    if (lure) {
      const ahead = (0.6 + 8 * smoothstep(0, 0.03, lead)) / TRACK_LENGTH;
      const p = trackPoint(lead + ahead, -5.25);
      lure.visible = frame.running && !frame.reduced;
      lure.position.set(p.x, 0, p.z);
      lure.rotation.y = p.heading;
    }
    // Shadows follow the pack: a tight frustum keeps texel density high on phones.
    const mid = trackPoint((lead + trail) / 2, 0);
    packCentre.set(mid.x, 0, mid.z);
    const spread = (lead - trail) * TRACK_LENGTH;
    const half = Math.max(10, Math.min(28, spread / 2 + 7));
    const cam = sun.shadow.camera;
    if (cam.right !== half) {
      cam.left = cam.bottom = -half;
      cam.right = cam.top = half;
      cam.updateProjectionMatrix();
    }
    sun.position.copy(packCentre).addScaledVector(SUN_DIRECTION, 70);
    sun.target.position.copy(packCentre);
    sun.target.updateMatrixWorld();
    return { views, lead, trail, centre: packCentre };
  }

  /** Keep the fill light coming from the viewer and size dust for the drawing buffer. */
  function view(camera: THREE.PerspectiveCamera, drawingHeight: number) {
    // Haze starts beyond the field, so distant overviews (aerial, reduced motion) stay clear.
    const fog = scene.fog as THREE.Fog;
    fog.near = Math.max(70, camera.position.distanceTo(packCentre) * 0.9 + 30);
    fog.far = fog.near + 260;
    fill.position.copy(camera.position);
    fill.target.position.copy(packCentre);
    fill.target.updateMatrixWorld();
    if (dust)
      dust.material.uniforms.scale.value =
        drawingHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }

  return {
    dogs,
    track,
    sun,
    update,
    view,
    reset,
    dispose() {
      dogs.forEach((d) => d.dispose());
      kit.dispose();
      track.dispose();
      resources.forEach((r) => r.dispose());
      scene.environment = null;
    },
  };
}
export type RaceWorld = ReturnType<typeof createRaceWorld>;
