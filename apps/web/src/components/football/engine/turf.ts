import * as THREE from 'three';
import { PITCH } from './director';

/**
 * Original procedural match turf. Instead of one large painted canvas (about 16 MB of GPU
 * memory once mipmapped), the pitch combines:
 *  - a small tiling grass-detail canvas (256²) sampled at two scales to avoid visible repeats;
 *  - analytic, derivative-antialiased markings computed per pixel in world metres, so lines
 *    stay crisp and continuous from the near touchline to the far one at any resolution;
 *  - mowing bands parallel to the goal lines whose contrast depends on the viewing direction,
 *    as bent grass blades do under floodlights;
 *  - restrained goalmouth and centre wear.
 * Markings follow the same PITCH dimensions the director and goals use.
 */
export const TURF = Object.freeze({
  /** Mown band width in metres (bands run parallel to the goal lines). */
  stripe: 5.5,
  /** Painted line width in metres (Laws of the Game: no wider than 12 cm). */
  lineWidth: 0.12,
  /** Grass detail repeat, metres per tile. */
  detailTile: 3.4,
  /** Turf beyond the touch/goal lines up to the perimeter. */
  marginLength: 8,
  marginWidth: 6,
});

/** Distances used by the analytic markings (exported so tests can check the layout). */
export const MARKINGS = Object.freeze({
  centreCircle: 9.15,
  penaltyDepth: PITCH.boxDepth,
  penaltyHalfWidth: PITCH.boxHalfWidth,
  goalAreaDepth: 5.5,
  goalAreaHalfWidth: 9.16,
  penaltySpot: 11,
  cornerArc: 1,
  spotRadius: 0.15,
});

/**
 * Fine, low-contrast blade texture. It deliberately has no large features: anything bigger than a
 * few blades would show as a repeating pattern across the pitch. Broad variation comes from the
 * separate, non-repeating macro map below.
 */
function grassDetailTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3f8f3c';
  ctx.fillRect(0, 0, size, size);
  let seed = 9173;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // Short blades in a narrow tonal range; every stroke wraps so the tile has no seam.
  const tones = ['#3a8838', '#44933f', '#3d8b3a', '#4a9843', '#378334', '#479541'];
  for (let i = 0; i < 7000; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 2 + rand() * 3;
    const lean = (rand() - 0.5) * 1.2;
    ctx.strokeStyle = tones[Math.floor(rand() * tones.length)];
    ctx.globalAlpha = 0.24 + rand() * 0.3;
    ctx.lineWidth = 0.8 + rand() * 0.5;
    for (const ox of [-size, 0, size])
      for (const oy of [-size, 0, size]) {
        if (x + ox < -6 || x + ox > size + 6 || y + oy < -6 || y + oy > size + 6) continue;
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox + lean, y + oy - len);
        ctx.stroke();
      }
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * One smooth, non-repeating variation map stretched over the whole playing surface: gentle
 * patches of lusher and drier grass several metres across. Value noise with two octaves.
 */
function grassMacroTexture(): THREE.DataTexture {
  const n = 64;
  let seed = 51031;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const lattice = (cells: number) => {
    const g = Array.from({ length: (cells + 1) * (cells + 1) }, rand);
    return (u: number, v: number) => {
      const x = u * cells;
      const y = v * cells;
      const i = Math.min(cells - 1, Math.floor(x));
      const j = Math.min(cells - 1, Math.floor(y));
      const fx = x - i;
      const fy = y - j;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const at = (a: number, b: number) => g[b * (cells + 1) + a];
      const top = at(i, j) + (at(i + 1, j) - at(i, j)) * sx;
      const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sx;
      return top + (bottom - top) * sy;
    };
  };
  const coarse = lattice(6);
  const fine = lattice(17);
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const v = (y + 0.5) / n;
      const value = coarse(u, v) * 0.7 + fine(u, v) * 0.3;
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(value * 255);
      data[i + 3] = 255;
    }
  const texture = new THREE.DataTexture(data, n, n);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

const VERTEX_DECL = /* glsl */ `
varying vec3 vTurfWorld;
`;
const VERTEX_BODY = /* glsl */ `
vTurfWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAGMENT_DECL = /* glsl */ `
varying vec3 vTurfWorld;
uniform vec2 uTurfHalf;
uniform float uTurfStripe;
uniform float uTurfLineHalf;
uniform vec3 uTurfLineColour;
uniform vec3 uTurfWearColour;
uniform sampler2D uTurfMacro;
uniform vec2 uTurfExtent;
float turfBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float turfHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float turfNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(turfHash(i), turfHash(i + vec2(1.0, 0.0)), u.x),
             mix(turfHash(i + vec2(0.0, 1.0)), turfHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Nearest painted line: x = distance (m) to its centre line, yz = unit normal across it.
// All markings are symmetric, so everything is evaluated in the positive quadrant.
void turfPick(inout vec3 best, float d, vec2 n) {
  if (d < best.x) best = vec3(d, n);
}
vec2 turfBoxNormal(vec2 q, vec2 b) {
  vec2 d = q - b;
  if (d.x > 0.0 || d.y > 0.0) return normalize(max(d, vec2(1e-5)));
  return d.x > d.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
}
vec2 turfRadial(vec2 q, vec2 c) {
  vec2 r = q - c;
  return length(r) > 1e-4 ? normalize(r) : vec2(1.0, 0.0);
}
vec3 turfLines(vec2 p) {
  vec2 q = abs(p);
  float hl = uTurfHalf.x;
  float hw = uTurfHalf.y;
  vec3 best = vec3(1e5, 1.0, 0.0);
  turfPick(best, abs(turfBox(q, vec2(hl, hw))), turfBoxNormal(q, vec2(hl, hw)));
  if (q.y <= hw) turfPick(best, q.x, vec2(1.0, 0.0));
  turfPick(best, abs(length(q) - ${MARKINGS.centreCircle.toFixed(2)}), turfRadial(q, vec2(0.0)));
  vec2 pc = vec2(hl - ${(MARKINGS.penaltyDepth / 2).toFixed(3)}, 0.0);
  vec2 pb = vec2(${(MARKINGS.penaltyDepth / 2).toFixed(3)}, ${MARKINGS.penaltyHalfWidth.toFixed(3)});
  vec2 pq = vec2(abs(q.x - pc.x), q.y);
  turfPick(best, abs(turfBox(q - pc, pb)), turfBoxNormal(pq, pb));
  vec2 gc = vec2(hl - ${(MARKINGS.goalAreaDepth / 2).toFixed(3)}, 0.0);
  vec2 gb = vec2(${(MARKINGS.goalAreaDepth / 2).toFixed(3)}, ${MARKINGS.goalAreaHalfWidth.toFixed(3)});
  vec2 gq = vec2(abs(q.x - gc.x), q.y);
  turfPick(best, abs(turfBox(q - gc, gb)), turfBoxNormal(gq, gb));
  vec2 spot = vec2(hl - ${MARKINGS.penaltySpot.toFixed(2)}, 0.0);
  if (q.x < hl - ${MARKINGS.penaltyDepth.toFixed(3)})
    turfPick(best, abs(length(q - spot) - ${MARKINGS.centreCircle.toFixed(2)}), turfRadial(q, spot));
  if (q.x <= hl && q.y <= hw)
    turfPick(best, abs(length(q - vec2(hl, hw)) - ${MARKINGS.cornerArc.toFixed(2)}), turfRadial(q, vec2(hl, hw)));
  return best;
}
float turfSpots(vec2 p) {
  vec2 q = abs(p);
  return min(length(q), length(q - vec2(uTurfHalf.x - ${MARKINGS.penaltySpot.toFixed(2)}, 0.0))) - ${MARKINGS.spotRadius.toFixed(2)};
}
`;

const FRAGMENT_BODY = /* glsl */ `
{
  vec2 p = vTurfWorld.xz;
  // Second, much larger sample of the same detail tile breaks up visible repetition.
  // Broad, non-repeating patches of lusher and drier grass (one lookup in a 64x64 map).
  float macro = texture2D(uTurfMacro, p / uTurfExtent + 0.5).r;
  diffuseColor.rgb *= 0.91 + 0.18 * macro;
  // Real floodlit turf is less saturated than raw grass albedo; keep about three quarters.
  float turfLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(turfLuma * vec3(1.06, 1.0, 0.78), diffuseColor.rgb, 0.74);
  // Mowing bands parallel to the goal lines, antialiased square wave. Their contrast follows
  // the view direction: blades bent toward/away from a side camera read darker/lighter.
  float f = (p.x + uTurfHalf.x) / uTurfStripe;
  // Edges blend over about 0.4 m like real mown grass, and never sharper than a pixel.
  float band = clamp(0.5 + 0.5 * sin(3.14159265 * f) / (3.14159265 * max(fwidth(f), 0.075)), 0.0, 1.0);
  vec3 toEye = normalize(cameraPosition - vTurfWorld);
  float sheen = 0.45 + 0.55 * abs(toEye.z);
  diffuseColor.rgb *= 1.0 + (band - 0.5) * 0.2 * sheen;
  // Gentle wear: goalmouths, penalty spots and the kick-off area (noise only where worn).
  vec2 q = abs(p);
  float wear = 0.0;
  wear = max(wear, (1.0 - smoothstep(0.0, 1.0, length((q - vec2(uTurfHalf.x - 2.8, 0.0)) / vec2(3.4, 4.6)))) * 0.62);
  wear = max(wear, (1.0 - smoothstep(0.0, 1.0, length(q - vec2(uTurfHalf.x - ${MARKINGS.penaltySpot.toFixed(2)}, 0.0)) / 1.6)) * 0.45);
  wear = max(wear, (1.0 - smoothstep(0.0, 1.0, length(q) / 2.4)) * 0.3);
  if (wear > 0.001) {
    float n = turfNoise(p * 0.9) * 0.6 + turfNoise(p * 3.1) * 0.4;
    wear *= smoothstep(0.25, 0.75, n);
    diffuseColor.rgb = mix(diffuseColor.rgb, uTurfWearColour * (0.75 + 0.5 * n), wear);
  }
  // Painted markings: exact box-filtered coverage of the pixel footprint measured across the
  // nearest line (from smooth world-position derivatives, so it never collapses at the line
  // centre), with a perceptual floor that keeps a sub-pixel far touchline continuous.
  vec3 nearest = turfLines(p);
  float d = nearest.x;
  vec2 dpx = dFdx(p);
  vec2 dpy = dFdy(p);
  float a = max(length(vec2(dot(nearest.yz, dpx), dot(nearest.yz, dpy))), 1e-4);
  float line = clamp((min(d + 0.5 * a, uTurfLineHalf) - max(d - 0.5 * a, -uTurfLineHalf)) / a, 0.0, 1.0);
  line = max(line, sqrt(min(1.0, uTurfLineHalf * 2.0 / a)) * 0.62 * step(d, 0.5 * a + uTurfLineHalf));
  float s = turfSpots(p);
  float sa = max(length(vec2(length(dpx), length(dpy))) * 0.7, 1e-4);
  line = max(line, clamp(0.5 - s / sa, 0.0, 1.0));
  diffuseColor.rgb = mix(diffuseColor.rgb, uTurfLineColour, min(1.0, line * 1.2) * 0.9);
}
`;

export interface Turf {
  mesh: THREE.Mesh;
  dispose(): void;
}

export function buildTurf(options: { anisotropy?: number } = {}): Turf {
  const lengthM = PITCH.halfLength * 2 + TURF.marginLength * 2;
  const widthM = PITCH.halfWidth * 2 + TURF.marginWidth * 2;
  const detail = grassDetailTexture();
  detail.repeat.set(lengthM / TURF.detailTile, widthM / TURF.detailTile);
  detail.anisotropy = Math.max(1, Math.min(8, options.anisotropy ?? 4));
  const macro = grassMacroTexture();
  const geometry = new THREE.PlaneGeometry(lengthM, widthM);
  // Grass is a rough diffuse surface: per-pixel Lambert shading matches it and skips the
  // environment-reflection lookups, which are the costliest part of a full-screen material.
  const material = new THREE.MeshLambertMaterial({
    map: detail,
    // A faint neutral lift stands in for bounce light from the lit stands and night haze.
    emissive: '#0d110c',
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTurfHalf = { value: new THREE.Vector2(PITCH.halfLength, PITCH.halfWidth) };
    shader.uniforms.uTurfStripe = { value: TURF.stripe };
    shader.uniforms.uTurfLineHalf = { value: TURF.lineWidth / 2 };
    shader.uniforms.uTurfLineColour = { value: new THREE.Color('#e6ebe2') };
    shader.uniforms.uTurfWearColour = { value: new THREE.Color('#6d7448') };
    shader.uniforms.uTurfMacro = { value: macro };
    shader.uniforms.uTurfExtent = { value: new THREE.Vector2(lengthM, widthM) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAGMENT_BODY}`);
  };
  material.customProgramCacheKey = () => 'football-turf-v2';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.name = 'turf';
  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
      detail.dispose();
      macro.dispose();
    },
  };
}
