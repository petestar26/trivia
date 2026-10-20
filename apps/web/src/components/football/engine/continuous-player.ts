import * as THREE from 'three';
import { continuousShirtCoverage } from './continuous-player-coverage';
import { createContinuousBodyCorrectives } from './continuous-body-correctives';
import { createContinuousKit, syncContinuousBootFlex } from './continuous-kit';
import { createContinuousPlayerLod } from './continuous-player-lod';
import { createContinuousShirtCorrectives } from './continuous-shirt-correctives';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  BONES,
  boneParent,
  restLocalPosition,
  restPosition,
  type HumanGeometry,
  type Look,
  type Rig,
} from './rig';
import type { HeadVisual, PlayerDetail, appearanceTextures } from './player-appearance';
import { reviewSkinMaterial, type ReviewPlayerAssets } from './review-player';

export interface ContinuousPlayerAssets {
  body: THREE.BufferGeometry;
  jersey: THREE.BufferGeometry;
  dispose(): void;
}

function release(gltf: GLTF) {
  const resources = new Set<{ dispose(): void }>();
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      resources.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        resources.add(m);
        for (const value of Object.values(m))
          if (value instanceof THREE.Texture) resources.add(value);
      }
    }
    if (o instanceof THREE.SkinnedMesh) resources.add(o.skeleton);
  });
  resources.forEach((resource) => resource.dispose());
}

/** These assets are only a visual surface on the existing contact skeleton. */
export function validateContinuousMesh(gltf: GLTF, name: string) {
  const mesh = gltf.scene.getObjectByName(name);
  if (!(mesh instanceof THREE.SkinnedMesh)) throw new Error(`Missing bound ${name}`);
  if (
    mesh.skeleton.bones.length !== BONES.length ||
    mesh.skeleton.bones.some((bone, i) => bone.name !== BONES[i])
  )
    throw new Error('Continuous player joint contract mismatch');
  mesh.updateWorldMatrix(true, false);
  const identity = new THREE.Matrix4();
  if (mesh.bindMatrix.elements.some((v, k) => Math.abs(v - identity.elements[k]) > 0.00001))
    throw new Error('Continuous player mesh bind must be identity');
  mesh.skeleton.bones.forEach((bone, i) => {
    const parent = boneParent(BONES[i]);
    if (
      bone.position.distanceTo(restLocalPosition(BONES[i])) > 0.000001 ||
      (parent ? bone.parent?.name !== parent : bone.parent instanceof THREE.Bone) ||
      bone.quaternion.angleTo(new THREE.Quaternion()) > 0.000001 ||
      bone.scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 0.000001
    )
      throw new Error('Continuous player rest frame mismatch');
    bone.updateWorldMatrix(true, false);
    const expectedWorld = new THREE.Matrix4().setPosition(restPosition(BONES[i]));
    if (
      bone.matrixWorld.elements.some((v, k) => Math.abs(v - expectedWorld.elements[k]) > 0.000001)
    )
      throw new Error('Continuous player world rest frame mismatch');
    const rest = bone.matrixWorld.clone().multiply(mesh.skeleton.boneInverses[i]);
    if (
      rest.elements.some(
        (v, k) => !Number.isFinite(v) || Math.abs(v - identity.elements[k]) > 0.00001
      )
    )
      throw new Error('Continuous player inverse bind mismatch');
  });
  const g = mesh.geometry;
  const p = g.getAttribute('position');
  for (const [key, size] of [
    ['position', 3],
    ['normal', 3],
    ['uv', 2],
    ['skinIndex', 4],
    ['skinWeight', 4],
  ] as const) {
    const a = g.getAttribute(key);
    if (
      !p ||
      !a ||
      !p.count ||
      a.itemSize !== size ||
      a.count !== p.count ||
      Array.from(a.array).some((v) => !Number.isFinite(v))
    )
      throw new Error(`Invalid continuous ${key}`);
  }
  if (!g.index || !g.index.count || g.index.count % 3 !== 0)
    throw new Error('Invalid continuous indices');
  for (let i = 0; i < g.index.count; i++) {
    const v = g.index.getX(i);
    if (!Number.isInteger(v) || v < 0 || v >= p.count)
      throw new Error('Continuous index out of range');
  }
  const joints = g.getAttribute('skinIndex'),
    weights = g.getAttribute('skinWeight');
  for (let i = 0; i < p.count; i++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const j = joints.getComponent(i, k),
        w = weights.getComponent(i, k);
      if (!Number.isInteger(j) || j < 0 || j >= BONES.length || w < 0 || w > 1.00001)
        throw new Error('Invalid continuous skin binding');
      sum += w;
    }
    if (Math.abs(sum - 1) > 0.0001) throw new Error('Unnormalized continuous weights');
  }
  for (const key of ['position', 'normal'] as const)
    for (const a of g.morphAttributes[key] ?? [])
      if (
        a.itemSize !== 3 ||
        a.count !== p.count ||
        !Number.isInteger(a.count) ||
        Array.from(a.array).some((v) => !Number.isFinite(v))
      )
        throw new Error('Invalid continuous corrective');
  if (name === 'continuous-body') {
    const names = [
      'blinkLeft',
      'blinkRight',
      'jawOpen',
      'browRaise',
      'smile',
      'noseWidth',
      'lipFullness',
      'earSize',
    ];
    if (
      g.morphAttributes.position?.length !== 8 ||
      g.morphAttributes.normal?.length !== 8 ||
      names.some((key, i) => mesh.morphTargetDictionary?.[key] !== i)
    )
      throw new Error('Continuous neck expression contract mismatch');
    // Reject a stale correspondence mask before this optional asset is adopted.
    continuousShirtCoverage(g);
    g.userData.morphNames = { ...mesh.morphTargetDictionary };
  }
  return g;
}

/** All-or-nothing optional load; late adoption/disposal belongs to the player pool. */
export async function loadContinuousPlayerAssets(): Promise<ContinuousPlayerAssets> {
  const loader = new GLTFLoader();
  const loaded = await Promise.allSettled(
    ['body', 'jersey'].map((part) => loader.loadAsync(`/models/football/continuous-${part}.glb`))
  );
  const owned: THREE.BufferGeometry[] = [];
  try {
    if (loaded.some((r) => r.status === 'rejected'))
      throw new Error('Continuous player unavailable');
    const body = validateContinuousMesh(
      (loaded[0] as PromiseFulfilledResult<GLTF>).value,
      'continuous-body'
    ).clone();
    owned.push(body);
    const jersey = validateContinuousMesh(
      (loaded[1] as PromiseFulfilledResult<GLTF>).value,
      'continuous-jersey'
    ).clone();
    owned.push(jersey);
    let disposed = false;
    return {
      body,
      jersey,
      dispose() {
        if (disposed) return;
        disposed = true;
        owned.forEach((g) => g.dispose());
      },
    };
  } catch (error) {
    owned.forEach((g) => g.dispose());
    throw error;
  } finally {
    loaded.forEach((r) => {
      if (r.status === 'fulfilled') release(r.value);
    });
  }
}

/** One continuous anatomical surface plus the separately authored CC0 shirt.
 * Only this actor receives the fitted kit and reduced distant surface. */
export function attachContinuousPlayer(
  rig: Rig,
  _source: HumanGeometry,
  look: Look,
  kitMaterial: THREE.Material,
  assets: ContinuousPlayerAssets,
  review: ReviewPlayerAssets,
  maps: ReturnType<typeof appearanceTextures>,
  head: HeadVisual
) {
  const bodyGeometry = assets.body.clone();
  const positions = bodyGeometry.getAttribute('position');
  bodyGeometry.setAttribute('uv1', bodyGeometry.getAttribute('uv').clone());
  bodyGeometry.setAttribute(
    'part',
    new THREE.Float32BufferAttribute(new Float32Array(positions.count), 1)
  );
  const colors = new Float32Array(positions.count * 3),
    outfit = new Float32Array(positions.count);
  const tint = new THREE.Color(look.skin),
    reference = new THREE.Color('#e9ba97');
  tint.r /= reference.r;
  tint.g /= reference.g;
  tint.b /= reference.b;
  const joints = bodyGeometry.getAttribute('skinIndex'),
    weights = bodyGeometry.getAttribute('skinWeight');
  const covered = continuousShirtCoverage(bodyGeometry);
  for (let i = 0; i < positions.count; i++) {
    colors.set(tint.toArray(), i * 3);
    let arm = 0;
    for (let k = 0; k < 4; k++) {
      const bone = BONES[joints.getComponent(i, k)],
        w = weights.getComponent(i, k);
      if (/^(upperArm|foreArm|hand|thumb|index|middle|ring|pinky)/.test(bone)) arm += w;
    }
    outfit[i] = arm;
    // Preferred MHCLO body references define covered skin. Its source supplies
    // no delete_verts; the generated render mask preserves collar/cuff openings.
  }
  const visible: number[] = [],
    index = bodyGeometry.index!;
  for (let i = 0; i < index.count; i += 3) {
    const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    if (
      ids.some((id) => positions.getY(id) < 0.16) ||
      ids.every((id) => covered[id]) ||
      ids.every((id) => outfit[id] < 0.1 && positions.getY(id) < 0.474) ||
      ids.every((id) => outfit[id] < 0.1 && positions.getY(id) > 0.68 && positions.getY(id) < 1.07)
    )
      continue;
    visible.push(...ids);
  }
  bodyGeometry.setIndex(visible);
  bodyGeometry.userData.coverage = {
    originalTriangles: index.count / 3,
    visibleTriangles: visible.length / 3,
    reason:
      'MHCLO shirt coverage plus fitted shorts/socks/footwear coverage; full editable source retained',
  };
  bodyGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  bodyGeometry.setAttribute('outfit', new THREE.Float32BufferAttribute(outfit, 1));
  const bodyMaterial = reviewSkinMaterial(review, maps);
  const shirtMaterial = (kitMaterial as THREE.MeshStandardMaterial).clone();
  shirtMaterial.vertexColors = false;
  shirtMaterial.color.set(shirtMaterial.map ? '#ffffff' : look.kit.primary);
  shirtMaterial.roughness = 0.9;
  shirtMaterial.side = THREE.DoubleSide;
  // Borrow the existing fictional number canvas. Project in the shirt's bind
  // coordinates so the marking follows the exact garment skin deformation.
  const numberMap = { value: null as THREE.Texture | null };
  const numberEnabled = { value: 0 };
  shirtMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.continuousNumberMap = numberMap;
    shader.uniforms.continuousNumberEnabled = numberEnabled;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vNumberBindPosition; varying float vNumberBack;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvNumberBindPosition=position; vNumberBack=-normal.z;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D continuousNumberMap; uniform float continuousNumberEnabled; varying vec3 vNumberBindPosition; varying float vNumberBack;'
      )
      .replace(
        '#include <map_fragment>',
        // Project only the diffuse atlas in the fragment. The source garment
        // UVs remain available to its fabric normal/roughness channels, and
        // angular wrap is never interpolated across a source triangle.
        'float kitHeight=(vNumberBindPosition.y-0.95)/0.57;\n' +
          'vec2 computedKitUv=vec2(0.75+atan(vNumberBindPosition.x,vNumberBindPosition.z)/(2.0*PI),0.5+0.5*clamp(kitHeight,0.0001,0.9999));\n' +
          // Analytic angular gradients avoid treating atan's one-repeat branch
          // as a huge texture footprint when choosing a mip at the back seam.
          'vec3 kitPositionDx=dFdx(vNumberBindPosition); vec3 kitPositionDy=dFdy(vNumberBindPosition);\n' +
          'float kitAngularDenominator=2.0*PI*max(dot(vNumberBindPosition.xz,vNumberBindPosition.xz),1e-8);\n' +
          'float kitHeightGradient=(kitHeight>0.0001 && kitHeight<0.9999)?0.5/0.57:0.0;\n' +
          'vec2 kitUvDx=vec2((vNumberBindPosition.z*kitPositionDx.x-vNumberBindPosition.x*kitPositionDx.z)/kitAngularDenominator,kitHeightGradient*kitPositionDx.y);\n' +
          'vec2 kitUvDy=vec2((vNumberBindPosition.z*kitPositionDy.x-vNumberBindPosition.x*kitPositionDy.z)/kitAngularDenominator,kitHeightGradient*kitPositionDy.y);\n' +
          THREE.ShaderChunk.map_fragment
            .replaceAll('vMapUv', 'computedKitUv')
            .replace(
              'texture2D( map, computedKitUv )',
              'textureGrad( map, computedKitUv, kitUvDx, kitUvDy )'
            )
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n' +
          'vec2 numberUv=vec2(0.5-vNumberBindPosition.x/0.3,(vNumberBindPosition.y-1.15)/0.3);\n' +
          'if(continuousNumberEnabled>0.5 && vNumberBack>0.25 && all(greaterThanEqual(numberUv,vec2(0.0))) && all(lessThanEqual(numberUv,vec2(1.0)))) {\n' +
          'vec4 numberInk=texture2D(continuousNumberMap,numberUv); diffuseColor.rgb=mix(diffuseColor.rgb,numberInk.rgb,numberInk.a);\n}'
      );
  };
  shirtMaterial.customProgramCacheKey = () => 'playqube-continuous-shirt-atlas-number-v3';
  const make = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => {
    const mesh = new THREE.SkinnedMesh(g, m);
    mesh.name = name;
    if (g.userData.morphNames) mesh.morphTargetDictionary = { ...g.userData.morphNames };
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    rig.root.add(mesh);
    mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
    return mesh;
  };
  const body = make(bodyGeometry, bodyMaterial, 'continuous-player-body');
  const corrective = createContinuousBodyCorrectives(body);
  const lowBodyGeometry = createContinuousPlayerLod(bodyGeometry, { protectNeck: true });
  const lowBody = make(lowBodyGeometry, bodyMaterial, 'continuous-player-body-low');
  const jersey = make(assets.jersey, shirtMaterial, 'continuous-player-jersey');
  const shirtCorrective = createContinuousShirtCorrectives(jersey, rig);
  const lowJerseyGeometry = createContinuousPlayerLod(assets.jersey, { protectNeck: false });
  const lowJersey = make(lowJerseyGeometry, shirtMaterial, 'continuous-player-jersey-low');
  const lowShirtCorrective = createContinuousShirtCorrectives(lowJersey, rig);
  const kit = createContinuousKit(look, assets.body);
  const shorts = make(kit.geometries.shorts, kit.materials.shorts, 'continuous-player-shorts');
  const socks = make(kit.geometries.socks, kit.materials.socks, 'continuous-player-socks');
  const boots = make(kit.geometries.boots, kit.materials.boots, 'continuous-player-footwear');
  lowBody.visible = lowJersey.visible = false;
  let disposed = false,
    close = true;
  let currentDetail: PlayerDetail | undefined;
  function syncFace() {
    if (disposed) return;
    for (const surface of [body, lowBody])
      for (const [name, target] of Object.entries(surface.morphTargetDictionary ?? {})) {
        const index = head.mesh.morphTargetDictionary?.[name];
        surface.morphTargetInfluences![target] =
          index === undefined ? 0 : (head.mesh.morphTargetInfluences?.[index] ?? 0);
      }
    if (close) corrective.update();
    if (close) shirtCorrective.update();
    else lowShirtCorrective.update();
    syncContinuousBootFlex(boots, rig);
  }
  return {
    meshes: { body, lowBody, jersey, lowJersey, shorts, socks, boots },
    syncFace,
    setNumberTexture(texture: THREE.Texture) {
      if (disposed) return;
      numberMap.value = texture;
      numberEnabled.value = 1;
    },
    setDetail(detail: PlayerDetail) {
      // apply() already synchronizes the released frame. A repeated detail
      // selection must not run boot/shirt deformation a second time.
      if (disposed || currentDetail === detail) return;
      currentDetail = detail;
      close = detail !== 'low';
      body.visible = jersey.visible = close;
      lowBody.visible = lowJersey.visible = !close;
      rig.mesh.visible = false;
      rig.root.userData.continuousPlayerDetail = detail;
      syncFace();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      body.removeFromParent();
      lowBody.removeFromParent();
      jersey.removeFromParent();
      lowJersey.removeFromParent();
      shorts.removeFromParent();
      socks.removeFromParent();
      boots.removeFromParent();
      corrective.dispose();
      shirtCorrective.dispose();
      lowShirtCorrective.dispose();
      bodyGeometry.dispose();
      lowBodyGeometry.dispose();
      lowJerseyGeometry.dispose();
      bodyMaterial.dispose();
      shirtMaterial.dispose();
      kit.dispose();
      rig.mesh.visible = true;
    },
  };
}
