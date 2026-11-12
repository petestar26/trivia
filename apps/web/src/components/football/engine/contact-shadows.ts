import * as THREE from 'three';

/**
 * Floodlit "star" shadows: under stadium floodlights every player casts several faint shadows,
 * one per light bank, plus a dark contact patch at the feet. These are cheap ground decals
 * (three instanced draw calls for the whole match) that ground players on every device,
 * including the phone/low setting that renders no shadow map. When the shadow map is active
 * the key light's real shadow replaces its decal.
 *
 * The texture is a generated DataTexture, so no canvas or external image is needed.
 */
export interface ShadowLight {
  /** Direction from the ground towards the light, world space (need not be normalised). */
  toLight: THREE.Vector3;
  /** Peak opacity of this light's shadow decal. */
  strength: number;
}
export interface ContactShadows {
  group: THREE.Group;
  /** Ground positions (x, z) of every actor, and the ball position. */
  update(actors: ReadonlyArray<{ x: number; z: number }>, ball: THREE.Vector3): void;
  /** True when the renderer draws a real key-light shadow (the key decal is then hidden). */
  setKeyShadowMapped(mapped: boolean): void;
  dispose(): void;
}

const PLAYER_HEIGHT = 1.8;

/** Soft teardrop: dense at the feet (v = 0), fading along the shadow (v = 1). */
function shadowTexture(): THREE.DataTexture {
  const w = 32;
  const h = 64;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w - 0.5;
      const v = (y + 0.5) / h;
      const width = 0.5 * (1 - 0.35 * v);
      const across = Math.exp(-((u / (width * 0.55)) ** 2) * 2.2);
      const along = Math.min(1, v / 0.08) * Math.pow(1 - v, 1.6);
      const a = Math.round(255 * Math.max(0, Math.min(1, across * along)));
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
      data[i + 3] = a;
    }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Round, soft contact patch. */
function contactTexture(): THREE.DataTexture {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const a = Math.round(255 * Math.max(0, 1 - r) ** 1.7);
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
      data[i + 3] = a;
    }
  const texture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function decalMaterial(map: THREE.Texture, opacity: number) {
  return new THREE.MeshBasicMaterial({
    map,
    color: '#000000',
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
    fog: false,
  });
}

export function createContactShadows(
  actorCount: number,
  key: ShadowLight,
  others: ShadowLight[]
): ContactShadows {
  const group = new THREE.Group();
  group.name = 'contact-shadows';
  const streak = shadowTexture();
  const patch = contactTexture();
  // A unit quad lying on the ground: x across, z along the shadow (0 at the feet .. 1 at the tip).
  const streakGeometry = new THREE.PlaneGeometry(1, 1);
  streakGeometry.rotateX(-Math.PI / 2);
  streakGeometry.translate(0, 0, 0.5);
  // PlaneGeometry v runs 0 (bottom, -y) .. 1; after rotation -y maps to +z, so flip v so that
  // v = 0 sits at the feet.
  const uv = streakGeometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const patchGeometry = new THREE.PlaneGeometry(1, 1);
  patchGeometry.rotateX(-Math.PI / 2);

  const lights = [key, ...others].map((light) => {
    const flat = new THREE.Vector2(light.toLight.x, light.toLight.z);
    const horizontal = flat.length();
    const height = Math.max(1, light.toLight.y);
    // Shadow points away from the light; its length follows the elevation of the light.
    return {
      yaw: Math.atan2(-flat.x, -flat.y),
      length: Math.min(4.2, (PLAYER_HEIGHT * horizontal) / height) + 0.25,
      strength: light.strength,
    };
  });
  const keyMesh = new THREE.InstancedMesh(
    streakGeometry,
    decalMaterial(streak, lights[0].strength),
    actorCount
  );
  const softMeshes = lights
    .slice(1)
    .map(
      (light) =>
        new THREE.InstancedMesh(streakGeometry, decalMaterial(streak, light.strength), actorCount)
    );
  const contactMesh = new THREE.InstancedMesh(
    patchGeometry,
    decalMaterial(patch, 0.58),
    actorCount + 1
  );
  const meshes = [keyMesh, ...softMeshes, contactMesh];
  meshes.forEach((mesh, i) => {
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = i === meshes.length - 1 ? 'contact-patches' : 'floodlight-shadows';
    group.add(mesh);
  });

  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const lift = 0.012;
  return {
    group,
    update(actors, ball) {
      const n = Math.min(actors.length, actorCount);
      [keyMesh, ...softMeshes].forEach((mesh, li) => {
        const light = lights[li];
        rotation.setFromAxisAngle(yAxis, light.yaw);
        scale.set(0.62, 1, light.length);
        for (let i = 0; i < n; i++) {
          position.set(actors[i].x, lift, actors[i].z);
          mesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
      });
      rotation.identity();
      for (let i = 0; i < n; i++) {
        position.set(actors[i].x, lift, actors[i].z);
        scale.set(1.05, 1, 0.85);
        contactMesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
      }
      // The ball's patch spreads and fades (by shrinking its dense core) as it rises.
      const air = Math.max(0, ball.y - 0.11);
      const size = 0.3 + air * 0.25;
      const fade = 1 / (1 + air * 0.9);
      position.set(ball.x, lift, ball.z);
      scale.set(size * fade + 0.0001, 1, size * fade + 0.0001);
      contactMesh.setMatrixAt(n, matrix.compose(position, rotation, scale));
      contactMesh.count = n + 1;
      contactMesh.instanceMatrix.needsUpdate = true;
    },
    setKeyShadowMapped(mapped) {
      keyMesh.visible = !mapped;
    },
    dispose() {
      streakGeometry.dispose();
      patchGeometry.dispose();
      streak.dispose();
      patch.dispose();
      meshes.forEach((mesh) => {
        (mesh.material as THREE.Material).dispose();
        mesh.dispose();
      });
    },
  };
}
