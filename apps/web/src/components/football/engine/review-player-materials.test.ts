import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  borrowReviewFabric,
  reviewKitMaterials,
  reviewMaterialStudy as study,
  reviewShirtMaterial,
} from './review-player-materials';
import { reviewSkinMaterial, type ReviewPlayerAssets } from './review-player';
import { createContinuousKit } from './continuous-kit';
import { kitFromClub, type Look } from './rig';

describe('one review player material ownership and surface response', () => {
  it('borrows the shared cloth samplers without mutating or disposing their source', () => {
    const normal = new THREE.Texture(),
      roughness = new THREE.Texture(),
      source = new THREE.MeshStandardMaterial({
        normalMap: normal,
        roughnessMap: roughness,
        normalScale: new THREE.Vector2(0.1, 0.1),
        roughness: 0.96,
      }),
      shorts = new THREE.MeshStandardMaterial(),
      socks = new THREE.MeshStandardMaterial(),
      normalDispose = vi.spyOn(normal, 'dispose'),
      roughnessDispose = vi.spyOn(roughness, 'dispose');
    const transform = normal.matrix.clone(),
      repeat = normal.repeat.clone();
    for (const target of [shorts, socks]) {
      const version = target.version;
      borrowReviewFabric(target, source);
      borrowReviewFabric(target, source);
      expect(target.normalMap).toBe(normal);
      expect(target.roughnessMap).toBe(roughness);
      expect(target.normalScale).not.toBe(source.normalScale);
      expect(target.version).toBe(version);
      target.dispose();
    }
    expect(source.normalScale.toArray()).toEqual([0.1, 0.1]);
    expect(source.roughness).toBe(0.96);
    expect(normal.matrix.equals(transform)).toBe(true);
    expect(normal.repeat.equals(repeat)).toBe(true);
    expect(normalDispose).not.toHaveBeenCalled();
    expect(roughnessDispose).not.toHaveBeenCalled();
    source.dispose();
    normal.dispose();
    roughness.dispose();
  });

  it('keeps shared skin pigmentation and bounded part-specific shader ownership', () => {
    const skin = new THREE.Texture(),
      normal = new THREE.CanvasTexture(document.createElement('canvas')),
      roughness = new THREE.CanvasTexture(document.createElement('canvas')),
      environment = new THREE.Texture();
    const assets = { skin, environment } as ReviewPlayerAssets,
      maps = { normal, roughness, dispose: () => {} },
      face = reviewSkinMaterial(assets, maps),
      body = reviewSkinMaterial(assets, maps);
    const disposers = [skin, normal, roughness, environment].map((t) => vi.spyOn(t, 'dispose'));
    for (const material of [face, body]) {
      expect(material.normalMap).toBe(normal);
      expect(material.roughnessMap).toBe(roughness);
      expect(material.envMap).toBe(environment);
      expect(material.metalness).toBe(0);
      const shader = {
        uniforms: {},
        vertexShader: '#include <common>\n#include <begin_vertex>',
        fragmentShader:
          '#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <lights_physical_fragment>',
      };
      material.onBeforeCompile(
        shader as unknown as Parameters<typeof material.onBeforeCompile>[0],
        {} as THREE.WebGLRenderer
      );
      expect((shader.uniforms as Record<string, { value: unknown }>).reviewSkin.value).toBe(skin);
      expect(
        (
          shader.uniforms as Record<string, { value: THREE.Vector4 }>
        ).reviewSkinResponse.value.toArray()
      ).toEqual([0.59, 0.71, 0.48, 0.48]);
      expect(material.specularIntensity).toBe(0.32);
      expect(material.envMapIntensity).toBe(0.32);
      expect(shader.fragmentShader).toContain('texture2D(reviewSkin,vReviewUv)');
      expect(shader.fragmentShader).toContain(
        'clamp(roughnessFactor/reviewSkinGrainScale,0.0,1.0)'
      );
      // Eyes and lips retain separate response; the body remains the same skin
      // branch rather than acquiring a separate collar/hand shader.
      expect(shader.fragmentShader).toContain('(vPart>2.5 && vPart<5.5)?reviewEyeRoughness');
      expect(shader.fragmentShader).toContain(
        'vPart>0.5 && vPart<1.5?mix(reviewSkinResponse.z,reviewSkinResponse.w,reviewPore)'
      );
      expect(shader.fragmentShader).toContain(
        'material.clearcoat=(vPart>2.5 && vPart<5.5)?0.85:reviewDryClearcoat'
      );
      material.dispose();
    }
    expect(disposers.every((dispose) => dispose.mock.calls.length === 0)).toBe(true);
    for (const texture of [skin, normal, roughness, environment]) texture.dispose();
  });

  it('retains three kit material slots and no boot image samplers', () => {
    const look = {
      skin: '#b97c57',
      kit: kitFromClub({ primary: '#7a253d', secondary: '#eee9e2', pattern: 'solid' }),
    } as Look;
    const kit = createContinuousKit(look),
      boot = kit.materials.boots,
      dispose = vi.spyOn(boot, 'dispose');
    expect(Object.keys(kit.materials)).toEqual(['shorts', 'socks', 'boots']);
    expect(boot).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(boot.vertexColors).toBe(true);
    expect(boot.metalness).toBe(0);
    expect(boot.map).toBeNull();
    expect(boot.normalMap).toBeNull();
    expect(boot.roughnessMap).toBeNull();
    expect(boot.clearcoatMap).toBeNull();
    kit.dispose();
    kit.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('one review actor material response', () => {
  it('keeps linear roughness modulation through semantic skin, lip and eye response', () => {
    const normal = new THREE.CanvasTexture(document.createElement('canvas')),
      roughness = new THREE.CanvasTexture(document.createElement('canvas'));
    const skin = new THREE.Texture(),
      environment = new THREE.Texture();
    const material = reviewSkinMaterial({ skin, environment } as ReviewPlayerAssets, {
      normal,
      roughness,
      dispose() {},
    });
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as Parameters<THREE.Material['onBeforeCompile']>[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(material.roughnessMap).toBe(roughness);
    expect(roughness.colorSpace).toBe(THREE.NoColorSpace);
    expect(shader.fragmentShader).toContain('#include <roughnessmap_fragment>');
    expect(shader.fragmentShader).toContain('roughnessFactor/reviewSkinGrainScale');
    expect(shader.uniforms.reviewSkinResponse.value.toArray()).toEqual([
      study.skin.roughnessMin,
      study.skin.roughnessMax,
      study.skin.lipMin,
      study.skin.lipMax,
    ]);
    expect(shader.uniforms.reviewEyeRoughness.value).toBeLessThan(study.skin.lipMin);
    expect(study.skin.lipMax).toBeLessThan(study.skin.roughnessMin);
    material.dispose();
    [normal, roughness, skin, environment].forEach((t) => t.dispose());
  });

  it('borrows artist bump on source garment UVs without mutating or owning shared maps', () => {
    const map = new THREE.Texture(),
      bump = new THREE.Texture(),
      normal = new THREE.Texture(),
      roughness = new THREE.Texture();
    const base = new THREE.MeshStandardMaterial({
      map,
      normalMap: normal,
      roughnessMap: roughness,
    });
    const disposed = [map, bump, normal, roughness].map((t) => vi.spyOn(t, 'dispose'));
    const material = reviewShirtMaterial(base, bump);
    expect(material.map).toBe(map);
    expect(material.bumpMap).toBe(bump);
    expect(material.normalMap).toBeNull(); // Three chooses normal over bump if both are set.
    expect(material.bumpScale).toBeLessThan(0.001);
    expect(material.sheen).toBe(study.shirt.sheen);
    expect(base.normalMap).toBe(normal);
    material.dispose();
    disposed.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    base.dispose();
    [map, bump, normal, roughness].forEach((t) => t.dispose());
  });

  it('keeps footwear zones in a material shader and leaves the shared fabric untouched', () => {
    const fabric = new THREE.MeshStandardMaterial({
      normalMap: new THREE.Texture(),
      roughnessMap: new THREE.Texture(),
    });
    const materials = {
      shorts: new THREE.MeshStandardMaterial(),
      socks: new THREE.MeshStandardMaterial(),
      boots: new THREE.MeshStandardMaterial({ vertexColors: true }),
    };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0.01, 0, 0, 0.07, 0, 0, 0.1, 0], 3)
    );
    geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0.2, 0.2, 0.2], 3)
    );
    const old = fabric.clone();
    const originalPositions = geometry.getAttribute('position').array.slice();
    reviewKitMaterials(materials, fabric, geometry);
    expect(fabric.normalScale).toEqual(old.normalScale);
    expect(fabric.roughness).toBe(old.roughness);
    expect(materials.shorts.normalMap).toBe(fabric.normalMap);
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as Parameters<THREE.Material['onBeforeCompile']>[0];
    materials.boots.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('vReviewBootRoughness=reviewBootRoughness');
    expect(shader.vertexShader).not.toContain('transformed=');
    const zones = geometry.getAttribute('reviewBootRoughness');
    expect(zones.getX(0)).toBeCloseTo(study.boots.soleRoughness);
    expect(zones.getX(1)).toBeCloseTo(study.boots.upperRoughness);
    expect(zones.getX(2)).toBeCloseTo(study.boots.laceRoughness);
    expect(geometry.getAttribute('position').array).toEqual(originalPositions);
    (geometry.getAttribute('position') as THREE.BufferAttribute).setY(0, 0.2);
    expect(zones.getX(0)).toBeCloseTo(study.boots.soleRoughness);
    Object.values(materials).forEach((m) => m.dispose());
    fabric.normalMap!.dispose();
    fabric.roughnessMap!.dispose();
    fabric.dispose();
    old.dispose();
    geometry.dispose();
  });
});
