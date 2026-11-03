import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { createContinuousPlayerLod } from './continuous-player-lod';
import { continuousShirtCoverage } from './continuous-player-coverage';
import { BONES } from './rig';

const bytes = (g: THREE.BufferGeometry) =>
  [...Object.values(g.attributes), ...Object.values(g.morphAttributes).flat(), g.index!].reduce(
    (sum, a) => sum + (a?.array.byteLength ?? 0),
    0
  );
const edges = (g: THREE.BufferGeometry) => {
  const result = new Map<string, number>(),
    p = g.getAttribute('position'),
    index = g.index!;
  const point = (i: number) => [p.getX(i), p.getY(i), p.getZ(i)].join(',');
  for (let i = 0; i < index.count; i += 3)
    for (let k = 0; k < 3; k++) {
      const key = [point(index.getX(i + k)), point(index.getX(i + ((k + 1) % 3)))].sort().join('|');
      result.set(key, (result.get(key) ?? 0) + 1);
    }
  return [...result]
    .filter(([, n]) => n === 1)
    .map(([key]) => key)
    .sort();
};
async function fixture(part: 'body' | 'jersey') {
  const gltf = await new GLTFLoader().parseAsync(
    Uint8Array.from(readFileSync(`public/models/football/continuous-${part}.glb`)).buffer,
    ''
  );
  const mesh = gltf.scene.getObjectByName(`continuous-${part}`) as THREE.SkinnedMesh;
  const g = mesh.geometry.clone();
  if (part === 'body') {
    const covered = continuousShirtCoverage(g),
      p = g.getAttribute('position'),
      index = g.index!,
      visible: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      const arm = (id: number) => {
        const si = g.getAttribute('skinIndex'),
          sw = g.getAttribute('skinWeight');
        let value = 0;
        for (let k = 0; k < 4; k++)
          if (
            /^(upperArm|foreArm|hand|thumb|index|middle|ring|pinky)/.test(
              BONES[si.getComponent(id, k)]
            )
          )
            value += sw.getComponent(id, k);
        return value;
      };
      if (
        ids.some((id) => p.getY(id) < 0.16) ||
        ids.every((id) => covered[id]) ||
        ids.every((id) => arm(id) < 0.1 && p.getY(id) < 0.474) ||
        ids.every((id) => arm(id) < 0.1 && p.getY(id) > 0.68 && p.getY(id) < 1.07)
      )
        continue;
      visible.push(...ids);
    }
    g.setIndex(visible);
  }
  return g;
}

describe('continuous actor load-time geometry LOD', () => {
  for (const part of ['body', 'jersey'] as const)
    it(`preserves actual ${part} openings, skin, morphs and neck`, async () => {
      const source = await fixture(part),
        before = source.getAttribute('position').array.slice();
      const lod = createContinuousPlayerLod(source, { protectNeck: part === 'body' });
      console.log(
        part,
        source.index!.count / 3,
        lod.index!.count / 3,
        bytes(source),
        bytes(lod),
        lod.userData.continuousLod
      );
      expect(lod.userData.continuousLod.fallback).toBe(false);
      expect(lod.index!.count).toBeLessThan(source.index!.count);
      expect(edges(lod)).toEqual(edges(source));
      expect(source.getAttribute('position').array).toEqual(before);
      expect(lod.morphTargetsRelative).toBe(source.morphTargetsRelative);
      const p = lod.getAttribute('position'),
        si = lod.getAttribute('skinIndex'),
        sw = lod.getAttribute('skinWeight');
      const normal = lod.getAttribute('normal'),
        used = new Set(lod.index!.array);
      for (const i of used) {
        const sum = [0, 1, 2, 3].reduce((v, k) => v + sw.getComponent(i, k), 0);
        expect(sum).toBeCloseTo(1, 6);
        for (let k = 0; k < 4; k++) expect(si.getComponent(i, k)).toBeLessThan(49);
        if (part !== 'body' || p.getY(i) < 1.45)
          expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeCloseTo(1, 5);
      }
      const visibleBounds = new THREE.Box3();
      const point = new THREE.Vector3(),
        originalPosition = source.getAttribute('position');
      for (const i of source.index!.array)
        visibleBounds.expandByPoint(point.fromBufferAttribute(originalPosition, i));
      lod.computeBoundingBox();
      expect(lod.boundingBox!.min.distanceTo(visibleBounds.min)).toBeLessThan(0.056);
      expect(lod.boundingBox!.max.distanceTo(visibleBounds.max)).toBeLessThan(0.056);
      if (part === 'body') {
        expect(lod.morphAttributes.position).toHaveLength(8);
        const original = source.getAttribute('position');
        for (let i = 0; i < original.count; i++)
          if (original.getY(i) >= 1.45) {
            let found = -1;
            for (let j = 0; j < p.count; j++)
              if (
                p.getX(j) === original.getX(i) &&
                p.getY(j) === original.getY(i) &&
                p.getZ(j) === original.getZ(i)
              ) {
                found = j;
                break;
              }
            expect(found).toBeGreaterThanOrEqual(0);
            for (const name of ['position', 'normal'] as const)
              source.morphAttributes[name]!.forEach((m, k) => {
                for (let axis = 0; axis < 3; axis++)
                  expect(lod.morphAttributes[name]![k].getComponent(found, axis)).toBe(
                    m.getComponent(i, axis)
                  );
              });
          }
      }
      source.dispose();
      lod.dispose();
    });
});
