import * as THREE from 'three';

/** The exported cycle starts at frame one. Remove its leading hold and close the seam. */
export function continuousGallop(source: THREE.AnimationClip) {
  const clip = source.clone();
  const first = Math.min(...clip.tracks.map((track) => track.times[0]));
  if (first <= 0) return clip;
  for (const track of clip.tracks) {
    const size = track.getValueSize();
    const times = new Float32Array(track.times.length + 1);
    const values = new Float32Array(track.values.length + size);
    track.times.forEach((time, i) => {
      times[i] = time - first;
    });
    times[times.length - 1] = source.duration;
    values.set(track.values);
    values.set(track.values.slice(0, size), track.values.length);
    track.times = times;
    track.values = values;
  }
  return clip;
}

/** Keys per authored frame in the resampled loop. */
export const GALLOP_RESAMPLE = 4;

/**
 * A velocity-continuous loop of the authored gallop.
 *
 * The exported Run clip has thirteen 30 fps frames. Its last frame is inconsistent
 * per bone: some bones repeat their previous pose (a one-frame freeze), others already
 * repeat the first pose, and the step into the next cycle is then up to twice an
 * ordinary frame. At the natural stride rate that is a visible hitch every 0.43 s.
 *
 * Only that last frame is re-derived, from its neighbours on both sides of the seam
 * with a periodic cubic; every other authored frame is kept exactly. Moving tracks
 * are then resampled with periodic monotone cubic splines, so linear key interpolation
 * no longer produces a velocity corner at every key and no pose overshoots its keys. Static tracks are left untouched.
 * The duration, bone set and authored poses at frames 0–11 are unchanged.
 */
export function seamlessGallop(source: THREE.AnimationClip, resample = GALLOP_RESAMPLE) {
  const clip = continuousGallop(source);
  const duration = clip.duration;
  for (const track of clip.tracks) {
    // continuousGallop appended the first pose; the period is keys 0..n-1.
    const n = track.times.length - 1;
    if (n < 4) continue;
    const size = track.getValueSize();
    const quaternion = size === 4 && track.name.endsWith('.quaternion');
    const key = (i: number) => {
      const k = ((i % n) + n) % n;
      return Array.from(track.values.slice(k * size, k * size + size));
    };
    const keys = Array.from({ length: n }, (_, i) => key(i));
    if (quaternion) alignHemisphere(keys);
    // Re-derive the inconsistent final authored frame between frame n-2 and frame 0.
    const last = n - 1;
    const p0 = keys[last - 2],
      p1 = keys[last - 1],
      p2 = keys[0],
      p3 = keys[1];
    // Frames n-2 → (n-1) → 0 span two intervals: Hermite at the midpoint with
    // central-difference tangents (per two-interval segment).
    keys[last] = p1.map((_, c) => {
      const m1 = (p2[c] - p0[c]) / 3, // per interval, segment spans 2 intervals
        m2 = (p3[c] - p1[c]) / 3;
      // Hermite on [p1, p2] with tangents scaled to the 2-interval segment, at u = .5.
      return 0.5 * p1[c] + 0.5 * p2[c] + 0.125 * (2 * m1) - 0.125 * (2 * m2);
    });
    if (quaternion) {
      normalize(keys[last]);
      alignHemisphere(keys);
    }
    const count = n * resample;
    const times = new Float32Array(count + 1);
    const values = new Float32Array((count + 1) * size);
    for (let s = 0; s <= count; s++) {
      const u = s / resample,
        i = Math.floor(u) % n,
        t = u - Math.floor(u);
      const a = keys[(i - 1 + n) % n],
        b = keys[i],
        c = keys[(i + 1) % n],
        d = keys[(i + 2) % n];
      const out = b.map((_, k) => monotoneCubic(a[k], b[k], c[k], d[k], t));
      if (quaternion) normalize(out);
      times[s] = (s / count) * duration;
      values.set(s === count ? values.slice(0, size) : out, s * size);
    }
    track.times = times;
    track.values = values;
  }
  return clip;
}

/**
 * Uniform cubic Hermite between b and c with Steffen's monotone tangents: C1, and
 * never overshoots the neighbouring authored values. A plain Catmull-Rom spline dipped
 * a planted hind hoof up to 30 mm below its authored stance between keys.
 */
function monotoneCubic(a: number, b: number, c: number, d: number, t: number) {
  const tangent = (left: number, right: number) =>
    (Math.sign(left) + Math.sign(right)) *
    Math.min(Math.abs(left), Math.abs(right), 0.25 * Math.abs(left + right));
  const m1 = tangent(b - a, c - b),
    m2 = tangent(c - b, d - c);
  const t2 = t * t,
    t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * b + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * c + (t3 - t2) * m2
  );
}
function normalize(q: number[]) {
  const length = Math.hypot(...q) || 1;
  for (let i = 0; i < q.length; i++) q[i] /= length;
}
/** Keep consecutive quaternions in one hemisphere so component splines take the short path. */
function alignHemisphere(keys: number[][]) {
  for (let i = 1; i < keys.length; i++) {
    const dot = keys[i].reduce((sum, v, k) => sum + v * keys[i - 1][k], 0);
    if (dot < 0) for (let k = 0; k < keys[i].length; k++) keys[i][k] = -keys[i][k];
  }
}

/** Largest change of angular (or linear) speed between consecutive intervals, per track. */
export function seamIrregularity(clip: THREE.AnimationClip, samples = 520) {
  const results: { name: string; seam: number; elsewhere: number }[] = [];
  for (const track of clip.tracks) {
    if (track.times.length < 4) continue;
    const size = track.getValueSize();
    const interpolant =
      size === 4
        ? new THREE.QuaternionLinearInterpolant(track.times, track.values, 4, new Float32Array(4))
        : new THREE.LinearInterpolant(track.times, track.values, size, new Float32Array(size));
    const value = (time: number) => Array.from(interpolant.evaluate(time) as Float32Array);
    const step = clip.duration / samples;
    const distance = (a: number[], b: number[]) =>
      size === 4
        ? 2 * Math.acos(Math.min(1, Math.abs(a.reduce((s, v, i) => s + v * b[i], 0))))
        : Math.hypot(...a.map((v, i) => v - b[i]));
    const speeds: number[] = [];
    for (let s = 0; s < samples; s++)
      speeds.push(distance(value(s * step), value(((s + 1) % samples) * step)) / step);
    let seam = 0,
      elsewhere = 0;
    for (let s = 0; s < samples; s++) {
      const change = Math.abs(speeds[s] - speeds[(s + samples - 1) % samples]);
      const nearSeam = s < samples * 0.04 || s > samples * 0.88;
      if (nearSeam) seam = Math.max(seam, change);
      else elsewhere = Math.max(elsewhere, change);
    }
    results.push({ name: track.name, seam, elsewhere });
  }
  return results;
}
