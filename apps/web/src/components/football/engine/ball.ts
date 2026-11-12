import * as THREE from 'three';

/**
 * Original match-ball surface: the classic 32-panel truncated icosahedron (12 dark pentagons,
 * 20 white hexagons) with stitched seams, generated texel by texel on the sphere's own
 * equirectangular UVs, so panels keep their true shape instead of distorting toward the poles.
 * Pure geometry, no external image.
 */
const PHI = (1 + Math.sqrt(5)) / 2;
/** Angular inradius of each spherical face (pentagon and hexagon) of a truncated icosahedron. */
const PENTAGON_INRADIUS = 0.2814;
const HEXAGON_INRADIUS = 0.357;
const SEAM = 0.013;

function icosahedronCentres() {
  const vertices: THREE.Vector3[] = [];
  for (const a of [-1, 1])
    for (const b of [-1, 1]) {
      vertices.push(new THREE.Vector3(0, a, b * PHI).normalize());
      vertices.push(new THREE.Vector3(a, b * PHI, 0).normalize());
      vertices.push(new THREE.Vector3(b * PHI, 0, a).normalize());
    }
  // Face centres of the icosahedron: every triple of mutually adjacent vertices.
  const edge = Math.min(...vertices.slice(1).map((v) => v.distanceTo(vertices[0])));
  const near = (a: THREE.Vector3, b: THREE.Vector3) => Math.abs(a.distanceTo(b) - edge) < 1e-4;
  const faces: THREE.Vector3[] = [];
  for (let i = 0; i < 12; i++)
    for (let j = i + 1; j < 12; j++)
      for (let k = j + 1; k < 12; k++)
        if (
          near(vertices[i], vertices[j]) &&
          near(vertices[j], vertices[k]) &&
          near(vertices[i], vertices[k])
        )
          faces.push(vertices[i].clone().add(vertices[j]).add(vertices[k]).normalize());
  return { pentagons: vertices, hexagons: faces };
}

export function ballPanelData(width = 256, height = 128) {
  const { pentagons, hexagons } = icosahedronCentres();
  const data = new Uint8Array(width * height * 4);
  const dir = new THREE.Vector3();
  const dark = [22, 24, 30];
  const light = [242, 242, 236];
  const seam = [120, 122, 128];
  for (let ty = 0; ty < height; ty++) {
    // SphereGeometry: texture v = 1 - theta / PI, u = phi / 2PI.
    const theta = (1 - (ty + 0.5) / height) * Math.PI;
    for (let tx = 0; tx < width; tx++) {
      const phi = ((tx + 0.5) / width) * Math.PI * 2;
      dir.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
      let best = Infinity;
      let second = Infinity;
      let bestDark = false;
      for (const [centres, inradius, isDark] of [
        [pentagons, PENTAGON_INRADIUS, true],
        [hexagons, HEXAGON_INRADIUS, false],
      ] as const)
        for (const c of centres) {
          // Power-diagram distance: a face boundary is where both sides reach their inradius.
          const score = Math.acos(Math.min(1, Math.max(-1, dir.dot(c)))) - inradius;
          if (score < best) {
            second = best;
            best = score;
            bestDark = isDark;
          } else if (score < second) second = score;
        }
      const colour = second - best < SEAM ? seam : bestDark ? dark : light;
      const i = (ty * width + tx) * 4;
      data[i] = colour[0];
      data[i + 1] = colour[1];
      data[i + 2] = colour[2];
      data[i + 3] = 255;
    }
  }
  return data;
}

export function ballTexture(): THREE.DataTexture {
  const width = 256;
  const height = 128;
  const texture = new THREE.DataTexture(ballPanelData(width, height), width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}
