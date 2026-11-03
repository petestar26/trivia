import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import sourceControls from './continuous-shirt-collar-source.json';
import {
  authorContinuousShirtCollar,
  createAuthoredContinuousShirtSource,
} from './continuous-shirt-authoring';
import { createContinuousPlayerLod } from './continuous-player-lod';

async function sourceGeometry() {
  const raw = readFileSync('public/models/football/continuous-jersey.glb');
  expect(createHash('sha256').update(raw).digest('hex')).toBe(sourceControls.source.sha256);
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(raw).buffer, '');
  return (gltf.scene.getObjectByName('continuous-jersey') as THREE.SkinnedMesh).geometry;
}
describe('editable neutral collar control source', () => {
  it('evaluates every explicit authored target, retaining source UVs, weights and geometry', async () => {
    const g = await sourceGeometry(),
      p = g.getAttribute('position'),
      base = Array.from(p.array),
      positions = base.slice();
    const snapshots = Object.fromEntries(
      Object.entries(g.attributes).map(([key, value]) => [key, Array.from(value.array)])
    );
    const report = authorContinuousShirtCollar(g, positions);
    expect(sourceControls.controls.length).toBe(26);
    for (const control of sourceControls.controls) {
      const id = control.sourceVertex;
      expect([p.getX(id), p.getY(id), p.getZ(id)]).toEqual(control.sourcePosition);
      expect(
        new THREE.Vector3()
          .fromArray(positions, id * 3)
          .distanceTo(new THREE.Vector3().fromArray(control.position))
      ).toBeLessThan(2e-7);
    }
    expect(report.maximumDisplacementMetres).toBeGreaterThan(0.001);
    expect(report.maximumDisplacementMetres).toBeLessThan(
      sourceControls.maximumAuthoredDisplacementMetres
    );
    expect(report.records.length).toBeGreaterThan(50);
    const touched = new Set(report.records.map((r: { vertex: number }) => r.vertex));
    for (let i = 0; i < p.count; i++) {
      const distance = Math.hypot(
        positions[i * 3] - base[i * 3],
        positions[i * 3 + 1] - base[i * 3 + 1],
        positions[i * 3 + 2] - base[i * 3 + 2]
      );
      expect(distance).toBeLessThanOrEqual(sourceControls.maximumAuthoredDisplacementMetres);
      if (!touched.has(i))
        expect(positions.slice(i * 3, i * 3 + 3)).toEqual(base.slice(i * 3, i * 3 + 3));
      if (distance > 0) expect(p.getY(i)).toBeGreaterThan(1.4);
    }
    for (const [key, values] of Object.entries(snapshots))
      expect(Array.from(g.getAttribute(key).array)).toEqual(values);
    expect(authorContinuousShirtCollar(g, base.slice())).toEqual(report);
    g.dispose();
  });
  it('authors once before distant-detail derivation and rejects source-index edits on raw decimation', async () => {
    const high = await sourceGeometry(),
      rawLow = createContinuousPlayerLod(high, { protectNeck: false }),
      rawPositions = Array.from(rawLow.getAttribute('position').array);
    expect(authorContinuousShirtCollar(rawLow, rawPositions).applied).toBe(false);
    expect(rawPositions).toEqual(Array.from(rawLow.getAttribute('position').array));
    const authored = createAuthoredContinuousShirtSource(high),
      low = createContinuousPlayerLod(authored, { protectNeck: false });
    expect(authored.userData.authoredCollarSource.applied).toBe(true);
    const before = Array.from(low.getAttribute('position').array),
      positions = before.slice();
    const report = authorContinuousShirtCollar(low, positions);
    expect(report.applied).toBe(true);
    expect(report.transferredToLod).toBe(true);
    expect(positions).toEqual(before);
    expect(positions.every(Number.isFinite)).toBe(true);
    expect(authored.getIndex()!.array).toEqual(high.getIndex()!.array);
    expect(authored.getAttribute('uv').array).toEqual(high.getAttribute('uv').array);
    expect(authored.getAttribute('skinIndex').array).toEqual(high.getAttribute('skinIndex').array);
    expect(authored.getAttribute('skinWeight').array).toEqual(
      high.getAttribute('skinWeight').array
    );
    high.dispose();
    rawLow.dispose();
    authored.dispose();
    low.dispose();
  });
  it('removes the actual reversed outer-collar fold while fixing its body-side anchor ring', async () => {
    const high = await sourceGeometry(),
      authored = createAuthoredContinuousShirtSource(high),
      source = high.getAttribute('position'),
      indices = high.index!;
    const rep = new Map<string, number>(),
      canonical: number[] = [];
    for (let i = 0; i < source.count; i++) {
      const k = [source.getX(i), source.getY(i), source.getZ(i)]
        .map((v) => Math.round(v * 1e7))
        .join(',');
      if (!rep.has(k)) rep.set(k, i);
      canonical.push(rep.get(k)!);
    }
    function foldedEdges(g: THREE.BufferGeometry) {
      const p = g.getAttribute('position'),
        edges = new Map<string, THREE.Vector3[]>();
      for (let k = 0; k < indices.count; k += 3) {
        const ids = [indices.getX(k), indices.getX(k + 1), indices.getX(k + 2)];
        const a = new THREE.Vector3().fromBufferAttribute(p, ids[0]),
          b = new THREE.Vector3().fromBufferAttribute(p, ids[1]),
          c = new THREE.Vector3().fromBufferAttribute(p, ids[2]);
        const normal = new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)).normalize();
        for (let j = 0; j < 3; j++) {
          const x = canonical[ids[j]],
            y = canonical[ids[(j + 1) % 3]];
          if (source.getY(x) <= 1.38 || source.getY(y) <= 1.38) continue;
          const key = [Math.min(x, y), Math.max(x, y)].join(',');
          const list = edges.get(key) ?? [];
          list.push(normal);
          edges.set(key, list);
        }
      }
      return [...edges.values()].filter(
        (normals) => normals.length === 2 && normals[0].dot(normals[1]) < 0
      ).length;
    }
    expect(foldedEdges(high)).toBe(83);
    expect(foldedEdges(authored)).toBe(0);
    const p = authored.getAttribute('position');
    for (const c of sourceControls.surfaceControls.filter(
      (c) => c.row === sourceControls.construction.fixedBodyRow
    ))
      expect([p.getX(c.sourceVertex), p.getY(c.sourceVertex), p.getZ(c.sourceVertex)]).toEqual(
        c.sourcePosition
      );
    high.dispose();
    authored.dispose();
  });
});
