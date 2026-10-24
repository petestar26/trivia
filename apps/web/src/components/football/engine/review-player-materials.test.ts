import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { borrowReviewFabric } from './review-player-materials';
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
      expect(shader.uniforms).toEqual({ reviewSkin: { value: skin } });
      expect(shader.fragmentShader).toContain('texture2D(reviewSkin,vReviewUv)');
      expect(shader.fragmentShader).toContain('clamp(roughnessFactor/0.67,0.0,1.0)');
      // Eyes and lips retain separate response; the body remains the same skin
      // branch rather than acquiring a separate collar/hand shader.
      expect(shader.fragmentShader).toContain('(vPart>2.5 && vPart<5.5)?0.12');
      expect(shader.fragmentShader).toContain('vPart>0.5 && vPart<1.5?0.48');
      expect(shader.fragmentShader).toContain(
        'material.clearcoat=(vPart>2.5 && vPart<5.5)?0.85:0.006'
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
