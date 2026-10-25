import { expect, it } from 'vitest';
import * as THREE from 'three';
import { frameDerbyField } from './field-camera';
it('keeps all eight horse silhouettes and number markers inside phone, landscape and desktop views', () => {
  for (const field of [6, 8])
    for (const aspect of [390 / 290, 390 / 600, 844 / 280, 1354 / 390])
      for (const gap of [0.2, 1.62, 3]) {
        const positions = Array.from({ length: field }, (_, i) => 100 - i * gap);
        const camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 2000);
        frameDerbyField(camera, positions, field);
        positions.forEach((x, i) => {
          const z = (i - (field - 1) / 2) * 2.15;
          for (const dx of [-3.3, 3.3])
            for (const y of [0, 4.6])
              for (const dz of [-0.8, 0.8]) {
                const screen = new THREE.Vector3(x + dx, y, z + dz).project(camera);
                expect(Math.abs(screen.x)).toBeLessThan(1);
                expect(Math.abs(screen.y)).toBeLessThan(1);
              }
        });
      }
});
it('contains the field immediately on spread and eases a contracting lens without clipping enlarged number markers', () => {
  const camera = new THREE.PerspectiveCamera(36, 390 / 600, 0.1, 2000);
  const wide = [40, 44, 48, 52, 56, 60, 64, 68];
  const narrow = Array(8).fill(54);
  frameDerbyField(camera, wide, 8);
  const prior = camera.position.clone();
  frameDerbyField(camera, narrow, 8, 1 / 30);
  const smoothDistance = camera.position.clone();
  const immediate = new THREE.PerspectiveCamera(36, 390 / 600, 0.1, 2000);
  frameDerbyField(immediate, narrow, 8);
  expect(smoothDistance.z).toBeGreaterThan(immediate.position.z);
  expect(smoothDistance.z).toBeLessThan(prior.z);
  for (const positions of [narrow, wide]) {
    frameDerbyField(camera, positions, 8, 1 / 30);
    positions.forEach((x, i) => {
      const z = (i - 3.5) * 2.15;
      for (const y of [0, 5])
        for (const dx of [-3.3, 3.3]) {
          const point = new THREE.Vector3(x + dx, y, z).project(camera);
          expect(Math.abs(point.x)).toBeLessThan(1);
          expect(Math.abs(point.y)).toBeLessThan(1);
        }
    });
  }
});

it('contains the enlarged billboard number quads for six/eight runners at phone stage sizes', () => {
  for (const field of [6, 8])
    for (const [width, height] of [
      [390, 292],
      [390, 600],
      [844, 230],
    ]) {
      const positions = Array.from({ length: field }, (_, i) => 100 - i * 1.62);
      const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 2000);
      frameDerbyField(camera, positions, field);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      positions.forEach((x, i) => {
        const centre = new THREE.Vector3(x, 4.235, (i - (field - 1) / 2) * 2.15);
        for (const dx of [-0.8, 0.8])
          for (const dy of [-0.8, 0.8]) {
            const screen = centre
              .clone()
              .addScaledVector(right, dx)
              .addScaledVector(up, dy)
              .project(camera);
            expect(Math.abs(screen.x)).toBeLessThan(1);
            expect(Math.abs(screen.y)).toBeLessThan(1);
          }
      });
    }
});

it('gives a close six/eight-runner field useful portrait space instead of mostly empty grass', () => {
  for (const field of [6, 8]) {
    const camera = new THREE.PerspectiveCamera(36, 390 / 844, 0.1, 2000);
    const positions = Array.from({ length: field }, (_, i) => 100 + i * 0.936);
    const published = [...positions];
    frameDerbyField(camera, positions, field);
    const x: number[] = [],
      y: number[] = [];
    // A conservative rectangular approximation of the shipped runner's skin
    // envelope, independently measured across Run96/Idle1 source samples.
    for (let i = 0; i < field; i++)
      for (const dx of [-2.55, 2.55])
        for (const height of [0.035, 3.25])
          for (const dz of [-0.674, 0.674]) {
            const p = new THREE.Vector3(
              positions[i] + dx,
              height,
              (i - (field - 1) / 2) * 2.15 + dz
            ).project(camera);
            x.push(p.x);
            y.push(p.y);
          }
    expect((Math.max(...x) - Math.min(...x)) / 2).toBeGreaterThan(0.6);
    expect((Math.max(...y) - Math.min(...y)) / 2).toBeGreaterThan(0.32);
    expect(positions).toEqual(published);
  }
});
