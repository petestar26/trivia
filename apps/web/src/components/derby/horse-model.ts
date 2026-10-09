import * as THREE from 'three';
import { gallopPose, legJoint } from './gallop';
import { createLegSurface } from './leg-surface';

type Resources = {
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
};
/** Original anatomical surface meshes and articulated rig, authored for this game. */
export function createHorse(
  coatColor: string,
  silkColor: string,
  index: number,
  resources: Resources,
  merge: (parent: THREE.Object3D) => void
) {
  const root = new THREE.Group();
  function material(color: string, roughness = 0.7, metallic = 0) {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: metallic });
    resources.materials.push(m);
    return m;
  }
  const coat = new THREE.MeshPhysicalMaterial({
    color: coatColor,
    roughness: 0.56,
    clearcoat: 0.12,
    clearcoatRoughness: 0.65,
    vertexColors: true,
  });
  resources.materials.push(coat);
  const coatCanvas = document.createElement('canvas');
  coatCanvas.width = coatCanvas.height = 128;
  const coatContext = coatCanvas.getContext('2d');
  if (coatContext) {
    coatContext.fillStyle = '#bbb';
    coatContext.fillRect(0, 0, 128, 128);
    let noise = 851 + index;
    for (let n = 0; n < 6500; n++) {
      noise = (noise * 1664525 + 1013904223) >>> 0;
      const x = noise % 128,
        y = (noise >>> 8) % 128,
        shade = 130 + ((noise >>> 16) % 90);
      coatContext.fillStyle = `rgb(${shade},${shade},${shade})`;
      coatContext.fillRect(x, y, 3, 1);
    }
    const texture = new THREE.CanvasTexture(coatCanvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 3);
    resources.textures.push(texture);
    coat.bumpMap = texture;
    coat.bumpScale = 0.006;
  }
  const hair = material('#231b16'),
    leather = material('#30251e', 0.4),
    hoof = material('#38322c'),
    silk = material(silkColor, 0.42),
    ivory = material('#e4ddc7'),
    gold = material('#b89b58', 0.32, 0.65),
    skin = material('#bb8765'),
    eye = material('#080a09', 0.1);
  function add(
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    m: THREE.Material,
    x = 0,
    y = 0,
    z = 0
  ) {
    if (m === coat && !geo.getAttribute('color')) {
      geo.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(
          new Float32Array(geo.getAttribute('position').count * 3).fill(1),
          3
        )
      );
    }
    resources.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  function oval(
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    rx: number,
    ry: number,
    rz: number,
    m: THREE.Material
  ) {
    const mesh = add(parent, new THREE.SphereGeometry(1, 20, 14), m, x, y, z);
    mesh.scale.set(rx, ry, rz);
    return mesh;
  }
  function strand(parent: THREE.Object3D, points: number[][], radius: number, m: THREE.Material) {
    return add(
      parent,
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))),
        16,
        radius,
        5,
        false
      ),
      m
    );
  }
  // Swept, smoothly tapered cross-sections give continuous shoulders, withers,
  // belly and jaw instead of a collection of visible ball-shaped parts.
  function surface(parent: THREE.Object3D, profiles: number[][], m: THREE.Material) {
    const path = new THREE.CatmullRomCurve3(profiles.map((p) => new THREE.Vector3(p[0], p[1], 0)));
    const radii = new THREE.CatmullRomCurve3(profiles.map((p) => new THREE.Vector3(p[2], p[3], 0)));
    const colors: number[] = [];
    const vertices: number[] = [],
      uv: number[] = [],
      indices: number[] = [];
    const rings = 40,
      sides = 20;
    for (let r = 0; r <= rings; r++) {
      const t = r / rings,
        c = path.getPoint(t),
        d = path.getTangent(t),
        radius = radii.getPoint(t);
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2,
          height = Math.cos(a) * Math.max(0.002, radius.x);
        vertices.push(
          c.x - d.y * height,
          c.y + d.x * height,
          Math.sin(a) * Math.max(0.002, radius.y)
        );
        // Subtle anatomical coat variation: darker belly and warm flank highlights.
        // Vertex shading follows the surface rather than a repeating painted stripe.
        const light = 0.76 + 0.24 * ((Math.cos(a) + 1) / 2);
        const flank = 0.035 * Math.sin(t * Math.PI * 3) * Math.sin(a) ** 2;
        colors.push(light + flank, light + flank * 0.6, light);
        uv.push(t, s / sides);
        if (r < rings && s < sides) {
          const n = r * (sides + 1) + s;
          indices.push(n, n + 1, n + sides + 1, n + 1, n + sides + 2, n + sides + 1);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return add(parent, geo, m);
  }
  surface(
    root,
    [
      [-1.28, 2.03, 0.01, 0.01],
      [-1.12, 2.05, 0.37, 0.32],
      [-0.8, 2.1, 0.51, 0.44],
      [-0.32, 2.03, 0.43, 0.37],
      [0.16, 2.02, 0.48, 0.4],
      [0.59, 2.04, 0.58, 0.43],
      [0.94, 2.12, 0.36, 0.29],
      [1.07, 2.12, 0.01, 0.01],
    ],
    coat
  );
  // A lean sloping neck rises from the chest; the throat narrows below the jaw.
  const neck = new THREE.Group();
  neck.position.set(0.72, 2.15, 0);
  root.add(neck);
  surface(
    neck,
    [
      [-0.15, -0.18, 0.01, 0.01],
      [0.03, -0.03, 0.39, 0.32],
      [0.22, 0.31, 0.34, 0.27],
      [0.44, 0.64, 0.27, 0.2],
      [0.62, 0.85, 0.2, 0.16],
      [0.72, 0.92, 0.025, 0.025],
    ],
    coat
  );
  surface(
    neck,
    [
      [0.45, 0.86, 0.01, 0.01],
      [0.66, 0.84, 0.25, 0.18],
      [0.9, 0.73, 0.16, 0.135],
      [1.1, 0.52, 0.13, 0.115],
      [1.22, 0.42, 0.115, 0.145],
      [1.29, 0.37, 0.02, 0.02],
    ],
    coat
  );
  for (const side of [-1, 1]) {
    oval(neck, 1.19, 0.4, side * 0.115, 0.093, 0.078, 0.028, leather);
    oval(neck, 0.8, 0.86, side * 0.174, 0.049, 0.043, 0.018, eye);
    const ear = add(neck, new THREE.ConeGeometry(0.075, 0.32, 10), coat, 0.59, 1.16, side * 0.115);
    ear.rotation.z = -0.24;
    const inner = add(
      neck,
      new THREE.ConeGeometry(0.039, 0.23, 8),
      leather,
      0.608,
      1.18,
      side * 0.15
    );
    inner.rotation.z = -0.24;
    // Browband, cheekpiece, bit and reins follow the face and neck.
    strand(
      neck,
      [
        [0.62, 0.99, side * 0.19],
        [0.87, 0.77, side * 0.18],
        [1.14, 0.44, side * 0.16],
      ],
      0.018,
      leather
    );
    oval(neck, 1.12, 0.42, side * 0.17, 0.045, 0.045, 0.015, gold);
    strand(
      root,
      [
        [1.84, 2.59, side * 0.18],
        [1.16, 2.55, side * 0.32],
        [0.55, 2.74, side * 0.23],
      ],
      0.014,
      leather
    );
  }
  strand(
    neck,
    [
      [1.12, 0.51, -0.15],
      [1.19, 0.54, 0],
      [1.12, 0.51, 0.15],
    ],
    0.022,
    leather
  );
  // A narrow blaze and dark crest break up the coat without large toy-like eyes.
  strand(
    neck,
    [
      [0.69, 1.07, 0],
      [0.93, 0.86, 0],
      [1.15, 0.63, 0],
    ],
    0.022,
    ivory
  );
  for (let n = 0; n < 18; n++) {
    const t = n / 17;
    strand(
      neck,
      [
        [-0.1 + t * 0.62, 0.16 + t * 0.9, 0],
        [-0.24 + t * 0.65, 0.19 + t * 0.91, 0.018],
        [-0.3 + t * 0.65, 0.1 + t * 0.88, 0.025],
      ],
      0.018,
      hair
    );
  }
  const tail = new THREE.Group();
  tail.position.set(-1.13, 2.25, 0);
  root.add(tail);
  for (let n = 0; n < 12; n++) {
    const z = (n - 5.5) * 0.014;
    strand(
      tail,
      [
        [0, 0, z],
        [-0.35, -0.15, z],
        [-0.85, -0.35, z * 2],
        [-1.22, -0.48 + n * 0.012, z * 2.2],
      ],
      0.022,
      hair
    );
  }
  // Draped saddlecloth, stitched leather saddle and a racing crouch.
  oval(root, -0.04, 2.4, 0, 0.57, 0.12, 0.45, silk);
  for (const side of [-1, 1]) {
    const cloth = add(
      root,
      new THREE.BoxGeometry(0.85, 0.48, 0.025),
      silk,
      -0.12,
      2.16,
      side * 0.414
    );
    cloth.rotation.x = side * -0.12;
    strand(
      root,
      [
        [-0.55, 1.96, side * 0.45],
        [0.28, 1.96, side * 0.45],
        [0.31, 2.3, side * 0.43],
      ],
      0.013,
      gold
    );
    strand(
      root,
      [
        [0.18, 2.4, side * 0.4],
        [0.21, 1.86, side * 0.43],
        [0.21, 1.63, side * 0.25],
      ],
      0.026,
      leather
    );
  }
  const numberCanvas = document.createElement('canvas');
  numberCanvas.width = numberCanvas.height = 128;
  const nc = numberCanvas.getContext('2d');
  if (nc) {
    nc.fillStyle = silkColor;
    nc.fillRect(0, 0, 128, 128);
    nc.strokeStyle = '#ead4a4';
    nc.lineWidth = 5;
    nc.strokeRect(6, 6, 116, 116);
    nc.fillStyle = '#101b19';
    nc.font = 'bold 90px sans-serif';
    nc.textAlign = 'center';
    nc.textBaseline = 'middle';
    nc.fillText(String(index + 1), 64, 68);
  }
  const numberTexture = new THREE.CanvasTexture(numberCanvas);
  numberTexture.colorSpace = THREE.SRGBColorSpace;
  resources.textures.push(numberTexture);
  const numberMaterial = new THREE.MeshStandardMaterial({ map: numberTexture, roughness: 0.9 });
  resources.materials.push(numberMaterial);
  for (const side of [-1, 1]) {
    const patch = add(
      root,
      new THREE.PlaneGeometry(0.42, 0.4),
      numberMaterial,
      -0.16,
      2.18,
      side * 0.439
    );
    patch.rotation.y = side < 0 ? Math.PI : 0;
  }
  oval(root, -0.18, 2.51, 0, 0.4, 0.085, 0.28, leather);
  const rider = new THREE.Group();
  root.add(rider);
  const torso = oval(rider, 0.08, 2.86, 0, 0.42, 0.17, 0.22, silk);
  torso.rotation.z = -0.25;
  oval(rider, 0.51, 2.99, 0, 0.13, 0.16, 0.13, skin);
  oval(rider, 0.53, 3.1, 0, 0.17, 0.11, 0.16, silk);
  oval(rider, 0.64, 3.015, 0, 0.075, 0.045, 0.135, eye);
  for (const side of [-1, 1]) {
    strand(
      rider,
      [
        [-0.28, 2.77, side * 0.14],
        [-0.02, 2.39, side * 0.38],
        [-0.4, 2.14, side * 0.42],
      ],
      0.1,
      ivory
    );
    strand(
      rider,
      [
        [-0.4, 2.14, side * 0.42],
        [-0.3, 1.94, side * 0.42],
        [-0.1, 1.91, side * 0.42],
      ],
      0.085,
      leather
    );
    strand(
      rider,
      [
        [0.28, 2.89, side * 0.19],
        [0.33, 2.66, side * 0.29],
        [0.64, 2.71, side * 0.22],
      ],
      0.061,
      silk
    );
    oval(rider, 0.64, 2.71, side * 0.22, 0.073, 0.055, 0.055, leather);
    strand(
      root,
      [
        [-0.31, 2.47, side * 0.32],
        [-0.3, 1.91, side * 0.47],
        [-0.05, 1.91, side * 0.47],
      ],
      0.018,
      gold
    );
  }
  // A single deforming skin per limb keeps knees and muscle contours continuous.
  const limbCoat = coat.clone();
  limbCoat.vertexColors = true;
  resources.materials.push(limbCoat);
  const legs = Array.from({ length: 4 }, (_, leg) => {
    const hind = leg < 2,
      side = leg % 2 ? 1 : -1;
    const x = hind ? -0.83 : 0.7,
      z = side * 0.285;
    const skin = createLegSurface(hind);
    const mesh = add(root, skin.geometry, limbCoat);
    mesh.frustumCulled = false; // Deforming bounds are tiny and remain inside the race field.
    const foot = add(root, new THREE.CylinderGeometry(0.065, 0.105, 0.16, 16), hoof);
    foot.scale.set(1.35, 1, 0.9);
    return { skin, mesh, foot, x, z, hind };
  });
  const animated = [neck, tail, rider, ...legs.flatMap((l) => [l.mesh, l.foot])];
  animated.forEach((x) => root.remove(x));
  merge(root);
  animated.forEach((x) => root.add(x));
  merge(neck);
  merge(tail);
  merge(rider);
  function animate(seconds: number, moving: boolean) {
    const pose = gallopPose(seconds, index, moving);
    root.position.y = pose.bounce;
    neck.rotation.z = pose.neck;
    rider.rotation.z = pose.rider;
    tail.rotation.z = pose.tail;
    legs.forEach((leg, i) => {
      const foot = pose.feet[i],
        hipY = 1.68,
        joint = legJoint(foot.x, foot.y - hipY, leg.hind);
      leg.skin.pose(leg.x, hipY, leg.x + joint.x, hipY + joint.y, leg.x + foot.x, foot.y, leg.z);
      leg.foot.position.set(leg.x + foot.x + 0.025, foot.y - 0.015, leg.z);
      leg.foot.rotation.z = foot.contact ? 0 : leg.hind ? -0.2 : 0.3;
    });
  }
  animate(0, false);
  return { root, animate };
}
