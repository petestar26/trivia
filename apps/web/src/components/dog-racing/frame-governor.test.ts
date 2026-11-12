import { expect, it } from 'vitest';
import { createFrameGovernor, type GovernorDecision } from './frame-governor';

const target = 1000 / 30;
/** Feed `count` frames of a fixed interval; return every decision in order. */
function run(
  governor: ReturnType<typeof createFrameGovernor>,
  clock: { now: number },
  interval: number,
  count: number
) {
  const decisions: GovernorDecision[] = [];
  for (let i = 0; i < count; i++) {
    clock.now += interval;
    const d = governor.sample(interval, clock.now);
    if (d) decisions.push(d);
  }
  return decisions;
}

it('leaves a device that keeps up at full resolution', () => {
  const g = createFrameGovernor({ targetMs: target }),
    clock = { now: 0 };
  expect(run(g, clock, 33.4, 900)).toEqual([]);
  expect(g.scale).toBe(1);
});

it('lowers resolution step by step under sustained overload, then asks for one tier down', () => {
  const g = createFrameGovernor({ targetMs: target }),
    clock = { now: 0 };
  const decisions = run(g, clock, 70, 400);
  const scales = decisions.filter((d) => d.scale).map((d) => +d.scale!.toFixed(3));
  expect(scales).toEqual([0.8, 0.64, 0.6]);
  const tiers = decisions.filter((d) => d.tier);
  expect(tiers.length).toBeGreaterThanOrEqual(1);
  expect(tiers.every((d) => d.tier === 'down')).toBe(true);
  // Never more than one tier request per two overloaded windows plus settling.
  expect(tiers.length).toBeLessThanOrEqual(Math.ceil((400 * 70) / (2 * 1400 + 1500)));
});

it('ignores a short burst of slow frames and the first moments after a change', () => {
  const g = createFrameGovernor({ targetMs: target }),
    clock = { now: 0 };
  run(g, clock, 33.4, 120);
  // Five frames of a garbage-collection pause inside an otherwise healthy window.
  const decisions = [...run(g, clock, 120, 5), ...run(g, clock, 33.4, 200)];
  expect(decisions).toEqual([]);
  g.reset(clock.now);
  expect(run(g, clock, 90, 16)).toEqual([]); // still settling after the reset
});

it('holds steady in the band between headroom and overload (hysteresis)', () => {
  const g = createFrameGovernor({ targetMs: target }),
    clock = { now: 0 };
  // Overload until the first step down to 0.8, then sit between the two thresholds.
  while (g.scale === 1) run(g, clock, 70, 1);
  expect(g.scale).toBeCloseTo(0.8, 6);
  expect(run(g, clock, 42, 900)).toEqual([]);
  expect(g.scale).toBeCloseTo(0.8, 6);
});

it('treats long gaps as pauses, not as slowness', () => {
  const g = createFrameGovernor({ targetMs: target }),
    clock = { now: 0 };
  const decisions: GovernorDecision[] = [];
  for (let i = 0; i < 30; i++) {
    decisions.push(...run(g, clock, 33.4, 25));
    clock.now += 5000;
    const d = g.sample(5000, clock.now); // tab hidden or course scrolled away
    if (d) decisions.push(d);
  }
  expect(decisions).toEqual([]);
});

it('climbs back to full resolution with sustained headroom but never above it', () => {
  const g = createFrameGovernor({ targetMs: target }),
    clock = { now: 0 };
  run(g, clock, 70, 120);
  expect(g.scale).toBeLessThan(1);
  const decisions = run(g, clock, 30, 3000);
  expect(g.scale).toBe(1);
  expect(decisions.every((d) => d.scale !== undefined && d.scale <= 1)).toBe(true);
  expect(decisions.some((d) => d.tier)).toBe(false);
});

it('does not keep probing upward on a device that sits at the threshold', () => {
  // A fill-rate cliff, as measured in software rendering: comfortable up to ~0.72 scale,
  // overloaded above it. Without back-off this probes up and falls back every ~12 s.
  const g = createFrameGovernor({ targetMs: target }),
    clock = { now: 0 };
  const changes: number[] = [];
  for (let i = 0; i < 8000; i++) {
    const interval = g.scale < 0.74 ? 34 : 52;
    clock.now += interval;
    const d = g.sample(interval, clock.now);
    if (d?.scale) changes.push(clock.now);
  }
  // About five minutes of frames: a few early steps, then rare, backed-off probes
  // (without back-off this model makes about 76 changes in the same time).
  expect(clock.now).toBeGreaterThan(240000);
  expect(changes.length).toBeLessThanOrEqual(12);
  const late = changes.filter((t) => t > 120000);
  expect(late.length).toBeLessThanOrEqual(3);
});
