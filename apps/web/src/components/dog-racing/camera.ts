import * as THREE from 'three';
import { trackPoint, TRACK_LENGTH } from './track';

export type DogCamera = 'trackside' | 'chase' | 'aerial';
export type CameraPack = {
  lead: number;
  trail: number;
  running: boolean;
  /** Ground positions of the visible runners. */
  runners: { x: number; z: number }[];
};

/** Vertical field of view wide enough that a portrait viewport still sees ~40° across. */
export function fieldOfView(aspect: number) {
  const across = THREE.MathUtils.degToRad(40);
  const needed = THREE.MathUtils.radToDeg(
    2 * Math.atan(Math.tan(across / 2) / Math.max(0.3, aspect))
  );
  return Math.max(30, Math.min(64, needed));
}

const UP = new THREE.Vector3(0, 1, 0);
const scratch = {
  f: new THREE.Vector3(),
  r: new THREE.Vector3(),
  u: new THREE.Vector3(),
  rel: new THREE.Vector3(),
};
/**
 * Smallest distance along `direction` (target to camera) at which every point fits
 * inside the frustum, with a margin. Exact for a pinhole camera looking at `target`.
 */
export function fitDistance(
  points: THREE.Vector3[],
  target: THREE.Vector3,
  direction: THREE.Vector3,
  fov: number,
  aspect: number,
  margin = 0.86
) {
  const { f, r, u, rel } = scratch;
  f.copy(direction).negate();
  r.crossVectors(f, UP).normalize();
  u.crossVectors(r, f);
  const tanV = Math.tan(fov / 2) * margin,
    tanH = Math.tan(fov / 2) * aspect * margin;
  let d = 0;
  for (const p of points) {
    rel.subVectors(p, target);
    const along = rel.dot(direction);
    d = Math.max(d, Math.abs(rel.dot(r)) / tanH + along, Math.abs(rel.dot(u)) / tanV + along);
  }
  return d;
}

// Conservative bounds include the tilted roof, seating and back wall. Keep this
// envelope in sync with the grandstand built in track.ts; scenery is not hidden.
export const GRANDSTAND_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-55.5, 0, -46.2),
  new THREE.Vector3(55.5, 9.9, -36.8)
);

/** Lift a camera above any sightline crossing the stand's horizontal footprint.
 * Testing paws as well as heads keeps the entire runner visible. Applied after
 * shot easing too, since a clear pair of endpoints can have an obstructed path.
 */
export function clearGrandstand(position: THREE.Vector3, points: THREE.Vector3[]) {
  const box = GRANDSTAND_BOUNDS;
  let height = position.y;
  for (const point of points) {
    // Segment parameter starts at the runner (0) and ends at the camera (1).
    let enter = 0,
      leave = 1;
    for (const axis of ['x', 'z'] as const) {
      const delta = position[axis] - point[axis];
      if (Math.abs(delta) < 1e-9) {
        if (point[axis] < box.min[axis] || point[axis] > box.max[axis]) leave = -1;
      } else {
        const a = (box.min[axis] - point[axis]) / delta;
        const b = (box.max[axis] - point[axis]) / delta;
        enter = Math.max(enter, Math.min(a, b));
        leave = Math.min(leave, Math.max(a, b));
      }
    }
    if (enter <= leave && leave > 0 && enter > 1e-6) {
      height = Math.max(height, point.y + (box.max.y + 1 - point.y) / enter);
    }
  }
  position.y = height;
}

/**
 * Broadcast-style camera. Each mode has a fixed viewing direction relative to the
 * oval at the field's position; the distance is solved so every published runner is
 * in frame on any viewport. It follows the centre line, so lateral jostling never
 * shakes the view; changes of shot ease on a critically damped spring (no overshoot,
 * no shake). Reduced motion uses one fixed overview of the whole course.
 */
export function createCameraRig() {
  // The camera sits exactly on the solved framing, which already moves smoothly with
  // the published field. Only changes of shot (camera button, the off, leaving the
  // gate shot) are eased: the old view becomes an offset that decays on a critically
  // damped spring. Smoothing the position itself would trail a field running at
  // 10 m/s by several metres and lose the leaders off the edge of the frame.
  const offset = new THREE.Vector3(),
    lookOffset = new THREE.Vector3(),
    velocity = new THREE.Vector3(),
    lookVelocity = new THREE.Vector3(),
    look = new THREE.Vector3(),
    zero = new THREE.Vector3();
  const goal = new THREE.Vector3(),
    goalLook = new THREE.Vector3(),
    direction = new THREE.Vector3();
  const pool = Array.from({ length: 18 }, () => new THREE.Vector3());
  const clearancePoints: THREE.Vector3[] = [];
  let ready = false,
    shot = '';
  const spring = (
    x: THREE.Vector3,
    v: THREE.Vector3,
    target: THREE.Vector3,
    w: number,
    dt: number
  ) => {
    // Exact critically damped step; stable for any frame time.
    const e = Math.exp(-w * dt);
    const dx = x.x - target.x,
      dy = x.y - target.y,
      dz = x.z - target.z;
    const jx = v.x + w * dx,
      jy = v.y + w * dy,
      jz = v.z + w * dz;
    x.set(
      target.x + (dx + jx * dt) * e,
      target.y + (dy + jy * dt) * e,
      target.z + (dz + jz * dt) * e
    );
    v.set((v.x - w * jx * dt) * e, (v.y - w * jy * dt) * e, (v.z - w * jz * dt) * e);
  };
  /** Solves the framing into goal/goalLook and names the shot it used. */
  function frame(mode: DogCamera, pack: CameraPack, aspect: number, reduced: boolean): string {
    const fov = THREE.MathUtils.degToRad(fieldOfView(aspect));
    const across = 2 * Math.atan(Math.tan(fov / 2) * aspect);
    if (reduced) {
      // One still view of the whole oval (152 m x 62 m including rails), fitted to the viewport.
      const tilt = THREE.MathUtils.degToRad(58);
      const wide = 80 / Math.tan(across / 2),
        deep = (31 * Math.sin(tilt) + 6) / Math.tan(fov / 2);
      const d = Math.max(wide, deep) * 1.04;
      goal.set(0, Math.sin(tilt) * d, Math.cos(tilt) * d);
      goalLook.set(0, 0, 0);
      return 'overview';
    }
    if (!pack.running && pack.lead <= 0) {
      // At the traps: a low shot from in front of the numbered doors.
      const front = trackPoint(9 / TRACK_LENGTH, 4.6);
      goal.set(front.x, 1.9, front.z);
      goalLook.set(-47.6, 0.72, 22.6);
      return 'gate';
    }
    // Aim on the centre lane a little ahead of the middle of the field.
    const focus = pack.trail + (pack.lead - pack.trail) * 0.6;
    const at = trackPoint(focus, 0);
    const forward = new THREE.Vector3(Math.cos(at.heading), 0, -Math.sin(at.heading)),
      outward = new THREE.Vector3(Math.sin(at.heading), 0, Math.cos(at.heading));
    goalLook.set(at.x, 0.7, at.z);
    let minimum = 11;
    if (mode === 'aerial') {
      direction.copy(outward).multiplyScalar(0.45).addScaledVector(forward, -0.12);
      direction.y = 0.88;
      minimum = 18;
    } else if (mode === 'chase') {
      direction.copy(forward).multiplyScalar(-1);
      direction.y = 0.42;
      minimum = 10;
    } else {
      // Trackside rail camera: broadside from outside the course, slightly ahead.
      direction.copy(outward).addScaledVector(forward, 0.16);
      direction.y = 0.27;
    }
    direction.normalize();
    // Each runner contributes its paws and its number chip height.
    const points: THREE.Vector3[] = [pool[0].set(at.x, 0, at.z)];
    pack.runners.slice(0, 8).forEach((r, i) => {
      points.push(pool[1 + i * 2].set(r.x, 0, r.z), pool[2 + i * 2].set(r.x, 2.1, r.z));
    });
    const d = Math.max(
      minimum,
      Math.min(140, fitDistance(points, goalLook, direction, fov, aspect))
    );
    goal.copy(goalLook).addScaledVector(direction, d);
    clearGrandstand(goal, points);
    return mode;
  }

  return {
    reset() {
      ready = false;
    },
    /** True while a change of shot is still settling; idle scenes then drop their frame rate. */
    moving() {
      return (
        offset.lengthSq() > 0.0004 ||
        velocity.lengthSq() > 0.0025 ||
        lookVelocity.lengthSq() > 0.0025
      );
    },
    update(
      camera: THREE.PerspectiveCamera,
      mode: DogCamera,
      pack: CameraPack,
      dt: number,
      reduced: boolean
    ) {
      const fov = fieldOfView(camera.aspect);
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      const next = frame(mode, pack, camera.aspect, reduced);
      if (!ready || reduced || next === 'overview' || shot === 'overview') {
        // First frame, reduced motion and leaving it are hard cuts: no camera travel.
        offset.set(0, 0, 0);
        lookOffset.set(0, 0, 0);
        velocity.set(0, 0, 0);
        lookVelocity.set(0, 0, 0);
        ready = true;
      } else if (next !== shot) {
        // Keep the current view, then ease onto the new shot.
        offset.copy(camera.position).sub(goal);
        lookOffset.copy(look).sub(goalLook);
      }
      shot = next;
      spring(offset, velocity, zero, 2.4, dt);
      spring(lookOffset, lookVelocity, zero, 3.1, dt);
      camera.position.copy(goal).add(offset);
      look.copy(goalLook).add(lookOffset);
      // Recheck the actual eased shot, not just its destination. Refit after
      // lifting so portrait fields stay framed as the elevation changes.
      clearancePoints.length = 0;
      pack.runners.slice(0, 8).forEach((r, i) => {
        clearancePoints.push(pool[i * 2].set(r.x, 0, r.z), pool[i * 2 + 1].set(r.x, 2.1, r.z));
      });
      const points = clearancePoints;
      for (let i = 0; i < 8; i++) {
        clearGrandstand(camera.position, points);
        direction.copy(camera.position).sub(look);
        const distance = direction.length();
        direction.normalize();
        const fit = fitDistance(
          points,
          look,
          direction,
          THREE.MathUtils.degToRad(fov),
          camera.aspect
        );
        if (fit <= distance + 1e-6) break;
        camera.position.copy(look).addScaledVector(direction, fit + 0.01);
      }
      clearGrandstand(camera.position, points);
      camera.lookAt(look);
    },
  };
}
