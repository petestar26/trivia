import * as THREE from 'three';
import { COURSE_LENGTH, laneZ } from './racecourse';

/** Camera presets offered to players; the names match the Dog Racing controls. */
export type DerbyCameraMode = 'trackside' | 'chase' | 'aerial';
export type CameraObstacle = { name: string; box: THREE.Box3; margin?: number };
export type DirectorInput = {
  /** Displayed (already published and interpolated) world X of each runner. */
  positions: readonly number[];
  field: number;
  running: boolean;
  /** The official order has been published. */
  finished: boolean;
  reduced: boolean;
  /** Seconds; only drives the slow pre-race drift. */
  time: number;
};
/** Conservative runner silhouette around its root: tail to nose, hooves to cap. */
export const RUNNER_SILHOUETTE = Object.freeze({
  back: -2.75,
  front: 2.45,
  top: 3.55,
  halfWidth: 0.62,
});

const UP = new THREE.Vector3(0, 1, 0);
/**
 * Vertical field of view. Wide stages use a longer, broadcast-style lens (flatter
 * perspective, lanes separated by elevation); portrait stages widen to keep about
 * 46° across.
 */
export function directorFov(aspect: number) {
  const across = THREE.MathUtils.degToRad(46);
  const needed = THREE.MathUtils.radToDeg(
    2 * Math.atan(Math.tan(across / 2) / Math.max(0.3, aspect))
  );
  return THREE.MathUtils.clamp(needed, 24, 58);
}

/** Smallest distance along `direction` at which every point is inside the frustum. */
export function fitDistance(
  points: readonly THREE.Vector3[],
  target: THREE.Vector3,
  direction: THREE.Vector3,
  fovDegrees: number,
  aspect: number,
  margin = 0.88
) {
  const forward = direction.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward);
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovDegrees) / 2) * margin,
    tanH = tanV * aspect;
  const rel = new THREE.Vector3();
  let distance = 0;
  for (const p of points) {
    rel.subVectors(p, target);
    const along = rel.dot(direction);
    distance = Math.max(
      distance,
      Math.abs(rel.dot(right)) / tanH + along,
      Math.abs(rel.dot(up)) / tanV + along
    );
  }
  return distance;
}

/** Corners of every runner's silhouette (actual lane and displayed position only). */
export function runnerPoints(
  positions: readonly number[],
  field: number,
  out: THREE.Vector3[] = []
) {
  out.length = 0;
  positions.forEach((x, i) => {
    const z = laneZ(i, field);
    for (const dx of [RUNNER_SILHOUETTE.back, RUNNER_SILHOUETTE.front])
      for (const y of [0, RUNNER_SILHOUETTE.top])
        for (const dz of [-RUNNER_SILHOUETTE.halfWidth, RUNNER_SILHOUETTE.halfWidth])
          out.push(new THREE.Vector3(x + dx, y, z + dz));
  });
  return out;
}

/**
 * Raise a camera above any obstacle crossing a runner sightline. Points inside an
 * obstacle (runners in the stalls) are skipped. Returns true if it moved.
 */
export function clearSightlines(
  position: THREE.Vector3,
  points: readonly THREE.Vector3[],
  obstacles: readonly CameraObstacle[],
  margin = 0.3
) {
  let height = position.y;
  for (const { box, margin: own } of obstacles) {
    // Runners in or among a structure (the stalls at the break) are framed through
    // it, as on television; only scenery standing apart from them must stay clear.
    if (points.some((point) => box.containsPoint(point))) continue;
    for (const point of points) {
      let enter = 0,
        leave = 1;
      for (const axis of ['x', 'z'] as const) {
        const delta = position[axis] - point[axis];
        if (Math.abs(delta) < 1e-9) {
          if (point[axis] < box.min[axis] || point[axis] > box.max[axis]) leave = -1;
        } else {
          const a = (box.min[axis] - point[axis]) / delta,
            b = (box.max[axis] - point[axis]) / delta;
          enter = Math.max(enter, Math.min(a, b));
          leave = Math.min(leave, Math.max(a, b));
        }
      }
      if (enter <= leave && leave > 0 && enter > 1e-6) {
        const top = box.max.y + (own ?? margin);
        if (point.y + (height - point.y) * enter < top)
          height = Math.max(height, point.y + (top - point.y) / enter);
      }
    }
  }
  const moved = height > position.y + 1e-9;
  position.y = height;
  return moved;
}

/** True if any sightline still crosses an obstacle (used by tests and diagnostics). */
export function blockedSightlines(
  position: THREE.Vector3,
  points: readonly THREE.Vector3[],
  obstacles: readonly CameraObstacle[]
) {
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  const blocked: string[] = [];
  for (const { name, box } of obstacles)
    for (const point of points) {
      if (box.containsPoint(point)) continue;
      ray.origin.copy(point);
      ray.direction.subVectors(position, point);
      const length = ray.direction.length();
      ray.direction.normalize();
      if (ray.intersectBox(box, hit) && hit.distanceTo(point) < length - 1e-6) {
        blocked.push(name);
        break;
      }
    }
  return blocked;
}

type Shot = {
  name: string;
  look: THREE.Vector3;
  direction: THREE.Vector3;
  minimum: number;
};

/**
 * A broadcast director for the straight course. Every shot is solved from published,
 * displayed positions only: it frames all runners on any stage, never predicts a
 * finishing order and cuts only on public race phases (stalls, the break, the final
 * furlong, the post). Changes of shot ease on a critically damped spring; reduced
 * motion holds one still overview.
 */
export function createBroadcastDirector(obstacles: readonly CameraObstacle[] = []) {
  const offset = new THREE.Vector3(),
    velocity = new THREE.Vector3(),
    lookOffset = new THREE.Vector3(),
    lookVelocity = new THREE.Vector3(),
    goal = new THREE.Vector3(),
    look = new THREE.Vector3(),
    direction = new THREE.Vector3();
  let points: THREE.Vector3[] = [];
  let ready = false,
    current = '',
    lastFit = Infinity;
  const spring = (x: THREE.Vector3, v: THREE.Vector3, w: number, dt: number) => {
    const e = Math.exp(-w * dt);
    const jx = v.x + w * x.x,
      jy = v.y + w * x.y,
      jz = v.z + w * x.z;
    x.set((x.x + jx * dt) * e, (x.y + jy * dt) * e, (x.z + jz * dt) * e);
    v.set((v.x - w * jx * dt) * e, (v.y - w * jy * dt) * e, (v.z - w * jz * dt) * e);
  };

  function shot(mode: DerbyCameraMode, input: DirectorInput, aspect: number): Shot {
    const lead = Math.max(...input.positions),
      trail = Math.min(...input.positions);
    const focus = trail + (lead - trail) * 0.58;
    // Taller stages see across the lanes from higher up so runners separate vertically.
    const portrait = THREE.MathUtils.clamp((1.55 - aspect) / 1.0, 0, 1);
    if (input.reduced)
      return {
        name: 'overview',
        look: new THREE.Vector3(focus, 1.2, 0),
        direction: new THREE.Vector3(0.12, 0.5 + 0.35 * portrait, 1),
        minimum: 16,
      };
    if (!input.running && !input.finished && lead < 8) {
      // At the stalls: a slow, low three-quarter drift across the front of the gate.
      const drift = Math.sin(input.time * 0.09) * 0.16;
      return {
        name: 'stalls',
        look: new THREE.Vector3(0.8, 1.55, 0),
        direction: new THREE.Vector3(0.9 + drift, 0.3 + 0.25 * portrait, 0.82 - drift),
        minimum: 13,
      };
    }
    if (mode === 'aerial')
      return {
        name: 'aerial',
        look: new THREE.Vector3(focus, 0.4, 0),
        direction: new THREE.Vector3(0.22, 1.2, 0.8),
        minimum: 26,
      };
    // A follow camera cannot sit behind the stalls: it joins once the field is clear.
    if (mode === 'chase' && trail > 30)
      return {
        name: 'chase',
        look: new THREE.Vector3(lead - (lead - trail) * 0.3 + 3, 1.3, 0),
        direction: new THREE.Vector3(-1, 0.48 + 0.2 * portrait, 0.34),
        minimum: 12,
      };
    if (input.running && (lead < 26 || (mode === 'chase' && trail <= 30)))
      return {
        name: 'break',
        look: new THREE.Vector3(focus + 1.5, 1.45, 0),
        direction: new THREE.Vector3(0.85, 0.3 + 0.25 * portrait, 0.78),
        minimum: 13,
      };
    if (input.running && !input.finished && lead > COURSE_LENGTH - 90 && lead < COURSE_LENGTH + 3)
      return {
        name: 'final',
        look: new THREE.Vector3(focus + 2, 1.45, 0),
        direction: new THREE.Vector3(1.05, 0.27 + 0.25 * portrait, 0.62),
        minimum: 14,
      };
    return {
      name: 'side',
      look: new THREE.Vector3(focus, 1.35, 0),
      direction: new THREE.Vector3(0.16, 0.25 + 0.36 * portrait, 1),
      minimum: 13,
    };
  }

  return {
    reset() {
      ready = false;
    },
    /** True while a change of shot is still settling. */
    moving() {
      return (
        offset.lengthSq() > 1e-3 || velocity.lengthSq() > 1e-3 || lookVelocity.lengthSq() > 1e-3
      );
    },
    get shot() {
      return current;
    },
    update(
      camera: THREE.PerspectiveCamera,
      mode: DerbyCameraMode,
      input: DirectorInput,
      dt: number
    ) {
      const fov = directorFov(camera.aspect);
      if (Math.abs(camera.fov - fov) > 1e-6) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      points = runnerPoints(input.positions, input.field, points);
      const next = shot(mode, input, camera.aspect);
      direction.copy(next.direction).normalize();
      let distance = Math.max(
        next.minimum,
        fitDistance(points, next.look, direction, fov, camera.aspect)
      );
      // Widen immediately for a spreading field; ease a contracting lens within one shot.
      if (ready && next.name === current && dt > 0 && distance < lastFit)
        distance += (lastFit - distance) * Math.exp(-Math.min(dt, 0.25) * 2.5);
      lastFit = distance;
      goal.copy(next.look).addScaledVector(direction, distance);
      if (!ready || input.reduced || next.name === 'overview' || current === 'overview') {
        offset.set(0, 0, 0);
        velocity.set(0, 0, 0);
        lookOffset.set(0, 0, 0);
        lookVelocity.set(0, 0, 0);
        ready = true;
      } else if (next.name !== current) {
        // Keep the current view and ease onto the new shot.
        offset.copy(camera.position).sub(goal);
        lookOffset.copy(look).sub(next.look);
      }
      current = next.name;
      if (dt > 0) {
        spring(offset, velocity, 2.3, dt);
        spring(lookOffset, lookVelocity, 2.9, dt);
      }
      camera.position.copy(goal).add(offset);
      look.copy(next.look).add(lookOffset);
      // Recheck the actual eased position: clear obstacles, then refit, until stable.
      for (let i = 0; i < 8; i++) {
        clearSightlines(camera.position, points, obstacles);
        const view = camera.position.clone().sub(look);
        const length = view.length();
        view.normalize();
        const fit = fitDistance(points, look, view, fov, camera.aspect);
        if (fit <= length + 1e-6) break;
        camera.position.copy(look).addScaledVector(view, fit + 0.01);
      }
      clearSightlines(camera.position, points, obstacles);
      camera.position.y = Math.max(0.8, camera.position.y);
      camera.lookAt(look);
      camera.updateMatrixWorld(true);
      return {
        shot: current,
        center: (Math.max(...input.positions) + Math.min(...input.positions)) / 2,
      };
    },
  };
}
export type BroadcastDirector = ReturnType<typeof createBroadcastDirector>;
