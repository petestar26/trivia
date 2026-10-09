import * as THREE from 'three';
import { DIVE_CONTACT, diveRoot, KICK, kickGeometry, type Celebration, type DiveSpec, type KickSpec } from './poses';

/**
 * The match director is a PURE function of (match key, server-synchronised match time,
 * already-released goals). It holds no state and never sees anything that has not been
 * released: decorative play is derived only from the public fixture id, and a goal sequence
 * starts only at the released goal time. Decorative shots can never end inside the net.
 * Units: metres and seconds. +X is the pitch length, +Z the width, heading 0 faces +Z.
 */
export const PITCH = Object.freeze({
  halfLength: 45,
  halfWidth: 29,
  goalHalfWidth: 3.66,
  goalHeight: 2.44,
  goalDepth: 2.2,
  boxDepth: 16.5,
  boxHalfWidth: 20.15,
});
export const GOAL_SEQUENCE = Object.freeze({
  /** Whole sequence, seconds. Goals are at least 4 s apart so sequences never overlap. */
  length: 4,
  /** When the ball crosses the line, seconds after the goal is released. */
  moment: 2.05,
});
export type TeamId = 'H' | 'A';
export const ACTOR_COUNT = 23; // 11 home, 11 away, referee
export const REFEREE = 22;

export type Anim =
  | { kind: 'idle' }
  | { kind: 'run' }
  | { kind: 'kick'; t: number; spec: KickSpec }
  | { kind: 'keeperReady' }
  | { kind: 'keeperDive'; t: number; spec: DiveSpec; ball: THREE.Vector3 }
  | { kind: 'celebrate'; celebration: Celebration; t: number };
export interface ActorState {
  x: number;
  z: number;
  /** Yaw in radians (0 faces +Z, PI/2 faces +X). */
  heading: number;
  speed: number;
  anim: Anim;
}
export type Mode = 'PRE' | 'PLAY' | 'HALFTIME' | 'POST' | 'GOAL';
export interface Frame {
  actors: ActorState[];
  ball: { x: number; y: number; z: number };
  camera: { x: number; y: number; z: number; lx: number; ly: number; lz: number; fov: number };
  mode: Mode;
  half: 1 | 2;
  /** Present during a goal sequence. */
  goal: {
    n: number;
    side: TeamId;
    /** Seconds since the goal was released. */
    t: number;
    /** True once the ball has crossed the line (the displayed score may flip). */
    scored: boolean;
    net: { x: number; y: number; z: number; t: number } | null;
  } | null;
  /** 0..1 crowd excitement. */
  crowd: number;
}
export interface ReleasedGoal {
  n: number;
  side: TeamId;
  atMs: number;
}
export interface DirectorInput {
  matchKey: string;
  elapsedMs: number;
  status: 'SCHEDULED' | 'FIRST_HALF' | 'HALFTIME' | 'SECOND_HALF' | 'FULL_TIME';
  goals: ReleasedGoal[];
  /** Only known at full time. */
  fullTime: { home: number; away: number } | null;
}

/* ------------------------------------------------------------------------------------- *
 * Small deterministic helpers (public randomness for decoration only)
 * ------------------------------------------------------------------------------------- */
function hash32(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: string) {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (t: number) => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
interface Vec {
  x: number;
  z: number;
}
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.z - b.z);
const norm = (a: Vec, b: Vec): Vec => {
  const d = dist(a, b) || 1;
  return { x: (b.x - a.x) / d, z: (b.z - a.z) / d };
};
const headingOf = (dx: number, dz: number) => Math.atan2(dx, dz);

const attackDir = (team: TeamId, half: 1 | 2): 1 | -1 => ((team === 'H') === (half === 1) ? 1 : -1);
const actorIndex = (team: TeamId, i: number) => (team === 'H' ? i : 11 + i);
const other = (team: TeamId): TeamId => (team === 'H' ? 'A' : 'H');

/* ------------------------------------------------------------------------------------- *
 * Formations
 * ------------------------------------------------------------------------------------- */
const FORMATIONS: Record<TeamId, Array<[number, number]>> = {
  H: [[-0.98, 0], [-0.62, -0.75], [-0.66, -0.27], [-0.66, 0.27], [-0.62, 0.75], [-0.2, -0.8], [-0.14, -0.27], [-0.14, 0.27], [-0.2, 0.8], [0.3, -0.25], [0.3, 0.25]],
  A: [[-0.98, 0], [-0.62, -0.75], [-0.66, -0.27], [-0.66, 0.27], [-0.62, 0.75], [-0.18, 0], [-0.1, -0.5], [-0.1, 0.5], [0.3, -0.65], [0.34, 0], [0.3, 0.65]],
};
const LAG = 0.5; // the team shape also trails the ball a little

function formationPos(team: TeamId, i: number, dir: 1 | -1, anchor: Vec): Vec {
  const [d, l] = FORMATIONS[team][i];
  const depth = clamp((anchor.x * dir) / 43, -1, 1); // ball depth in the team's own terms
  if (i === 0) return { x: dir * (-43 + 4 * (depth + 1)), z: clamp(anchor.z * 0.18, -3, 3) };
  const shifted = clamp(d * 0.88 + 0.42 * depth, -0.95, 0.92);
  const lateral = l * 23 * (1 - 0.15 * Math.abs(depth)) + 0.4 * anchor.z * (1 - 0.5 * Math.abs(l));
  return { x: dir * shifted * 43, z: clamp(lateral, -PITCH.halfWidth + 2, PITCH.halfWidth - 2) };
}

/* ------------------------------------------------------------------------------------- *
 * Decorative play: a deterministic list of beats for an epoch
 * ------------------------------------------------------------------------------------- */
interface Beat {
  kind: 'PASS' | 'LOOSE' | 'SHOT' | 'RESTART';
  team: TeamId; // kicker
  from: number;
  toTeam: TeamId; // receiving team (SHOT: the defending team whose keeper may react)
  to: number;
  tKick: number;
  flight: number;
  /** Ball position at contact. */
  origin: Vec;
  /** Holder position at contact. */
  holder: Vec;
  /** Arrival of the previous beat, i.e. when this holder got the ball. */
  prevArrival: number;
  prevTarget: Vec;
  target: Vec;
  targetY: number;
  arc: number;
  dir: Vec;
  shot?: { outcome: 'SAVED' | 'WIDE' | 'HIGH'; goalX: number };
}
interface Epoch {
  beats: Beat[];
  anchors: Array<{ t: number; p: Vec }>;
  dir: Record<TeamId, 1 | -1>;
  half: 1 | 2;
}
const epochCache = new Map<string, Epoch>();

/**
 * Where the team shape is anchored at time t: the ball's resting positions averaged over the
 * previous AVERAGE seconds. Averaging bounds how fast a formation can move (distance /
 * AVERAGE), so a long ball never makes the whole team lurch faster than people can run.
 */
const AVERAGE = 2.5;
function anchorAt(anchors: Epoch['anchors'], t: number): Vec {
  let x = 0;
  let z = 0;
  const from = t - AVERAGE;
  for (let i = 0; i < anchors.length; i++) {
    const start = Math.max(anchors[i].t, from);
    const end = Math.min(i + 1 < anchors.length ? anchors[i + 1].t : Infinity, t);
    if (end > start) {
      x += anchors[i].p.x * (end - start);
      z += anchors[i].p.z * (end - start);
    }
  }
  return { x: x / AVERAGE, z: z / AVERAGE };
}

function buildEpoch(key: string, startTeam: TeamId, half: 1 | 2): Epoch {
  const cached = epochCache.get(key);
  if (cached) return cached;
  const r = rng(key);
  const dir = { H: attackDir('H', half), A: attackDir('A', half) };
  const beats: Beat[] = [];
  const anchors: Epoch['anchors'] = [{ t: -10, p: { x: 0, z: 0 } }];
  const field = (p: Vec): Vec => ({ x: clamp(p.x, -PITCH.halfLength + 3, PITCH.halfLength - 3), z: clamp(p.z, -PITCH.halfWidth + 2, PITCH.halfWidth - 2) });
  let team = startTeam;
  let holder = 9;
  let pos: Vec = { x: 0, z: 0 };
  let prevArrival = -1;
  let prevTarget: Vec = { x: 0, z: 0 };
  let t = 0;
  for (let i = 0; i < 40 && t < 75; i++) {
    const d = dir[team];
    const depth = (pos.x * d) / 43;
    const hold = i === 0 ? 1.4 : 0.35 + r() * 0.55;
    const tKick = t + hold;
    const holderAtKick: Vec = { x: pos.x + d * Math.min(hold, 0.8) * 1.4, z: pos.z };
    const roll = r();
    let kind: Beat['kind'] = 'PASS';
    if (i > 0 && depth > 0.35 && roll < 0.5) kind = 'SHOT';
    else if (i > 1 && roll > 0.88) kind = 'LOOSE';
    if (kind === 'SHOT') {
      const goalX = d * PITCH.halfLength;
      const outcomeRoll = r();
      const outcome = outcomeRoll < 0.5 ? 'SAVED' : outcomeRoll < 0.8 ? 'WIDE' : 'HIGH';
      const aim = r() * 2 - 1;
      // A miss is defined AT THE GOAL LINE: wide of the post, or above the bar, whatever the
      // shooter's distance. The target lies beyond the line on the same straight path.
      const toLine = Math.max(4, Math.abs(goalX - holderAtKick.x));
      const beyond = outcome === 'WIDE' ? 1.5 : PITCH.goalDepth + 1.5;
      const sLine = toLine / (toLine + beyond);
      let target: Vec;
      let targetY: number;
      if (outcome === 'SAVED') {
        target = { x: goalX - d * 1.0, z: aim * 2.6 };
        targetY = 0.5 + r() * 1.3;
      } else if (outcome === 'WIDE') {
        const zLine = (aim < 0 ? -1 : 1) * (4.4 + r() * 1.4);
        target = { x: goalX + d * beyond, z: holderAtKick.z + (zLine - holderAtKick.z) / sLine };
        targetY = 0.5 + r() * 0.9;
      } else {
        const yLine = PITCH.goalHeight + 0.5 + r() * 0.6;
        target = { x: goalX + d * beyond, z: aim * 2.8 };
        targetY = 0.11 + (yLine - 0.11 - 4 * 0.15 * sLine * (1 - sLine)) / sLine;
      }
      const dd = norm(holderAtKick, target);
      const origin = { x: holderAtKick.x + dd.x * 0.45, z: holderAtKick.z + dd.z * 0.45 };
      const flight = clamp(dist(origin, target) / 22, 0.5, 0.78);
      beats.push({ kind, team, from: holder, toTeam: other(team), to: 0, tKick, flight, origin, holder: holderAtKick, prevArrival, prevTarget, target, targetY, arc: 0.15, dir: dd, shot: { outcome, goalX } });
      // The defending keeper restarts play.
      const defTeam = other(team);
      const dd2 = dir[defTeam];
      const spot: Vec = outcome === 'SAVED' ? { x: goalX - d * 1.4, z: clamp(target.z, -3, 3) } : { x: goalX - d * 5.5, z: (r() < 0.5 ? -1 : 1) * 6 };
      const tRestart = tKick + flight + (outcome === 'SAVED' ? 1.7 : 2.3);
      const longBall = r() < 0.4;
      const candidates = longBall ? [9, 10, 8, 5] : [2, 3, 6, 7, 1, 4];
      const to = candidates[Math.floor(r() * candidates.length)];
      const arrivalT = tRestart + clamp(0, 0, 0) + (longBall ? 1.9 : 1.5);
      const f = formationPos(defTeam, to, dd2, anchorAt(anchors, arrivalT - LAG));
      const a = field(f);
      const dd3 = norm(spot, a);
      const origin2 = { x: spot.x + dd3.x * 0.4, z: spot.z + dd3.z * 0.4 };
      beats.push({ kind: 'RESTART', team: defTeam, from: 0, toTeam: defTeam, to, tKick: tRestart, flight: longBall ? 1.9 : 1.5, origin: origin2, holder: spot, prevArrival: tKick + flight, prevTarget: target, target: a, targetY: 0.11, arc: longBall ? 8 : 1.2, dir: dd3 });
      anchors.push({ t: arrivalT, p: a });
      team = defTeam;
      holder = to;
      pos = a;
      prevArrival = arrivalT;
      prevTarget = a;
      t = arrivalT;
      continue;
    }
    // PASS / LOOSE: choose a receiver whose formation spot is near and, usually, ahead.
    const mates = kind === 'LOOSE' ? other(team) : team;
    const md = dir[mates];
    const aimAhead: Vec = { x: holderAtKick.x + d * 10, z: holderAtKick.z };
    const probe = tKick + 1.3 - LAG;
    const pool = [];
    for (let j = depth < -0.6 ? 0 : 1; j < 11; j++) {
      if (mates === team && j === holder) continue;
      const f = formationPos(mates, j, md, anchorAt(anchors, probe));
      pool.push({ j, f, score: dist(f, kind === 'LOOSE' ? aimAhead : holderAtKick) });
    }
    pool.sort((p, q) => p.score - q.score);
    const near = pool.filter((p) => p.score > 6).slice(0, 4);
    const pick = near[Math.floor(r() * Math.max(1, near.length))] ?? pool[0];
    const targetPos = field(pick.f);
    const dd = norm(holderAtKick, targetPos);
    const origin = { x: holderAtKick.x + dd.x * 0.45, z: holderAtKick.z + dd.z * 0.45 };
    const length = dist(origin, targetPos);
    const flight = clamp(length / 14, 1.0, 1.7);
    const lofted = length > 22 || r() < 0.2;
    beats.push({ kind, team, from: holder, toTeam: mates, to: pick.j, tKick, flight, origin, holder: holderAtKick, prevArrival, prevTarget, target: targetPos, targetY: 0.11, arc: lofted ? Math.min(6, length * 0.2) : 0.25, dir: dd });
    anchors.push({ t: tKick + flight, p: targetPos });
    prevArrival = tKick + flight;
    prevTarget = targetPos;
    team = mates;
    holder = pick.j;
    pos = targetPos;
    t = tKick + flight;
  }
  const epoch: Epoch = { beats, anchors, dir, half };
  if (epochCache.size > 48) epochCache.clear();
  epochCache.set(key, epoch);
  return epoch;
}

function ballInEpoch(e: Epoch, t: number): { x: number; y: number; z: number } {
  const { beats } = e;
  let j = -1;
  for (let i = 0; i < beats.length && beats[i].tKick <= t; i++) j = i;
  const next = beats[j + 1];
  if (j < 0) {
    // The ball waits on the centre spot, then is played from the first holder's feet.
    if (!next) return { x: 0, y: 0.11, z: 0 };
    const s = smooth((t - (next.tKick - 0.6)) / 0.5);
    return { x: lerp(0, next.origin.x, s), y: 0.11, z: lerp(0, next.origin.z, s) };
  }
  const b = beats[j];
  const tf = t - b.tKick;
  if (tf < b.flight) {
    const s = tf / b.flight;
    const rise = b.kind === 'SHOT' ? s : s * s;
    const y = 0.11 + (b.targetY - 0.11) * rise + 4 * b.arc * s * (1 - s);
    return { x: lerp(b.origin.x, b.target.x, s), y: Math.max(0.11, y), z: lerp(b.origin.z, b.target.z, s) };
  }
  const arrival = b.tKick + b.flight;
  if (!next) return { x: b.target.x, y: b.kind === 'SHOT' ? 0.12 : 0.11, z: b.target.z };
  if (b.kind === 'SHOT' && b.shot!.outcome !== 'SAVED') {
    // A miss runs out of play behind the goal; it is fetched and placed for the goal kick.
    // It is never carried back through the goal mouth.
    const placed = t >= next.tKick - 0.7;
    return placed ? { x: next.origin.x, y: 0.11, z: next.origin.z } : { x: b.target.x, y: b.targetY > 1 ? lerp(b.targetY, 0.11, smooth((t - arrival) / 0.9)) : 0.11, z: b.target.z };
  }
  // Until the next kick the ball is controlled (a keeper holds a save), then carried to the spot.
  const wait = b.kind === 'SHOT' ? 0.55 : 0;
  const s = smooth((t - (arrival + wait)) / Math.max(0.2, next.tKick - 0.1 - (arrival + wait)));
  const rest = b.kind === 'SHOT' ? lerp(b.targetY, 0.13, smooth((t - arrival) / 0.35)) : 0.11;
  return { x: lerp(b.target.x, next.origin.x, s), y: lerp(rest, 0.11, s), z: lerp(b.target.z, next.origin.z, s) };
}

interface PlayActor {
  pos: Vec;
  anim?: Anim;
  facing?: Vec;
}

/** Position (and any scripted animation) of a team member inside an epoch at epoch time t. */
function playActor(e: Epoch, team: TeamId, i: number, t: number): PlayActor {
  const dir = e.dir[team];
  const base = formationPos(team, i, dir, anchorAt(e.anchors, t - LAG));
  const { beats } = e;
  let j = -1;
  for (let k = 0; k < beats.length && beats[k].tKick <= t; k++) j = k;
  for (let k = Math.max(0, j - 1); k <= Math.min(beats.length - 1, j + 1); k++) {
    const b = beats[k];
    // Holder window: from receiving the ball until a moment after the kick.
    if (b.team === team && b.from === i && t >= b.prevArrival && t <= b.tKick + 1.7) {
      const spec: KickSpec = {
        ball: new THREE.Vector3(b.origin.x, 0.11, b.origin.z),
        dir: new THREE.Vector3(b.dir.x, 0, b.dir.z).normalize(),
        foot: b.dir.z >= 0 ? 'R' : 'L',
        power: b.kind === 'SHOT' ? 1 : b.kind === 'RESTART' ? 0.9 : 0.55,
        loft: b.arc > 1 ? 1 : 0.1,
      };
      const tk = t - (b.tKick - KICK.contact);
      if (tk >= 0 && tk <= KICK.duration) {
        const g = kickGeometry(spec);
        return { pos: { x: g.root.x, z: g.root.z }, anim: { kind: 'kick', t: tk, spec }, facing: b.dir };
      }
      if (t < b.tKick) {
        // Receive, then drift forward with the ball until the kick starts.
        const s = smooth((t - b.prevArrival) / Math.max(0.05, b.tKick - KICK.contact - b.prevArrival));
        return { pos: { x: lerp(b.prevTarget.x, b.holder.x, s), z: lerp(b.prevTarget.z, b.holder.z, s) }, facing: b.dir };
      }
      // After the kick the player eases back into the team shape.
      const s = smooth((t - (b.tKick + KICK.duration - KICK.contact)) / 1.0);
      return { pos: { x: lerp(b.holder.x, base.x, s), z: lerp(b.holder.z, base.z, s) }, facing: s < 1 ? b.dir : undefined };
    }
    // Receiver window: runs onto the ball.
    if (b.toTeam === team && b.to === i && b.kind !== 'SHOT' && t >= b.tKick && t <= b.tKick + b.flight) {
      const s = smooth((t - b.tKick) / b.flight);
      const start = formationPos(team, i, dir, anchorAt(e.anchors, b.tKick - LAG));
      return { pos: { x: lerp(start.x, b.target.x, s), z: lerp(start.z, b.target.z, s) } };
    }
    // The defending keeper reacts to a shot.
    if (b.kind === 'SHOT' && b.toTeam === team && i === 0 && t >= b.tKick && t <= b.tKick + b.flight + 1.6) {
      const keeper = formationPos(team, 0, dir, anchorAt(e.anchors, b.tKick - LAG));
      const out = b.shot!.outcome;
      if (out === 'SAVED') {
        const start = b.tKick + b.flight - DIVE_CONTACT;
        const td = t - start;
        const dz = b.target.z - keeper.z;
        const heading = headingOf(-dir, 0);
        const lateral = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
        const direction: 1 | -1 = lateral.z * dz >= 0 ? 1 : -1;
        const spec: DiveSpec = { direction, reach: clamp(Math.abs(dz), 0.8, 3.2), height: b.targetY };
        if (td >= 0) {
          const off = diveRoot(spec, td);
          const world = new THREE.Vector3(off.x, 0, off.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), heading);
          const ball = ballInEpoch(e, t);
          return { pos: { x: keeper.x + world.x, z: keeper.z + world.z }, anim: { kind: 'keeperDive', t: td, spec, ball: new THREE.Vector3(ball.x, ball.y, ball.z) }, facing: { x: -dir, z: 0 } };
        }
      }
      return { pos: keeper, anim: { kind: 'keeperReady' }, facing: { x: -dir, z: 0 } };
    }
  }
  return { pos: base };
}

/* ------------------------------------------------------------------------------------- *
 * Goal sequences
 * ------------------------------------------------------------------------------------- */
type Key = [number, number, number];
function pathAt(keys: Key[], t: number): { x: number; z: number; vx: number; vz: number } {
  if (t <= keys[0][0]) return { x: keys[0][1], z: keys[0][2], vx: 0, vz: 0 };
  for (let i = 1; i < keys.length; i++)
    if (t <= keys[i][0]) {
      const [t0, x0, z0] = keys[i - 1];
      const [t1, x1, z1] = keys[i];
      const s = (t - t0) / (t1 - t0 || 1);
      return { x: lerp(x0, x1, s), z: lerp(z0, z1, s), vx: (x1 - x0) / (t1 - t0 || 1), vz: (z1 - z0) / (t1 - t0 || 1) };
    }
  const last = keys[keys.length - 1];
  return { x: last[1], z: last[2], vx: 0, vz: 0 };
}

interface GoalFrame {
  actors: Map<number, ActorState>;
  ball: { x: number; y: number; z: number };
  net: { x: number; y: number; z: number; t: number } | null;
  camera: Frame['camera'];
  scored: boolean;
  crowd: number;
}

/**
 * A scripted goal. Two variants (cross and volley, through-ball and placed finish) are timed
 * so the ball crosses the line at exactly GOAL_SEQUENCE.moment seconds after release. Which
 * wing, which corner and which variant are drawn from the public fixture id and goal number.
 */
function goalSequence(matchKey: string, goal: ReleasedGoal, half: 1 | 2, t: number): GoalFrame {
  const r = rng(`${matchKey}|goal|${goal.n}`);
  const a = attackDir(goal.side, half); // the direction the scoring team attacks
  const gx = a * PITCH.halfLength;
  const w = r() < 0.5 ? -1 : 1; // the wing the move comes down
  const cross = r() < 0.5;
  const farSide = -w; // the corner the shot is placed in
  const att = goal.side;
  const def = other(goal.side);
  const A = (i: number) => actorIndex(att, i);
  const D = (i: number) => actorIndex(def, i);
  const M = GOAL_SEQUENCE.moment;
  const actors = new Map<number, ActorState>();
  const put = (idx: number, p: { x: number; z: number; vx?: number; vz?: number }, anim: Anim, facing?: Vec) => {
    const speed = Math.hypot(p.vx ?? 0, p.vz ?? 0);
    const heading = facing ? headingOf(facing.x, facing.z) : speed > 0.3 ? headingOf(p.vx!, p.vz!) : headingOf(-a, 0);
    actors.set(idx, { x: p.x, z: p.z, heading, speed, anim });
  };

  // --- geometry and timing -----------------------------------------------------------
  const strike: Vec = cross ? { x: gx - a * 11.4, z: w * 0.4 } : { x: gx - a * 13, z: -w * 3 };
  const corner: Vec = { x: gx + a * 0.3, z: farSide * 3.1 };
  const cornerY = cross ? 1.9 : 0.35;
  const speed = cross ? 25 : 22;
  const flight = Math.hypot(corner.x - strike.x, corner.z - strike.z) / speed;
  const kickAt = M - flight; // the finisher's boot meets the ball here
  const strikeY = cross ? 0.5 : 0.11;
  const shotDir = new THREE.Vector3(corner.x - strike.x, 0, corner.z - strike.z).normalize();
  const shot: KickSpec = { ball: new THREE.Vector3(strike.x, strikeY, strike.z), dir: shotDir, foot: shotDir.z >= 0 ? 'R' : 'L', power: 1, loft: cross ? 0.4 : 0 };
  const shotRoot = kickGeometry(shot).root;
  const passerStart: Vec = cross ? { x: gx - a * 24, z: w * 21 } : { x: gx - a * 33, z: w * 4 };
  const passAt = cross ? 0.45 : 0.3; // the cross / through-ball is struck here
  const passBall: Vec = { x: passerStart.x + a * 0.4, z: passerStart.z };
  const passDir = new THREE.Vector3(strike.x - passBall.x, 0, strike.z - passBall.z).normalize();
  const pass: KickSpec = { ball: new THREE.Vector3(passBall.x, 0.11, passBall.z), dir: passDir, foot: 'R', power: 0.9, loft: cross ? 1 : 0.1 };
  const passRoot = kickGeometry(pass).root;
  const group: Vec = { x: gx - a * 17, z: w * 6 }; // where the celebration gathers
  /** The start point from which running at `speed` along (dx, dz) arrives at `target` after `seconds`. */
  const arriveFrom = (target: Vec, dx: number, dz: number, seconds: number, speed = 6.5): Vec => {
    const n = Math.hypot(dx, dz) || 1;
    return { x: target.x - (dx / n) * speed * seconds, z: target.z - (dz / n) * speed * seconds };
  };

  // --- the ball ----------------------------------------------------------------------
  const ball = { x: passBall.x, y: 0.11, z: passBall.z };
  let net: GoalFrame['net'] = null;
  if (t >= passAt && t < kickAt) {
    const s = (t - passAt) / (kickAt - passAt);
    ball.x = lerp(passBall.x, strike.x, s);
    ball.z = lerp(passBall.z, strike.z, s);
    ball.y = cross ? lerp(0.11, strikeY, s) + 3.4 * 4 * s * (1 - s) : 0.11;
  } else if (t >= kickAt) {
    const s = Math.min(1, (t - kickAt) / flight);
    ball.x = lerp(strike.x, corner.x, s);
    ball.z = lerp(strike.z, corner.z, s);
    ball.y = lerp(strikeY, cornerY, s);
    if (s >= 1) {
      // Into the netting, which carries it a little further before it drops.
      const since = t - M;
      ball.x = corner.x + a * 1.3 * smooth(since / 0.5);
      ball.z = corner.z + farSide * 0.2 * smooth(since / 0.5);
      ball.y = Math.max(0.11, cornerY * (1 - smooth(since / 0.9)) + 0.11);
      net = { x: corner.x + a * 0.6, y: cornerY, z: corner.z, t: since };
    }
  }

  // --- the passer (winger or midfielder) ---------------------------------------------------
  const passerIdx = cross ? (w > 0 ? 8 : 5) : 6;
  {
    const tk = t - (passAt - KICK.contact);
    if (tk < 0) put(A(passerIdx), passerStart, { kind: 'idle' }, { x: passDir.x, z: passDir.z });
    else if (tk <= KICK.duration) put(A(passerIdx), { x: passRoot.x, z: passRoot.z }, { kind: 'kick', t: tk, spec: pass }, { x: passDir.x, z: passDir.z });
    else {
      const t0 = passAt - KICK.contact + KICK.duration;
      const p = pathAt([[t0, passRoot.x, passRoot.z], [3.4, group.x - a * 2, group.z + w * 4]], t);
      put(A(passerIdx), p, t > 3.2 ? { kind: 'celebrate', celebration: 'HUG', t } : { kind: 'run' });
    }
  }
  // --- the scorer ------------------------------------------------------------------------
  {
    const start = arriveFrom({ x: shotRoot.x, z: shotRoot.z }, a, (cross ? 0.3 : 0.4) * w, kickAt - KICK.contact);
    const tk = t - (kickAt - KICK.contact);
    if (tk < 0) {
      const p = pathAt([[0, start.x, start.z], [kickAt - KICK.contact, shotRoot.x, shotRoot.z]], t);
      put(A(9), p, { kind: 'run' });
    } else if (tk <= KICK.duration) put(A(9), { x: shotRoot.x, z: shotRoot.z }, { kind: 'kick', t: tk, spec: shot }, { x: shotDir.x, z: shotDir.z });
    else {
      // Celebration run, arms up, then a knee slide towards the camera.
      const t0 = kickAt - KICK.contact + KICK.duration;
      const slideAt = 3.35;
      const p = pathAt([[t0, shotRoot.x, shotRoot.z], [slideAt, group.x, group.z]], t);
      if (t >= slideAt) put(A(9), { x: group.x + a * (t - slideAt) * 1.6, z: group.z + w * (t - slideAt) * 1.6 }, { kind: 'celebrate', celebration: 'KNEE_SLIDE', t: t - slideAt }, { x: 0.3 * a, z: 1 });
      else put(A(9), p, { kind: 'celebrate', celebration: 'ARMS_UP', t });
    }
  }
  // --- supporting forward and the rest of the attack ------------------------------------------
  {
    const target: Vec = { x: gx - a * 8, z: w * 7 }; // arrives at the back post as the shot is struck
    const start = arriveFrom(target, a * 0.8, w * 0.6, kickAt);
    const p = pathAt([[0, start.x, start.z], [kickAt, target.x, target.z], [3.5, group.x - a * 3, group.z - w * 3]], t);
    put(A(10), p, t > 3.3 ? { kind: 'celebrate', celebration: 'HUG', t } : { kind: 'run' });
  }
  const supporters: Array<[number, Vec, boolean]> = [
    [7, { x: gx - a * 18, z: 4 }, true],
    [cross ? 6 : 8, { x: gx - a * 16, z: -10 }, true],
    [2, { x: gx - a * 31, z: 12 }, false],
    [3, { x: gx - a * 31, z: -12 }, false],
  ];
  for (const [idx, to, joins] of supporters) {
    const start = arriveFrom(to, a, 0, kickAt, 5);
    const end: Vec = joins ? { x: group.x - a * (1 + (idx % 3)), z: group.z + (idx - 6) * 2 } : { x: to.x + a * 3, z: to.z };
    const p = pathAt([[0, start.x, start.z], [kickAt, to.x, to.z], [3.6, end.x, end.z]], t);
    put(A(idx), p, joins && t > 3.4 ? { kind: 'celebrate', celebration: 'HUG', t } : { kind: 'run' });
  }
  // --- the defence ----------------------------------------------------------------------
  {
    const home: Vec = { x: gx - a * 1.4, z: 0 };
    const heading = headingOf(-a, 0);
    const lateral = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
    const direction: 1 | -1 = lateral.z * (corner.z - home.z) >= 0 ? 1 : -1;
    const spec: DiveSpec = { direction, reach: 2.4, height: cornerY };
    const td = t - (kickAt + 0.06); // the keeper reacts to the strike
    if (td < 0) put(D(0), home, { kind: 'keeperReady' }, { x: -a, z: 0 });
    else {
      const off = diveRoot(spec, td);
      const world = new THREE.Vector3(off.x, 0, off.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), heading);
      put(D(0), { x: home.x + world.x, z: home.z + world.z }, { kind: 'keeperDive', t: td, spec, ball: new THREE.Vector3(ball.x, ball.y, ball.z) }, { x: -a, z: 0 });
    }
  }
  for (const [idx, off] of [[2, 3.5], [3, -3.5], [1, 11], [4, -11]] as const) {
    const chaseTo: Vec = { x: strike.x + a * (2 + idx * 0.6), z: strike.z + off };
    const start = arriveFrom(chaseTo, a, 0, kickAt, 6);
    const p = pathAt([[0, start.x, start.z], [kickAt, chaseTo.x, chaseTo.z], [3.2, chaseTo.x + a * 0.5, chaseTo.z]], t);
    put(D(idx), p, t > kickAt + 0.5 ? { kind: 'celebrate', celebration: 'DEJECTED', t } : { kind: 'run' });
  }
  // --- everyone else watches from the shape they were in ----------------------------------------
  const anchor: Vec = { x: gx - a * 14, z: 0 };
  for (const team of ['H', 'A'] as TeamId[])
    for (let i = 0; i < 11; i++) {
      const idx = actorIndex(team, i);
      if (actors.has(idx)) continue;
      const f = formationPos(team, i, attackDir(team, half), anchor);
      put(idx, f, i === 0 ? { kind: 'keeperReady' } : { kind: 'idle' }, { x: gx - f.x, z: -f.z });
    }
  put(REFEREE, { x: gx - a * 22, z: 6 }, { kind: 'idle' }, { x: a, z: 0 });

  // --- camera: low and wide of the goal, with a slow push-in ----------------------------------
  const push = smooth((t - 1.2) / 2.2);
  const camera = {
    x: lerp(gx - a * 26, gx - a * 20, push),
    y: lerp(6.5, 4.8, push),
    z: 28,
    lx: gx - a * 8,
    ly: 1.3,
    lz: 0,
    fov: 36,
  };
  const crowd = t < M ? 0.4 : clamp(1 - (t - M) / 8, 0.55, 1);
  return { actors, ball, net, camera, scored: t >= M, crowd };
}

/* ------------------------------------------------------------------------------------- *
 * Frame
 * ------------------------------------------------------------------------------------- */
const BROADCAST_Y = 18;
const BROADCAST_Z = 58;
function broadcastCamera(bx: number): Frame['camera'] {
  const x = clamp(bx * 0.9, -PITCH.halfLength + 17, PITCH.halfLength - 17);
  return { x, y: BROADCAST_Y, z: BROADCAST_Z, lx: x * 0.97, ly: 0.9, lz: 3, fov: 30 };
}

function epochKey(matchKey: string, start: number, half: 1 | 2, team: TeamId) {
  return `${matchKey}|${start.toFixed(3)}|${half}|${team}`;
}

export function directorFrame(input: DirectorInput): Frame {
  const t = input.elapsedMs / 1000;
  const half: 1 | 2 = input.status === 'SECOND_HALF' || input.status === 'FULL_TIME' || t >= 32 ? 2 : 1;
  const goals = [...input.goals].sort((x, y) => x.atMs - y.atMs);
  const actors: ActorState[] = [];
  const idle = (): Anim => ({ kind: 'idle' });

  const lineup = (anchor: Vec, mode: Mode, facing?: (team: TeamId) => Vec | undefined, anim?: (team: TeamId, i: number) => Anim): Frame => {
    for (const team of ['H', 'A'] as TeamId[])
      for (let i = 0; i < 11; i++) {
        const dir = attackDir(team, half);
        const p = formationPos(team, i, dir, anchor);
        const f = facing?.(team);
        actors[actorIndex(team, i)] = { x: p.x, z: p.z, heading: f ? headingOf(f.x, f.z) : headingOf(dir, 0), speed: 0, anim: anim ? anim(team, i) : i === 0 ? { kind: 'keeperReady' } : idle() };
      }
    actors[REFEREE] = { x: 2, z: 5, heading: headingOf(1, 0), speed: 0, anim: idle() };
    return { actors, ball: { x: anchor.x, y: 0.11, z: anchor.z }, camera: broadcastCamera(0), mode, half, goal: null, crowd: 0.25 };
  };

  // A goal sequence takes over for its length once the goal has been released, even if the
  // half or the match ends meanwhile (the last goal may arrive 1.5 s before full time).
  if (input.status !== 'SCHEDULED')
    for (const goal of goals) {
      const tg = t - goal.atMs / 1000;
      if (tg >= 0 && tg < GOAL_SEQUENCE.length) {
        const g = goalSequence(input.matchKey, goal, goal.atMs / 1000 >= 32 ? 2 : 1, tg);
        for (let i = 0; i < ACTOR_COUNT; i++) actors[i] = g.actors.get(i)!;
        return { actors, ball: g.ball, camera: g.camera, mode: 'GOAL', half, goal: { n: goal.n, side: goal.side, t: tg, scored: g.scored, net: g.net }, crowd: g.crowd };
      }
    }

  if (input.status === 'SCHEDULED') return lineup({ x: 0, z: 0 }, 'PRE');
  if (input.status === 'HALFTIME') return lineup({ x: 0, z: 0 }, 'HALFTIME');
  if (input.status === 'FULL_TIME') {
    const ft = input.fullTime;
    return lineup(
      { x: 0, z: 0 },
      'POST',
      undefined,
      (team, i) => {
        if (i === 0 && !ft) return { kind: 'keeperReady' };
        const mine = ft ? (team === 'H' ? ft.home : ft.away) : 0;
        const theirs = ft ? (team === 'H' ? ft.away : ft.home) : 0;
        if (mine > theirs) return { kind: 'celebrate', celebration: i % 3 === 0 ? 'ARMS_UP' : i % 3 === 1 ? 'HUG' : 'WINGS', t: t + i * 0.3 };
        if (mine < theirs) return { kind: 'celebrate', celebration: 'DEJECTED', t: t + i * 0.2 };
        return idle();
      }
    );
  }

  // Live play.
  // Decorative play since the latest restart (kick-off, second half, or the last goal).
  let start = half === 2 ? 32 : 0;
  let team: TeamId = half === 2 ? 'A' : 'H';
  for (const goal of goals) {
    const end = goal.atMs / 1000 + GOAL_SEQUENCE.length;
    if (end <= t && end > start) {
      start = end;
      team = other(goal.side);
    }
  }
  const e = buildEpoch(epochKey(input.matchKey, start, half, team), team, half);
  const local = t - start;
  const ball = ballInEpoch(e, local);
  const at = (tt: number, tm: TeamId, i: number) => playActor(e, tm, i, tt);
  for (const tm of ['H', 'A'] as TeamId[])
    for (let i = 0; i < 11; i++) {
      const now = at(local, tm, i);
      const before = at(local - 0.08, tm, i).pos;
      const after = at(local + 0.08, tm, i).pos;
      const vx = (after.x - before.x) / 0.16;
      const vz = (after.z - before.z) / 0.16;
      const speed = Math.min(9.5, Math.hypot(vx, vz));
      const toBall = { x: ball.x - now.pos.x, z: ball.z - now.pos.z };
      const faceDir = now.facing ?? (speed > 0.6 ? { x: vx, z: vz } : toBall);
      const anim: Anim = now.anim ?? (i === 0 && speed < 1 ? { kind: 'keeperReady' } : speed > 0.6 ? { kind: 'run' } : idle());
      actors[actorIndex(tm, i)] = { x: now.pos.x, z: now.pos.z, heading: headingOf(faceDir.x, faceDir.z), speed, anim };
    }
  const trail = anchorAt(e.anchors, local - LAG * 0.6);
  actors[REFEREE] = { x: trail.x * 0.6 - 6, z: trail.z * 0.5 + 9, heading: headingOf(ball.x - trail.x * 0.6, ball.z - trail.z * 0.5), speed: 2.5, anim: { kind: 'run' } };
  return { actors, ball, camera: broadcastCamera(ball.x), mode: 'PLAY', half, goal: null, crowd: 0.3 };
}
