import * as THREE from 'three';
import {
  createRiggedHorse,
  loadHorseAssets,
  prepareHorseAssets,
  type RaceHorse,
} from '../components/derby/rigged-horse';
import { runnerLook } from '../components/derby/runner-identity';
import { createRacecourse, laneZ, RUNNER_GROUND_Y } from '../components/derby/racecourse';
import {
  createBroadcastDirector,
  type DerbyCameraMode,
} from '../components/derby/broadcast-camera';

// Dev-only review of the Derby rigs and course. Query parameters:
//   ?n=1..8 runners  ?view=side|quarter|front|rear|top|jockey|hoof|saddle|wide
//   ?phase=0.3 stride seconds  ?moving=1|0  ?idle=0 idle seconds  ?drive=0..1
//   ?course=1 build the racecourse  ?x=120 world X of the field  ?quality=high|balanced|low
//   ?capture=1 render only on window.__lab.frame(...)
const q = new URLSearchParams(location.search);
const field = Math.max(1, Math.min(8, Number(q.get('n') ?? 1)));
const quality = (q.get('quality') ?? 'high') as 'high' | 'balanced' | 'low';
const host = document.getElementById('host')!;
const hud = document.getElementById('hud')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.shadowMap.enabled = quality !== 'low';
renderer.shadowMap.type = quality === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 3000);
const course = q.get('course') === '1' ? createRacecourse(scene, { quality, renderer }) : null;
if (!course) {
  scene.background = new THREE.Color('#9fb6c4');
  scene.add(new THREE.HemisphereLight('#e4eff6', '#5d6447', 1.3));
  const sun = new THREE.DirectionalLight('#fff0d4', 2.6);
  sun.position.set(20, 30, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12 });
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#6f8a4f', roughness: 0.95 })
  );
  ground.receiveShadow = true;
  ground.position.y = RUNNER_GROUND_Y;
  scene.add(ground);
}
const director = course ? createBroadcastDirector(course.obstacles) : null;
// Cost ablations for software-render study only.
if (q.get('clouds') === '0') scene.getObjectByName('clouds')?.removeFromParent();
if (q.get('shadows') === '0') renderer.shadowMap.enabled = false;
if (q.get('aa') === '0') renderer.setPixelRatio(1);
const state = {
  mode: (q.get('mode') ?? 'trackside') as DerbyCameraMode,
  running: q.get('running') !== '0',
  finished: q.get('finished') === '1',
  spread: Number(q.get('spread') ?? 1.5),
  aspect: 0,
  view: q.get('view') ?? 'side',
  phase: Number(q.get('phase') ?? 0.3),
  moving: q.get('moving') !== '0',
  idle: Number(q.get('idle') ?? 0),
  drive: Number(q.get('drive') ?? 0),
  x: Number(q.get('x') ?? 0),
};
let horses: RaceHorse[] = [];
const assets = await loadHorseAssets();
const started = performance.now();
await prepareHorseAssets(assets);
const calibrationMs = performance.now() - started;
horses = Array.from({ length: field }, (_, i) => {
  const look = runnerLook(i);
  const horse = createRiggedHorse(assets, look.coat, look.silks, i, {
    look,
    quality,
    environment: course?.environment,
  });
  horse.root.position.set(0, RUNNER_GROUND_Y, laneZ(i, field));
  scene.add(horse.root);
  return horse;
});

function aim(view: string) {
  const x = state.x,
    mid = 0;
  const near = laneZ(field - 1, field);
  const views: Record<string, [number[], number[], number]> = {
    side: [[x + 0.4, 2.1, near + 9.5], [x + 0.3, 1.6, near], 30],
    quarter: [[x + 7, 3.2, near + 7], [x, 1.6, near], 30],
    front: [[x + 10, 2.2, near + 0.2], [x, 1.5, near], 30],
    rear: [[x - 9, 3, near + 2.5], [x, 1.5, near], 30],
    top: [[x, 14, near + 0.01], [x, 0, near], 30],
    jockey: [[x + 1.2, 3.1, near + 4], [x + 0.2, 2.4, near], 30],
    hoof: [[x + 0.5, 0.45, near + 4.2], [x + 0.2, 0.35, near], 32],
    saddle: [[x - 0.6, 3.4, near + 3.2], [x - 0.1, 2.2, near], 32],
    cloth: [[x - 0.3, 2.1, near + 3.6], [x - 0.3, 1.95, near], 30],
    wide: [[x + 6, 6, mid + 26], [x, 1.2, mid], 34],
  };
  const [p, t, fov] = views[view] ?? views.side;
  camera.position.set(p[0], p[1], p[2]);
  camera.fov = fov;
  camera.lookAt(t[0], t[1], t[2]);
}
function resize() {
  const w = host.clientWidth,
    h = host.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
let shot = '';
function frame(next: Partial<typeof state> = {}) {
  Object.assign(state, next);
  resize();
  // Deterministic, published-looking spread: alternating small gaps per runner.
  const positions = horses.map((_, i) => state.x - ((i * 37) % field) * state.spread * 0.5);
  horses.forEach((horse, i) => {
    horse.root.position.x = state.view === 'director' ? positions[i] : state.x;
    horse.animate(state.phase + i * 0.05, state.moving, {
      idle: state.idle,
      drive: state.drive,
    });
  });
  if (state.view === 'director' && director) {
    director.reset();
    shot = director.update(
      camera,
      state.mode,
      {
        positions,
        field,
        running: state.running,
        finished: state.finished,
        reduced: false,
        time: state.idle,
      },
      0
    ).shot;
  } else aim(state.view);
  course?.update({
    center: state.x,
    spread: state.spread * field + 6,
    camera,
    time: state.idle,
    field,
    gateOpen: state.moving,
  });
  renderer.render(scene, camera);
  hud.textContent = `Derby lab · ${state.view}${shot ? ' ' + shot : ''} · x ${state.x.toFixed(0)} · phase ${state.phase.toFixed(3)} · ${
    state.moving ? 'gallop' : 'standing'
  } · calibration ${calibrationMs.toFixed(0)} ms · ${renderer.info.render.calls} draws · ${
    renderer.info.render.triangles
  } tris`;
  return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
}
(window as unknown as { __lab: unknown }).__lab = { ready: true, frame, calibrationMs };
if (q.get('capture') !== '1') {
  const loop = (t: number) => {
    frame({ phase: state.moving ? t / 1000 : state.phase, idle: t / 1000 });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
} else frame();
