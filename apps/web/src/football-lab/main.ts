const hostEl = document.getElementById('host')!;
const hudEl = document.getElementById('hud')!;
const q = new URLSearchParams(location.search);
if (q.get('scene') === 'match') {
  // Full broadcast scene driven by the real engine. Everything is a pure function of the URL:
  //   ?scene=match&t=<seconds>&key=<fixture id>&home=<club>&away=<club>&goals=6000H,19500A&reduced=1
  const goals = (q.get('goals') ?? '')
    .split(',')
    .filter(Boolean)
    .map((g, i) => ({ n: i + 1, side: g.endsWith('A') ? ('A' as const) : ('H' as const), atMs: Number(g.slice(0, -1)) }));
  const t = Number(q.get('t') ?? '10');
  const status = t < 0 ? 'SCHEDULED' : t < 28 ? 'FIRST_HALF' : t < 32 ? 'HALFTIME' : t < 60 ? 'SECOND_HALF' : 'FULL_TIME';
  const released = goals.filter((g) => g.atMs <= t * 1000);
  const engine = createEngine({ host: hostEl, getElapsed: () => t * 1000, reduced: q.get('reduced') === '1', maxPixelRatio: 1 });
  engine.setMatch({
    matchKey: q.get('key') ?? 'vf-s1-w01-f01',
    homeClub: Number(q.get('home') ?? 1),
    awayClub: Number(q.get('away') ?? 2),
    status,
    goals: released,
    fullTime: t >= 60 ? { home: released.filter((g) => g.side === 'H').length, away: released.filter((g) => g.side === 'A').length } : null,
  });
  // A short lead-in lets the camera settle exactly as live play would.
  const lead = q.get('settle') === '1' ? 18 : 0;
  for (let i = lead; i > 0; i--) engine.renderAt(Math.max(-1000, t * 1000 - i * 33), 1 / 30);
  const frame = engine.renderAt(t * 1000, 1 / 30);
  const info = engine.info();
  hudEl.textContent = `match view · t=${t}s · mode=${frame.mode} · tris=${info.triangles} calls=${info.calls}`;
  (window as unknown as { __lab: unknown }).__lab = {
    ready: true,
    engine,
    renderAt: (ms: number, dt = 1 / 30) => engine.renderAt(ms, dt).mode,
    setGoals: (g: Array<{ n: number; side: 'H' | 'A'; atMs: number }>) =>
      engine.setMatch({ matchKey: q.get('key') ?? 'vf-s1-w01-f01', homeClub: Number(q.get('home') ?? 1), awayClub: Number(q.get('away') ?? 2), status: 'FIRST_HALF', goals: g, fullTime: null }),
    info: () => engine.info(),
  };
  throw new Error('lab:match-ready'); // stop the legacy filmstrip code below from running
}

import * as THREE from 'three';
import { createRig, kitFromClub, kitTexture, lookGeometry, type Look, type Rig } from '@/components/football/engine/rig';
import { createEngine } from '@/components/football/engine/engine';
import { DIVE_DURATION, diveRoot, KICK, kickGeometry, poseCelebrate, poseIdle, poseKeeperDive, poseKeeperReady, poseKick, poseRun, strideLength, type Celebration } from '@/components/football/engine/poses';

/**
 * Dev-only lab for the Virtual Football engine. Open /football-lab.html?scene=<name>:
 *   rest | run | sprint | kick | keeper | celebrate
 * Everything is a pure function of the URL, so a screenshot is reproducible.
 */
const host = document.getElementById('host')!;
const hud = document.getElementById('hud')!;
const params = new URLSearchParams(location.search);
const scene3 = params.get('scene') ?? 'rest';
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(host.clientWidth, host.clientHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#223049');
scene.add(new THREE.HemisphereLight('#cfe0ff', '#2c4a2a', 1.2));
const sun = new THREE.DirectionalLight('#fff4e0', 2.6);
sun.position.set(4, 8, 6);
sun.castShadow = true;
sun.shadow.camera.left = -8; sun.shadow.camera.right = 8; sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: '#3e8a45' }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const looks: Look[] = [
  { kit: kitFromClub({ primary: '#d9382c', secondary: '#ffffff', pattern: 'stripes' }), skin: '#f2c7a0', hair: '#1d1a18' },
  { kit: kitFromClub({ primary: '#1d4fd8', secondary: '#f5f7ff', pattern: 'hoops' }), skin: '#a86b45', hair: '#0f0e10' },
  { kit: { ...kitFromClub({ primary: '#6ee05a', secondary: '#6ee05a', pattern: 'solid' }), shorts: '#222', socks: '#222', keeper: true, glove: '#f2f2f2' }, skin: '#f5d6b8', hair: '#a9783b' },
];
const cleanup: Array<() => void> = [];
function rigFor(look: Look): Rig {
  const lg = lookGeometry(look);
  const map = kitTexture(look.kit);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 0.78 });
  const rig = createRig(material, lg.geometry);
  scene.add(rig.root);
  cleanup.push(() => { rig.dispose(); lg.dispose(); map.dispose(); material.dispose(); });
  return rig;
}
function ball(x: number, y: number, z: number) {
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 16), new THREE.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.5 }));
  b.position.set(x, y, z);
  b.castShadow = true;
  scene.add(b);
}
const camera = new THREE.PerspectiveCamera(30, host.clientWidth / host.clientHeight, 0.1, 100);
let caption = scene3;

if (scene3 === 'rest') {
  looks.forEach((l, i) => { const r = rigFor(l); r.root.position.set((i - 1) * 1.1, 0, 0); poseIdle(r, 0, i); });
  camera.position.set(0, 1.3, 7.2); camera.lookAt(0, 0.95, 0);
} else if (scene3 === 'run' || scene3 === 'sprint') {
  const speed = scene3 === 'run' ? 4.2 : 8.5;
  const n = 8;
  for (let i = 0; i < n; i++) {
    const r = rigFor(looks[i % 2]);
    r.root.position.set(-5.2 + i * 1.5, 0, 0);
    r.root.rotation.y = Math.PI / 2; // face +X
    poseRun(r, i / n, speed);
  }
  caption = `${scene3}: ${speed} m/s, stride ${strideLength(speed).toFixed(2)} m, 8 phases`;
  camera.position.set(0, 1.4, -11); camera.lookAt(0, 0.9, 0); camera.fov = 34;
} else if (scene3 === 'kick') {
  const times = [0, 0.12, KICK.contact - 0.05, KICK.contact, KICK.contact + 0.1, 0.62];
  times.forEach((t, i) => {
    const r = rigFor(looks[0]);
    const spec = { ball: new THREE.Vector3(0, 0.11, 0), dir: new THREE.Vector3(1, 0, 0), foot: 'R' as const, power: 1, loft: 0.2 };
    const g = kickGeometry(spec);
    r.root.position.copy(g.root).add(new THREE.Vector3(-5.5 + i * 2.2, 0, 0));
    r.root.rotation.y = Math.PI / 2;
    const shifted = { ...spec, ball: spec.ball.clone().add(new THREE.Vector3(-5.5 + i * 2.2, 0, 0)) };
    poseKick(r, t, shifted);
    if (t <= KICK.contact) ball(shifted.ball.x, 0.11, 0);
    else ball(shifted.ball.x + 0.6 + (t - KICK.contact) * 14, 0.11 + (t - KICK.contact) * 3, 0);
  });
  caption = `kick: t = ${times.map((t) => t.toFixed(2)).join(', ')} s (contact ${KICK.contact}s)`;
  camera.position.set(0, 1.3, -10.5); camera.lookAt(0, 0.8, 0); camera.fov = 34;
} else if (scene3 === 'keeper') {
  const times = [0, 0.15, 0.3, 0.45, 0.7, 1.0, 1.6];
  times.forEach((t, i) => {
    const r = rigFor(looks[2]);
    const spec = { direction: 1 as const, reach: 1.6, height: 1.4 };
    r.root.position.set(-4.2 + i * 1.5, 0, 0).add(diveRoot(spec, t).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0));
    r.root.rotation.y = 0;
    const target = new THREE.Vector3(-4.2 + i * 1.5 + 1.6, 1.4, 0.6);
    if (t === 0) poseKeeperReady(r, 0.2); else poseKeeperDive(r, t, spec, target);
    if (t <= 0.5) ball(target.x, target.y, target.z);
  });
  caption = `keeper dive, t = ${times.join(', ')} of ${DIVE_DURATION}s`;
  camera.position.set(0, 1.5, 9.5); camera.lookAt(0, 0.8, 0); camera.fov = 34;
} else if (scene3 === 'celebrate') {
  const kinds: Celebration[] = ['ARMS_UP', 'WINGS', 'LEAP', 'KNEE_SLIDE', 'HUG', 'DEJECTED'];
  kinds.forEach((k, i) => {
    const r = rigFor(looks[i % 2]);
    r.root.position.set(-4.2 + i * 1.7, 0, 0);
    r.root.rotation.y = Math.PI;
    poseCelebrate(r, k, 0.25);
  });
  caption = `celebrations: ${kinds.join(', ')}`;
  camera.position.set(0, 1.4, -8.5); camera.lookAt(0, 0.9, 0); camera.fov = 36;
}
camera.aspect = host.clientWidth / host.clientHeight;
camera.updateProjectionMatrix();
renderer.render(scene, camera);
hud.textContent = `${caption}\ntris=${renderer.info.render.triangles} calls=${renderer.info.render.calls}`;
(window as unknown as { __lab: unknown }).__lab = { ready: true };
void cleanup;
void kickGeometry;
