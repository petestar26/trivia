import * as THREE from 'three';

/**
 * Original saddle cloth, racing saddle and girth for the CC0 horse.
 *
 * Each piece is generated once per asset set as a surface that conforms to the actual
 * bind-pose barrel (ray-cast outwards from the spine axis against the shipped mesh)
 * and is skinned to the horse's own skeleton with the interpolated weights of the
 * skin triangle beneath each vertex. The tack therefore bends with the back exactly as the skin does: no rigid
 * pucks, no gaps and no per-frame CPU fitting. Geometry is shared by every runner.
 */
export type TackKit = {
  cloth: THREE.BufferGeometry;
  saddle: THREE.BufferGeometry;
  girth: THREE.BufferGeometry;
  /** Bind-pose points (mesh space) where the stirrup leathers hang from the saddle. */
  leatherAnchors: [THREE.Vector3, THREE.Vector3];
  dispose: () => void;
};

/**
 * A tack surface laid over the bind-pose barrel. Each vertex is found by casting a
 * ray outwards from the spine axis to the actual skin triangles; it takes that
 * triangle's interpolated joints/weights, so it deforms exactly like the skin below.
 */
function surface(
  probe: THREE.Mesh,
  skin: { index: THREE.BufferAttribute; weight: THREE.BufferAttribute },
  {
    from,
    to,
    angle,
    rows,
    columns,
    offset,
  }: {
    from: number;
    to: number;
    angle: number;
    rows: number;
    columns: number;
    /** Distance above the skin for (u across, v along) in [0, 1]. */
    offset: (u: number, v: number) => number;
  }
) {
  const raycaster = new THREE.Raycaster();
  const first = (origin: THREE.Vector3, direction: THREE.Vector3) => {
    raycaster.set(origin, direction);
    raycaster.far = 1.2;
    return raycaster.intersectObject(probe, false)[0];
  };
  const up = new THREE.Vector3(0, 1, 0),
    down = new THREE.Vector3(0, -1, 0);
  const positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = [],
    joints: number[] = [],
    weights: number[] = [];
  const blend = new Map<number, number>();
  for (let r = 0; r <= rows; r++) {
    const z = from + ((to - from) * r) / rows;
    // Barrel centre: halfway between the back and the belly on this cross-section.
    const top = first(new THREE.Vector3(0, 1.15, z), up)?.point.y ?? 1.5;
    const bottom = first(new THREE.Vector3(0, 1.15, z), down)?.point.y ?? 0.88;
    const origin = new THREE.Vector3(0, (top + bottom) / 2, z);
    for (let c = 0; c <= columns; c++) {
      const u = c / columns,
        v = r / rows;
      const theta = -angle + 2 * angle * u;
      const direction = new THREE.Vector3(Math.sin(theta), Math.cos(theta), 0);
      const hit = first(origin, direction);
      const distance = (hit?.distance ?? 0.25) + offset(u, v);
      const point = origin.clone().addScaledVector(direction, distance);
      positions.push(point.x, point.y, point.z);
      uvs.push(u, v);
      blend.clear();
      if (hit?.face && hit.barycoord) {
        const corners = [hit.face.a, hit.face.b, hit.face.c],
          bary = [hit.barycoord.x, hit.barycoord.y, hit.barycoord.z];
        corners.forEach((vertex, k) => {
          for (let j = 0; j < 4; j++) {
            const joint = skin.index.getComponent(vertex, j),
              weight = skin.weight.getComponent(vertex, j) * bary[k];
            if (weight > 0) blend.set(joint, (blend.get(joint) ?? 0) + weight);
          }
        });
      }
      const strongest = [...blend].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const total = strongest.reduce((sum, [, w]) => sum + w, 0) || 1;
      for (let j = 0; j < 4; j++) {
        joints.push(strongest[j]?.[0] ?? 0);
        weights.push((strongest[j]?.[1] ?? (j === 0 && !strongest.length ? 1 : 0)) / total);
      }
      if (r < rows && c < columns) {
        const a = r * (columns + 1) + c;
        indices.push(a, a + columns + 1, a + 1, a + 1, a + columns + 1, a + columns + 2);
      }
    }
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  result.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4));
  result.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  result.setIndex(indices);
  result.computeVertexNormals();
  return result;
}

export function createTackKit(body: THREE.SkinnedMesh): TackKit {
  const probeMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const probe = new THREE.Mesh(body.geometry, probeMaterial);
  const skin = {
    index: body.geometry.getAttribute('skinIndex') as THREE.BufferAttribute,
    weight: body.geometry.getAttribute('skinWeight') as THREE.BufferAttribute,
  };
  // Saddle cloth: from behind the withers back over the loins, two thirds down the barrel.
  const cloth = surface(probe, skin, {
    from: -0.3,
    to: 0.34,
    angle: THREE.MathUtils.degToRad(100),
    rows: 12,
    columns: 32,
    offset: () => 0.008,
  });
  // A low racing saddle: thin pommel at the front, raised cantle at the back.
  const saddleColumns = 16,
    saddleRows = 10;
  const saddle = surface(probe, skin, {
    from: -0.16,
    to: 0.16,
    angle: THREE.MathUtils.degToRad(46),
    rows: saddleRows,
    columns: saddleColumns,
    offset: (u, v) => {
      const across = Math.sin(Math.PI * u),
        along = Math.sin(Math.PI * v);
      const cantle = Math.exp(-(((v - 0.14) / 0.12) ** 2)) * 0.028;
      const pommel = Math.exp(-(((v - 0.88) / 0.1) ** 2)) * 0.02;
      return 0.012 + (0.024 * along + cantle + pommel) * across ** 0.7;
    },
  });
  // Girth: a full band round the barrel just behind the elbow.
  const girth = surface(probe, skin, {
    from: 0.27,
    to: 0.31,
    angle: Math.PI,
    rows: 2,
    columns: 40,
    offset: () => 0.012,
  });
  probeMaterial.dispose();
  // Leathers hang from the saddle bars, just below its edge on each side.
  const anchor = (side: 1 | -1) => {
    const positions = saddle.getAttribute('position');
    // Column 0 is the right side (−X), the last column the left (+X); middle row.
    const i = Math.round(saddleRows * 0.55) * (saddleColumns + 1) + (side > 0 ? saddleColumns : 0);
    return new THREE.Vector3(positions.getX(i), positions.getY(i) - 0.01, positions.getZ(i));
  };
  return {
    cloth,
    saddle,
    girth,
    leatherAnchors: [anchor(1), anchor(-1)],
    dispose() {
      cloth.dispose();
      saddle.dispose();
      girth.dispose();
    },
  };
}

/** The runner's numbered saddle cloth: a number on each side, upright from the rail. */
export function createClothTexture(number: number, cloth: string, ink: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = cloth;
    ctx.fillRect(0, 0, 512, 256);
    // White piping around the cloth edge and along the spine.
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(0, 0, 10, 256);
    ctx.fillRect(502, 0, 10, 256);
    ctx.fillRect(0, 0, 512, 7);
    ctx.fillRect(0, 249, 512, 7);
    ctx.font = '900 118px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ink;
    ctx.lineWidth = 8;
    ctx.strokeStyle = ink === '#101418' ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)';
    // Texture u runs across the back (canvas X), v along the horse (canvas Y), with
    // flipY off. Right side (−X, u < .5): text up = +u, reading = +v.
    // Each number sits on the lower side panel, behind the rider's boot and below the
    // saddle flap (θ ≈ ±72° round the barrel; v ≈ .33 from the back).
    for (const [x, rotation] of [
      [72, Math.PI / 2],
      [440, -Math.PI / 2],
    ] as const) {
      ctx.save();
      ctx.translate(x, 86);
      ctx.rotate(rotation);
      ctx.strokeText(String(number), 0, 6);
      ctx.fillText(String(number), 0, 6);
      ctx.restore();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
