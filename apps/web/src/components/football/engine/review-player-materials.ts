import * as THREE from 'three';
import study from './review-material-study.json';

export { study as reviewMaterialStudy };

/** Reuse the pool-owned fabric maps on the review kit. Materials borrow these
 * samplers; neither this helper nor material disposal owns their textures.
 * Construction-only: no geometry, UV, texture transform or per-frame work. */
export function borrowReviewFabric(
  target: THREE.MeshStandardMaterial,
  source: THREE.MeshStandardMaterial
) {
  target.normalMap = source.normalMap;
  target.roughnessMap = source.roughnessMap;
  target.normalScale.set(0.08, 0.08);
  target.roughness = 0.98;
}

/** An actor-owned material borrows the pool's existing textures. Source shirt
 * UVs drive its CC0 rib/hem bump; the fictional kit atlas is projected separately. */
export function reviewShirtMaterial(base: THREE.MeshStandardMaterial, bump?: THREE.Texture) {
  return new THREE.MeshPhysicalMaterial({
    color: base.map ? '#ffffff' : base.color,
    map: base.map,
    roughness: study.shirt.roughness,
    roughnessMap: base.roughnessMap,
    normalMap: bump ? null : base.normalMap,
    normalScale: new THREE.Vector2(study.shirt.normalScale, study.shirt.normalScale),
    bumpMap: bump ?? null,
    bumpScale: study.shirt.bumpScaleMetres,
    sheen: study.shirt.sheen,
    sheenColor: new THREE.Color('#b9b5ac'),
    sheenRoughness: study.shirt.sheenRoughness,
    metalness: 0,
    side: THREE.DoubleSide,
  });
}

/** Calibrates only this actor's owned materials. No boot geometry, fit, cache or
 * contact data is changed. Bind-height/color distinguish rubber and woven lace. */
export function reviewKitMaterials(
  materials: {
    shorts: THREE.MeshStandardMaterial;
    socks: THREE.MeshStandardMaterial;
    boots: THREE.MeshStandardMaterial;
  },
  fabric: THREE.MeshStandardMaterial,
  bootGeometry: THREE.BufferGeometry
) {
  borrowReviewFabric(materials.shorts, fabric);
  borrowReviewFabric(materials.socks, fabric);
  const boots = materials.boots;
  boots.roughness = study.boots.upperRoughness;
  const positions = bootGeometry.getAttribute('position'),
    colors = bootGeometry.getAttribute('color');
  const response = new Float32Array(positions.count);
  for (let i = 0; i < positions.count; i++) {
    const rubber =
      1 -
      THREE.MathUtils.smoothstep(
        positions.getY(i),
        study.boots.soleTopBindMetres - 0.003,
        study.boots.soleTopBindMetres + 0.003
      );
    const lace = THREE.MathUtils.smoothstep(
      Math.max(colors.getX(i), colors.getY(i), colors.getZ(i)),
      0.1,
      0.16
    );
    response[i] = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(study.boots.upperRoughness, study.boots.soleRoughness, rubber),
      study.boots.laceRoughness,
      lace
    );
  }
  // Immutable semantic attribute, captured before dynamic boot flex. Posed
  // position.y cannot identify rubber because a toe may already be bent.
  bootGeometry.setAttribute('reviewBootRoughness', new THREE.Float32BufferAttribute(response, 1));
  boots.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float reviewBootRoughness; varying float vReviewBootRoughness;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvReviewBootRoughness=reviewBootRoughness;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vReviewBootRoughness;')
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n' + 'roughnessFactor=vReviewBootRoughness;'
      );
  };
  boots.customProgramCacheKey = () => 'playqube-review-boot-material-v1';
}
