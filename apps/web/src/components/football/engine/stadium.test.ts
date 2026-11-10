import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROADCAST_RIG, PITCH } from './director';
import { buildStadium } from './stadium';
import { buildTurf, MARKINGS } from './turf';
import { buildCrowd, CROWD_SEAT, type CrowdRow } from './crowd';
import { createContactShadows } from './contact-shadows';
import { ballPanelData } from './ball';

// jsdom has no 2D canvas: accept every drawing call as a no-op.
beforeEach(() => {
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => undefined,
      set: () => true,
    }
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as ReturnType<HTMLCanvasElement['getContext']>
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs a material's shader hook against three's real program source. */
function injected(material: THREE.Material, lib: 'lambert' | 'basic') {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib[lib].vertexShader,
    fragmentShader: THREE.ShaderLib[lib].fragmentShader,
  };
  material.onBeforeCompile(
    shader as unknown as THREE.WebGLProgramParametersWithUniforms,
    {} as THREE.WebGLRenderer
  );
  return shader;
}

describe('stadium', () => {
  it('stays inside a phone-friendly draw-call and triangle budget', () => {
    const stadium = buildStadium();
    let draws = 0;
    let triangles = 0;
    stadium.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh && !(o as THREE.Points).isPoints) return;
      const groups = mesh.isMesh && Array.isArray(mesh.material) ? 3 : 1;
      draws += groups;
      const g = mesh.geometry;
      const count = g.index ? g.index.count : g.getAttribute('position').count;
      if (mesh.isMesh) triangles += count / 3;
    });
    // The previous stadium drew ~460k crowd triangles alone; the full bowl is now far lighter.
    expect(draws).toBeLessThan(80);
    expect(triangles).toBeLessThan(120_000);
    stadium.dispose();
  });

  it('ripples a goal net once and settles it back to its rest shape', () => {
    const stadium = buildStadium();
    const net = stadium.nets['1'];
    const mesh = net.group.children[0] as THREE.Mesh;
    const rest = Float32Array.from(mesh.geometry.getAttribute('position').array);
    net.impact(PITCH.halfLength + 1, 1.2, 1);
    stadium.update(0.1, 1);
    const moved = mesh.geometry.getAttribute('position').array as Float32Array;
    expect(moved.some((v, i) => Math.abs(v - rest[i]) > 0.01)).toBe(true);
    for (let i = 0; i < 200; i++) stadium.update(0.05, 0.3);
    const settled = mesh.geometry.getAttribute('position').array as Float32Array;
    expect(Math.max(...settled.map((v, i) => Math.abs(v - rest[i])))).toBeLessThan(0.01);
    stadium.dispose();
  });

  it('releases every geometry and material it draws, and its generated textures', () => {
    const released = new Set<unknown>();
    const record = (proto: { dispose(): void }) => {
      const original = proto.dispose;
      vi.spyOn(proto, 'dispose').mockImplementation(function (this: { dispose(): void }) {
        released.add(this);
        original.call(this);
      });
    };
    record(THREE.BufferGeometry.prototype);
    record(THREE.Material.prototype);
    record(THREE.Texture.prototype);
    const stadium = buildStadium();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    stadium.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.geometry) return;
      geometries.add(mesh.geometry);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(m);
        for (const value of Object.values(m))
          if (value instanceof THREE.Texture) textures.add(value);
      }
    });
    released.clear();
    stadium.dispose();
    for (const g of geometries) expect(released.has(g)).toBe(true);
    for (const m of materials) expect(released.has(m)).toBe(true);
    expect(textures.size).toBeGreaterThanOrEqual(5);
    for (const t of textures) expect(released.has(t)).toBe(true);
  });
});

describe('turf', () => {
  it('injects analytic markings into the Lambert material program', () => {
    const turf = buildTurf();
    const shader = injected(turf.mesh.material as THREE.Material, 'lambert');
    expect(shader.vertexShader).toContain('vTurfWorld = (modelMatrix');
    expect(shader.fragmentShader).toContain('vec3 nearest = turfLines(p);');
    expect(shader.fragmentShader).toContain('uniform float uTurfLineHalf;');
    expect(shader.uniforms.uTurfHalf.value).toEqual(
      new THREE.Vector2(PITCH.halfLength, PITCH.halfWidth)
    );
    // Lines are 12 cm and the layout uses Laws of the Game distances.
    expect(shader.uniforms.uTurfLineHalf.value).toBeCloseTo(0.06);
    expect(MARKINGS.centreCircle).toBe(9.15);
    expect(MARKINGS.penaltySpot).toBe(11);
    // Broad variation comes from one non-repeating map over the whole surface, not the tile.
    expect(shader.uniforms.uTurfMacro.value).toBeInstanceOf(THREE.DataTexture);
    expect(shader.fragmentShader).toContain('texture2D(uTurfMacro');
    expect(shader.fragmentShader).not.toContain('vMapUv * 0.071');
    expect(turf.mesh.receiveShadow).toBe(true);
    turf.dispose();
  });
});

describe('crowd', () => {
  const row = (facing: THREE.Vector3, along: THREE.Vector3, origin: THREE.Vector3): CrowdRow => ({
    origin,
    along,
    facing,
    length: 20,
    shade: 0.6,
    seed: 3,
  });
  it('turns card segments toward the broadcast camera, never more than 60 degrees', () => {
    // An end stand at +x: rows run along z and face -x.
    const end = row(
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(52, 2, 30)
    );
    const crowd = buildCrowd([end], { x: BROADCAST_RIG.x, z: BROADCAST_RIG.z });
    const pos = crowd.mesh.geometry.getAttribute('position');
    const quads = pos.count / 4;
    expect(quads).toBe(Math.round(20 / CROWD_SEAT / 4));
    for (let q = 0; q < quads; q++) {
      const a = new THREE.Vector3().fromBufferAttribute(pos, q * 4);
      const b = new THREE.Vector3().fromBufferAttribute(pos, q * 4 + 2);
      const dir = b.sub(a).normalize();
      const normal = new THREE.Vector3(dir.z, 0, -dir.x);
      const toViewer = new THREE.Vector3(
        BROADCAST_RIG.x - a.x,
        0,
        BROADCAST_RIG.z - a.z
      ).normalize();
      const turned = Math.acos(Math.abs(normal.dot(new THREE.Vector3(-1, 0, 0))));
      expect(turned).toBeLessThanOrEqual((60 * Math.PI) / 180 + 1e-6);
      // Facing the viewer better than the unturned card would.
      expect(Math.abs(normal.dot(toViewer))).toBeGreaterThanOrEqual(Math.abs(toViewer.x) - 1e-6);
    }
    crowd.dispose();
  });

  it('animates supporters in the shader from time and excitement only', () => {
    const crowd = buildCrowd([
      row(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(-10, 2, -36)),
    ]);
    const material = crowd.mesh.material as THREE.Material;
    const shader = injected(material, 'basic');
    expect(shader.fragmentShader).toContain('textureGrad(map, suv');
    crowd.update(3.5, 1.4);
    expect(shader.uniforms.uCrowdTime.value).toBe(3.5);
    expect(shader.uniforms.uCrowdExcite.value).toBe(1);
    crowd.dispose();
  });
});

describe('floodlight decals', () => {
  it('casts one decal per floodlight away from it and hides the mapped key decal', () => {
    const decals = createContactShadows(
      3,
      { toLight: new THREE.Vector3(0, 30, 60), strength: 0.3 },
      [{ toLight: new THREE.Vector3(-50, 30, 0), strength: 0.1 }]
    );
    const actors = [
      { x: 0, z: 0 },
      { x: 10, z: -5 },
      { x: -20, z: 8 },
    ];
    decals.update(actors, new THREE.Vector3(1, 0.11, 1));
    const [key, side, contact] = decals.group.children as THREE.InstancedMesh[];
    const m = new THREE.Matrix4();
    key.getMatrixAt(1, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(10);
    expect(p.z).toBeCloseTo(-5);
    // The shadow quad's +z (feet -> tip) points away from the light: toward -z for the key.
    const tip = new THREE.Vector3(0, 0, 1).transformDirection(m);
    expect(tip.z).toBeLessThan(-0.9);
    side.getMatrixAt(0, m);
    expect(new THREE.Vector3(0, 0, 1).transformDirection(m).x).toBeGreaterThan(0.9);
    expect(contact.count).toBe(4); // three actors and the ball
    decals.setKeyShadowMapped(true);
    expect(key.visible).toBe(false);
    expect(side.visible).toBe(true);
    decals.dispose();
  });
});

describe('match ball', () => {
  it('draws 12 dark pentagon panels and 20 light hexagons with seams', () => {
    const w = 256;
    const h = 128;
    const data = ballPanelData(w, h);
    let dark = 0;
    let seam = 0;
    let light = 0;
    let weight = 0;
    for (let y = 0; y < h; y++) {
      // Weight texels by their true area on the sphere.
      const area = Math.sin(((y + 0.5) / h) * Math.PI);
      for (let x = 0; x < w; x++) {
        const r = data[(y * w + x) * 4];
        weight += area;
        if (r < 60) dark += area;
        else if (r < 200) seam += area;
        else light += area;
      }
    }
    // Truncated icosahedron: 12 pentagons (1.720 a² each) of 72.6 a² total, about 28 %.
    expect(dark / weight).toBeGreaterThan(0.22);
    expect(dark / weight).toBeLessThan(0.3);
    expect(light / weight).toBeGreaterThan(0.6);
    expect(seam / weight).toBeGreaterThan(0.02);
  });
});
