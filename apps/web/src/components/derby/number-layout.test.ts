import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { frameDerbyField } from './field-camera';
import { createDerbyNumberLayout, layoutDerbyNumbers } from './number-layout';

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

describe('per-scene number continuity', () => {
  it.each([
    [288, 300, 8],
    [358, 300, 6],
    [844, 230, 8],
  ])('avoids free-region jumps at %s×%s with %s slowly moving runners', (width, height, field) => {
    const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 2000),
      layout = createDerbyNumberLayout();
    let previous: ReturnType<typeof layoutDerbyNumbers> | undefined,
      maximumMove = 0;
    for (let step = 0; step <= 1200; step++) {
      const positions = Array.from(
        { length: field },
        (_, i) => 100 + step * 0.02 - (i * step) / 600
      );
      frameDerbyField(camera, positions, field, step ? 1 / 30 : 0);
      const anchors = positions.map((x, i) => {
        const p = new THREE.Vector3(x, 3.485, (i - (field - 1) / 2) * 2.15).project(camera);
        return { x: ((p.x + 1) * width) / 2, y: ((1 - p.y) * height) / 2 };
      });
      const badges = layout.update(anchors, width, height, step ? 1 / 30 : 0);
      if (previous)
        badges.forEach((p, i) => {
          maximumMove = Math.max(
            maximumMove,
            Math.hypot(p.x - previous![i].x, p.y - previous![i].y)
          );
        });
      if (step % 100 === 0) check(badges, width, height);
      previous = badges;
    }
    // Former stateless choices jumped25–66px on subpixel source movement.
    expect(maximumMove).toBeLessThan(3);
  });

  it('resets prior placement for round resets, resize and reduced-motion snaps without cross-scene state', () => {
    const points = Array.from({ length: 8 }, (_, i) => ({ x: 170 + i * 0.3, y: 80 + i * 3 }));
    const a = createDerbyNumberLayout(),
      b = createDerbyNumberLayout();
    const initial = a.update(points, 358, 300, 0);
    expect(
      a.update(
        points.map((p) => ({ x: p.x + 1e-10, y: p.y - 1e-10 })),
        358,
        300,
        1 / 30
      )
    ).toEqual(initial);
    for (let i = 0; i < 12; i++)
      a.update(
        points.map((p) => ({ x: p.x + i * 0.1, y: p.y })),
        358,
        300,
        1 / 30
      );
    expect(b.update(points, 358, 300, 0)).toEqual(initial);
    a.reset();
    expect(a.update(points, 358, 300, 1 / 30)).toEqual(initial);
    expect(a.update(points, 844, 230, 1 / 30)).toEqual(layoutDerbyNumbers(points, 844, 230));
    expect(a.update(points, 358, 300, 0)).toEqual(initial);
  });
});
