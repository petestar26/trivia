/** Presentation only. No outcome, odds or settlement logic belongs in this module. */
export const STRIDE_SECONDS = 0.74;
export const CONTACT_FRACTION = 0.22;
// Right hind, left hind, right fore, left fore: four distinct contacts, then suspension.
export const FOOTFALLS = [0, 0.14, 0.4, 0.54] as const;
const tau = Math.PI * 2;
export function gallopPose(seconds: number, horse: number, moving: boolean) {
  const cycle = moving ? (((seconds / STRIDE_SECONDS + horse * 0.173) % 1) + 1) % 1 : 0;
  const bounce = moving ? 0.045 + (0.09 * (1 + Math.sin(cycle * tau - 1.1))) / 2 : 0.24;
  const feet = FOOTFALLS.map((offset, leg) => {
    if (!moving) return { x: leg < 2 ? -0.12 : 0.12, y: 0.12 - bounce, contact: true };
    const phase = (cycle - offset + 1) % 1;
    const contact = phase < CONTACT_FRACTION;
    const swing = (phase - CONTACT_FRACTION) / (1 - CONTACT_FRACTION);
    // A planted hoof travels backwards relative to the body. Recovery folds it up
    // and brings it forwards; no four independent sine-wave paddles.
    const x = contact
      ? 0.52 - (phase / CONTACT_FRACTION) * 1.04
      : -0.52 + (0.5 - Math.cos(swing * Math.PI) / 2) * 1.04;
    const lift = contact ? 0 : Math.pow(Math.sin(swing * Math.PI), 2) * (leg < 2 ? 0.72 : 0.93);
    return { x, y: 0.12 + lift - bounce, contact };
  });
  return {
    bounce,
    feet,
    neck: moving ? Math.sin(cycle * tau + 0.5) * 0.065 : 0,
    rider: moving ? -Math.sin(cycle * tau - 0.4) * 0.055 : 0,
    tail: moving ? Math.sin(cycle * tau + 1) * 0.12 : 0,
  };
}
/** Two fixed-length bones. Fore knees and hind hocks bend in opposite directions. */
export function legJoint(x: number, y: number, hind: boolean) {
  const upper = 0.86,
    lower = 0.95;
  const distance = Math.min(upper + lower - 0.0001, Math.max(0.01, Math.hypot(x, y)));
  const actual = Math.hypot(x, y);
  const ux = actual ? x / actual : 0,
    uy = actual ? y / actual : -1;
  const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
  const bend = Math.sqrt(Math.max(0, upper * upper - along * along)) * (hind ? -1 : 1);
  return { x: ux * along - uy * bend, y: uy * along + ux * bend };
}
