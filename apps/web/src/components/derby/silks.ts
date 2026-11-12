import * as THREE from 'three';
import type { SilkPattern, SilkSpec } from './runner-identity';

const PATTERNS: Record<SilkPattern, number> = {
  plain: 0,
  hoops: 1,
  sash: 2,
  crossbelts: 3,
  quartered: 4,
  chevrons: 5,
  braces: 6,
  halved: 7,
  stripes: 8,
};
const SLEEVES = { body: 0, accent: 1, hoops: 2 } as const;
const SKIN = ['#b9825d', '#7d513d', '#d0a17c', '#9a6549', '#5f3d2c', '#c48f6a'];

/**
 * Racing silks, breeches, gloves and boots for the CC0 human. Regions come from its
 * bind pose (T-pose: arms along ±X, height along +Y), so patterns follow the body
 * while the limbs are posed. Original shader code; no textures are added.
 */
export function createSilkMaterial(silk: SilkSpec, index: number) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0 });
  const uniforms = {
    silkBody: { value: new THREE.Color(silk.body) },
    silkAccent: { value: new THREE.Color(silk.accent) },
    silkPattern: { value: PATTERNS[silk.pattern] },
    silkSleeves: { value: SLEEVES[silk.sleeves] },
    silkSkin: { value: new THREE.Color(SKIN[index % SKIN.length]) },
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
        uniform vec3 silkBody, silkAccent, silkSkin;
        uniform float silkPattern, silkSleeves;
        float band(float v, float w) { return 1.0 - smoothstep(w - 0.006, w + 0.006, abs(v)); }
        `
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float ax = abs(vRest.x);
        vec3 tint;
        float rough = 0.42;
        if (vRest.y > 1.56 && ax < 0.17) { tint = silkSkin; rough = 0.62; }
        else if (ax > 0.74) { tint = vec3(0.12, 0.1, 0.09); rough = 0.55; }
        else if (vRest.y < 0.335) { tint = vec3(0.035, 0.032, 0.03); rough = 0.28; }
        else if (vRest.y < 0.4) { tint = vec3(0.47, 0.3, 0.17); rough = 0.4; }
        else if (vRest.y < 0.98) { tint = vec3(0.93, 0.91, 0.87); rough = 0.6; }
        else if (ax > 0.21) {
          float s = silkSleeves < 0.5 ? 0.0 : silkSleeves < 1.5 ? 1.0 : step(0.5, fract(ax * 9.0));
          tint = mix(silkBody, silkAccent, s);
        } else {
          float v = vRest.y - 1.27;
          float p = 0.0;
          if (silkPattern < 0.5) p = 0.0;
          else if (silkPattern < 1.5) p = step(0.5, fract((vRest.y - 0.98) * 6.0));
          else if (silkPattern < 2.5) p = band(vRest.x * 0.8 + v * 0.75, 0.055);
          else if (silkPattern < 3.5) p = max(band(vRest.x * 0.8 + v * 0.75, 0.04), band(vRest.x * 0.8 - v * 0.75, 0.04));
          else if (silkPattern < 4.5) p = (vRest.x > 0.0) == (v > 0.0) ? 1.0 : 0.0;
          else if (silkPattern < 5.5) p = step(0.5, fract((vRest.y - ax * 1.1) * 5.0));
          else if (silkPattern < 6.5) p = band(ax - 0.085, 0.022);
          else if (silkPattern < 7.5) p = vRest.x > 0.0 ? 1.0 : 0.0;
          else p = step(0.5, fract(vRest.x * 11.0 + 0.25));
          tint = mix(silkBody, silkAccent, p);
          // A collar in the accent colour finishes the neckline.
          tint = mix(tint, silkAccent, step(1.5, vRest.y) * step(ax, 0.12));
        }
        diffuseColor.rgb = tint;
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = rough;`
      );
  };
  material.customProgramCacheKey = () => 'derby-silks-v1';
  return material;
}

const CAPS = { plain: 0, quartered: 1, hooped: 2, peak: 3 } as const;
/** Skull cap cover over the helmet, in the runner's cap colours. */
export function createCapMaterial(silk: SilkSpec) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0 });
  const uniforms = {
    capColor: { value: new THREE.Color(silk.cap) },
    capAccent: { value: new THREE.Color(silk.capAccent) },
    capPattern: { value: CAPS[silk.capPattern] },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCap;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCap = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vCap;
        uniform vec3 capColor, capAccent;
        uniform float capPattern;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float p = 0.0;
        if (capPattern > 0.5 && capPattern < 1.5) p = (vCap.x > 0.0) == (vCap.z > 0.0) ? 1.0 : 0.0;
        else if (capPattern > 1.5 && capPattern < 2.5) p = step(0.5, fract(vCap.y * 22.0));
        else if (capPattern > 2.5) p = step(0.6, normalize(vCap).z);
        // A small button on the crown.
        p = max(p, 1.0 - smoothstep(0.012, 0.02, length(vCap.xz)) * step(0.125, vCap.y));
        diffuseColor.rgb = mix(capColor, capAccent, p);`
      );
  };
  material.customProgramCacheKey = () => 'derby-cap-v1';
  return material;
}
