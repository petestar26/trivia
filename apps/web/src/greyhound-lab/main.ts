import * as THREE from 'three';
import { createRaceWorld, laneOffset, type RaceQuality } from '../components/dog-racing/world';
import { createCameraRig, type DogCamera } from '../components/dog-racing/camera';
import { trackPoint, TRACK_LENGTH } from '../components/dog-racing/track';

// ?view=side|quarter|front|rear|trackside|chase|aerial  ?dogs=1..8  ?speed=10.5 (scene m/s)
// ?lap=0.12 start lap  ?quality=high|balanced|low  ?capture=1 (no rAF; drive window.__lab.step)
// ?reduced=1  ?running=0 (standing at the given lap)
// Benchmark (software-render cost study): ?bench=1&dpr=1&aa=0|1&shadows=0|1|soft&env=0|1
//   &bump=0|1&scenery=standard|lambert&receive=all|track&dust=0|1 — results in window.__bench
const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'side';
const field = Math.max(1, Math.min(8, Number(q.get('dogs') ?? 1)));
const speed = Number(q.get('speed') ?? 10.5);
const startLap = Number(q.get('lap') ?? 0.08);
const quality = (q.get('quality') ?? 'high') as RaceQuality;
const reduced = q.get('reduced') === '1';
const running = q.get('running') !== '0';
const host = document.getElementById('host')!;
const flag = (name: string, fallback: string) => q.get(name) ?? fallback;
const renderer = new THREE.WebGLRenderer({
  antialias: flag('aa', quality === 'low' ? '0' : '1') === '1',
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Number(flag('dpr', String(Math.min(2, window.devicePixelRatio)))));
renderer.shadowMap.enabled = flag('shadows', quality === 'low' ? '0' : '1') !== '0';
renderer.shadowMap.type =
  flag('shadows', quality === 'high' ? 'soft' : '1') === 'soft'
    ? THREE.PCFSoftShadowMap
    : THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.3, 600);
const world = createRaceWorld(scene, { quality, renderer, runners: 8 });
const rig = createCameraRig();
// Ablations for the benchmark only; they never ship.
if (q.get('env') === '0') scene.environment = null;
const dogMeshes = new Set<THREE.Object3D>();
world.dogs.forEach((d) => d.root.traverse((o) => dogMeshes.add(o)));
scene.traverse((o) => {
  if (!(o instanceof THREE.Mesh) || dogMeshes.has(o)) return;
  if (
    q.get('receive') === 'track' &&
    !(o.material as THREE.Material & { vertexColors?: boolean }).vertexColors
  )
    o.receiveShadow = false;
  const m = o.material as THREE.MeshStandardMaterial;
  if (q.get('scenery') === 'lambert' && m instanceof THREE.MeshStandardMaterial) {
    o.material = new THREE.MeshLambertMaterial({
      color: m.color,
      map: m.map,
      vertexColors: m.vertexColors,
      emissive: m.emissive,
      emissiveIntensity: m.emissiveIntensity,
      alphaMap: m.alphaMap,
      alphaTest: m.alphaTest,
      side: m.side,
    });
  }
});
if (q.get('bump') === '0')
  world.dogs.forEach((d) => {
    const m = d.mesh.material as THREE.MeshStandardMaterial;
    m.bumpMap = null;
    m.needsUpdate = true;
  });
if (q.get('dust') === '0') scene.traverse((o) => o instanceof THREE.Points && (o.visible = false));
function resize() {
  renderer.setSize(host.clientWidth, host.clientHeight);
  camera.aspect = host.clientWidth / host.clientHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
let clock = 0;
const laps = () =>
  Array.from({ length: 8 }, (_, i) =>
    running ? startLap + (speed * (1 - i * 0.012) * clock) / TRACK_LENGTH - i * 0.002 : startLap
  );
function step(seconds: number) {
  clock += seconds;
  const current = laps();
  const result = world.update({ laps: current, field, running, reduced, dt: seconds, time: clock });
  const subject = trackPoint(current[0], laneOffset(0, field));
  const forward = new THREE.Vector3(Math.cos(subject.heading), 0, -Math.sin(subject.heading));
  const outward = new THREE.Vector3(Math.sin(subject.heading), 0, Math.cos(subject.heading));
  const centre = new THREE.Vector3(subject.x, 0.62, subject.z);
  if (['trackside', 'chase', 'aerial'].includes(view)) {
    rig.update(
      camera,
      view as DogCamera,
      {
        lead: result.lead,
        trail: result.trail,
        running,
        runners: result.views.filter((v) => v.visible),
      },
      seconds,
      reduced
    );
  } else {
    camera.fov = 30;
    camera.updateProjectionMatrix();
    const offsets: Record<string, [number, number, number]> = {
      side: [0.25, 5.2, 1.0],
      quarter: [3.2, 4.2, 1.3],
      front: [6.5, 0.6, 0.9],
      rear: [-6, 1.2, 1.4],
    };
    const [f, o, h] = offsets[view] ?? offsets.side;
    camera.position.copy(centre).addScaledVector(forward, f).addScaledVector(outward, o);
    camera.position.y = h;
    camera.lookAt(centre.clone().addScaledVector(forward, 0.15));
  }
  world.view(camera, renderer.domElement.height);
  renderer.render(scene, camera);
}
step(1 / 60);
(window as unknown as { __lab: unknown }).__lab = { step: (ms: number) => step(ms / 1000) };
if (q.get('bench') === '1') {
  // Time each frame including the GPU (or software rasteriser): a one-pixel readback
  // forces a synchronous round trip (gl.finish() does not block in Chrome).
  const gl = renderer.getContext();
  const pixel = new Uint8Array(4);
  const times: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now();
    step(1 / 30);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    if (i >= 10) times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  (window as unknown as { __bench: unknown }).__bench = {
    medianMs: times[Math.floor(times.length / 2)],
    p90Ms: times[Math.floor(times.length * 0.9)],
    buffer: [renderer.domElement.width, renderer.domElement.height],
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  };
}
if (q.get('capture') !== '1') {
  let last = performance.now();
  const loop = (now: number) => {
    step(Math.min(0.1, (now - last) / 1000));
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
