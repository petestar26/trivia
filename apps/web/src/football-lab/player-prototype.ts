import {
  createNativeJogState,
  resetNativeJogState,
  prepareNativeJog,
  applyNativeJogAfterPlant,
  poseNativeJogFingers,
} from '../components/football/engine/native-jog';
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
  loadContinuousPlayerAssets,
  attachContinuousPlayer,
} from '../components/football/engine/continuous-player';
import {
  sampleReviewMotionScenario,
  applyReviewPlayerMotion,
  poseReviewPlayerHands,
  REVIEW_MOTION_SCENARIOS,
  type ReviewMotionScenario,
  createReviewMotionState,
  resetReviewMotionState,
  sampleReviewFinishingSequence,
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
  resetPose,
  capture,
  blendTo,
  type PoseSnapshot,
} from '../components/football/engine/poses';
import { placeFoot } from '../components/football/engine/ik';

const q = new URLSearchParams(location.search),
  scene = new THREE.Scene();
const reduced = q.has('reduced') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const requested = q.get('scenario') ?? 'jog';
const finishingSequence = requested === 'finishingSequence';
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
// Original diagnostic markings expose travelled distance and planted turns even
// while the close camera follows the actor. They are not match outcome inputs.
const markings = new THREE.GridHelper(60, 30, '#a8bfa7', '#496f54');
markings.position.y = 0.0005;
markings.visible = finishingSequence || q.has('markers');
scene.add(markings);
const base = await loadPlayerUpgrade();
const assets = await loadReviewPlayerAssets().catch(() => undefined);
const continuousAssets =
  !q.has('baseline') && assets
    ? await loadContinuousPlayerAssets('native-authored-v5').catch(() => undefined)
    : undefined;
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
  ? attachReviewHead(rig, base.heads!, identity, fallback, assets, skin, !!continuousAssets)
  : attachPlayerHead(rig, base.heads!, identity, fallback);
const body = assets
  ? continuousAssets
    ? attachContinuousPlayer(rig, base, look, material, continuousAssets, assets, skin, head)
    : attachReviewBody(rig, base, look, material)
  : undefined;
const detail = q.get('detail') === 'low' ? 'low' : q.get('detail') === 'mid' ? 'mid' : 'high';
head.setDetail(detail);
body?.setDetail(detail);
const boots = attachBootDetails(rig);
boots.setDetail(continuousAssets ? 'low' : detail);
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(0.11, 16, 10),
  new THREE.MeshStandardMaterial({ color: '#f6f3ed', roughness: 0.55 })
);
scene.add(ball);
let plants: RunPlant = {};
const motionState = createReviewMotionState();
const nativeJogState = createNativeJogState();
const nativeAdopted = !!body && !!continuousAssets?.nativeAuthored;
let lastDrawTime: number | undefined;
let lastKind: string | undefined;
let transitionFrom: PoseSnapshot | undefined;
let transitionAge = 1;
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
  const dt = lastDrawTime === undefined ? 0 : Math.max(0, t - lastDrawTime);
  if (lastDrawTime === undefined || t < lastDrawTime || dt > 0.25) {
    resetReviewMotionState(motionState);
    resetNativeJogState(nativeJogState);
    transitionFrom = undefined;
    lastKind = undefined;
  }
  lastDrawTime = t;
  const close = q.has('face');
  const finishing = finishingSequence && !close ? sampleReviewFinishingSequence(t) : undefined;
  const s = finishing ?? sampleReviewMotionScenario(close ? 'idle' : scenario, t);
  const activeKick = finishing?.kickSpec ?? kick;
  if (finishing && lastKind !== undefined && lastKind !== s.motion.kind) {
    transitionFrom = nativeJogState.baseline ?? capture(rig);
    transitionAge = 0;
    plants = {};
  }
  lastKind = s.motion.kind;
  rig.root.position.set(s.position.x, s.position.y, s.position.z);
  rig.root.rotation.y = close ? 0 : s.heading;
  ball.visible = !close && (s.motion.kind === 'kick' || s.motion.kind === 'keeperDive');
  ball.position.copy(activeKick.ball);
  if (close || reduced) poseIdle(rig, 0);
  else if (s.motion.kind === 'run') {
    poseRun(rig, s.phase, Math.max(1.2, s.speed), {
      acceleration: Math.max(0, s.motion.acceleration ?? 0) / 4,
      accelerationTime: t,
      turn: s.motion.turn,
      turnTime: t,
    });
  } else if (s.motion.kind === 'kick') {
    const root = kickGeometry(activeKick).root;
    rig.root.position.copy(root);
    poseKick(rig, s.motion.time, activeKick);
    if (s.motion.time > KICK.contact)
      ball.position.addScaledVector(activeKick.dir, (s.motion.time - KICK.contact) * 5).y +=
        Math.sin(Math.min(1, (s.motion.time - KICK.contact) / 1.5) * Math.PI) * 0.5;
  } else if (scenario === 'keeperDive' && s.keeperSpec) {
    const target = new THREE.Vector3(s.keeperSpec.reach, s.keeperSpec.height, 0.12);
    poseKeeperDive(rig, t, s.keeperSpec, target);
    ball.position.copy(target);
    if (t < DIVE_CONTACT) ball.position.z += (DIVE_CONTACT - t) * 3;
  } else poseIdle(rig, t);
  if (finishing && transitionFrom && transitionAge < 0.14 && !reduced) {
    // Use the match renderer's contact-preserving base-pose transition.
    const feet = (['L', 'R'] as const).map((side) => ({
      side,
      ankle: rig.bones[`foot${side}`].getWorldPosition(new THREE.Vector3()),
      angles: new THREE.Euler().setFromQuaternion(
        rig.bones[`foot${side}`].getWorldQuaternion(new THREE.Quaternion()),
        'YXZ'
      ),
    }));
    transitionAge = Math.min(0.14, transitionAge + dt);
    const u = transitionAge / 0.14;
    blendTo(rig, transitionFrom, u * u * (3 - 2 * u));
    if (s.motion.kind === 'run' || s.motion.kind === 'kick')
      feet.forEach((f) => placeFoot(rig, f.side, f.ankle, f.angles.x, f.angles.y, f.angles.z));
  }
  const nativeInput = { ...s.motion, reducedMotion: reduced, deltaSeconds: dt };
  const nativeWeight = nativeAdopted ? prepareNativeJog(nativeJogState, nativeInput) : 0;
  if (assets)
    applyReviewPlayerMotion(rig, {
      nativeJogWeight: nativeWeight,
      nativeJogSample: nativeJogState.sample,
      ...s.motion,
      time: close ? t : s.motion.time,
      reducedMotion: reduced,
      motionState,
      deltaSeconds: dt,
    });
  if (s.motion.kind === 'run' && !reduced)
    plantRunFeet(rig, s.phase, Math.max(1.2, s.speed), plants);
  if (nativeAdopted && !reduced)
    applyNativeJogAfterPlant(rig, nativeJogState, nativeInput, motionState);
  poseFingers(rig, s.motion.kind, !reduced);
  if (assets)
    poseReviewPlayerHands(rig, s.motion.kind, !reduced, s.phase, {
      time: s.motion.time,
      direction: s.motion.kind === 'kick' && activeKick.foot === 'L' ? -1 : 1,
    });
  if (nativeAdopted && !reduced) poseNativeJogFingers(rig, nativeJogState);
  head.animate(t, s.motion.kind, !reduced);
  const proofPose = q.get('pose');
  if (proofPose) {
    resetPose(rig);
    if (proofPose === 'shoulders') {
      rig.bones.upperArmL.rotation.z = Math.PI / 2;
      rig.bones.upperArmR.rotation.z = -Math.PI / 2;
    } else if (proofPose === 'elbows') {
      rig.bones.foreArmL.rotation.x = rig.bones.foreArmR.rotation.x = (-Math.PI * 2) / 3;
    } else if (proofPose === 'knees') {
      rig.bones.hips.position.y -= (0.43 + 0.42) * (1 - Math.cos(Math.PI / 3));
      rig.bones.upperLegL.rotation.x = rig.bones.upperLegR.rotation.x = -Math.PI / 3;
      rig.bones.lowerLegL.rotation.x = rig.bones.lowerLegR.rotation.x = (Math.PI * 2) / 3;
      rig.bones.footL.rotation.x = rig.bones.footR.rotation.x = -Math.PI / 3;
    } else if (proofPose === 'neck') {
      rig.bones.neck.rotation.y = 0.25;
      rig.bones.head.rotation.y = 0.8;
    }
    head.animate(0, 'idle', false);
  }
  if (body && 'syncFace' in body)
    body.syncFace(ball.visible ? { center: ball.position, radius: 0.11 } : undefined);
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
    const view = q.get('view');
    camera.position.set(
      position.x + (view === 'front' || view === 'back' ? 0 : view === 'side' ? 4.2 : 2.1),
      1.2,
      position.z + (view === 'back' ? -4.2 : view === 'side' ? 0 : view === 'front' ? 4.2 : 3.8)
    );
    camera.lookAt(position.x, 0.92, position.z);
  }
  renderer.render(scene, camera);
  const caption = document.querySelector('#caption');
  if (caption)
    caption.textContent = `Simulated character diagnostic · ${identity.name} · ${proofPose ? `${proofPose} deformation proof` : reduced ? 'reduced motion' : s.label} · ${nativeAdopted ? 'native authored V5 body / supported jog' : continuousAssets ? 'continuous body / MHCLO shirt' : assets ? 'reviewed baseline' : 'PR59 fallback'}`;
  return {
    t,
    scenario: finishingSequence ? 'finishingSequence' : scenario,
    label: s.label,
    sample: s,
    identity,
    reviewAssets: !!assets,
    continuousAssets: !!continuousAssets,
    nativeAssets: nativeAdopted,
    nativeMode: continuousAssets?.nativeAuthored?.mode ?? null,
    nativeJogWeight: nativeJogState.appliedWeight,
    keeper,
    reduced,
    camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() },
    info: { ...renderer.info.render },
    jpeg: exportFrame ? renderer.domElement.toDataURL('image/jpeg', 0.94) : undefined,
  };
}
(window as any).__prototype = {
  ready: true,
  nativeAssets: nativeAdopted,
  nativeMode: continuousAssets?.nativeAuthored?.mode ?? null,
  draw,
  rig,
  head,
  body,
  camera,
  scene,
  renderer,
  reset() {
    plants = {};
    lastDrawTime = undefined;
    lastKind = undefined;
    transitionFrom = undefined;
    resetReviewMotionState(motionState);
    resetNativeJogState(nativeJogState);
  },
  dispose() {
    resetNativeJogState(nativeJogState);
    resetReviewMotionState(motionState);
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
    continuousAssets?.dispose();
    base.geometry.dispose();
    for (const g of Object.values(base.heads ?? {})) g.dispose();
    for (const b of Object.values(base.bodyLods ?? {})) b.geometry.dispose();
    (ground.geometry as THREE.BufferGeometry).dispose();
    (ground.material as THREE.Material).dispose();
    ball.geometry.dispose();
    (ball.material as THREE.Material).dispose();
    renderer.dispose();
    markings.geometry.dispose();
    for (const material of Array.isArray(markings.material)
      ? markings.material
      : [markings.material])
      material.dispose();
  },
};
draw(Number(q.get('t') ?? 0));
