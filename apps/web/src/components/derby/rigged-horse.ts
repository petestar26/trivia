import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

export type HorseAssets = {
  horse: THREE.Group;
  rider: THREE.Group;
  run: THREE.AnimationClip;
  idle: THREE.AnimationClip;
  dispose: () => void;
};
export type RaceHorse = {
  root: THREE.Group;
  animate: (seconds: number, moving: boolean) => void;
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

const vector = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Anatomical skinned horse and human, with a separately posed racing jockey. */
export function createRiggedHorse(
  assets: HorseAssets,
  coatColor: string,
  silkColor: string,
  index: number
): RaceHorse {
  const root = new THREE.Group();
  const model = clone(assets.horse) as THREE.Group;
  const rider = clone(assets.rider) as THREE.Group;
  const owned = new Set<{ dispose: () => void }>();
  const dark = new THREE.MeshStandardMaterial({ color: '#211b17', roughness: 0.76 });
  const silk = new THREE.MeshStandardMaterial({ color: silkColor, roughness: 0.5 });
  const gold = new THREE.MeshStandardMaterial({
    color: '#a99973',
    roughness: 0.35,
    metalness: 0.65,
  });
  [dark, silk, gold].forEach((m) => owned.add(m));
  // Keep the authored face, hoof and mane palette. Tint only the brown coat region.
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const original = object.material as THREE.MeshStandardMaterial;
    const material = original.clone();
    material.color.set('#ffffff');
    material.onBeforeCompile = (shader) => {
      shader.uniforms.derbyCoat = { value: new THREE.Color(coatColor) };
      shader.fragmentShader = 'uniform vec3 derbyCoat;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `
        #include <map_fragment>
        if (diffuseColor.r > diffuseColor.g * 1.6 && diffuseColor.g > diffuseColor.b * 1.3 && diffuseColor.r < .65) {
          diffuseColor.rgb = derbyCoat * (.7 + diffuseColor.r * .6);
        }
      `
      );
    };
    material.customProgramCacheKey = () => 'derby-coat-v1';
    material.roughness = 0.64;
    material.metalness = 0;
    owned.add(material);
    object.material = material;
    object.castShadow = true;
    object.receiveShadow = true;
    if (object instanceof THREE.SkinnedMesh) {
      object.frustumCulled = false;
      owned.add(object.skeleton);
    }
  });
  // Jersey, breeches, boots, gloves and natural skin on the actual human mesh.
  rider.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    const geometry = object.geometry.clone();
    owned.add(geometry);
    object.geometry = geometry;
    const positions = geometry.getAttribute('position'),
      colors = new Float32Array(positions.count * 3);
    const skin = new THREE.Color(['#b9825d', '#7d513d', '#d0a17c', '#9a6549'][index % 4]);
    const shirt = new THREE.Color(silkColor),
      pants = new THREE.Color('#ece2ce'),
      boots = new THREE.Color('#211d1b');
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i),
        x = Math.abs(positions.getX(i));
      const color =
        y > 1.56 && x < 0.16
          ? skin
          : y < 0.39
            ? boots
            : y < 0.98
              ? pants
              : x > 0.74
                ? boots
                : shirt;
      color.toArray(colors, i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.69 });
    owned.add(material);
    object.material = material;
    object.castShadow = true;
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
  // Pose the pelvis/trunk forward, then solve limbs to real stirrup and rein locations.
  const pelvis = bone('pelvis');
  rotateWorld(
    pelvis,
    new THREE.Quaternion().setFromAxisAngle(vector(1, 0, 0), 1.0).multiply(worldRotation(pelvis))
  );
  const head = bone('head');
  rotateWorld(
    head,
    new THREE.Quaternion().setFromAxisAngle(vector(1, 0, 0), -0.82).multiply(worldRotation(head))
  );
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
  for (const [side, sign] of [
    ['l', 1],
    ['r', -1],
  ] as const) {
    solveLimb(
      bone(`thigh_${side}`),
      bone(`calf_${side}`),
      bone(`foot_${side}`),
      vector(sign * 0.48, 0.32, -0.18),
      vector(sign * 0.72, 0.6, 0.8)
    );
    // Level the boots instead of leaving them pointing down with the shin.
    aim(
      bone(`foot_${side}`),
      bone(`ball_${side}`),
      worldPosition(bone(`foot_${side}`)).add(vector(0, -0.03, 0.16))
    );
    solveLimb(
      bone(`upperarm_${side}`),
      bone(`lowerarm_${side}`),
      bone(`hand_${side}`),
      vector(sign * 0.21, 1.14, 0.77),
      vector(sign * 0.5, 0.93, 0.65)
    );
    // Close the fingers around the reins.
    for (const finger of ['index', 'middle', 'ring', 'pinky'])
      for (const joint of ['01', '02', '03']) {
        const digit = rider.getObjectByName(`${finger}_${joint}_${side}`);
        if (digit) digit.rotateZ(sign * 0.55);
      }
  }
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
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  // Helmet and visor follow the human head, with proportions fitted to its actual surface.
  const headFrame = new THREE.Group();
  rider.add(headFrame);
  headFrame.position.copy(worldPosition(head));
  headFrame.quaternion.copy(worldRotation(head));
  // Bone local axes differ from anatomical axes: accessories use a level world frame.
  headFrame.quaternion.identity();
  addMesh(
    headFrame,
    new THREE.SphereGeometry(0.14, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.56),
    silk,
    vector(0, 0.17, -0.006),
    vector(1, 1, 0.96)
  );
  addMesh(
    headFrame,
    new THREE.SphereGeometry(0.12, 16, 8),
    dark,
    vector(0, 0.15, 0.1),
    vector(1, 0.07, 0.85)
  );
  addMesh(
    headFrame,
    new THREE.SphereGeometry(0.09, 16, 8),
    dark,
    vector(0, 0.1, 0.155),
    vector(1, 0.28, 0.28)
  );
  // Remove rest-pelvis height, then fit a light jockey above the horse's withers.
  rider.position.set(0, 1.65 - 0.917 * 0.79, -0.12);
  rider.scale.setScalar(0.79);
  model.add(rider);
  const saddle = addMesh(
    model,
    new THREE.SphereGeometry(1, 20, 12),
    dark,
    vector(0, 1.52, -0.12),
    vector(0.27, 0.06, 0.29)
  );
  const cloth = addMesh(
    model,
    new THREE.SphereGeometry(1, 20, 12),
    silk,
    vector(0, 1.43, -0.13),
    vector(0.33, 0.075, 0.32)
  );
  for (const side of [-1, 1]) {
    addMesh(
      model,
      new THREE.TorusGeometry(0.06, 0.009, 6, 12),
      gold,
      vector(side * 0.38, 1.15, -0.26)
    );
  }
  // Tack follows the animated head; rein endpoints are resampled from the real hands.
  const headBone = model.getObjectByName('head')!;
  model.updateMatrixWorld(true);
  const tack = new THREE.Group();
  model.add(tack);
  const tubes: THREE.Mesh[] = [];
  function tube(
    points: THREE.Vector3[],
    radius: number,
    material: THREE.Material,
    parent: THREE.Object3D
  ) {
    const geometry = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(points),
      12,
      radius,
      5,
      false
    );
    return addMesh(parent, geometry, material, vector(0, 0, 0));
  }
  // Bridle coordinates are authored in the horse rest frame, then bound to the head joint.
  const bridle = new THREE.Group();
  model.add(bridle);
  for (const side of [-1, 1]) {
    tube(
      [
        vector(side * 0.13, 1.82, 1.08),
        vector(side * 0.16, 1.65, 1.25),
        vector(side * 0.105, 1.48, 1.4),
      ],
      0.012,
      dark,
      bridle
    );
    tubes.push(
      tube(
        [
          vector(side * 0.1, 1.48, 1.4),
          vector(side * 0.2, 1.58, 0.9),
          vector(side * 0.2, 1.65, 0.55),
        ],
        0.008,
        dark,
        tack
      )
    );
  }
  tube(
    [vector(-0.11, 1.5, 1.39), vector(0, 1.55, 1.45), vector(0.11, 1.5, 1.39)],
    0.013,
    dark,
    bridle
  );
  model.updateMatrixWorld(true);
  headBone.attach(bridle);
  const bitPoints = [vector(-0.1, 1.48, 1.4), vector(0.1, 1.48, 1.4)].map((p) =>
    headBone.worldToLocal(p)
  );
  const mixer = new THREE.AnimationMixer(model);
  const run = mixer.clipAction(assets.run);
  run.setLoop(THREE.LoopRepeat, Infinity);
  run.play();
  // An actual resting pose is sampled once for the stopped state.
  const idle = mixer.clipAction(assets.idle);
  idle.setLoop(THREE.LoopRepeat, Infinity);
  const spine = model.getObjectByName('spine_2')!;
  const spineRest = worldPosition(spine);
  model.rotation.y = Math.PI / 2;
  model.scale.setScalar(1.5);
  root.add(model);
  let active: boolean | null = null;
  function animate(seconds: number, moving: boolean) {
    if (active !== moving) {
      active = moving;
      run.enabled = moving;
      idle.enabled = !moving;
      if (!moving) idle.play();
    }
    // Each runner has an independent mixer. Absolute travel phase is frame-rate independent.
    mixer.setTime(moving ? seconds + index * assets.run.duration * 0.137 : 0);
    model.updateMatrixWorld(true);
    const spinePosition = spine.getWorldPosition(new THREE.Vector3());
    model.worldToLocal(spinePosition);
    const bounce = spinePosition.y - spineRest.y;
    rider.position.y = 1.65 - 0.917 * 0.79 + bounce * 0.55;
    rider.rotation.x = moving
      ? Math.sin((seconds / assets.run.duration) * Math.PI * 2 + index * 0.861) * 0.025
      : 0;
    saddle.position.y = 1.52 + bounce;
    cloth.position.y = 1.43 + bounce;
    model.updateMatrixWorld(true);
    for (let side = 0; side < 2; side++) {
      const start = model.worldToLocal(headBone.localToWorld(bitPoints[side].clone()));
      const end = model.worldToLocal(worldPosition(bone(side === 0 ? 'hand_r' : 'hand_l')));
      const mid = start.clone().lerp(end, 0.5);
      mid.y -= 0.08;
      const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
      const geometry = tubes[side].geometry;
      const position = geometry.getAttribute('position');
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
            point.x + binormal.x * Math.sin(angle) * 0.008,
            point.y + Math.cos(angle) * 0.008,
            point.z + binormal.z * Math.sin(angle) * 0.008
          );
        }
      }
      position.needsUpdate = true;
      tubes[side].frustumCulled = false;
    }
  }
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
