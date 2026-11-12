import { describe, expect, it } from 'vitest';
import {
  boneEnd,
  FOOTFALLS,
  LIMBS,
  limbState,
  poseGreyhound,
  strideFor,
  type LimbName,
} from './gait';

const paw = (limb: (typeof LIMBS)[number]) =>
  (limb.side === 1 ? 'r_' : 'l_') + (limb.rear ? 'hindpaw' : 'forepaw');

describe('rotary gallop', () => {
  it('lands left hind, right hind, right fore, left fore with two flight phases', () => {
    const order = (Object.keys(FOOTFALLS) as LimbName[]).sort(
      (a, b) => FOOTFALLS[a].touch - FOOTFALLS[b].touch
    );
    expect(order).toEqual(['leftHind', 'rightHind', 'rightFore', 'leftFore']);
    const lastHindLift = Math.max(FOOTFALLS.leftHind.lift, FOOTFALLS.rightHind.lift);
    const lastForeLift = Math.max(FOOTFALLS.rightFore.lift, FOOTFALLS.leftFore.lift);
    expect(FOOTFALLS.rightFore.touch).toBeGreaterThan(lastHindLift); // extended flight
    expect(lastForeLift).toBeLessThan(1); // gathered flight before the next hind touchdown
    for (const { touch, lift } of Object.values(FOOTFALLS)) {
      expect(lift - touch).toBeGreaterThan(0.18);
      expect(lift - touch).toBeLessThan(0.3);
    }
  });

  it('keeps every planted toe fixed on the ground while the body travels over it', () => {
    for (const speed of [5.8, 8.4]) {
      const { length } = strideFor(speed);
      for (const limb of LIMBS) {
        const { touch, lift } = FOOTFALLS[limb.name];
        for (let t = 0.05; t < 0.95; t += 0.15) {
          const phase = touch + (lift - touch) * t,
            next = phase + 0.01;
          const a = limbState(limb.name, phase, length),
            b = limbState(limb.name, next, length);
          expect(a.contact && b.contact).toBe(true);
          // World x of the toe = body travel + toe position in the body frame.
          expect(phase * length + a.tip.x).toBeCloseTo(next * length + b.tip.x, 9);
          expect(a.tip.y).toBeCloseTo(0.008, 9);
        }
      }
    }
  });

  it('reaches each planted paw within a centimetre at published race speeds', () => {
    for (const speed of [5.8, 8.4]) {
      const { length } = strideFor(speed);
      for (let i = 0; i < 400; i++) {
        const phase = i / 400,
          pose = poseGreyhound({ phase, speed, run: 1, time: 0 });
        for (const limb of LIMBS) {
          const target = limbState(limb.name, phase, length);
          if (!target.contact) continue;
          const end = boneEnd(pose, paw(limb));
          expect(Math.hypot(end.x - target.tip.x, end.y - target.tip.y)).toBeLessThan(0.0105);
        }
      }
    }
  });

  it('stands square on four paws and stays finite for every speed and phase', () => {
    const stand = poseGreyhound({ phase: 0.3, speed: 0, run: 0, time: 4 });
    for (const limb of LIMBS) expect(boneEnd(stand, paw(limb)).y).toBeLessThan(0.02);
    for (const speed of [0, 2, 6, 9, 12, 16])
      for (let phase = -1; phase < 2; phase += 0.037) {
        const pose = poseGreyhound({ phase, speed, run: Math.min(1, speed / 4), time: phase });
        for (const [name, bone] of Object.entries(pose)) {
          if (name === 'contact') continue;
          const b = bone as { start: { x: number; y: number }; angle: number };
          expect([b.start.x, b.start.y, b.angle].every(Number.isFinite)).toBe(true);
        }
      }
  });

  it('flexes the back in gathered flight and stretches it in extended flight', () => {
    const length = (phase: number) => {
      const pose = poseGreyhound({ phase, speed: 8.4, run: 1, time: 0 });
      return pose.thorax2.start.x - pose.pelvis.start.x;
    };
    expect(length(0.93)).toBeLessThan(length(0.43) - 0.03);
  });
});
