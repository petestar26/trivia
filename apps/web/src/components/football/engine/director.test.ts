import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ACTOR_COUNT,
  GOAL_SEQUENCE,
  PITCH,
  REFEREE,
  directorFrame,
  type DirectorInput,
  type Frame,
  type ReleasedGoal,
} from './director';
import { KICK, poseKick } from './poses';
import { createRig, kitFromClub, lookGeometry } from './rig';

const status = (t: number): DirectorInput['status'] =>
  t < 0
    ? 'SCHEDULED'
    : t < 28
      ? 'FIRST_HALF'
      : t < 32
        ? 'HALFTIME'
        : t < 60
          ? 'SECOND_HALF'
          : 'FULL_TIME';
const input = (t: number, goals: ReleasedGoal[], key = 'vf-s1-w01-f01'): DirectorInput => ({
  matchKey: key,
  elapsedMs: Math.round(t * 1000),
  status: status(t),
  goals: goals.filter((g) => g.atMs <= t * 1000),
  fullTime:
    t >= 60
      ? {
          home: goals.filter((g) => g.side === 'H').length,
          away: goals.filter((g) => g.side === 'A').length,
        }
      : null,
});
const GOALS: ReleasedGoal[] = [
  { n: 1, side: 'H', atMs: 6000 },
  { n: 2, side: 'A', atMs: 19500 },
  { n: 3, side: 'H', atMs: 40000 },
  { n: 4, side: 'H', atMs: 44500 },
  { n: 5, side: 'A', atMs: 58500 },
];
// The net is the box between the goal line and the back of the netting, between the posts, under the bar.
const inNet = (b: Frame['ball']) =>
  Math.abs(b.x) > PITCH.halfLength &&
  Math.abs(b.x) < PITCH.halfLength + PITCH.goalDepth &&
  Math.abs(b.z) < PITCH.goalHalfWidth &&
  b.y < PITCH.goalHeight;
const frames = (goals: ReleasedGoal[], key?: string, step = 0.05) => {
  const out: Array<{ t: number; f: Frame }> = [];
  for (let t = -1; t <= 62; t += step) out.push({ t, f: directorFrame(input(t, goals, key)) });
  return out;
};

describe('director purity', () => {
  it('is a deterministic function of its input', () => {
    for (const t of [-1, 0, 3.3, 12.5, 29, 33, 41.2, 59.9, 61])
      expect(directorFrame(input(t, GOALS))).toEqual(directorFrame(input(t, GOALS)));
  });

  it('cannot depend on a goal that has not been released (non-interference)', () => {
    // The director only ever receives released goals, so a frame must be identical whether or
    // not later goals exist in the world.
    const sampleTimes = Array.from({ length: 60 }, (_, i) => i * 1.01 + 0.07);
    for (const t of sampleTimes) {
      const withFuture = directorFrame(input(t, GOALS));
      const released = GOALS.filter((g) => g.atMs <= t * 1000);
      const withoutFuture = directorFrame({ ...input(t, []), goals: released });
      expect(withFuture).toEqual(withoutFuture);
    }
    // And a different future produces the same present.
    const alt: ReleasedGoal[] = [
      { n: 1, side: 'H', atMs: 6000 },
      { n: 2, side: 'H', atMs: 31000 },
    ];
    for (const t of [1, 3, 5.9, 6.0, 8, 11, 17, 19.4])
      expect(directorFrame(input(t, GOALS))).toEqual(directorFrame(input(t, alt)));
  });

  it('starts a goal sequence only at or after the released goal time', () => {
    for (const { t, f } of frames(GOALS)) {
      const goalNow = f.goal;
      if (goalNow) {
        const g = GOALS.find((x) => x.n === goalNow.n)!;
        expect(t * 1000).toBeGreaterThanOrEqual(g.atMs - 1);
        expect(goalNow.t).toBeGreaterThanOrEqual(0);
        expect(goalNow.t).toBeLessThan(GOAL_SEQUENCE.length + 1e-9);
      }
    }
    // With no goals there is never a goal sequence.
    for (const { f } of frames([])) {
      expect(f.mode).not.toBe('GOAL');
      expect(f.goal).toBeNull();
    }
  });
});

describe('goals and the ball', () => {
  it('shows exactly one sequence per released goal, and the ball enters the right goal at the moment', () => {
    for (const goal of GOALS) {
      const half = goal.atMs >= 32000 ? 2 : 1;
      const dir = (goal.side === 'H') === (half === 1) ? 1 : -1;
      const seen: Frame[] = [];
      for (let tg = 0; tg < GOAL_SEQUENCE.length; tg += 0.02) {
        const f = directorFrame(input(goal.atMs / 1000 + tg, GOALS));
        expect(f.mode).toBe('GOAL');
        expect(f.goal!.n).toBe(goal.n);
        expect(f.goal!.side).toBe(goal.side);
        seen.push(f);
      }
      const before = seen.filter((f) => !f.goal!.scored);
      const after = seen.filter((f) => f.goal!.scored);
      expect(before.length).toBeGreaterThan(80);
      expect(after.length).toBeGreaterThan(80);
      expect(Math.abs(before.at(-1)!.goal!.t - GOAL_SEQUENCE.moment)).toBeLessThan(0.03);
      // Before the moment the ball is outside the goal; afterwards it is inside the scoring end.
      // (The ball reaches the goal line a few centiseconds before the sequence moment.)
      for (const f of before.filter((x) => x.goal!.t < GOAL_SEQUENCE.moment - 0.05))
        expect(inNet(f.ball), `ball in net early for goal ${goal.n} at ${f.goal!.t}`).toBe(false);
      const settled = after.at(-1)!;
      expect(Math.sign(settled.ball.x)).toBe(dir);
      expect(Math.abs(settled.ball.x)).toBeGreaterThan(PITCH.halfLength);
      expect(Math.abs(settled.ball.z)).toBeLessThan(PITCH.goalHalfWidth + 0.2);
      expect(settled.goal!.net).not.toBeNull();
      expect(before.every((f) => f.goal!.net === null)).toBe(true);
    }
  });

  it('keeps the ball out of both nets whenever no goal has been released, across many matches', () => {
    for (let m = 0; m < 10; m++) {
      for (const { t, f } of frames([], `vf-s${m + 1}-w0${(m % 9) + 1}-f0${(m % 9) + 1}`, 0.02)) {
        expect(inNet(f.ball), `decorative ball in the net at ${t} (match ${m})`).toBe(false);
        expect(f.mode).not.toBe('GOAL');
      }
    }
  });

  it('only lets the ball into the net during a released goal sequence', () => {
    for (const { t, f } of frames(GOALS, 'vf-s3-w04-f07', 0.04))
      if (inNet(f.ball)) expect(f.mode, `net at ${t}`).toBe('GOAL');
  });

  it('plays decorative shots that are saved, wide or over, never scored', () => {
    let saves = 0;
    let misses = 0;
    for (let m = 0; m < 12; m++) {
      let diving = false;
      let beyond = false;
      for (const { f } of frames([], `shots-${m}`, 0.05)) {
        if (f.actors.some((a, i) => (i === 0 || i === 11 ? a.anim.kind === 'keeperDive' : false)))
          diving = true;
        if (Math.abs(f.ball.x) > PITCH.halfLength) {
          beyond = true;
          // Behind the goal line the ball is outside the posts, above the bar, or behind the netting.
          expect(inNet(f.ball)).toBe(false);
        }
      }
      saves += diving ? 1 : 0;
      misses += beyond ? 1 : 0;
    }
    expect(saves).toBeGreaterThan(2);
    expect(misses).toBeGreaterThan(2);
  });
});

describe('actors', () => {
  it('stay on the pitch, move at human speeds, and never jump within a play epoch', () => {
    for (const key of ['vf-s1-w01-f01', 'vf-s2-w05-f09']) {
      let prev: Frame | null = null;
      let prevT = 0;
      for (const { t, f } of frames(GOALS, key, 0.05)) {
        expect(f.actors).toHaveLength(ACTOR_COUNT);
        for (const [i, a] of f.actors.entries()) {
          expect(Number.isFinite(a.x + a.z + a.heading + a.speed), `actor ${i} at ${t}`).toBe(true);
          expect(Math.abs(a.x)).toBeLessThanOrEqual(PITCH.halfLength + 6);
          expect(Math.abs(a.z)).toBeLessThanOrEqual(PITCH.halfWidth + 3);
          expect(a.speed).toBeLessThanOrEqual(9.6);
          if (
            prev &&
            prev.mode === f.mode &&
            f.mode === 'PLAY' &&
            f.half === prev.half &&
            i !== REFEREE
          ) {
            const jump = Math.hypot(a.x - prev.actors[i].x, a.z - prev.actors[i].z);
            // 12 m/s is above any sprint, plus a little for kick-pose root placement.
            expect(jump, `actor ${i} jumped ${jump.toFixed(2)} m at ${t.toFixed(2)}`).toBeLessThan(
              12 * (t - prevT) + 0.5
            );
          }
        }
        prev = f;
        prevT = t;
      }
    }
  });

  it('has each side attacking opposite ends, swapping at the second half', () => {
    const first = directorFrame(input(1, []));
    const second = directorFrame(input(40, []));
    const homeKeeperFirst = first.actors[0].x;
    const homeKeeperSecond = second.actors[0].x;
    expect(Math.sign(homeKeeperFirst)).toBe(-Math.sign(homeKeeperSecond));
    expect(Math.sign(first.actors[0].x)).toBe(-Math.sign(first.actors[11].x));
  });

  it('shows full-time reactions only once the final score is known', () => {
    const live = directorFrame(input(59, [{ n: 1, side: 'H', atMs: 10000 }]));
    expect(live.mode).not.toBe('POST');
    const over = directorFrame(input(61, [{ n: 1, side: 'H', atMs: 10000 }]));
    expect(over.mode).toBe('POST');
    expect(over.actors[1].anim.kind).toBe('celebrate');
    expect(over.actors[12].anim).toMatchObject({ kind: 'celebrate', celebration: 'DEJECTED' });
  });

  it("puts the ball where the kicker's boot meets it at every kick contact", () => {
    const rig = createRig(
      new THREE.MeshBasicMaterial(),
      lookGeometry({
        kit: kitFromClub({ primary: '#f00', secondary: '#fff', pattern: 'solid' }),
        skin: '#d99c73',
        hair: '#222',
      }).geometry
    );
    let checked = 0;
    for (const key of ['vf-s1-w01-f01', 'vf-s4-w11-f03', 'vf-s8-w02-f06']) {
      let lastKickT = -9;
      for (let t = 1; t < 28; t += 0.01) {
        const f = directorFrame(input(t, [], key));
        for (const [i, actor] of f.actors.entries()) {
          if (
            actor.anim.kind !== 'kick' ||
            Math.abs(actor.anim.t - KICK.contact) > 0.006 ||
            t - lastKickT < 0.5
          )
            continue;
          lastKickT = t;
          rig.root.position.set(actor.x, 0, actor.z);
          rig.root.rotation.y = Math.atan2(actor.anim.spec.dir.x, actor.anim.spec.dir.z);
          poseKick(rig, actor.anim.t, actor.anim.spec);
          const toe = rig.bones[actor.anim.spec.foot === 'R' ? 'toeR' : 'toeL'].getWorldPosition(
            new THREE.Vector3()
          );
          expect(
            toe.distanceTo(new THREE.Vector3(f.ball.x, f.ball.y, f.ball.z)),
            `actor ${i} at ${t.toFixed(2)}`
          ).toBeLessThan(0.3);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
    rig.dispose();
  });
});

describe('camera and crowd', () => {
  it('follows the ball in the broadcast view and cuts to the goal during a sequence', () => {
    const play = directorFrame(input(5, []));
    expect(play.camera.y).toBeGreaterThan(10);
    expect(Math.abs(play.camera.x - play.ball.x)).toBeLessThan(PITCH.halfLength * 0.4);
    const goal = directorFrame(input(7, GOALS));
    expect(goal.mode).toBe('GOAL');
    expect(goal.camera.y).toBeLessThan(10);
    for (const { f } of frames(GOALS, undefined, 0.5)) {
      expect(f.crowd).toBeGreaterThanOrEqual(0);
      expect(f.crowd).toBeLessThanOrEqual(1);
      expect(Math.abs(f.camera.x)).toBeLessThanOrEqual(PITCH.halfLength + 30);
    }
  });
});
