/**
 * Broadcast camera operator: eases the camera toward the director's framing with a critically
 * damped spring per channel (position, look-at point, field of view). Unlike first-order
 * exponential smoothing, a spring starts and stops a pan gradually, as a person operating a
 * fluid-head tripod does, and never overshoots. The result is a deterministic function of the
 * sequence of targets and time steps, so captures and tests are reproducible.
 */
export interface CameraShot {
  x: number;
  y: number;
  z: number;
  lx: number;
  ly: number;
  lz: number;
  fov: number;
}
export interface OperatorTiming {
  /** Approximate time (s) to settle the look-at point horizontally (pan). */
  pan: number;
  /** Approximate time (s) to settle the look-at point toward/away from the camera (tilt). */
  tilt: number;
  /** Approximate time (s) to settle the zoom. */
  zoom: number;
  /** Fastest pan of the look-at point, metres per second. */
  maxPanSpeed: number;
}
export const OPERATOR_PLAY: OperatorTiming = Object.freeze({
  pan: 0.62,
  tilt: 0.85,
  zoom: 0.9,
  maxPanSpeed: 26,
});
export const OPERATOR_GOAL: OperatorTiming = Object.freeze({
  pan: 0.34,
  tilt: 0.5,
  zoom: 0.55,
  maxPanSpeed: 40,
});

/**
 * Critically damped spring step (the widely used "SmoothDamp" closed form). Stable for any dt.
 * Returns the new value and updates `velocity[index]`.
 */
export function smoothDamp(
  current: number,
  target: number,
  velocity: Float64Array,
  index: number,
  smoothTime: number,
  dt: number,
  maxSpeed = Infinity
): number {
  const time = Math.max(1e-4, smoothTime);
  const omega = 2 / time;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const maxChange = maxSpeed * time;
  const change = Math.max(-maxChange, Math.min(maxChange, current - target));
  const goal = current - change;
  const temp = (velocity[index] + omega * change) * dt;
  velocity[index] = (velocity[index] - omega * temp) * decay;
  let next = goal + (change + temp) * decay;
  // Never overshoot the requested framing.
  if (target - current > 0 === next > target) {
    next = target;
    velocity[index] = dt > 0 ? (next - target) / dt : 0;
  }
  return next;
}

export interface CameraOperator {
  /** Jumps straight to a framing (a cut), clearing all motion. */
  cut(shot: CameraShot): void;
  /** Eases toward a framing. The first call after creation or `reset` behaves as a cut. */
  follow(shot: CameraShot, dt: number, timing: OperatorTiming): void;
  reset(): void;
  readonly shot: Readonly<CameraShot>;
}

const KEYS = ['x', 'y', 'z', 'lx', 'ly', 'lz', 'fov'] as const;

export function createCameraOperator(): CameraOperator {
  const shot: CameraShot = { x: 0, y: 0, z: 0, lx: 0, ly: 0, lz: 0, fov: 30 };
  const velocity = new Float64Array(KEYS.length);
  let ready = false;
  const cut = (target: CameraShot) => {
    for (const key of KEYS) shot[key] = target[key];
    velocity.fill(0);
    ready = true;
  };
  return {
    cut,
    follow(target, dt, timing) {
      if (!ready) return cut(target);
      const times = [timing.pan, timing.pan, timing.pan, timing.pan, timing.tilt, timing.tilt];
      KEYS.forEach((key, i) => {
        if (key === 'fov') {
          // Zoom out quickly and in slowly, as camera operators do: widening to keep the action
          // in frame must not lag, while a push-in can take its time.
          const widening = target.fov > shot.fov;
          const time = widening ? timing.zoom * 0.35 : timing.zoom;
          shot.fov = smoothDamp(shot.fov, target.fov, velocity, i, time, dt);
          return;
        }
        const speed = key === 'lx' || key === 'x' ? timing.maxPanSpeed : Infinity;
        shot[key] = smoothDamp(shot[key], target[key], velocity, i, times[i], dt, speed);
      });
    },
    reset() {
      ready = false;
      velocity.fill(0);
    },
    get shot() {
      return shot;
    },
  };
}
