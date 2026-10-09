import { BufferGeometry, Float32BufferAttribute, DynamicDrawUsage } from 'three';

/** Continuous, tapered skin over a two-bone leg. All coordinates are presentation-only. */
export function createLegSurface(hind: boolean) {
  const rings = 24,
    sides = 12;
  const positions = new Float32Array((rings + 1) * (sides + 1) * 3);
  const normals = new Float32Array(positions.length);
  const colors = new Float32Array(positions.length);
  const uv = new Float32Array((rings + 1) * (sides + 1) * 2);
  const indices: number[] = [];
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(positions, 3).setUsage(DynamicDrawUsage)
  );
  geometry.setAttribute(
    'normal',
    new Float32BufferAttribute(normals, 3).setUsage(DynamicDrawUsage)
  );
  // The top expands inside the shoulder/haunch; cannon and fetlock are distinct.
  const profiles = hind
    ? [
        [0, 0.25],
        [0.12, 0.23],
        [0.32, 0.13],
        [0.48, 0.085],
        [0.56, 0.075],
        [0.78, 0.042],
        [0.9, 0.068],
        [1, 0.061],
      ]
    : [
        [0, 0.19],
        [0.13, 0.16],
        [0.33, 0.105],
        [0.48, 0.073],
        [0.56, 0.066],
        [0.78, 0.038],
        [0.9, 0.064],
        [1, 0.055],
      ];
  const radiusAt = (t: number) => {
    const next = profiles.findIndex(([p]) => p >= t);
    if (next <= 0) return profiles[0][1];
    const [a, ar] = profiles[next - 1],
      [b, br] = profiles[next];
    const u = (t - a) / (b - a),
      smooth = u * u * (3 - 2 * u);
    return ar + (br - ar) * smooth;
  };
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= sides; s++) {
      const i = r * (sides + 1) + s;
      const shade = 0.82 + 0.18 * Math.cos((s / sides) * Math.PI * 2) ** 2;
      colors.set([shade, shade, shade], i * 3);
      uv.set([r / rings, s / sides], i * 2);
      if (r < rings && s < sides)
        indices.push(i, i + 1, i + sides + 1, i + 1, i + sides + 2, i + sides + 1);
    }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  const pos = geometry.getAttribute('position'),
    normal = geometry.getAttribute('normal');
  let previousPose: number[] | undefined;
  function pose(
    hipX: number,
    hipY: number,
    kneeX: number,
    kneeY: number,
    footX: number,
    footY: number,
    z: number
  ) {
    const currentPose = [hipX, hipY, kneeX, kneeY, footX, footY, z];
    if (previousPose && currentPose.every((value, i) => value === previousPose![i])) return;
    previousPose = currentPose;
    // Quadratic fillet around the knee: the outer surface bends without detached cylinders.
    const ax = hipX,
      ay = hipY + 0.34;
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      let x: number, y: number, dx: number, dy: number;
      if (t < 0.4) {
        const u = t / 0.5;
        x = ax + (kneeX - ax) * u;
        y = ay + (kneeY - ay) * u;
        dx = kneeX - ax;
        dy = kneeY - ay;
      } else if (t > 0.6) {
        const u = (t - 0.5) / 0.5;
        x = kneeX + (footX - kneeX) * u;
        y = kneeY + (footY - kneeY) * u;
        dx = footX - kneeX;
        dy = footY - kneeY;
      } else {
        const u = (t - 0.4) / 0.2,
          v = 1 - u;
        const bx = ax + (kneeX - ax) * 0.8,
          by = ay + (kneeY - ay) * 0.8;
        const cx = kneeX + (footX - kneeX) * 0.2,
          cy = kneeY + (footY - kneeY) * 0.2;
        x = v * v * bx + 2 * v * u * kneeX + u * u * cx;
        y = v * v * by + 2 * v * u * kneeY + u * u * cy;
        dx = v * (kneeX - bx) + u * (cx - kneeX);
        dy = v * (kneeY - by) + u * (cy - kneeY);
      }
      const length = Math.hypot(dx, dy) || 1,
        nx = -dy / length,
        ny = dx / length,
        radius = radiusAt(t);
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2,
          c = Math.cos(a),
          sn = Math.sin(a),
          i = r * (sides + 1) + s;
        pos.setXYZ(i, x + nx * c * radius, y + ny * c * radius, z + sn * radius * 0.83);
        normal.setXYZ(i, nx * c, ny * c, sn);
      }
    }
    pos.needsUpdate = normal.needsUpdate = true;
  }
  return { geometry, pose };
}
