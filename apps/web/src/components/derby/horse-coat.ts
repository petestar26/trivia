import * as THREE from 'three';
import type { CoatSpec } from './runner-identity';

export type CoatQuality = 'high' | 'balanced' | 'low';

// The CC0 horse is palette-mapped: its UVs index an 8x8 colour grid. These cells
// identify anatomical regions (measured from the shipped mesh, see docs).
const CELLS = {
  coat: '1.0,7.0',
  legs: '0.0,7.0',
  hoof: '3.0,6.0',
  muzzle: '3.0,7.0',
  mane: '6.0,0.0',
  eye: '0.0,2.0',
};

/**
 * Original coat shading for the CC0 horse. Regions come from the palette cell; the
 * coat itself (black points, white socks, face markings, dapples and a fine
 * coat-direction sheen) is computed from the bind-pose position, so it follows the
 * skin exactly while galloping. No textures beyond the shipped palette are added.
 */
export function createCoatMaterial(
  source: THREE.MeshStandardMaterial,
  coat: CoatSpec,
  quality: CoatQuality = 'high'
) {
  const material = new THREE.MeshPhysicalMaterial({
    map: source.map,
    color: '#ffffff',
    roughness: 0.56,
    metalness: 0,
    // A short groomed coat: a soft clearcoat lobe reads as sheen on muscle under sun.
    clearcoat: quality === 'high' ? 0.14 : 0,
    clearcoatRoughness: 0.42,
    vertexColors: false,
  });
  const uniforms = {
    coatBase: { value: new THREE.Color(coat.base) },
    coatPoints: { value: new THREE.Color(coat.points) },
    coatMane: { value: new THREE.Color(coat.mane) },
    coatHoof: { value: new THREE.Color(coat.hoof) },
    coatSocks: { value: new THREE.Vector4(...coat.socks) },
    coatFace: { value: coat.face },
    coatDapple: { value: coat.dapple },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRest;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vRest;
        uniform vec3 coatBase, coatPoints, coatMane, coatHoof;
        uniform vec4 coatSocks;
        uniform float coatFace, coatDapple;
        float coatHash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float coatNoise(vec3 x) {
          vec3 i = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(coatHash(i), coatHash(i + vec3(1, 0, 0)), f.x),
                mix(coatHash(i + vec3(0, 1, 0)), coatHash(i + vec3(1, 1, 0)), f.x), f.y),
            mix(mix(coatHash(i + vec3(0, 0, 1)), coatHash(i + vec3(1, 0, 1)), f.x),
                mix(coatHash(i + vec3(0, 1, 1)), coatHash(i + vec3(1, 1, 1)), f.x), f.y),
            f.z);
        }
        bool coatCell(vec2 cell, vec2 target) { return all(lessThan(abs(cell - target), vec2(0.5))); }
        `
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec2 cell = floor(vMapUv * 8.0);
        bool isCoat = coatCell(cell, vec2(${CELLS.coat})) || coatCell(cell, vec2(${CELLS.legs}));
        bool isHoof = coatCell(cell, vec2(${CELLS.hoof}));
        bool isMane = coatCell(cell, vec2(${CELLS.mane}));
        bool isMuzzle = coatCell(cell, vec2(${CELLS.muzzle}));
        bool isEye = coatCell(cell, vec2(${CELLS.eye}));
        bool front = vRest.z > -0.1;
        bool left = vRest.x > 0.0;
        float sockHeight = front ? (left ? coatSocks.x : coatSocks.y) : (left ? coatSocks.z : coatSocks.w);
        float edge = 0.018 * sin(vRest.x * 90.0 + vRest.z * 70.0);
        float sock = sockHeight > 0.0 ? 1.0 - smoothstep(sockHeight - 0.015, sockHeight + 0.015, vRest.y + edge) : 0.0;
        vec3 shade = coatBase;
        // Low-frequency unevenness and a slightly darker topline, as on a real coat.
        float n = coatNoise(vRest * vec3(5.0, 7.0, 3.0));
        shade *= 0.9 + 0.16 * n;
        shade *= mix(1.0, 0.86, smoothstep(1.25, 1.6, vRest.y) * (1.0 - coatDapple));
        // Dapples: lighter centres ringed by the base coat on the barrel and quarters.
        float dap = coatNoise(vRest * 13.0) * 0.6 + coatNoise(vRest * 27.0) * 0.4;
        float barrel = smoothstep(0.9, 1.1, vRest.y);
        shade = mix(shade, shade * (0.78 + 0.42 * smoothstep(0.45, 0.7, dap)), coatDapple * barrel);
        // Points below the knee and hock, blended rather than cut.
        float pointsTop = front ? 0.52 : 0.6;
        float points = 1.0 - smoothstep(pointsTop - 0.1, pointsTop + 0.12, vRest.y);
        // Greys darken towards the legs and muzzle more softly.
        shade = mix(shade, coatPoints, points * (isCoat ? 1.0 : 0.0));
        shade = mix(shade, vec3(0.86, 0.84, 0.8), sock);
        // Face markings on the front of the head only.
        float faceFront = vRest.z - (1.46 - (vRest.y - 1.45) * 0.42);
        float onFace = step(1.0, vRest.z) * step(-0.07, faceFront) * step(1.38, vRest.y);
        float star = 1.0 - smoothstep(0.8, 1.15, length(vec2(vRest.x / 0.05, (vRest.y - 1.84) / 0.045)));
        float blaze = (1.0 - smoothstep(0.03 + 0.03 * (1.9 - vRest.y), 0.05 + 0.03 * (1.9 - vRest.y), abs(vRest.x))) * step(1.42, vRest.y) * step(vRest.y, 1.93);
        float stripe = (1.0 - smoothstep(0.012, 0.022, abs(vRest.x))) * step(1.5, vRest.y) * step(vRest.y, 1.88);
        float snip = 1.0 - smoothstep(0.7, 1.1, length(vec2(vRest.x / 0.04, (vRest.y - 1.45) / 0.03)));
        float marking = coatFace < 0.5 ? 0.0 : coatFace < 1.5 ? star : coatFace < 2.5 ? blaze : max(stripe, snip);
        shade = mix(shade, vec3(0.88, 0.86, 0.82), marking * onFace);
        vec3 maneShade = coatMane * (0.82 + 0.3 * coatNoise(vec3(vRest.x * 60.0, vRest.y * 6.0, vRest.z * 3.0)));
        vec3 hoofShade = sockHeight > 0.0 ? vec3(0.42, 0.37, 0.3) : coatHoof;
        vec3 muzzleShade = mix(vec3(0.16, 0.14, 0.13), vec3(0.42, 0.33, 0.31), marking);
        diffuseColor.rgb = isCoat ? shade
          : isHoof ? hoofShade
          : isMane ? maneShade
          : isMuzzle ? muzzleShade
          : isEye ? vec3(0.02, 0.018, 0.016)
          : diffuseColor.rgb * 0.5;
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = isEye ? 0.12 : isHoof ? 0.38 : isMane ? 0.66 : isMuzzle ? 0.5 : roughnessFactor;
        `
      );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
      #ifdef USE_CLEARCOAT
        material.clearcoat *= isCoat ? 1.0 : 0.0;
      #endif`
    );
  };
  material.customProgramCacheKey = () => `derby-coat-v2-${quality}`;
  return material;
}
