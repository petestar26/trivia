import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { frameDerbyField } from './field-camera';
import { layoutDerbyNumbers } from './number-layout';

function check(points: ReturnType<typeof layoutDerbyNumbers>, width: number, height: number) {
  for (const point of points) {
    expect(point.size).toBe(28);
    expect(point.x - point.size / 2).toBeGreaterThanOrEqual(5.7);
    expect(point.x + point.size / 2).toBeLessThanOrEqual(width - 5.7);
    expect(point.y - point.size / 2).toBeGreaterThanOrEqual(8 - 1e-7);
    expect(point.y + point.size / 2).toBeLessThanOrEqual(height - 8 + 1e-7);
  }
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const x = Math.abs(points[i].x - points[j].x),
        y = Math.abs(points[i].y - points[j].y);
      expect(Math.max(x, y)).toBeGreaterThanOrEqual(32 - 1e-7);
    }
}

describe('pixel-readable Derby numbers', () => {
  for (const field of [6, 8])
    it(`separates all ${field} markers at real phone and landscape/desktop stages`, () => {
      for (const [width, height] of [
        [288, 300],
        [358, 300],
        [390, 844],
        [844, 230],
        [844, 390],
        [1354, 390],
      ])
        for (const positions of [
          Array(field).fill(100),
          Array.from({ length: field }, (_, i) => 100 - i * 0.2),
          Array.from({ length: field }, (_, i) => 100 - i * 1.62),
          Array.from({ length: field }, (_, i) => 100 - i * 10),
          Array.from({ length: field }, (_, i) => (i % 2 ? 180 : 0)),
        ]) {
          const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 2000);
          frameDerbyField(camera, positions, field);
          const anchors = positions.map((x, i) => {
            const point = new THREE.Vector3(x, 3.485, (i - (field - 1) / 2) * 2.15).project(camera);
            return { x: ((point.x + 1) * width) / 2, y: ((1 - point.y) * height) / 2 };
          });
          const prior = JSON.stringify(anchors),
            result = layoutDerbyNumbers(anchors, width, height);
          expect(result).toHaveLength(field);
          check(result, width, height);
          expect(JSON.stringify(anchors)).toBe(prior);
          expect(layoutDerbyNumbers(anchors, width, height)).toEqual(result);
        }
    });

  it('keeps all eight distinct IDs visible even when every anchor projects onto one edge', () => {
    for (const [width, height] of [
      [288, 128],
      [288, 300],
      [844, 230],
    ])
      for (const point of [
        { x: 0, y: 0 },
        { x: width, y: height },
        { x: width / 2, y: height / 2 },
      ]) {
        const result = layoutDerbyNumbers(
          Array.from({ length: 8 }, () => ({ ...point })),
          width,
          height
        );
        expect(result).toHaveLength(8);
        check(result, width, height);
      }
  });

  it('does not retain a viewport or ordering cache across resize and rewind', () => {
    const points = Array.from({ length: 8 }, (_, i) => ({ x: 180 + i * 0.2, y: 90 + i * 4 }));
    const before = layoutDerbyNumbers(points, 358, 300);
    layoutDerbyNumbers(points, 844, 230);
    layoutDerbyNumbers([...points].reverse(), 358, 300);
    expect(layoutDerbyNumbers(points, 358, 300)).toEqual(before);
    expect(layoutDerbyNumbers([], 358, 300)).toEqual([]);
  });
});
