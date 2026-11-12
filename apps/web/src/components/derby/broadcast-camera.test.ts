import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  blockedSightlines,
  clearSightlines,
  createBroadcastDirector,
  runnerPoints,
  type DerbyCameraMode,
  type DirectorInput,
} from './broadcast-camera';
import { COURSE_LENGTH, courseX, createRacecourse } from './racecourse';

const course = createRacecourse(new THREE.Scene(), { quality: 'balanced', field: 8 });
const ASPECTS = [288 / 300, 358 / 300, 390 / 844, 844 / 230, 844 / 390, 1354 / 390, 1440 / 560];
const MODES: DerbyCameraMode[] = ['trackside', 'chase', 'aerial'];

function expectFramed(camera: THREE.PerspectiveCamera, positions: number[], field: number) {
  camera.updateMatrixWorld(true);
  for (const point of runnerPoints(positions, field)) {
    const screen = point.clone().project(camera);
    expect(Math.abs(screen.x)).toBeLessThan(1);
    expect(Math.abs(screen.y)).toBeLessThan(1);
    expect(screen.z).toBeLessThan(1);
  }
}
const input = (positions: number[], field: number, extra: Partial<DirectorInput> = {}) => ({
  positions,
  field,
  running: true,
  finished: false,
  reduced: false,
  time: 0,
  ...extra,
});

describe('Derby broadcast director', () => {
  it('frames every six/eight-runner silhouette on phone, landscape and desktop stages in every shot', () => {
    for (const field of [6, 8])
      for (const aspect of ASPECTS)
        for (const mode of MODES)
          for (const positions of [
            Array(field).fill(0), // stalls
            Array.from({ length: field }, (_, i) => 12 + i * 0.4), // the break
            Array(field).fill(courseX(0.45)), // bunched
            Array.from({ length: field }, (_, i) => courseX(0.5) + i * 0.94), // correlated
            Array.from({ length: field }, (_, i) => courseX(0.92) - i * 4), // final furlong, strung out
            Array.from({ length: field }, (_, i) => COURSE_LENGTH * 1.06 - i * 3), // pulled up
          ])
            for (const running of [true, false]) {
              const camera = new THREE.PerspectiveCamera(36, aspect, 0.3, 3000);
              const director = createBroadcastDirector(course.obstacles);
              director.update(camera, mode, input(positions, field, { running }), 0);
              expectFramed(camera, positions, field);
            }
  });

  it('keeps every hoof and head sightline clear of scenery, including mid-transition', () => {
    for (const field of [6, 8])
      for (const aspect of [358 / 300, 390 / 844, 844 / 390, 1440 / 560])
        for (const mode of MODES) {
          const camera = new THREE.PerspectiveCamera(36, aspect, 0.3, 3000);
          const director = createBroadcastDirector(course.obstacles);
          // A whole published race at 10 Hz: stalls, break, straight, final furlong, post.
          for (let t = -2; t <= 47; t += 0.1) {
            const progress = Math.max(0, Math.min(1.06, (t / 45) * 1.06));
            const positions = Array.from(
              { length: field },
              (_, i) =>
                courseX(progress) - (progress > 0.6 ? ((i * 3) % field) * (progress - 0.6) * 9 : 0)
            );
            const running = t >= 0 && t < 45;
            director.update(
              camera,
              mode,
              input(positions, field, { running, finished: t >= 45, time: t }),
              0.1
            );
            const points = runnerPoints(positions, field);
            const blocked = blockedSightlines(
              camera.position,
              points,
              course.obstacles.filter((o) => !points.some((p) => o.box.containsPoint(p)))
            );
            expect(
              blocked,
              `${mode} ${aspect.toFixed(2)} t=${t.toFixed(1)} ${director.shot}`
            ).toEqual([]);
            // Never inside scenery or below the turf.
            expect(course.obstacles.filter((o) => o.box.containsPoint(camera.position))).toEqual(
              []
            );
            expect(camera.position.y).toBeGreaterThan(0.75);
            expectFramed(camera, positions, field);
          }
        }
  });

  it('widens immediately for a spreading field and eases a contracting lens within one shot', () => {
    const camera = new THREE.PerspectiveCamera(36, 390 / 600, 0.3, 3000);
    const director = createBroadcastDirector(course.obstacles);
    const wide = Array.from({ length: 8 }, (_, i) => 300 + i * 4);
    const narrow = Array(8).fill(314);
    director.update(camera, 'trackside', input(wide, 8), 0);
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const distanceWide = camera.position.z;
    director.update(camera, 'trackside', input(narrow, 8), 1 / 30);
    const eased = camera.position.z;
    const fresh = new THREE.PerspectiveCamera(36, 390 / 600, 0.3, 3000);
    createBroadcastDirector(course.obstacles).update(fresh, 'trackside', input(narrow, 8), 0);
    expect(eased).toBeLessThan(distanceWide);
    expect(eased).toBeGreaterThan(fresh.position.z);
    director.update(camera, 'trackside', input(wide, 8), 1 / 30);
    expectFramed(camera, wide, 8);
    void look;
  });

  it('eases changes of shot without overshoot and holds still in reduced motion', () => {
    const camera = new THREE.PerspectiveCamera(36, 1440 / 560, 0.3, 3000);
    const director = createBroadcastDirector(course.obstacles);
    const positions = Array(8).fill(300);
    director.update(camera, 'trackside', input(positions, 8), 0);
    const side = camera.position.clone();
    director.update(camera, 'aerial', input(positions, 8), 1 / 30);
    const first = camera.position.clone();
    expect(first.distanceTo(side)).toBeLessThan(2);
    let previous = first.y;
    for (let i = 0; i < 240; i++) {
      director.update(camera, 'aerial', input(positions, 8), 1 / 30);
      expect(camera.position.y).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = camera.position.y;
    }
    const still = new THREE.PerspectiveCamera(36, 1440 / 560, 0.3, 3000);
    const calm = createBroadcastDirector(course.obstacles);
    calm.update(still, 'chase', input(positions, 8, { reduced: true }), 0);
    const held = still.position.clone();
    calm.update(still, 'aerial', input(positions, 8, { reduced: true, time: 9 }), 1);
    expect(still.position.distanceTo(held)).toBeLessThan(1e-9);
    expect(calm.shot).toBe('overview');
  });

  it('chooses shots from public phases only, never from an unpublished order', () => {
    const camera = new THREE.PerspectiveCamera(36, 2, 0.3, 3000);
    const a = createBroadcastDirector(course.obstacles),
      b = createBroadcastDirector(course.obstacles);
    const positions = Array.from({ length: 8 }, (_, i) => courseX(0.5) + i);
    a.update(camera, 'trackside', input(positions, 8), 0);
    const one = camera.position.clone();
    // Same published positions: the same view, whatever the private finishing order.
    b.update(camera, 'trackside', input([...positions], 8), 0);
    expect(camera.position.distanceTo(one)).toBeLessThan(1e-9);
    const shots = [
      [Array(8).fill(0), false, 'stalls'],
      [Array(8).fill(10), true, 'break'],
      [Array(8).fill(courseX(0.5)), true, 'side'],
      [Array(8).fill(COURSE_LENGTH - 40), true, 'final'],
    ] as const;
    for (const [where, running, shot] of shots) {
      const director = createBroadcastDirector(course.obstacles);
      director.update(camera, 'trackside', input([...where], 8, { running }), 0);
      expect(director.shot).toBe(shot);
    }
  });

  it('lifts a camera only as far as a crossing obstacle needs', () => {
    const box = new THREE.Box3(new THREE.Vector3(-10, 0, 10), new THREE.Vector3(10, 1, 11));
    const position = new THREE.Vector3(0, 0.5, 20);
    const points = [new THREE.Vector3(0, 0, 0)];
    expect(clearSightlines(position, points, [{ name: 'rail', box, margin: 0 }])).toBe(true);
    // The sightline enters the box at z = 10, half way: it must clear y = 1 there.
    expect(position.y).toBeCloseTo(2, 9);
    expect(blockedSightlines(position.clone().setY(2.01), points, [{ name: 'rail', box }])).toEqual(
      []
    );
  });
});
