import * as THREE from 'three';
import { BONES, type BoneName, type Look, type Rig } from './rig';

type Weight = [BoneName, number][];
type Point = [number, number, number];
/** Original editable parametric garment construction in production world-rest metres. */
class Tailor {
  p: number[] = [];
  uv: number[] = [];
  joints: number[] = [];
  weights: number[] = [];
  ids: number[] = [];
  vertex(p: Point, uv: [number, number], weights: Weight) {
    const i = this.p.length / 3;
    this.p.push(...p);
    this.uv.push(...uv);
    this.joints.push(
      ...weights.map(([b]) => BONES.indexOf(b)),
      ...Array(4 - weights.length).fill(0)
    );
    this.weights.push(...weights.map(([, w]) => w), ...Array(4 - weights.length).fill(0));
    return i;
  }
  rings(rows: { point(t: number): Point; weights: Weight }[], segments = 32) {
    const base = this.p.length / 3;
    rows.forEach((row, r) => {
      for (let j = 0; j <= segments; j++)
        this.vertex(
          row.point((j / segments) * Math.PI * 2),
          [j / segments, r / (rows.length - 1)],
          row.weights
        );
    });
    for (let r = 0; r < rows.length - 1; r++)
      for (let j = 0; j < segments; j++) {
        const a = base + r * (segments + 1) + j,
          b = a + segments + 1;
        this.ids.push(a, a + 1, b, b, a + 1, b + 1);
      }
  }
  geometry(name: string) {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.joints, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.weights, 4));
    g.setIndex(this.ids);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** A connected pair-of-pants surface: one waist/seat, sewn rise, shared crotch
 * saddle and two open returned hems. All seam vertices share binding too. */
function sewnShorts(shorts: Tailor) {
  shorts.rings(
    [
      [1.045, 0.191, 0.106],
      [1.025, 0.198, 0.113],
      [0.965, 0.213, 0.124],
      [0.89, 0.215, 0.12],
    ].map(([y, rx, rz]) => ({
      point(t: number): Point {
        return [rx * Math.cos(t), y, rz * Math.sin(t) - 0.007];
      },
      weights: [['hips', 1]] as Weight,
    })),
    64
  );
  for (const side of ['L', 'R'] as const) {
    const sign = side === 'L' ? 1 : -1,
      upper: BoneName = `upperLeg${side}`;
    const rows: { point(t: number): Point; weights: Weight }[] = [
      {
        point(t: number): Point {
          const c = Math.cos(t),
            outer = c * sign >= 0;
          return [
            outer ? 0.215 * c : 0,
            outer ? 0.89 : 0.89 - 0.055 * Math.abs(c),
            0.12 * Math.sin(t) - 0.007,
          ];
        },
        weights: [['hips', 1]],
      },
    ];
    for (const [y, rx, rz] of [
      [0.81, 0.102, 0.113],
      [0.77, 0.099, 0.108],
      [0.72, 0.096, 0.102],
      [0.691, 0.094, 0.098],
      [0.682, 0.094, 0.098],
      [0.686, 0.09, 0.094],
    ]) {
      const hip = Math.max(0, (y - 0.79) / 0.15);
      rows.push({
        point(t: number): Point {
          return [0.1 * sign + rx * Math.cos(t), y, rz * Math.sin(t) - 0.007];
        },
        weights: [
          ['hips', hip],
          [upper, 1 - hip],
        ],
      });
    }
    shorts.rings(rows, 64);
  }
  // Weld the pelvis-to-leg outer arcs and mirrored crotch saddle exactly.
  // Keeping original cloth UV coordinates at the seam is unnecessary for this
  // untextured original garment; the shared points prevent pose cracks.
  const ids = new Map<string, number>(),
    remap: number[] = [],
    p: number[] = [],
    uv: number[] = [],
    joints: number[] = [],
    weights: number[] = [];
  for (let i = 0; i < shorts.p.length / 3; i++) {
    const xyz = shorts.p.slice(i * 3, i * 3 + 3),
      js = shorts.joints.slice(i * 4, i * 4 + 4),
      ws = shorts.weights.slice(i * 4, i * 4 + 4);
    const key =
      xyz.map((v) => Math.round(v * 1e7)).join(',') + '|' + js.join(',') + '|' + ws.join(',');
    let n = ids.get(key);
    if (n === undefined) {
      n = p.length / 3;
      ids.set(key, n);
      p.push(...xyz);
      uv.push(...shorts.uv.slice(i * 2, i * 2 + 2));
      joints.push(...js);
      weights.push(...ws);
    }
    remap.push(n);
  }
  shorts.p = p;
  shorts.uv = uv;
  shorts.joints = joints;
  shorts.weights = weights;
  shorts.ids = shorts.ids.map((i) => remap[i]);
}

/** Owns all returned geometries/materials; caller owns bound mesh wrappers. Idempotent disposal. */
export function createContinuousKit(look: Look) {
  const shorts = new Tailor(),
    socks = new Tailor(),
    boots = new Tailor();
  sewnShorts(shorts);
  const tongueRanges: number[][] = [],
    laceRanges: number[][] = [];
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1,
      upper: BoneName = `upperLeg${side}`,
      lower: BoneName = `lowerLeg${side}`,
      foot: BoneName = `foot${side}`;
    // Ribbed fold-over cuff, calf shaping, ankle taper and narrow returned edge.
    socks.rings(
      [
        [0.473, 0.066, 0.071],
        [0.468, 0.069, 0.074],
        [0.448, 0.069, 0.074],
        [0.442, 0.066, 0.071],
        [0.4, 0.067, 0.074],
        [0.33, 0.061, 0.067],
        [0.24, 0.049, 0.054],
        [0.15, 0.04, 0.044],
        [0.105, 0.037, 0.04],
        [0.101, 0.034, 0.037],
      ].map(([y, rx, rz]) => ({
        point(t: number): Point {
          const rib = 1 + 0.009 * Math.cos(t * 24);
          return [0.1 * s + rx * Math.cos(t) * rib, y, rz * Math.sin(t) * rib];
        },
        weights:
          y >= 0.15
            ? [[lower, 1]]
            : ([
                [lower, (y - 0.08) / 0.07],
                [foot, 1 - (y - 0.08) / 0.07],
              ] as Weight),
      }))
    );
    // Rounded anatomical last: a closed heel, broad ball and rounded toe. Sole
    // stays flat (no curled rest toe); heel and ball match contact datums.
    const rows = [
      [-0.073, 0.004, 0.035, 0.078],
      [-0.07, 0.018, 0.01, 0.09],
      [-0.065, 0.028, 0.01, 0.107],
      [-0.04, 0.044, 0.01, 0.123],
      [0, 0.05, 0.011, 0.122],
      [0.055, 0.053, 0.012, 0.1],
      [0.105, 0.054, 0.012, 0.075],
      [0.15, 0.052, 0.012, 0.06],
      [0.178, 0.045, 0.012, 0.055],
      [0.197, 0.028, 0.012, 0.045],
      [0.204, 0.004, 0.02, 0.033],
    ];
    boots.rings(
      rows.map(([z, rx, bottom, top]) => ({
        point(t: number): Point {
          const h = (Math.sin(t) + 1) / 2;
          return [0.1 * s + rx * Math.cos(t), bottom + (top - bottom) * Math.pow(h, 0.65), z];
        },
        weights: [[foot, 1]] as Weight,
      })),
      32
    );
    // Original inset tongue and four raised rounded lace bars, with no marks.
    const tongueStart = boots.p.length / 3;
    for (const z of [-0.015, 0.005, 0.025, 0.045, 0.065])
      for (const x of [-0.024, -0.012, 0, 0.012, 0.024])
        boots.vertex(
          [0.1 * s + x, 0.128 - 0.4 * z - 14 * x * x, z],
          [(x + 0.024) / 0.048, (z + 0.015) / 0.08],
          [[foot, 1]]
        );
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++) {
        const a = tongueStart + r * 5 + c;
        boots.ids.push(a, a + 1, a + 5, a + 5, a + 1, a + 6);
      }
    tongueRanges.push([tongueStart, boots.p.length / 3]);
    const laceStart = boots.p.length / 3;
    for (const z of [0.002, 0.018, 0.034, 0.05]) {
      boots.rings(
        [-0.02, -0.01, 0, 0.01, 0.02].map((x) => ({
          point(t: number): Point {
            return [
              0.1 * s + x,
              0.131 - 0.4 * z - 14 * x * x + 0.0014 * Math.cos(t),
              z + 0.0014 * Math.sin(t),
            ];
          },
          weights: [[foot, 1]] as Weight,
        })),
        8
      );
    }
    laceRanges.push([laceStart, boots.p.length / 3]);
    // Eight original rounded studs per boot, kept inside the accepted sole
    // extremum; no added stud length changes heel/ball authority targets.
    for (const z of [-0.045, 0.025, 0.1, 0.15])
      for (const x of [-0.029, 0.029]) {
        boots.rings(
          [
            [0.01, 0.005],
            [0.012, 0.008],
            [0.02, 0.009],
          ].map(([y, r]) => ({
            point(t: number): Point {
              return [0.1 * s + x + r * Math.cos(t), y, z + r * Math.sin(t)];
            },
            weights: [[foot, 1]] as Weight,
          })),
          10
        );
      }
    // Sole lip, separate profile integrated into the same owned geometry.
    boots.rings(
      [0.012, 0.017, 0.021].map((y) => ({
        point(t: number): Point {
          return [0.1 * s + 0.052 * Math.cos(t), y, 0.061 + 0.135 * Math.sin(t)];
        },
        weights: [[foot, 1]] as Weight,
      })),
      40
    );
  }
  const geometries = {
    shorts: shorts.geometry('original-sewn-football-shorts'),
    socks: socks.geometry('original-ribbed-football-socks'),
    boots: boots.geometry('original-rounded-football-boots'),
  };
  const bootColors = new Float32Array(geometries.boots.getAttribute('position').count * 3),
    bootBase = new THREE.Color('#161b24'),
    tongueColor = new THREE.Color('#303c4a'),
    laceColor = new THREE.Color('#74808c');
  for (let i = 0; i < bootColors.length / 3; i++) bootColors.set(bootBase.toArray(), i * 3);
  for (const [a, b] of tongueRanges)
    for (let i = a; i < b; i++) bootColors.set(tongueColor.toArray(), i * 3);
  for (const [a, b] of laceRanges)
    for (let i = a; i < b; i++) bootColors.set(laceColor.toArray(), i * 3);
  geometries.boots.setAttribute('color', new THREE.Float32BufferAttribute(bootColors, 3));
  // Ordinary dynamic attributes are versioned by Three's WebGLAttributes.
  // Changing morph arrays after first render is unsupported by its morph atlas.
  (geometries.boots.getAttribute('position') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  (geometries.boots.getAttribute('normal') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  bootStates.set(geometries.boots, createBootState(geometries.boots));
  const material = (color: THREE.ColorRepresentation, roughness: number) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, side: THREE.DoubleSide });
  const materials = {
    shorts: material(look.kit.shorts, 0.94),
    socks: material(look.kit.socks, 0.96),
    boots: material('#ffffff', 0.56),
  };
  materials.boots.vertexColors = true;
  let disposed = false;
  return {
    geometries,
    materials,
    dispose() {
      if (disposed) return;
      disposed = true;
      bootStates.delete(geometries.boots);
      Object.values(geometries).forEach((g) => g.dispose());
      Object.values(materials).forEach((m) => m.dispose());
    },
  };
}

function createBootState(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position');
  return {
    neutral: new Float32Array(p.array),
    previous: new Float64Array(48).fill(Number.NaN),
    rootQuaternion: new THREE.Quaternion(),
    footQuaternion: new THREE.Quaternion(),
    forward: new THREE.Vector3(),
    bindPoint: new THREE.Vector3(),
    worldSole: new THREE.Vector3(),
    lifted: new THREE.Vector3(),
    matrices: [
      { world: new THREE.Matrix4(), inverse: new THREE.Matrix4(), rest: new THREE.Vector3(.1, .08, 0) },
      { world: new THREE.Matrix4(), inverse: new THREE.Matrix4(), rest: new THREE.Vector3(-.1, .08, 0) },
    ],
  };
}
const bootStates = new WeakMap<THREE.BufferGeometry, ReturnType<typeof createBootState>>();

/** Call after final contact solving; does not alter bones, anchors or timing.
 * Coherent forefoot/sole sections bend visually; legacy kick BALL markers may
 * cross turf, so their visible sole correspondence is explicitly not retained.
 * The owned dynamic position buffer uploads every changed pose. */
export function syncContinuousBootFlex(mesh: THREE.SkinnedMesh, rig: Rig) {
  const g = mesh.geometry,
    p = g.getAttribute('position') as THREE.BufferAttribute,
    state = bootStates.get(g);
  if (!state) return;
  rig.root.updateWorldMatrix(true, false);
  let changed = false;
  for (let j = 0; j < 3; j++) {
    const object = j === 0 ? rig.root : rig.bones[j === 1 ? 'footL' : 'footR'];
    object.updateWorldMatrix(true, false);
    for (let k = 0; k < 16; k++) {
      const value = object.matrixWorld.elements[k], index = j * 16 + k;
      if (!(Math.abs(value - state.previous[index]) <= 1e-10)) changed = true;
      state.previous[index] = value;
    }
    if (j > 0) {
      state.matrices[j - 1].world.copy(object.matrixWorld);
      state.matrices[j - 1].inverse.copy(object.matrixWorld).invert();
    }
  }
  if (!changed) return;
  const rootQ = rig.root.getWorldQuaternion(state.rootQuaternion).invert();
  const pitch = (side: 'L' | 'R') => {
    const bone = rig.skeleton.bones[BONES.indexOf(`foot${side}`)];
    const q = bone.getWorldQuaternion(state.footQuaternion).premultiply(rootQ);
    const forward = state.forward.set(0, 0, 1).applyQuaternion(q);
    return Math.min(2.5, Math.max(0, -forward.y / Math.max(0.25, forward.z)));
  };
  const l = pitch('L'),
    r = pitch('R');
  const { bindPoint, worldSole, lifted, neutral, matrices } = state;
  let maxDisplacement = 0;
  for (let i = 0; i < p.count; i++) {
    const x = neutral[i * 3], y = neutral[i * 3 + 1], z = neutral[i * 3 + 2];
    const left = x > 0,
      m = matrices[left ? 0 : 1];
    const flex = Math.max(0, z - 0.15) * (left ? l : r);
    // Coherent cross-section bend: the entire last section translates together
    // by its sole's shortfall, retaining toe-box thickness and curved upper.
    // No rendered point is independently clamped. Neutral sole remains flat.
    bindPoint.set(x, 0.01 + flex, z).sub(m.rest);
    worldSole.copy(bindPoint).applyMatrix4(m.world);
    lifted.copy(worldSole);
    lifted.y += Math.min(0.12, Math.max(0, 0.001 - worldSole.y));
    lifted.applyMatrix4(m.inverse).sub(bindPoint);
    p.setXYZ(i, x + lifted.x, y + flex + lifted.y, z + lifted.z);
    maxDisplacement = Math.max(maxDisplacement, Math.hypot(lifted.x, flex + lifted.y, lifted.z));
  }
  g.userData.maxVisualBootDisplacementMetres = maxDisplacement;
  p.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
}
