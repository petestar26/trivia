import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  HOOF_NAMES,
  constrainHoof,
  measureHoofWindows,
  measureHoofWindowsInSlices,
  sampleHoofSupport,
  sampledHoofSole,
  solveHoofTarget,
  type HoofWindow,
} from './authored-contact';
import { CONTACT_FRACTION, STRIDE_SECONDS } from './gallop';
import { continuousGallop, seamlessGallop } from './gallop-clip';
import { createCoatMaterial, type CoatQuality } from './horse-coat';
import { runnerLook, type CoatSpec, type RunnerLook, type SilkSpec } from './runner-identity';
import { createCapMaterial, createSilkMaterial } from './silks';
import { createClothTexture, createTackKit, type TackKit } from './tack';

export type HorseAssets = {
  horse: THREE.Group;
  rider: THREE.Group;
  run: THREE.AnimationClip;
  idle: THREE.AnimationClip;
  dispose: () => void;
};
export type AnimateOptions = {
  /** Wall-clock seconds for the standing animation; 0 holds one still pose. */
  idle?: number;
  /** 0–1 visual riding effort (hands pushing with the stride). Presentation only. */
  drive?: number;
};
export type RaceHorse = {
  root: THREE.Group;
  animate: (seconds: number, moving: boolean, options?: AnimateOptions) => void;
  dispose?: () => void;
};

/** One owned asset set per mounted scene. No remote CDN, shared skeleton or persistent GPU cache. */
export async function loadHorseAssets(): Promise<HorseAssets> {
  const results = await Promise.allSettled([
    new GLTFLoader().loadAsync('/models/derby/horse.glb'),
    new GLTFLoader().loadAsync('/models/derby/jockey.glb'),
  ]);
  const dispose = () => {
    const resources = new Set<{ dispose: () => void }>();
    for (const result of results)
      if (result.status === 'fulfilled')
        result.value.scene.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            resources.add(object.geometry);
            for (const material of Array.isArray(object.material)
              ? object.material
              : [object.material]) {
              resources.add(material);
              for (const value of Object.values(material))
                if (value instanceof THREE.Texture) resources.add(value);
            }
            if (object instanceof THREE.SkinnedMesh) resources.add(object.skeleton);
          }
        });
    resources.forEach((resource) => resource.dispose());
  };
  const [horse, rider] = results;
  if (horse.status !== 'fulfilled' || rider.status !== 'fulfilled') {
    dispose();
    throw new Error('Horse assets unavailable');
  }
  const run = horse.value.animations.find((clip) => clip.name === 'Run');
  const idle = horse.value.animations.find((clip) => clip.name === 'Idle');
  if (!run || !idle) {
    dispose();
    throw new Error('Horse animation missing');
  }
  return { horse: horse.value.scene, rider: rider.value.scene, run, idle, dispose };
}

export { continuousGallop };
/** The loop every runner plays and every contact calibration samples. */
export const raceGallop = seamlessGallop;

/** Phases of the standing clip whose sampled sole heights ground each hoof. */
const IDLE_SAMPLES = 64;
/** Standing soles rest this far above the turf (model units, 1.2 mm at the shipped scale). */
const IDLE_CLEARANCE = 0.0008;
type Calibration = {
  contacts: HoofWindow[];
  /** Per hoof, the calibrated hoof-joint lift over the standing clip. */
  idle: Float32Array[];
  tack: TackKit;
};
const calibrations = new WeakMap<HorseAssets, Calibration>();
function bodyOf(model: THREE.Object3D) {
  let body: THREE.SkinnedMesh | undefined;
  model.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh && !body) body = o;
  });
  if (!body) throw new Error('Horse skin missing');
  return body;
}
function legChain(model: THREE.Object3D, name: string) {
  const side = name.endsWith('_l') ? 'l' : 'r',
    family = name.startsWith('front') ? 'front' : 'back';
  return ['ankle', 'lower', 'upper', 'foot'].map(
    (joint) => model.getObjectByName(`${family}_leg_${joint}_${side}`)!
  );
}
/**
 * Per standing phase, the hoof-joint lift that puts each penetrating sole just above
 * the turf, found by solving and re-measuring the actual skin (as the gallop fit
 * does). Sole vertices are partly weighted to the ankle, so a raw height difference
 * alone left up to 9 mm inside the turf. Raised hooves keep a zero lift.
 */
export function measureIdleLift(source: THREE.Object3D, clip: THREE.AnimationClip) {
  const model = clone(source);
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(clip).play();
  const lifts = HOOF_NAMES.map(() => new Float32Array(IDLE_SAMPLES));
  // Secant steps: a hind sole rises only about a third as far as its hoof joint
  // (toe weighting), so the measured gain sets each correction.
  const previous = HOOF_NAMES.map(() =>
    Array.from({ length: IDLE_SAMPLES }, () => null as null | { lift: number; sole: number })
  );
  const chains = HOOF_NAMES.map((name) => legChain(model, name));
  for (let pass = 0; pass < 5; pass++)
    for (let i = 0; i < IDLE_SAMPLES; i++) {
      mixer.setTime((i * clip.duration) / IDLE_SAMPLES);
      model.updateMatrixWorld(true);
      // The mixer skips unchanged joints: restore them after measuring this phase.
      const saved = chains.flat().map((joint) => joint.quaternion.clone());
      HOOF_NAMES.forEach((name, hoof) => {
        if (lifts[hoof][i] <= 0) return;
        const target = model.worldToLocal(model.getObjectByName(name)!.getWorldPosition(new THREE.Vector3()));
        target.y += lifts[hoof][i];
        solveHoofTarget(model, name, target);
      });
      HOOF_NAMES.forEach((name, hoof) => {
        const sole = sampledHoofSole(model, name),
          lift = lifts[hoof][i];
        if (lift <= 0 && sole >= IDLE_CLEARANCE) return;
        const prior = previous[hoof][i];
        const gain =
          prior && Math.abs(lift - prior.lift) > 1e-7
            ? THREE.MathUtils.clamp((sole - prior.sole) / (lift - prior.lift), 0.15, 1.5)
            : 1;
        previous[hoof][i] = { lift, sole };
        lifts[hoof][i] = Math.min(0.05, Math.max(0, lift + (IDLE_CLEARANCE - sole) / gain));
      });
      chains.flat().forEach((joint, k) => joint.quaternion.copy(saved[k]));
    }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  model.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
  });
  return lifts;
}
function register(assets: HorseAssets, calibration: Calibration) {
  calibrations.set(assets, calibration);
  const release = assets.dispose;
  assets.dispose = () => {
    calibration.tack.dispose();
    release();
  };
  return calibration;
}
/** Contact fit, standing soles and fitted tack: once per asset set, in yielding slices. */
export async function prepareHorseAssets(assets: HorseAssets, pause?: () => Promise<void>) {
  if (calibrations.has(assets)) return;
  const contacts = await measureHoofWindowsInSlices(assets.horse, raceGallop(assets.run), pause);
  if (calibrations.has(assets)) return;
  const idle = measureIdleLift(assets.horse, assets.idle);
  const tack = createTackKit(bodyOf(assets.horse));
  if (calibrations.has(assets)) {
    tack.dispose();
    return;
  }
  register(assets, { contacts, idle, tack });
}
function calibrationOf(assets: HorseAssets) {
  return (
    calibrations.get(assets) ??
    register(assets, {
      contacts: measureHoofWindows(assets.horse, raceGallop(assets.run)),
      idle: measureIdleLift(assets.horse, assets.idle),
      tack: createTackKit(bodyOf(assets.horse)),
    })
  );
}

function periodic(values: Float32Array, time: number, duration: number) {
  const phase = ((((time % duration) + duration) % duration) / duration) * values.length;
  const i = Math.floor(phase) % values.length,
    u = phase - Math.floor(phase);
  return values[i] + (values[(i + 1) % values.length] - values[i]) * u;
}

function coatFromColor(color: string): CoatSpec {
  return {
    base: color,
    points: '#16110f',
    mane: '#120e0c',
    hoof: '#2e2925',
    socks: [0, 0, 0, 0],
    face: 0,
    dapple: 0,
  };
}
function silksFromColor(color: string): SilkSpec {
  return {
    body: color,
    accent: '#ffffff',
    pattern: 'plain',
    sleeves: 'body',
    cap: color,
    capAccent: '#ffffff',
    capPattern: 'plain',
  };
}

const vector = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// Racing-crouch fit, in horse model units (1.5× world). The rider's pelvis sits above
// the saddle with short leathers: knees high beside the withers, back nearly flat,
// head up and hands low either side of the crest.
const RIDER_SCALE = 0.79;
const PELVIS_REST = 0.917; // CC0 human pelvis height in its own units
const SEAT = { y: 1.8, z: -0.07 };
const FOOT = { x: 0.3, y: 1.32, z: 0.05 };
const KNEE_POLE = { x: 0.55, y: 1.9, z: 0.95 };
const HAND = { x: 0.13, y: 1.74, z: 0.62 };
const ELBOW_POLE = { x: 0.5, y: 1.7, z: 0.3 };
/** The fitted rider targets (left side; the right mirrors X), for tests and tooling. */
export const RIDER_FIT = Object.freeze({ SEAT, FOOT, KNEE_POLE, HAND, ELBOW_POLE });

/** Anatomical skinned horse and human, with a separately posed racing jockey. */
export function createRiggedHorse(
  assets: HorseAssets,
  coat: string | CoatSpec,
  silk: string | SilkSpec,
  index: number,
  {
    look = runnerLook(index),
    quality = 'high',
    environment = null,
  }: {
    look?: RunnerLook;
    quality?: CoatQuality;
    /** Sky-derived image light for coats, silks and tack (none on Low). */
    environment?: THREE.Texture | null;
  } = {}
): RaceHorse {
  const { contacts, idle: idleLifts, tack } = calibrationOf(assets);
  const coatSpec = typeof coat === 'string' ? coatFromColor(coat) : coat;
  const silkSpec = typeof silk === 'string' ? silksFromColor(silk) : silk;
  const root = new THREE.Group();
  const model = clone(assets.horse) as THREE.Group;
  const rider = clone(assets.rider) as THREE.Group;
  const owned = new Set<{ dispose: () => void }>();
  const own = <T extends { dispose: () => void }>(resource: T) => {
    owned.add(resource);
    return resource;
  };
  const leather = own(new THREE.MeshStandardMaterial({ color: '#2a1d16', roughness: 0.52 }));
  const strap = own(new THREE.MeshStandardMaterial({ color: '#1b1714', roughness: 0.6 }));
  const steel = own(
    new THREE.MeshStandardMaterial({ color: '#b9bcbf', roughness: 0.3, metalness: 0.85 })
  );
  const visor = own(new THREE.MeshStandardMaterial({ color: '#151719', roughness: 0.25 }));
  const brow = own(new THREE.MeshStandardMaterial({ color: look.cloth, roughness: 0.45 }));
  const coatMaterial = own(
    createCoatMaterial(bodyOf(assets.horse).material as THREE.MeshStandardMaterial, coatSpec, quality)
  );
  const body = bodyOf(model);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = coatMaterial;
    object.castShadow = true;
    object.receiveShadow = true;
    if (object instanceof THREE.SkinnedMesh) {
      object.frustumCulled = false;
      owned.add(object.skeleton);
    }
  });
  // Saddle cloth, saddle and girth share the horse's own skeleton and bind pose.
  const clothTexture = own(createClothTexture(look.number, look.cloth, look.ink));
  const clothMaterial = own(
    new THREE.MeshStandardMaterial({ map: clothTexture, roughness: 0.62, side: THREE.DoubleSide })
  );
  for (const [geometry, material] of [
    [tack.cloth, clothMaterial],
    [tack.saddle, leather],
    [tack.girth, strap],
  ] as const) {
    const piece = new THREE.SkinnedMesh(geometry, material);
    piece.bind(body.skeleton, body.bindMatrix);
    piece.frustumCulled = false;
    // Below High the horse body alone casts: small tack shadows cost a skinned pass each.
    piece.castShadow = quality === 'high';
    piece.receiveShadow = true;
    body.parent!.add(piece);
  }
  // Silks, breeches and boots on the actual human mesh (shared geometry).
  const silkMaterial = own(createSilkMaterial(silkSpec, index));
  rider.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    object.material = silkMaterial;
    // The 13.7k-triangle rider skips the shadow pass below High; the horse still casts.
    object.castShadow = quality === 'high';
    object.receiveShadow = true;
    object.frustumCulled = false;
    owned.add(object.skeleton);
  });
  const bone = (name: string) => {
    const result = rider.getObjectByName(name);
    if (!result) throw new Error(`Missing rider joint: ${name}`);
    return result;
  };
  rider.updateMatrixWorld(true);
  const worldPosition = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3());
  const worldRotation = (object: THREE.Object3D) =>
    object.getWorldQuaternion(new THREE.Quaternion());
  const rotateWorld = (object: THREE.Object3D, q: THREE.Quaternion) => {
    const parent = object.parent ? worldRotation(object.parent) : new THREE.Quaternion();
    object.quaternion.copy(parent.invert().multiply(q));
    object.updateMatrixWorld(true);
  };
  const aim = (object: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3) => {
    const origin = worldPosition(object),
      current = worldPosition(child).sub(origin).normalize(),
      desired = target.clone().sub(origin).normalize();
    rotateWorld(
      object,
      new THREE.Quaternion().setFromUnitVectors(current, desired).multiply(worldRotation(object))
    );
  };
  const solveLimb = (
    upper: THREE.Object3D,
    lower: THREE.Object3D,
    end: THREE.Object3D,
    target: THREE.Vector3,
    pole: THREE.Vector3
  ) => {
    const origin = worldPosition(upper),
      a = origin.distanceTo(worldPosition(lower)),
      b = worldPosition(lower).distanceTo(worldPosition(end));
    const direction = target.clone().sub(origin),
      distance = THREE.MathUtils.clamp(direction.length(), Math.abs(a - b) + 0.001, a + b - 0.001);
    direction.normalize();
    const along = (a * a - b * b + distance * distance) / (2 * distance);
    const bend = pole.clone().sub(origin);
    bend.addScaledVector(direction, -bend.dot(direction)).normalize();
    const joint = origin
      .clone()
      .addScaledVector(direction, along)
      .addScaledVector(bend, Math.sqrt(Math.max(0, a * a - along * along)));
    aim(upper, lower, joint);
    aim(lower, end, origin.clone().addScaledVector(direction, distance));
  };
  // Trunk: pelvis tipped well forward for a flat back, neck and head brought up to look
  // between the horse's ears.
  const pelvis = bone('pelvis');
  rotateWorld(
    pelvis,
    new THREE.Quaternion().setFromAxisAngle(vector(1, 0, 0), 1.42).multiply(worldRotation(pelvis))
  );
  for (const [name, angle] of [
    ['spine_02', 0.02],
    ['spine_03', 0],
    ['neck_01', -0.62],
  ] as const) {
    const joint = bone(name);
    rotateWorld(
      joint,
      new THREE.Quaternion().setFromAxisAngle(vector(1, 0, 0), angle).multiply(worldRotation(joint))
    );
  }
  const head = bone('head');
  rotateWorld(
    head,
    new THREE.Quaternion().setFromAxisAngle(vector(1, 0, 0), -0.72).multiply(worldRotation(head))
  );
  // Close the fingers around the reins once; IK below only aims the arm chain.
  for (const [side, sign] of [
    ['l', 1],
    ['r', -1],
  ] as const)
    for (const finger of ['index', 'middle', 'ring', 'pinky'])
      for (const joint of ['01', '02', '03']) {
        const digit = rider.getObjectByName(`${finger}_${joint}_${side}`);
        if (digit) digit.rotateZ(sign * 0.6);
      }
  const riderPose = new Map<THREE.Object3D, THREE.Quaternion>();
  rider.traverse((o) => {
    if (o instanceof THREE.Bone) riderPose.set(o, o.quaternion.clone());
  });
  function addMesh(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: THREE.Vector3,
    scale?: THREE.Vector3
  ) {
    owned.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    if (scale) mesh.scale.copy(scale);
    // Small accessories add a shadow-pass draw each for no visible shadow below High.
    mesh.castShadow = quality === 'high';
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  // Helmet with the runner's cap cover, a short peak and goggles, fitted to the head.
  const headFrame = new THREE.Group();
  rider.add(headFrame);
  const capMaterial = own(createCapMaterial(silkSpec));
  addMesh(
    headFrame,
    new THREE.SphereGeometry(0.14, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.56),
    capMaterial,
    vector(0, 0.17, -0.006),
    vector(1, 1, 0.98)
  );
  const peak = addMesh(
    headFrame,
    new THREE.SphereGeometry(0.11, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
    capMaterial,
    vector(0, 0.158, 0.09),
    vector(0.92, 0.12, 0.8)
  );
  peak.rotation.x = 0.18;
  addMesh(
    headFrame,
    new THREE.TorusGeometry(0.128, 0.012, 6, 24),
    visor,
    vector(0, 0.12, 0.012),
    vector(1, 1, 0.92)
  ).rotation.x = Math.PI / 2 + 0.12;
  addMesh(
    headFrame,
    new THREE.SphereGeometry(0.09, 16, 8),
    visor,
    vector(0, 0.115, 0.118),
    vector(0.95, 0.3, 0.32)
  );
  // Fit the light jockey above the saddle.
  rider.position.set(0, SEAT.y - PELVIS_REST * RIDER_SCALE, SEAT.z);
  rider.scale.setScalar(RIDER_SCALE);
  model.add(rider);
  // Stirrup irons and leathers, re-fitted to the actual boots each frame.
  const irons: THREE.Mesh[] = [],
    leathers: THREE.Mesh[] = [];
  const leatherGeometry = own(new THREE.BoxGeometry(0.022, 1, 0.006));
  for (let side = 0; side < 2; side++) {
    const iron = addMesh(model, new THREE.TorusGeometry(0.045, 0.008, 6, 14), steel, vector(0, 0, 0));
    iron.scale.set(1, 0.8, 1);
    irons.push(iron);
    const strip = new THREE.Mesh(leatherGeometry, leather);
    strip.castShadow = quality === 'high';
    model.add(strip);
    leathers.push(strip);
  }
  // Tack follows the animated head; rein endpoints are resampled from the real hands.
  const headBone = model.getObjectByName('head')!;
  model.updateMatrixWorld(true);
  const tubes: THREE.Mesh[] = [];
  function tube(points: THREE.Vector3[], radius: number, material: THREE.Material, parent: THREE.Object3D) {
    const geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 12, radius, 5, false);
    return addMesh(parent, geometry, material, vector(0, 0, 0));
  }
  // Bridle in the horse rest frame, bound to the head joint. The browband carries the
  // runner's cloth colour.
  const bridle = new THREE.Group();
  model.add(bridle);
  for (const side of [-1, 1]) {
    tube(
      [vector(side * 0.13, 1.82, 1.08), vector(side * 0.16, 1.65, 1.25), vector(side * 0.105, 1.48, 1.4)],
      0.013,
      strap,
      bridle
    );
    tubes.push(
      tube(
        [vector(side * 0.1, 1.48, 1.4), vector(side * 0.2, 1.58, 0.9), vector(side * 0.2, 1.65, 0.55)],
        0.009,
        strap,
        model
      )
    );
  }
  tube([vector(-0.13, 1.83, 1.1), vector(0, 1.9, 1.2), vector(0.13, 1.83, 1.1)], 0.016, brow, bridle);
  tube([vector(-0.11, 1.5, 1.39), vector(0, 1.55, 1.45), vector(0.11, 1.5, 1.39)], 0.014, strap, bridle);
  model.updateMatrixWorld(true);
  headBone.attach(bridle);
  const bitPoints = [vector(-0.1, 1.48, 1.4), vector(0.1, 1.48, 1.4)].map((p) =>
    headBone.worldToLocal(p)
  );
  // Leathers hang from the saddle bars, which move with the back's bones.
  const saddleBone = model.getObjectByName('spine_2')!;
  const anchors = tack.leatherAnchors.map((p) => saddleBone.worldToLocal(p.clone()));
  const mixer = new THREE.AnimationMixer(model);
  const run = mixer.clipAction(raceGallop(assets.run));
  run.setLoop(THREE.LoopRepeat, Infinity);
  run.play();
  const idle = mixer.clipAction(assets.idle);
  idle.setLoop(THREE.LoopRepeat, Infinity);
  const spine = model.getObjectByName('spine_2')!;
  const spineRest = worldPosition(spine);
  model.rotation.y = Math.PI / 2;
  model.scale.setScalar(1.5);
  root.add(model);
  const riderBaseY = SEAT.y - PELVIS_REST * RIDER_SCALE;
  const scratch = {
    a: new THREE.Vector3(),
    b: new THREE.Vector3(),
    c: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    up: new THREE.Vector3(0, 1, 0),
  };
  let active: boolean | null = null;
  // The mixer skips writing a joint whose sampled value has not changed. Standing
  // grounding is applied on top of that pose, so it is undone first every frame:
  // otherwise a still frame would lift an already-lifted hoof again.
  const grounded = new Map<THREE.Object3D, THREE.Quaternion>();
  const legJoints = new Map(HOOF_NAMES.map((name) => [name, legChain(model, name)] as const));
  function animate(seconds: number, moving: boolean, options: AnimateOptions = {}) {
    grounded.forEach((q, joint) => joint.quaternion.copy(q));
    grounded.clear();
    if (active !== moving) {
      active = moving;
      run.enabled = moving;
      idle.enabled = !moving;
      if (!moving) idle.play();
    }
    const drive = moving ? THREE.MathUtils.clamp(options.drive ?? 0, 0, 1) : 0;
    // The authored fore-hoof sweeps back 10 model units/s during contact. The distance
    // clock converts published travel into the rig's measured 1.5× world scale.
    const travel = (seconds / STRIDE_SECONDS) * (1.04 / CONTACT_FRACTION);
    const clipSeconds = travel / (10 * 1.5);
    const offset = index * assets.run.duration * 0.137;
    const idleTime =
      (((options.idle ?? 0) * 0.8 + index * 0.61) % assets.idle.duration + assets.idle.duration) %
      assets.idle.duration;
    mixer.setTime(moving ? clipSeconds + offset : options.idle ? idleTime : 0);
    model.updateMatrixWorld(true);
    if (moving) for (const contact of contacts) constrainHoof(model, contact, clipSeconds + offset, assets.run.duration);
    else {
      // The CC0 standing clip sinks the hooves up to 13 mm into the turf. Lift each
      // penetrating sole with the same three-joint hoof solver; positive clearance
      // (a raised, pawing hoof) is left exactly as authored.
      const time = options.idle ? idleTime : 0;
      HOOF_NAMES.forEach((name, hoof) => {
        const lift = periodic(idleLifts[hoof], time, assets.idle.duration);
        if (lift <= 0) return;
        for (const joint of legJoints.get(name)!)
          if (!grounded.has(joint)) grounded.set(joint, joint.quaternion.clone());
        const foot = model.getObjectByName(name)!;
        const target = model.worldToLocal(foot.getWorldPosition(scratch.a));
        target.y += lift;
        solveHoofTarget(model, name, target.clone());
      });
    }
    const spinePosition = model.worldToLocal(spine.getWorldPosition(scratch.b));
    const bounce = spinePosition.y - spineRest.y;
    const support = sampleHoofSupport(clipSeconds + offset - 0.015, assets.run.duration, contacts);
    const strideAngle = (clipSeconds / assets.run.duration) * Math.PI * 2 + index * 0.861;
    // The rider floats over the stride: legs absorb most of the saddle's movement.
    rider.position.y = riderBaseY + bounce * (moving ? 0.32 - 0.1 * support.load : 0.55);
    rider.rotation.x = moving ? (Math.sin(strideAngle - 0.35) * 0.6 + support.pitch * 0.4) * 0.04 : 0;
    rider.rotation.z = moving ? (Math.sin(strideAngle) * 0.5 + support.roll * 0.5) * 0.012 : 0;
    rider.position.z =
      SEAT.z + (moving ? (Math.sin(strideAngle - 0.35) * 0.5 + support.pitch * 0.5) * 0.018 : 0);
    model.updateMatrixWorld(true);
    // Reset to the fitted pose so repeated sampling and different frame steps agree.
    riderPose.forEach((q, joint) => joint.quaternion.copy(q));
    pelvis.rotateX(moving ? (Math.sin(strideAngle - 0.35) * 0.5 + support.pitch * 0.5) * 0.035 : 0);
    rider.updateMatrixWorld(true);
    // Hands push along the neck in time with the stride when the rider is driving.
    const push = drive * Math.sin(strideAngle + 0.6);
    const anchor = (x: number, y: number, z: number) => model.localToWorld(vector(x, y, z));
    for (const [side, sign, s] of [
      ['l', 1, 0],
      ['r', -1, 1],
    ] as const) {
      // Stirrup irons hang from the saddle and swing with the horse; boots stand in them.
      const iron = irons[s];
      iron.position.set(sign * FOOT.x, FOOT.y + bounce, FOOT.z);
      iron.rotation.set(0, 0, 0);
      iron.updateMatrixWorld();
      solveLimb(
        bone(`thigh_${side}`),
        bone(`calf_${side}`),
        bone(`foot_${side}`),
        anchor(sign * FOOT.x, FOOT.y + bounce + 0.035, FOOT.z - 0.05),
        anchor(sign * KNEE_POLE.x, KNEE_POLE.y + bounce, KNEE_POLE.z)
      );
      aim(
        bone(`foot_${side}`),
        bone(`ball_${side}`),
        worldPosition(bone(`foot_${side}`)).add(
          model.localToWorld(vector(sign * 0.02, -0.035, 0.16)).sub(model.localToWorld(vector(0, 0, 0)))
        )
      );
      solveLimb(
        bone(`upperarm_${side}`),
        bone(`lowerarm_${side}`),
        bone(`hand_${side}`),
        anchor(sign * HAND.x, HAND.y + bounce * 0.85 + push * 0.025, HAND.z + push * 0.07),
        anchor(sign * ELBOW_POLE.x, ELBOW_POLE.y + bounce, ELBOW_POLE.z)
      );
      // Leather from the saddle bar to the top of the iron.
      const top = model.worldToLocal(saddleBone.localToWorld(scratch.a.copy(anchors[s])));
      const bottom = scratch.b.set(sign * FOOT.x, FOOT.y + bounce + 0.04, FOOT.z);
      const strip = leathers[s];
      strip.position.copy(top).add(bottom).multiplyScalar(0.5);
      strip.scale.set(1, top.distanceTo(bottom), 1);
      strip.quaternion.setFromUnitVectors(scratch.up, scratch.c.copy(top).sub(bottom).normalize());
    }
    headFrame.position.copy(rider.worldToLocal(worldPosition(head)));
    headFrame.rotation.x = -0.12;
    model.updateMatrixWorld(true);
    for (let side = 0; side < 2; side++) {
      const start = model.worldToLocal(headBone.localToWorld(bitPoints[side].clone()));
      const end = model.worldToLocal(worldPosition(bone(side === 0 ? 'hand_r' : 'hand_l')));
      const mid = start.clone().lerp(end, 0.5);
      mid.y -= 0.06;
      const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
      const position = tubes[side].geometry.getAttribute('position');
      // Reuse the existing small rein buffer; no geometry allocations per frame.
      const normal = vector(0, 1, 0),
        binormal = new THREE.Vector3(),
        point = new THREE.Vector3();
      for (let ring = 0; ring <= 12; ring++) {
        curve.getPoint(ring / 12, point);
        binormal.crossVectors(curve.getTangent(ring / 12), normal).normalize();
        for (let edge = 0; edge <= 5; edge++) {
          const angle = (edge / 5) * Math.PI * 2;
          position.setXYZ(
            ring * 6 + edge,
            point.x + binormal.x * Math.sin(angle) * 0.009,
            point.y + Math.cos(angle) * 0.009,
            point.z + binormal.z * Math.sin(angle) * 0.009
          );
        }
      }
      position.needsUpdate = true;
      tubes[side].frustumCulled = false;
    }
  }
  if (environment)
    owned.forEach((resource) => {
      if (resource instanceof THREE.MeshStandardMaterial) {
        resource.envMap = environment;
        resource.envMapIntensity = 0.55;
      }
    });
  animate(0, false);
  return {
    root,
    animate,
    dispose: () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      owned.forEach((resource) => resource.dispose());
    },
  };
}
