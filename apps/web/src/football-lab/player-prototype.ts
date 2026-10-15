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
  loadReviewPlayerAssets,
  attachReviewHead,
} from '../components/football/engine/review-player';
import { attachReviewBody } from '../components/football/engine/review-player-body';
import {
  sampleReviewMotionScenario,
  applyReviewPlayerMotion,
  poseReviewPlayerHands,
  REVIEW_MOTION_SCENARIOS,
  type ReviewMotionScenario,
} from '../components/football/engine/review-player-motion';
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
  poseKeeperDive,
  type RunPlant,
  KICK,
  DIVE_CONTACT,
} from '../components/football/engine/poses';

const q = new URLSearchParams(location.search),
  scene = new THREE.Scene();
const reduced = q.has('reduced') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const requested = q.get('scenario') ?? 'jog';
const scenario: ReviewMotionScenario = REVIEW_MOTION_SCENARIOS.includes(
  requested as ReviewMotionScenario
)
  ? (requested as ReviewMotionScenario)
  : 'jog';
const keeper = q.has('keeper') || scenario === 'keeperDive';
scene.background = new THREE.Color('#8fa39b');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.append(renderer.domElement);
scene.add(new THREE.HemisphereLight('#e8f1f6', '#786c5d', 1.6));
const sun = new THREE.DirectionalLight('#fff2df', 2.2);
sun.position.set(2, 4, 5);
scene.add(sun);
const fill = new THREE.DirectionalLight('#edf3ff', 0.65);
fill.position.set(-3, 2, 1);
scene.add(fill);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(300, 300),
  new THREE.MeshStandardMaterial({ color: '#356746', roughness: 0.95 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.001;
scene.add(ground);
const base = await loadPlayerUpgrade();
const assets = await loadReviewPlayerAssets().catch(() => undefined);
const identity = playerIdentity(Number(q.get('club') ?? 1), Number(q.get('slot') ?? 1));
const kit = kitFromClub({
  primary: keeper ? '#397477' : '#6b233c',
  secondary: keeper ? '#d5b292' : '#d5b292',
  pattern: 'solid',
});
kit.shorts = '#202126';
if (keeper) {
  kit.keeper = true;
  kit.glove = '#deded8';
}
const look = { kit, skin: identity.skin, hair: identity.hair },
  lg = lookGeometry(look, base),
  fabric = appearanceTextures('fabric'),
  skin = appearanceTextures('skin');
const kitMap = kitTexture(kit),
  material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: kitMap,
    normalMap: fabric.normal,
    normalScale: new THREE.Vector2(0.2, 0.2),
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
const rig = createRig(material, lg.geometry);
scene.add(rig.root);
const fallback = headMaterial(skin);
const head = assets
  ? attachReviewHead(rig, base.heads!, identity, fallback, assets, skin)
  : attachPlayerHead(rig, base.heads!, identity, fallback);
const body = assets ? attachReviewBody(rig, base, look, material) : undefined;
head.setDetail('high');
body?.setDetail('high');
const boots = attachBootDetails(rig);
boots.setDetail('high');
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(0.11, 16, 10),
  new THREE.MeshStandardMaterial({ color: '#f6f3ed', roughness: 0.55 })
);
scene.add(ball);
let plants: RunPlant = {};
const camera = new THREE.PerspectiveCamera(
  q.has('face') ? 30 : 35,
  innerWidth / innerHeight,
  0.01,
  1000
);
const kick = {
  ball: new THREE.Vector3(0, 0.11, 0),
  dir: new THREE.Vector3(0, 0, 1),
  foot: 'R' as const,
  power: 0.75,
  loft: 0.2,
};
function draw(t = 0, exportFrame = false) {
  if (reduced) t = 0;
  const close = q.has('face'),
    s = sampleReviewMotionScenario(close ? 'idle' : scenario, t);
  rig.root.position.set(s.position.x, s.position.y, s.position.z);
  rig.root.rotation.y = close ? 0 : s.heading;
  ball.visible = !close && (scenario === 'kick' || scenario === 'keeperDive');
  ball.position.copy(kick.ball);
  if (close || reduced) poseIdle(rig, 0);
  else if (s.motion.kind === 'run') {
    poseRun(rig, s.phase, Math.max(1.2, s.speed), {
      acceleration: Math.max(0, s.motion.acceleration ?? 0) / 4,
      accelerationTime: t,
      turn: s.motion.turn,
      turnTime: t,
    });
  } else if (scenario === 'kick') {
    const root = kickGeometry(kick).root;
    rig.root.position.copy(root);
    poseKick(rig, t, kick);
    if (t > KICK.contact)
      ball.position.addScaledVector(kick.dir, (t - KICK.contact) * 5).y +=
        Math.sin(Math.min(1, (t - KICK.contact) / 1.5) * Math.PI) * 0.5;
  } else if (scenario === 'keeperDive' && s.keeperSpec) {
    const target = new THREE.Vector3(s.keeperSpec.reach, s.keeperSpec.height, 0.12);
    poseKeeperDive(rig, t, s.keeperSpec, target);
    ball.position.copy(target);
    if (t < DIVE_CONTACT) ball.position.z += (DIVE_CONTACT - t) * 3;
  } else poseIdle(rig, t);
  if (assets)
    applyReviewPlayerMotion(rig, {
      ...s.motion,
      time: close ? t : s.motion.time,
      reducedMotion: reduced,
    });
  if (s.motion.kind === 'run' && !reduced)
    plantRunFeet(rig, s.phase, Math.max(1.2, s.speed), plants);
  poseFingers(rig, s.motion.kind, !reduced);
  if (assets) poseReviewPlayerHands(rig, s.motion.kind, !reduced, s.phase);
  head.animate(t, s.motion.kind, !reduced);
  rig.root.updateMatrixWorld(true);
  const position = rig.root.position;
  if (close) {
    camera.position.set(
      position.x + (q.has('profile') ? 1.05 : 0.22),
      1.7,
      position.z + (q.has('profile') ? 0.45 : 1.16)
    );
    camera.lookAt(position.x, 1.67, position.z + 0.015);
  } else {
    camera.position.set(position.x + 2.1, 1.6, position.z + 3.8);
    camera.lookAt(position.x, 0.92, position.z);
  }
  renderer.render(scene, camera);
  const caption = document.querySelector('#caption');
  if (caption)
    caption.textContent = `Simulated character diagnostic · ${identity.name} · ${keeper ? 'goalkeeper kit' : 'outfield kit'} · ${reduced ? 'reduced motion' : s.label} · ${assets ? 'review assets' : 'PR59 fallback'}`;
  return {
    t,
    scenario,
    label: s.label,
    sample: s,
    identity,
    reviewAssets: !!assets,
    keeper,
    reduced,
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
    plants = {};
  },
  dispose() {
    head.dispose();
    body?.dispose();
    boots.dispose();
    rig.dispose();
    lg.dispose();
    material.dispose();
    kitMap.dispose();
    fallback.dispose();
    skin.dispose();
    fabric.dispose();
    assets?.dispose();
    base.geometry.dispose();
    for (const g of Object.values(base.heads ?? {})) g.dispose();
    for (const b of Object.values(base.bodyLods ?? {})) b.geometry.dispose();
    (ground.geometry as THREE.BufferGeometry).dispose();
    (ground.material as THREE.Material).dispose();
    ball.geometry.dispose();
    (ball.material as THREE.Material).dispose();
    renderer.dispose();
  },
};
draw(Number(q.get('t') ?? 0));
