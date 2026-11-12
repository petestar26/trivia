import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  COURSE_LENGTH,
  COURSE_RUN_OUT,
  courseX,
  createRacecourse,
  laneZ,
  RAIL_Z,
} from './racecourse';

function budget(scene: THREE.Scene) {
  let draws = 0,
    triangles = 0,
    casters = 0;
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry;
    const count = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    draws++;
    triangles += count * (o instanceof THREE.InstancedMesh ? o.count : 1);
    if (o.castShadow) casters++;
  });
  return { draws, triangles, casters };
}

it('maps published progress linearly onto the course and keeps lanes inside the rails', () => {
  expect(courseX(0)).toBe(0);
  expect(courseX(1)).toBe(COURSE_LENGTH);
  expect(courseX(1.06)).toBeLessThan(COURSE_RUN_OUT);
  for (const field of [6, 8])
    for (let i = 0; i < field; i++)
      expect(Math.abs(laneZ(i, field)) + 0.62).toBeLessThan(RAIL_Z - 3);
});

it('stays within a bounded draw and triangle budget on every quality tier', () => {
  const results = (['high', 'balanced', 'low'] as const).map((quality) => {
    const scene = new THREE.Scene();
    const course = createRacecourse(scene, { quality, field: 8 });
    const result = { quality, ...budget(scene), environment: course.environment };
    course.dispose();
    return result;
  });
  console.info(
    'course budget',
    results.map((r) => ({
      quality: r.quality,
      draws: r.draws,
      triangles: r.triangles,
      casters: r.casters,
    }))
  );
  for (const r of results) {
    expect(r.draws).toBeLessThanOrEqual(64);
    expect(r.triangles).toBeLessThan(r.quality === 'low' ? 60000 : 100000);
  }
  const low = results.find((r) => r.quality === 'low')!;
  expect(low.casters).toBe(0);
});

it('shades matte scenery with Lambert below High and casts no shadows on Low', () => {
  const scene = new THREE.Scene();
  const course = createRacecourse(scene, { quality: 'low', field: 6 });
  expect(course.sun.castShadow).toBe(false);
  expect(course.environment).toBeNull();
  let standard = 0;
  course.root.traverse((o) => {
    if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) standard++;
  });
  expect(standard).toBe(0);
  course.dispose();
});

it('publishes every structure the cameras must see past and stands nothing on the near side', () => {
  const course = createRacecourse(new THREE.Scene(), { quality: 'balanced', field: 8 });
  const names = course.obstacles.map((o) => o.name);
  for (const name of [
    'grandstand',
    'judge',
    'marquees',
    'screen',
    'stalls',
    'near-rail',
    'far-rail',
  ])
    expect(names).toContain(name);
  for (const { name, box } of course.obstacles)
    if (!['stalls', 'near-rail'].includes(name) && !name.startsWith('trees'))
      expect(box.max.z, name).toBeLessThan(-RAIL_Z + 0.2);
  course.dispose();
});

it('releases every owned GPU resource and leaves the scene empty', () => {
  const scene = new THREE.Scene();
  const course = createRacecourse(scene, { quality: 'high', field: 8 });
  const disposed = vi.fn();
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>();
  course.root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      geometries.add(o.geometry);
      materials.add(o.material as THREE.Material);
    }
  });
  geometries.forEach((g) => g.addEventListener('dispose', disposed));
  materials.forEach((m) => m.addEventListener('dispose', disposed));
  const owned = { size: geometries.size + materials.size };
  course.dispose();
  expect(disposed.mock.calls.length).toBeGreaterThanOrEqual(owned.size);
  expect(scene.children).toHaveLength(0);
});
