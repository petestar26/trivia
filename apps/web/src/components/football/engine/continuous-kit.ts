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
function sewnShorts(shorts: Tailor, bodyFit?: THREE.BufferGeometry) {
  const smooth = (a: number, b: number, v: number) => THREE.MathUtils.smoothstep(v, a, b);
  const skinPosition = bodyFit?.getAttribute('position'),
    skinJoints = bodyFit?.getAttribute('skinIndex'),
    skinWeights = bodyFit?.getAttribute('skinWeight');
  const skinTriangles: Array<{
    ids: number[];
    triangle: THREE.Triangle;
    lowY: number;
    highY: number;
  }> = [];
  if (bodyFit?.index && skinPosition && skinJoints && skinWeights)
    for (let k = 0; k < bodyFit.index.count; k += 3) {
      const ids = [bodyFit.index.getX(k), bodyFit.index.getX(k + 1), bodyFit.index.getX(k + 2)];
      let arm = 0;
      for (const id of ids)
        for (let c = 0; c < 4; c++)
          if (
            /^(upperArm|foreArm|hand|thumb|index|middle|ring|pinky)/.test(
              BONES[skinJoints.getComponent(id, c)]
            )
          )
            arm += skinWeights.getComponent(id, c) / 3;
      const lowY = Math.min(...ids.map((id) => skinPosition.getY(id))),
        highY = Math.max(...ids.map((id) => skinPosition.getY(id)));
      if (arm < 0.1 && highY > 0.65 && lowY < 1.08)
        skinTriangles.push({
          ids,
          triangle: new THREE.Triangle(
            ...(ids.map((id) => new THREE.Vector3().fromBufferAttribute(skinPosition, id)) as [
              THREE.Vector3,
              THREE.Vector3,
              THREE.Vector3,
            ])
          ),
          lowY,
          highY,
        });
    }
  const fieldCache = new Map<string, Weight>(),
    fieldSources = new Map<
      string,
      { sourceTriangle: number[]; barycentric: number[]; discardedMass: number }
    >(),
    point3 = new THREE.Vector3(),
    closest = new THREE.Vector3(),
    barycentric = new THREE.Vector3();
  const field = (point: Point): Weight => {
    const x = Math.round(point[0] * 1e7) / 1e7,
      y = Math.round(point[1] * 1e7) / 1e7;
    const key = point.map((v) => Math.round(v * 1e7)).join(',');
    if (fieldCache.has(key)) return fieldCache.get(key)!;
    point3.fromArray(point);
    let nearest: (typeof skinTriangles)[number] | undefined,
      distance = 0.025 ** 2;
    for (const triangle of skinTriangles) {
      if (y < triangle.lowY - 0.025 || y > triangle.highY + 0.025) continue;
      const d = triangle.triangle.closestPointToPoint(point3, closest).distanceToSquared(point3);
      if (d < distance) {
        distance = d;
        nearest = triangle;
      }
    }
    if (nearest && skinJoints && skinWeights) {
      nearest.triangle.closestPointToPoint(point3, closest);
      nearest.triangle.getBarycoord(closest, barycentric);
      const merged = new Map<number, number>();
      nearest.ids.forEach((id, n) => {
        for (let k = 0; k < 4; k++) {
          const joint = skinJoints.getComponent(id, k),
            mass = skinWeights.getComponent(id, k) * barycentric.getComponent(n);
          merged.set(joint, (merged.get(joint) ?? 0) + mass);
        }
      });
      const selected = [...merged.entries()]
          .filter(([, w]) => w > 1e-8)
          .sort((a, b) => b[1] - a[1] || a[0] - b[0])
          .slice(0, 4),
        total = selected.reduce((sum, [, w]) => sum + w, 0);
      const result = selected.map(([j, w]) => [BONES[j], w / total] as [BoneName, number]);
      fieldSources.set(key, {
        sourceTriangle: [...nearest.ids],
        barycentric: barycentric.toArray(),
        discardedMass: Math.max(0, 1 - total),
      });
      fieldCache.set(key, result);
      return result;
    }
    const leg = 1 - smooth(0.775, 1.035, y),
      left = smooth(-0.075, 0.075, x);
    const result: Weight = [
      ['hips', 1 - leg],
      ['upperLegL', leg * left],
      ['upperLegR', leg * (1 - left)],
    ];
    fieldCache.set(key, result);
    return result;
  };
  // Exact horizontal intersections of the anatomical mesh provide the fitted
  // cloth profile. Arms are a separate obstacle, never hidden or moved.
  const sections = new Map<number, { body: number[][]; arms: number[][] }>();
  const section = (y: number) => {
    if (sections.has(y)) return sections.get(y)!;
    const result = { body: [] as number[][], arms: [] as number[][] };
    if (bodyFit?.index) {
      const p = bodyFit.getAttribute('position'),
        joints = bodyFit.getAttribute('skinIndex'),
        weights = bodyFit.getAttribute('skinWeight');
      const armWeight = (i: number) => {
        let total = 0;
        for (let k = 0; k < 4; k++)
          if (
            /^(upperArm|foreArm|hand|thumb|index|middle|ring|pinky)/.test(
              BONES[joints.getComponent(i, k)]
            )
          )
            total += weights.getComponent(i, k);
        return total;
      };
      for (let k = 0; k < bodyFit.index.count; k += 3) {
        const tri = [bodyFit.index.getX(k), bodyFit.index.getX(k + 1), bodyFit.index.getX(k + 2)];
        const points: number[][] = [];
        for (let e = 0; e < 3; e++) {
          const a = tri[e],
            b = tri[(e + 1) % 3],
            ya = p.getY(a),
            yb = p.getY(b);
          if ((ya <= y && yb > y) || (yb <= y && ya > y)) {
            const t = (y - ya) / (yb - ya);
            points.push([
              THREE.MathUtils.lerp(p.getX(a), p.getX(b), t),
              THREE.MathUtils.lerp(p.getZ(a), p.getZ(b), t),
            ]);
          }
        }
        if (points.length === 2)
          (tri.reduce((v, i) => v + armWeight(i), 0) / 3 > 0.5 ? result.arms : result.body).push([
            ...points[0],
            ...points[1],
          ]);
      }
    }
    sections.set(y, result);
    return result;
  };
  const ray = (segments: number[][], cx: number, cz: number, dx: number, dz: number) => {
    let nearest = Infinity;
    for (const [ax, az, bx, bz] of segments) {
      const ex = bx - ax,
        ez = bz - az,
        det = dx * ez - dz * ex;
      if (Math.abs(det) < 1e-10) continue;
      const qx = ax - cx,
        qz = az - cz;
      const t = (qx * ez - qz * ex) / det,
        u = (qx * dz - qz * dx) / det;
      if (t > 0.005 && u >= 0 && u <= 1) nearest = Math.min(nearest, t);
    }
    return nearest;
  };
  const fitted = (
    y: number,
    t: number,
    cx: number,
    rx: number,
    rz: number,
    returned = false
  ): Point => {
    const dx = Math.cos(t),
      dz = Math.sin(t),
      cz = -0.007;
    const raw = Math.hypot(rx * dx, rz * dz),
      direction = Math.atan2(rz * dz, rx * dx);
    const ux = Math.cos(direction),
      uz = Math.sin(direction),
      slices = section(y);
    const anatomy = ray(slices.body, cx, cz, ux, uz),
      arm = ray(slices.arms, cx, cz, ux, uz);
    // Keep a close fit rather than the former 40–50mm oversized side panel.
    // If source anatomy conflicts with an arm corridor, retain the anatomy
    // envelope and expose that remaining conflict in geometric validation.
    let radius = Number.isFinite(anatomy) ? anatomy + 0.007 : raw;
    // Spend only the available cloth ease in a feasible arm corridor. Keep
    // at least .5mm anatomy clearance; never invent a 3mm arm-clearance pass
    // when the original body and arm surfaces themselves conflict.
    if (Number.isFinite(anatomy) && Number.isFinite(arm) && arm - 0.003 >= anatomy + 0.0005)
      radius = Math.min(radius, arm - 0.003);
    if (returned) radius -= 0.0012;
    return [cx + ux * radius, y, cz + uz * radius];
  };
  const loft = (rows: Array<{ point(t: number): Point }>) => {
    const base = shorts.p.length / 3,
      segments = 64;
    rows.forEach((row, r) => {
      for (let j = 0; j <= segments; j++) {
        const p = row.point((j / segments) * Math.PI * 2);
        shorts.vertex(p, [j / segments, r / (rows.length - 1)], field(p));
      }
    });
    for (let r = 0; r < rows.length - 1; r++)
      for (let j = 0; j < segments; j++) {
        const a = base + r * (segments + 1) + j,
          b = a + segments + 1;
        shorts.ids.push(a, a + 1, b, b, a + 1, b + 1);
      }
  };
  loft(
    [
      [1.045, 0.191, 0.106],
      [1.025, 0.198, 0.113],
      [1.005, 0.204, 0.118],
      [0.985, 0.209, 0.122],
      [0.965, 0.213, 0.124],
      [0.94, 0.214, 0.123],
      [0.915, 0.215, 0.122],
      [0.89, 0.215, 0.12],
    ].map(([y, rx, rz]) => ({
      point(t: number): Point {
        return fitted(y, t, 0, rx, rz);
      },
    }))
  );
  for (const side of ['L', 'R'] as const) {
    const sign = side === 'L' ? 1 : -1;
    const fork = (t: number): Point => {
      const c = Math.cos(t),
        outer = c * sign >= 0;
      if (outer) return fitted(0.89, t, 0, 0.215, 0.12);
      const front = fitted(0.89, Math.PI / 2, 0, 0.215, 0.12)[2],
        back = fitted(0.89, -Math.PI / 2, 0, 0.215, 0.12)[2];
      return [
        0,
        0.89 - 0.055 * Math.abs(c),
        THREE.MathUtils.lerp(back, front, (Math.sin(t) + 1) / 2),
      ];
    };
    const rows: { point(t: number): Point }[] = [
      {
        point: fork,
      },
    ];
    for (const u of [0.25, 0.5, 0.75])
      rows.push({
        point(t: number): Point {
          const a = fork(t),
            b = fitted(0.79, t, 0.1 * sign, 0.097, 0.109);
          return a.map((v, k) => THREE.MathUtils.lerp(v, b[k], u)) as Point;
        },
      });
    for (const [y, rx, rz] of [
      [0.79, 0.097, 0.109],
      [0.75, 0.098, 0.106],
      [0.72, 0.096, 0.102],
      [0.691, 0.094, 0.098],
      [0.682, 0.094, 0.098],
      [0.684, 0.094, 0.098],
    ]) {
      rows.push({
        point(t: number): Point {
          return fitted(y, t, 0.1 * sign, rx, rz, y === 0.684);
        },
      });
    }
    loft(rows);
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
  const records = Array.from({ length: shorts.p.length / 3 }, (_, i) => {
    const point = shorts.p.slice(i * 3, i * 3 + 3),
      key = point.map((v) => Math.round(v * 1e7)).join(',');
    return {
      vertex: i,
      ...(fieldSources.get(key) ?? { sourceTriangle: [], barycentric: [], discardedMass: 0 }),
      analyticFallback: !fieldSources.has(key),
    };
  });
  const buildGeometry = shorts.geometry;
  shorts.geometry = function (name: string) {
    const geometry = buildGeometry.call(this, name);
    geometry.userData.garmentFit = {
      sourceVertices: skinPosition?.count ?? 0,
      nominalRadialEaseMetres: 0.007,
      minimumFeasibleArmCorridorMetres: 0.003,
      weightRecipe:
        'nearest non-arm anatomical triangle within25mm; barycentric production49 merge; stable greatest4 normalize; welded identical-position cache',
      records,
    };
    return geometry;
  };
}

/** Owns all returned geometries/materials; caller owns bound mesh wrappers. Idempotent disposal. */
export function createContinuousKit(look: Look, bodyFit?: THREE.BufferGeometry) {
  const shorts = new Tailor(),
    socks = new Tailor(),
    boots = new Tailor();
  sewnShorts(shorts, bodyFit);
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
  (geometries.boots.getAttribute('position') as THREE.BufferAttribute).setUsage(
    THREE.DynamicDrawUsage
  );
  (geometries.boots.getAttribute('normal') as THREE.BufferAttribute).setUsage(
    THREE.DynamicDrawUsage
  );
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
      {
        world: new THREE.Matrix4(),
        inverse: new THREE.Matrix4(),
        rest: new THREE.Vector3(0.1, 0.08, 0),
      },
      {
        world: new THREE.Matrix4(),
        inverse: new THREE.Matrix4(),
        rest: new THREE.Vector3(-0.1, 0.08, 0),
      },
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
      const value = object.matrixWorld.elements[k],
        index = j * 16 + k;
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
    const x = neutral[i * 3],
      y = neutral[i * 3 + 1],
      z = neutral[i * 3 + 2];
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
