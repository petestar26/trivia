import { describe, it, expect } from 'vitest';
import { gallopPose, legJoint, STRIDE_SECONDS } from './gallop';

describe('horse locomotion', () => {
  it('has four distinct contacts followed by an airborne phase', () => {
    const landings = [0, 0, 0, 0];
    let airborne = false;
    let previous = gallopPose(-0.001, 0, true).feet;
    for (let t = 0; t < STRIDE_SECONDS; t += 0.001) {
      const pose = gallopPose(t, 0, true);
      airborne ||= pose.feet.every((f) => !f.contact);
      pose.feet.forEach((f, i) => {
        if (f.contact && !previous[i].contact) landings[i]++;
      });
      previous = pose.feet;
    }
    expect(landings).toEqual([1, 1, 1, 1]);
    expect(airborne).toBe(true);
  });
  it('keeps planted hooves at ground height and joints within their fixed lengths for all runners', () => {
    for (let horse = 0; horse < 8; horse++)
      for (let t = 0; t < STRIDE_SECONDS; t += 0.005) {
        const pose = gallopPose(t, horse, true);
        pose.feet.forEach((foot, i) => {
          expect(foot.y + pose.bounce).toBeGreaterThanOrEqual(0.11999);
          if (foot.contact) expect(foot.y + pose.bounce).toBeCloseTo(0.12, 8);
          const y = foot.y - 1.68,
            joint = legJoint(foot.x, y, i < 2);
          expect(Math.hypot(joint.x, joint.y)).toBeCloseTo(0.86, 6);
          expect(Math.hypot(foot.x - joint.x, y - joint.y)).toBeCloseTo(0.95, 6);
        });
      }
  });
  it('has no position jumps at contact transitions or stride wrap', () => {
    for (let t = 0; t < STRIDE_SECONDS; t += 0.0005) {
      const a = gallopPose(t, 0, true),
        b = gallopPose(t + 0.0005, 0, true);
      a.feet.forEach((f, i) => {
        expect(Math.abs(f.x - b.feet[i].x)).toBeLessThan(0.005);
        expect(Math.abs(f.y - b.feet[i].y)).toBeLessThan(0.005);
      });
    }
  });
  it('holds a stable standing pose when motion is disabled', () => {
    expect(gallopPose(0, 0, false)).toEqual(gallopPose(12345, 7, false));
    const standing = gallopPose(0, 0, false);
    expect(standing.feet.every((f) => f.contact)).toBe(true);
    standing.feet.forEach((f) => {
      expect(f.y + standing.bounce).toBeCloseTo(0.12, 8);
      expect(Math.hypot(f.x, f.y - 1.68)).toBeLessThan(1.81);
    });
    expect(legJoint(0, 0, false)).toEqual(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })
    );
    expect(Number.isFinite(legJoint(0, 0, false).x)).toBe(true);
  });
});
