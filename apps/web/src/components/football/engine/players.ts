import { loadPlayerGeometry } from './human-model';
import { matchKits, clubById } from '@/lib/football/clubs';
import * as THREE from 'three';
import { keeperColour, type ClubKit } from '@socialplay/shared';
import { ACTOR_COUNT, REFEREE, type ActorState, type Frame } from './director';
import {
  blendTo,
  capture,
  poseCelebrate,
  poseIdle,
  poseKeeperDive,
  poseKeeperReady,
  poseKick,
  poseRun,
  strideLength,
  type PoseSnapshot,
} from './poses';
import {
  createRig,
  HAIR_TONES,
  kitFromClub,
  kitTexture,
  lookGeometry,
  SKIN_TONES,
  type KitLook,
  type Look,
  type LookGeometry,
  type Rig,
  type HumanGeometry,
} from './rig';

/** Shirt numbers by formation slot (0 = goalkeeper). */
const NUMBERS = [1, 2, 5, 4, 3, 11, 8, 6, 7, 9, 10];

function plateTexture(number: number, colour: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 76px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 9;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeText(String(number), 48, 52);
  ctx.fillStyle = colour;
  ctx.fillText(String(number), 48, 52);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
const lightness = (hex: string) => {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

interface RigState {
  kind: Frame['actors'][number]['anim']['kind'] | 'none';
  phase: number;
  speed: number;
  yaw: number;
  lastX: number;
  lastZ: number;
  blend: number;
  from: PoseSnapshot | null;
  seen: boolean;
}

export interface PlayerPool {
  group: THREE.Group;
  rigs: Rig[];
  /** (Re)dresses all players for a fixture. Cheap; no renderer or skeleton is rebuilt. */
  setTeams(homeClub: number, awayClub: number): void;
  apply(frame: Frame, dt: number, time: number, animate: boolean): void;
  dispose(): void;
}

export function createPlayerPool(): PlayerPool {
  const group = new THREE.Group();
  const placeholder = new THREE.MeshStandardMaterial({ color: '#888888' });
  const emptyLook: Look = {
    kit: kitFromClub({ primary: '#888888', secondary: '#ffffff', pattern: 'solid' }),
    skin: SKIN_TONES[0],
    hair: HAIR_TONES[0],
  };
  const firstLook = lookGeometry(emptyLook);
  const rigs: Rig[] = Array.from({ length: ACTOR_COUNT }, () => {
    const rig = createRig(placeholder, firstLook.geometry);
    group.add(rig.root);
    return rig;
  });
  const states: RigState[] = rigs.map(() => ({
    kind: 'none',
    phase: 0,
    speed: 0,
    yaw: 0,
    lastX: 0,
    lastZ: 0,
    blend: 1,
    from: null,
    seen: false,
  }));
  let owned: Array<{ dispose(): void }> = [];
  const plates: Array<THREE.Mesh | null> = rigs.map(() => null);
  let dressed = false;
  let disposed = false;
  let anatomical: HumanGeometry | undefined;
  let teams: [number, number] | undefined;
  void loadPlayerGeometry()
    .then((base) => {
      if (disposed) {
        base.geometry.dispose();
        return;
      }
      anatomical = base;
      if (teams) setTeams(...teams);
    })
    .catch(() => {
      /* Keep the complete procedural fallback. */
    });

  function setTeams(homeClub: number, awayClub: number) {
    if (disposed) return;
    teams = [homeClub, awayClub];
    for (const o of owned) o.dispose();
    owned = [];
    const own = <T extends { dispose(): void }>(x: T) => (owned.push(x), x);
    const kits = matchKits(homeClub, awayClub);
    const homeKeeper = keeperColour(kits.home.primary, kits.away.primary);
    const awayKeeper = keeperColour(kits.home.primary, kits.away.primary, homeKeeper);
    const keeperKit = (colour: string): KitLook => ({
      primary: colour,
      secondary: colour,
      pattern: 'solid',
      shorts: '#1b1d22',
      socks: '#1b1d22',
      keeper: true,
      glove: '#f3f3f0',
    });
    const outfield = (kit: ClubKit): KitLook => kitFromClub(kit);
    const refereeKit: KitLook = {
      primary: '#f2d31b',
      secondary: '#111111',
      pattern: 'solid',
      shorts: '#111111',
      socks: '#111111',
    };
    const kitFor = (index: number): KitLook =>
      index === REFEREE
        ? refereeKit
        : index < 11
          ? index === 0
            ? keeperKit(homeKeeper)
            : outfield(kits.home)
          : index === 11
            ? keeperKit(awayKeeper)
            : outfield(kits.away);
    const materialCache = new Map<string, THREE.MeshStandardMaterial>();
    const materialFor = (kit: KitLook) => {
      const key = `${kit.primary}|${kit.secondary}|${kit.pattern}|${kit.keeper ? 'k' : ''}`;
      let m = materialCache.get(key);
      if (!m) {
        const map = own(kitTexture(kit));
        m = own(
          new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 0.82, metalness: 0 })
        );
        materialCache.set(key, m);
      }
      return m;
    };
    const plateCache = new Map<string, THREE.MeshBasicMaterial>();
    const plateGeometry = own(new THREE.PlaneGeometry(0.3, 0.3));
    rigs.forEach((rig, i) => {
      const kit = kitFor(i);
      const club = i < 11 ? clubById(homeClub) : clubById(awayClub);
      const look: Look = {
        kit,
        skin: SKIN_TONES[(club.id * 5 + i * 3) % SKIN_TONES.length],
        hair: HAIR_TONES[(club.id * 3 + i * 7) % HAIR_TONES.length],
      };
      const lg: LookGeometry = own(lookGeometry(look, anatomical));
      rig.mesh.geometry = lg.geometry;
      rig.mesh.material = materialFor(kit);
      plates[i]?.removeFromParent();
      plates[i] = null;
      if (i !== REFEREE) {
        const number = NUMBERS[i % 11];
        const colour = lightness(kit.primary) > 0.55 ? '#10151f' : '#ffffff';
        const key = `${number}|${colour}`;
        let pm = plateCache.get(key);
        if (!pm) {
          const tex = own(plateTexture(number, colour));
          pm = own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
          plateCache.set(key, pm);
        }
        const plate = new THREE.Mesh(plateGeometry, pm);
        plate.position.set(0, 0.03, -0.128);
        plate.rotation.y = Math.PI;
        rig.bones.chest.add(plate);
        plates[i] = plate;
      }
      // Slight height variation; referee is a touch older/smaller.
      const scale = 0.96 + ((club.id * 7 + i * 13) % 9) * 0.01;
      rig.root.scale.setScalar(i === REFEREE ? 0.97 : scale);
    });
    dressed = true;
  }

  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

  function apply(frame: Frame, dt: number, time: number, animate: boolean) {
    if (!dressed) return;
    for (let i = 0; i < ACTOR_COUNT; i++) {
      const actor: ActorState = frame.actors[i];
      const rig = rigs[i];
      const st = states[i];
      const kind = actor.anim.kind;
      const snapHeading = kind === 'kick' || kind === 'keeperDive' || !st.seen;
      const moved = Math.hypot(actor.x - st.lastX, actor.z - st.lastZ);
      const teleported = !st.seen || moved > 4;
      if (teleported) {
        st.phase = 0;
        st.speed = actor.speed;
        st.from = null;
        st.blend = 1;
      }
      const yawBefore = st.yaw;
      if (snapHeading || teleported) st.yaw = actor.heading;
      else st.yaw += clampAbs(wrap(actor.heading - st.yaw), 9 * Math.max(dt, 0.001)); // at most ~9 rad/s
      const yawRate = dt > 0 ? wrap(st.yaw - yawBefore) / dt : 0;
      rig.root.position.set(actor.x, 0, actor.z);
      rig.root.rotation.y = st.yaw;
      st.speed += (actor.speed - st.speed) * Math.min(1, Math.max(dt, 0) * 8);
      if (!teleported && kind === 'run')
        st.phase = (st.phase + moved / strideLength(Math.max(st.speed, 1.2))) % 1;
      st.lastX = actor.x;
      st.lastZ = actor.z;
      st.seen = true;

      if (!animate) {
        poseIdle(rig, 0, i * 0.37);
        st.kind = 'none';
        continue;
      }
      if (kind !== st.kind) {
        st.from = st.kind === 'none' ? null : capture(rig);
        st.blend = st.from ? 0 : 1;
        st.kind = kind;
      }
      switch (actor.anim.kind) {
        case 'idle':
          poseIdle(rig, time, i * 0.37);
          break;
        case 'run':
          poseRun(rig, st.phase, Math.max(actor.speed, 1.2), {
            bank: clampAbs(yawRate * 0.03, 0.22),
          });
          break;
        case 'kick':
          poseKick(rig, actor.anim.t, actor.anim.spec);
          break;
        case 'keeperReady':
          poseKeeperReady(rig, time + i, Math.sin(time * 0.7 + i));
          break;
        case 'keeperDive':
          poseKeeperDive(rig, actor.anim.t, actor.anim.spec, actor.anim.ball);
          break;
        case 'celebrate':
          poseCelebrate(rig, actor.anim.celebration, actor.anim.t);
          break;
      }
      if (st.from && st.blend < 1) {
        st.blend = Math.min(1, st.blend + dt / 0.14);
        blendTo(rig, st.from, st.blend);
        if (st.blend >= 1) st.from = null;
      }
    }
  }

  return {
    group,
    rigs,
    setTeams,
    apply,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const o of owned) o.dispose();
      owned = [];
      for (const r of rigs) r.dispose();
      firstLook.dispose();
      anatomical?.geometry.dispose();
      placeholder.dispose();
      group.removeFromParent();
    },
  };
}

function clampAbs(v: number, max: number) {
  return Math.max(-max, Math.min(max, v));
}
