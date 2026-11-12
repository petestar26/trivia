import { expect, it } from 'vitest';
import * as THREE from 'three';
import { createCameraRig, fieldOfView } from './camera';
import { trackPoint, TRACK_LENGTH } from './track';
import { laneOffset } from './world';

const runners = (lead: number, trail: number) =>
  Array.from({ length: 8 }, (_, i) =>
    trackPoint(trail + ((lead - trail) * i) / 7, laneOffset(i, 8))
  );
const pack = (lead: number, trail: number) => ({
  lead,
  trail,
  running: true,
  runners: runners(lead, trail),
});
function settle(
  mode: 'trackside' | 'chase' | 'aerial',
  lead: number,
  trail: number,
  aspect: number
) {
  const camera = new THREE.PerspectiveCamera(34, aspect, 0.4, 600);
  const rig = createCameraRig();
  for (let i = 0; i < 400; i++) rig.update(camera, mode, pack(lead, trail), 1 / 30, false);
  camera.updateMatrixWorld(true);
  return camera;
}

it('keeps every runner of a spread field inside the frame on phones and desktops', () => {
  for (const aspect of [0.56, 1.0, 1.55, 2.2])
    for (const [lead, trail] of [
      [0.2, 0.17],
      [0.55, 0.47],
      [0.97, 0.86],
      [1, 0.9],
    ])
      for (const mode of ['trackside', 'chase', 'aerial'] as const) {
        const camera = settle(mode, lead, trail, aspect);
        for (const [i, p] of runners(lead, trail).entries()) {
          const lap = trail + ((lead - trail) * i) / 7;
          for (const y of [0.1, 2.0]) {
            const v = new THREE.Vector3(p.x, y, p.z).project(camera);
            expect(Math.abs(v.x), `${mode} ${aspect} ${lap}`).toBeLessThan(1);
            expect(Math.abs(v.y), `${mode} ${aspect} ${lap}`).toBeLessThan(1);
            expect(v.z).toBeLessThan(1);
          }
        }
      }
});

it('widens the vertical field of view for portrait viewports only', () => {
  expect(fieldOfView(1.8)).toBe(30);
  expect(fieldOfView(0.6)).toBeGreaterThan(55);
  expect(fieldOfView(0.6)).toBeLessThanOrEqual(64);
});

it('keeps the moving field in frame on every frame, with no lag behind the runners', () => {
  // A field running at race speed for three seconds, frame by frame, in every mode.
  for (const aspect of [0.6, 1.55])
    for (const mode of ['trackside', 'chase', 'aerial'] as const) {
      const camera = new THREE.PerspectiveCamera(34, aspect, 0.4, 600);
      const rig = createCameraRig();
      for (let f = 0; f < 90; f++) {
        const lead = 0.2 + (10.5 * f) / 30 / TRACK_LENGTH;
        rig.update(camera, mode, pack(lead, lead - 0.02), 1 / 30, false);
        camera.updateMatrixWorld(true);
        for (const p of runners(lead, lead - 0.02)) {
          const v = new THREE.Vector3(p.x, 0.5, p.z).project(camera);
          expect(Math.abs(v.x), `${mode} ${aspect} frame ${f}`).toBeLessThan(0.95);
          expect(Math.abs(v.y), `${mode} ${aspect} frame ${f}`).toBeLessThan(0.95);
        }
      }
      expect(rig.moving()).toBe(false);
    }
});

it('eases a change of shot onto the new framing without overshoot', () => {
  const camera = new THREE.PerspectiveCamera(34, 1.6, 0.4, 600);
  const rig = createCameraRig();
  for (let i = 0; i < 5; i++) rig.update(camera, 'trackside', pack(0.11, 0.1), 1 / 30, false);
  const start = camera.position.clone();
  const target = settle('chase', 0.11, 0.1, 1.6).position;
  const distances: number[] = [];
  for (let i = 0; i < 300; i++) {
    rig.update(camera, 'chase', pack(0.11, 0.1), 1 / 30, false);
    distances.push(camera.position.distanceTo(target));
  }
  expect(start.distanceTo(target)).toBeGreaterThan(5);
  // The first eased frame stays near the old view: no jump cut on a button press.
  expect(distances[0]).toBeGreaterThan(start.distanceTo(target) * 0.9);
  for (let i = 1; i < distances.length; i++)
    expect(distances[i]).toBeLessThanOrEqual(distances[i - 1] + 1e-9);
  expect(distances.at(-1)).toBeLessThan(0.01);
  expect(rig.moving()).toBe(false);
});

it('holds a single still overview for reduced motion', () => {
  const camera = new THREE.PerspectiveCamera(34, 1.5, 0.4, 600);
  const rig = createCameraRig();
  rig.update(camera, 'trackside', pack(0.2, 0.15), 0.1, true);
  const first = camera.position.clone();
  rig.update(camera, 'chase', pack(0.7, 0.6), 0.1, true);
  expect(camera.position.toArray()).toEqual(first.toArray());
  camera.updateMatrixWorld(true);
  // The whole oval is in view.
  for (let lap = 0; lap < 1; lap += 0.05) {
    const p = trackPoint(lap, 5);
    const v = new THREE.Vector3(p.x, 0, p.z).project(camera);
    expect(Math.abs(v.x)).toBeLessThan(1);
    expect(Math.abs(v.y)).toBeLessThan(1);
  }
  expect(TRACK_LENGTH).toBeGreaterThan(300);
});
