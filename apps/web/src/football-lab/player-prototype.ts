import * as THREE from 'three';
import { loadPlayerUpgrade } from '../components/football/engine/player-assets';
import {
  appearanceTextures,
  headMaterial,
  attachPlayerHead,
  playerIdentity,
  poseFingers,
  attachBootDetails,
} from '../components/football/engine/player-appearance';
import {
  createRig,
  lookGeometry,
  kitTexture,
  kitFromClub,
} from '../components/football/engine/rig';
import {
  poseIdle,
  poseRun,
  poseKick,
  kickGeometry,
  plantRunFeet,
  strideLength,
  poseKeeperDive,
} from '../components/football/engine/poses';
const q = new URLSearchParams(location.search),
  scene = new THREE.Scene();
const reduced = q.has('reduced') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
scene.background = new THREE.Color('#8fa39b');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.append(renderer.domElement);
scene.add(new THREE.HemisphereLight('#e8f1f6', '#786c5d', 2.1));
const sun = new THREE.DirectionalLight('#fff2df', 2.2);
sun.position.set(2, 4, 5);
scene.add(sun);
const fill = new THREE.DirectionalLight('#edf3ff', 0.85);
fill.position.set(-3, 2, 1);
scene.add(fill);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(300, 300),
  new THREE.MeshStandardMaterial({ color: '#356746', roughness: 0.95 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.001;
scene.add(ground);
const base = await loadPlayerUpgrade(),
  heads = base.heads!,
  identity = playerIdentity(Number(q.get('club') ?? 1), Number(q.get('slot') ?? 1));
const kit = kitFromClub({ primary: '#6b233c', secondary: '#d5b292', pattern: 'solid' });
kit.shorts = '#202126';
const lg = lookGeometry({ kit, skin: identity.skin, hair: identity.hair }, base),
  fabric = appearanceTextures('fabric');
const rig = createRig(
  new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: kitTexture(kit),
    normalMap: fabric.normal,
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughness: 0.9,
  }),
  lg.geometry
);
scene.add(rig.root);
const skin = appearanceTextures('skin'),
  head = attachPlayerHead(rig, heads, identity, headMaterial(skin));
head.setDetail('high');
const boots = attachBootDetails(rig);
boots.setDetail('high');
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(0.11, 16, 10),
  new THREE.MeshStandardMaterial({ color: '#f6f3ed', roughness: 0.55 })
);
scene.add(ball);
const plants = {};
const camera = new THREE.PerspectiveCamera(
  q.has('face') ? 27 : 35,
  innerWidth / innerHeight,
  0.01,
  1000
);
function draw(t = 0, exportFrame = false) {
  if (reduced) t = 0;
  const close = q.has('face'),
    phase = t % 9;
  let x = phase < 2 ? phase * 2 : phase < 4 ? 4 : phase < 6 ? 4 - (phase - 4) * 2 : 0;
  const heading =
    phase < 2 ? Math.PI / 2 : phase < 4 ? Math.PI / 2 + ((phase - 2) * Math.PI) / 2 : Math.PI * 1.5;
  rig.root.position.set(x, 0, 0);
  rig.root.rotation.y = close ? 0 : heading;
  const spec = {
    ball: new THREE.Vector3(0, 0.11, 0),
    dir: new THREE.Vector3(-1, 0, 0),
    foot: 'R' as const,
    power: 0.75,
    loft: 0.2,
  };
  ball.visible = !close && phase >= 6;
  ball.position.copy(spec.ball);
  if (phase > 6.3)
    ball.position.addScaledVector(spec.dir, (phase - 6.3) * 5).y +=
      Math.sin(Math.min(1, (phase - 6.3) / 1.5) * Math.PI) * 0.5;
  if (close || reduced) poseIdle(rig, 0);
  else if (phase < 2) {
    poseRun(rig, (phase * 2) / strideLength(2), 2, {
      acceleration: Math.max(0, 1 - phase),
      accelerationTime: phase,
    });
    plantRunFeet(rig, (phase * 2) / strideLength(2), 2, plants);
  } else if (phase < 4) {
    poseRun(rig, (2 * 2) / strideLength(2), 1.2, { turn: 0.5, turnTime: phase - 2 });
    plantRunFeet(rig, (2 * 2) / strideLength(2), 1.2, plants);
  } else if (phase < 6) {
    poseRun(rig, ((phase - 4) * 2) / strideLength(2), 2);
    plantRunFeet(rig, ((phase - 4) * 2) / strideLength(2), 2, plants);
  } else if (phase < 7.2) {
    rig.root.position.copy(kickGeometry(spec).root);
    rig.root.rotation.y = -Math.PI / 2;
    poseKick(rig, phase - 6, spec);
  } else poseIdle(rig, 0);
  poseFingers(rig, phase < 2 ? 'run' : 'idle', !reduced);
  head.animate(t, close ? 'idle' : phase < 2 ? 'run' : 'idle', !reduced);
  rig.root.updateMatrixWorld(true);
  if (close) {
    camera.position.set(x + (q.has('profile') ? 0.9 : 0.22), 1.66, q.has('profile') ? 0.4 : 0.96);
    camera.lookAt(x, 1.63, 0.015);
  } else {
    camera.position.set(x + 2.2, 1.6, 4.9);
    camera.lookAt(x, 0.92, 0);
  }
  renderer.render(scene, camera);
  return {
    t,
    identity,
    camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() },
    info: { ...renderer.info.render },
    jpeg: exportFrame ? renderer.domElement.toDataURL('image/jpeg', 0.94) : undefined,
  };
}
(window as any).__prototype = {
  ready: true,
  draw,
  rig,
  head,
  camera,
  scene,
  renderer,
  reset() {
    for (const key of Object.keys(plants)) delete (plants as any)[key];
  },
};
draw(Number(q.get('t') ?? 0));
