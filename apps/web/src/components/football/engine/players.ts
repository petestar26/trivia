import { placeFoot, reachHand } from './ik';
import { loadPlayerGeometry } from './human-model';
import { loadPlayerUpgrade, disposePlayerGeometry } from './player-assets';
import {
  appearanceTextures,
  headMaterial,
  attachPlayerHead,
  attachBootDetails,
  playerIdentity,
  poseFingers,
  type HeadVisual,
  type PlayerDetail,
} from './player-appearance';
import { sampleAuthoredControl, type AuthoredMotionName } from './authored-motion';
import {
  loadReviewPlayerAssets,
  attachReviewHead,
  REVIEW_PLAYER_SLOT,
  type ReviewPlayerAssets,
} from './review-player';
import {
  applyReviewPlayerMotion,
  poseReviewPlayerHands,
  createReviewMotionState,
  resetReviewMotionState,
} from './review-player-motion';
import { attachReviewBody } from './review-player-body';
import {
  loadContinuousPlayerAssets,
  attachContinuousPlayer,
  type ContinuousPlayerAssets,
} from './continuous-player';
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
  plantRunFeet,
  type RunPlant,
  strideLength,
  type PoseSnapshot,
} from './poses';
import {
  BONES,
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
  yaw: number;
  lastX: number;
  lastZ: number;
  lastSpeed: number;
  accelerationTime: number;
  accelerationWeight: number;
  turnTime: number;
  blend: number;
  from: PoseSnapshot | null;
  seen: boolean;
  plants: RunPlant;
  fingerFrom: THREE.Quaternion[];
}

export interface PlayerPool {
  group: THREE.Group;
  rigs: Rig[];
  /** (Re)dresses all players for a fixture. Cheap; no renderer or skeleton is rebuilt. */
  setTeams(homeClub: number, awayClub: number): void;
  apply(frame: Frame, dt: number, time: number, animate: boolean): void;
  setDetail?(camera: THREE.PerspectiveCamera, viewportHeight: number): void;
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
  const fingers = BONES.filter((name) => /^(thumb|index|middle|ring|pinky)[123][LR]$/.test(name));
  const fingerTarget = new THREE.Quaternion();
  const detailBottom = new THREE.Vector3(),
    detailTop = new THREE.Vector3(),
    detailMiddle = new THREE.Vector3();
  const detailCandidates = rigs.map((_rig, i) => ({ i, pixels: 0 }));
  const highDetail = new Set<number>();
  const states: RigState[] = rigs.map(() => ({
    kind: 'none',
    phase: 0,
    yaw: 0,
    lastX: 0,
    lastZ: 0,
    lastSpeed: 0,
    accelerationTime: 0,
    accelerationWeight: 0,
    turnTime: 0,
    blend: 1,
    from: null,
    seen: false,
    plants: {},
    fingerFrom: fingers.map(() => new THREE.Quaternion()),
  }));
  let owned: Array<{ dispose(): void }> = [];
  const plates: Array<THREE.Mesh | null> = rigs.map(() => null);
  let dressed = false;
  let disposed = false;
  let anatomical: HumanGeometry | undefined;
  let upgraded = false;
  let reviewAssets: ReviewPlayerAssets | undefined;
  let reviewLoadStarted = false;
  let reviewBody: ReturnType<typeof attachReviewBody> | undefined;
  let continuousAssets: ContinuousPlayerAssets | undefined;
  let continuousLoadStarted = false;
  let continuousPlayer: ReturnType<typeof attachContinuousPlayer> | undefined;
  const reviewMotionState = createReviewMotionState();
  let reviewMotionTime: number | undefined;
  let skinMaps: ReturnType<typeof appearanceTextures> | undefined;
  let fabricMaps: ReturnType<typeof appearanceTextures> | undefined;
  let sharedHeadMaterial: THREE.Material | undefined;
  const heads: Array<HeadVisual | undefined> = rigs.map(() => undefined);
  const boots: Array<ReturnType<typeof attachBootDetails> | undefined> = rigs.map(() => undefined);
  const bodyLooks: Array<Record<PlayerDetail, LookGeometry> | undefined> = rigs.map(
    () => undefined
  );
  const details: PlayerDetail[] = rigs.map((_rig, i) => (i < 2 ? 'high' : 'mid'));
  let teams: [number, number] | undefined;
  function adopt(base: HumanGeometry, upgrade: boolean) {
    if (disposed || (!upgrade && upgraded)) {
      disposePlayerGeometry(base);
      return;
    }
    const previous = anatomical;
    anatomical = base;
    upgraded = upgrade;
    if (upgrade && base.heads && !reviewLoadStarted) {
      reviewLoadStarted = true;
      void loadReviewPlayerAssets()
        .then((assets) => {
          if (disposed) {
            assets.dispose();
            return;
          }
          reviewAssets = assets;
          if (teams) setTeams(...teams);
        })
        .catch(() => {
          /* Keep the complete PR59 character if any review asset fails. */
        });
    }
    if (upgrade && base.heads && !continuousLoadStarted) {
      continuousLoadStarted = true;
      void loadContinuousPlayerAssets()
        .then((assets) => {
          if (disposed) {
            assets.dispose();
            return;
          }
          continuousAssets = assets;
          if (teams && reviewAssets) setTeams(...teams);
        })
        .catch(() => {
          /* The complete reviewed player remains the fallback. */
        });
    }
    if (teams) setTeams(...teams);
    if (previous && previous !== base) disposePlayerGeometry(previous);
  }
  void loadPlayerGeometry()
    .then((base) => adopt(base, false))
    .catch(() => {
      /* Keep the complete procedural fallback. */
    });
  void loadPlayerUpgrade()
    .then((base) => adopt(base, true))
    .catch(() => {
      /* Legacy anatomical/procedural figures remain complete if an upgrade fails. */
    });

  function setTeams(homeClub: number, awayClub: number) {
    if (disposed) return;
    resetReviewMotionState(reviewMotionState);
    reviewMotionTime = undefined;
    teams = [homeClub, awayClub];
    continuousPlayer?.dispose();
    continuousPlayer = undefined;
    reviewBody?.dispose();
    reviewBody = undefined;
    for (const head of heads) head?.dispose();
    for (const boot of boots) boot?.dispose();
    boots.fill(undefined);
    heads.fill(undefined);
    bodyLooks.fill(undefined);
    for (const o of owned) o.dispose();
    owned = [];
    if (anatomical?.heads && !skinMaps) {
      skinMaps = appearanceTextures('skin');
      fabricMaps = appearanceTextures('fabric');
      sharedHeadMaterial = headMaterial(skinMaps);
    }
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
          new THREE.MeshStandardMaterial({
            vertexColors: true,
            map,
            roughness: 0.82,
            metalness: 0,
            ...(fabricMaps
              ? {
                  normalMap: fabricMaps.normal,
                  normalScale: new THREE.Vector2(0.14, 0.14),
                  roughnessMap: fabricMaps.roughness,
                }
              : {}),
          })
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
      const identity = playerIdentity(i === REFEREE ? 0 : club.id, i % 11);
      const look: Look = {
        kit,
        skin: identity.skin,
        hair: identity.hair,
      };
      const lg: LookGeometry = own(lookGeometry(look, anatomical));
      const mid = anatomical?.bodyLods?.mid;
      const low = anatomical?.bodyLods?.low;
      bodyLooks[i] = {
        high: lg,
        mid: mid ? own(lookGeometry(look, mid)) : lg,
        low: low ? own(lookGeometry(look, low)) : lg,
      };
      rig.mesh.geometry = bodyLooks[i]![details[i]].geometry;
      rig.root.userData.playerIdentity = identity;
      rig.root.userData.playerDetail = details[i];
      if (anatomical?.heads && sharedHeadMaterial) {
        heads[i] =
          i === REVIEW_PLAYER_SLOT && reviewAssets && skinMaps
            ? attachReviewHead(
                rig,
                anatomical.heads,
                identity,
                sharedHeadMaterial,
                reviewAssets,
                skinMaps,
                !!continuousAssets
              )
            : attachPlayerHead(rig, anatomical.heads, identity, sharedHeadMaterial);
        heads[i]!.setDetail(details[i]);
        boots[i] = attachBootDetails(rig);
        boots[i]!.setDetail(details[i]);
      }
      rig.mesh.material = materialFor(kit);
      rig.root.userData.reviewPlayer = i === REVIEW_PLAYER_SLOT && !!reviewAssets;
      if (i === REVIEW_PLAYER_SLOT && reviewAssets && anatomical?.heads) {
        const reviewMaterial = own(materialFor(kit).clone());
        reviewMaterial.side = THREE.DoubleSide;
        rig.mesh.material = reviewMaterial;
        if (continuousAssets && skinMaps && heads[i]) {
          continuousPlayer = attachContinuousPlayer(
            rig,
            anatomical,
            look,
            reviewMaterial,
            continuousAssets,
            reviewAssets,
            skinMaps,
            heads[i]!
          );
          continuousPlayer.setDetail(details[i]);
        } else {
          reviewBody = attachReviewBody(rig, anatomical, look, reviewMaterial);
          reviewBody.setDetail(details[i]);
        }
        rig.root.userData.continuousPlayer = !!continuousPlayer;
      }
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
        if (i === REVIEW_PLAYER_SLOT && continuousPlayer) {
          continuousPlayer.setNumberTexture(pm.map!);
          plate.visible = details[i] === 'low';
        }
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
      const snapHeading = !st.seen || !animate;
      const moved = Math.hypot(actor.x - st.lastX, actor.z - st.lastZ);
      const teleported = !st.seen || moved > 4;
      if (teleported) {
        st.phase = 0;
        st.plants = {};
        st.from = null;
        st.blend = 1;
      }
      if (i === REVIEW_PLAYER_SLOT) {
        if (
          teleported ||
          !animate ||
          dt > 0.25 ||
          (reviewMotionTime !== undefined && time < reviewMotionTime)
        )
          resetReviewMotionState(reviewMotionState);
        reviewMotionTime = time;
      }
      // A long suspension can skip a whole stance window; do not retain a stale world plant.
      if (dt > 0.25) st.plants = {};
      const yawBefore = st.yaw;
      if (snapHeading || teleported) st.yaw = actor.heading;
      else {
        // Integrate a bounded angular velocity analytically: linear at large errors, then
        // exponential near the target. Constant headings agree across different frame steps.
        const error = wrap(actor.heading - st.yaw);
        const magnitude = Math.abs(error);
        const linear = Math.min(Math.max(dt, 0), Math.max(0, (magnitude - 9 / 14) / 9));
        const remaining = magnitude - 9 * linear;
        st.yaw +=
          Math.sign(error) *
          (9 * linear + remaining * (1 - Math.exp(-14 * Math.max(0, dt - linear))));
      }
      const yawRate = dt > 0 ? wrap(st.yaw - yawBefore) / dt : 0;
      rig.root.position.set(actor.x, 0, actor.z);
      rig.root.rotation.y = st.yaw;
      if (!teleported && kind === 'run')
        st.phase = (st.phase + moved / strideLength(Math.max(actor.speed, 1.2))) % 1;
      st.lastX = actor.x;
      st.lastZ = actor.z;
      const signedAcceleration = !teleported && dt > 0 ? (actor.speed - st.lastSpeed) / dt : 0;
      const acceleration = Math.max(0, signedAcceleration);
      st.lastSpeed = actor.speed;
      if (teleported || !animate) {
        st.accelerationTime = 0;
        st.accelerationWeight = 0;
      }
      if (acceleration > 0.1) {
        if (st.accelerationWeight <= 0.01) st.accelerationTime = 0;
        st.accelerationWeight = Math.max(st.accelerationWeight, Math.min(1, acceleration / 6));
      } else st.accelerationWeight *= Math.exp(-4 * Math.max(dt, 0));
      if (st.accelerationWeight > 0.01) st.accelerationTime += Math.max(dt, 0);
      st.turnTime = Math.abs(yawRate) > 0.2 ? st.turnTime + Math.max(dt, 0) : 0;
      st.seen = true;
      if (animate)
        fingers.forEach((name, joint) => st.fingerFrom[joint].copy(rig.bones[name].quaternion));

      if (!animate) {
        poseIdle(rig, 0, i * 0.37);
        st.kind = 'none';
        st.plants = {};
        poseFingers(rig, kind, false);
        if (i === REVIEW_PLAYER_SLOT && reviewAssets) {
          applyReviewPlayerMotion(rig, {
            kind,
            time: 0,
            phase: 0,
            speed: 0,
            reducedMotion: true,
            motionState: reviewMotionState,
          });
          poseReviewPlayerHands(rig, kind, false);
        }
        heads[i]?.animate(0, kind, false);
        if (i === REVIEW_PLAYER_SLOT) continuousPlayer?.syncFace();
        continue;
      }
      if (kind !== st.kind) {
        st.plants = {};
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
            acceleration: st.accelerationWeight,
            accelerationTime: st.accelerationTime,
            turn: clampAbs(yawRate / 6, 1),
            turnTime: st.turnTime,
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
        // Preserve the authored world IK targets while blending the torso. Blending local leg
        // rotations alone lifts planted feet and displaces the boot at the unchanged kick clock.
        const feet = (['L', 'R'] as const).map((side) => ({
          side,
          ankle: rig.bones[`foot${side}`].getWorldPosition(new THREE.Vector3()),
          angles: new THREE.Euler().setFromQuaternion(
            rig.bones[`foot${side}`].getWorldQuaternion(new THREE.Quaternion()),
            'YXZ'
          ),
        }));
        const hands =
          kind === 'keeperDive'
            ? (['L', 'R'] as const).map((side) => ({
                side,
                target: rig.bones[`hand${side}`].getWorldPosition(new THREE.Vector3()),
              }))
            : [];
        st.blend = Math.min(1, st.blend + dt / 0.14);
        const weight = st.blend * st.blend * (3 - 2 * st.blend);
        blendTo(rig, st.from, weight);
        if (kind === 'run' || kind === 'kick' || kind === 'keeperDive') {
          for (const f of feet) placeFoot(rig, f.side, f.ankle, f.angles.x, f.angles.y, f.angles.z);
          for (const h of hands) reachHand(rig, h.side, h.target, new THREE.Vector3(0, -1, 0.2));
        }
        if (st.blend >= 1) st.from = null;
      }
      if (i === REVIEW_PLAYER_SLOT && reviewAssets) {
        applyReviewPlayerMotion(rig, {
          motionState: reviewMotionState,
          deltaSeconds: dt,
          kind,
          time:
            actor.anim.kind === 'kick' || actor.anim.kind === 'keeperDive' ? actor.anim.t : time,
          phase: st.phase,
          speed: actor.speed,
          acceleration: signedAcceleration,
          turn: clampAbs(yawRate / 6, 1),
          direction:
            actor.anim.kind === 'kick'
              ? actor.anim.spec.foot === 'R'
                ? 1
                : -1
              : actor.anim.kind === 'keeperDive'
                ? actor.anim.spec.direction
                : 1,
        });
      }
      if (kind === 'run') plantRunFeet(rig, st.phase, Math.max(actor.speed, 1.2), st.plants);
      poseFingers(rig, kind, true, handControls(actor, st.phase, time + i));
      if (i === REVIEW_PLAYER_SLOT && reviewAssets)
        poseReviewPlayerHands(rig, kind, true, st.phase);
      const fingerWeight = 1 - Math.exp(-14 * Math.max(dt, 0));
      // Capture target before copying the previous pose; palm/wrist IK is never touched.
      fingers.forEach((name, joint) => {
        fingerTarget.copy(rig.bones[name].quaternion);
        rig.bones[name].quaternion.copy(st.fingerFrom[joint]).slerp(fingerTarget, fingerWeight);
      });
      heads[i]?.animate(time, kind, true);
      if (i === REVIEW_PLAYER_SLOT) continuousPlayer?.syncFace();
    }
  }

  function setDetail(camera: THREE.PerspectiveCamera, viewportHeight: number) {
    if (disposed || !dressed || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return;
    camera.updateMatrixWorld(true);
    for (const candidate of detailCandidates) {
      const rig = rigs[candidate.i];
      rig.root.updateMatrixWorld(true);
      rig.root.getWorldPosition(detailBottom);
      detailTop.copy(detailBottom);
      detailTop.y += 1.86 * rig.root.scale.y;
      detailMiddle.copy(detailBottom).lerp(detailTop, 0.5).project(camera);
      const visible =
        detailMiddle.z >= -1 &&
        detailMiddle.z <= 1 &&
        Math.abs(detailMiddle.x) < 1.15 &&
        Math.abs(detailMiddle.y) < 1.15;
      candidate.pixels = visible
        ? (Math.abs(detailTop.project(camera).y - detailBottom.project(camera).y) *
            viewportHeight) /
          2
        : 0;
    }
    detailCandidates.sort(
      (a, b) =>
        b.pixels +
          (details[b.i] === 'high' ? 15 : 0) -
          (a.pixels + (details[a.i] === 'high' ? 15 : 0)) || a.i - b.i
    );
    highDetail.clear();
    for (const { i, pixels } of detailCandidates) {
      if (pixels >= (details[i] === 'high' ? 110 : 130) && highDetail.size < 2) highDetail.add(i);
    }
    for (const { i, pixels } of detailCandidates) {
      const next: PlayerDetail = highDetail.has(i)
        ? 'high'
        : pixels >= (details[i] === 'low' ? 45 : 35)
          ? 'mid'
          : 'low';
      details[i] = next;
      rigs[i].root.userData.playerDetail = next;
      rigs[i].root.userData.projectedPlayerPixels = pixels;
      if (bodyLooks[i]) rigs[i].mesh.geometry = bodyLooks[i]![next].geometry;
      heads[i]?.setDetail(next);
      boots[i]?.setDetail(next);
      if (i === REVIEW_PLAYER_SLOT) reviewBody?.setDetail(next);
      if (i === REVIEW_PLAYER_SLOT) continuousPlayer?.setDetail(next);
      if (i === REVIEW_PLAYER_SLOT && continuousPlayer) boots[i]?.setDetail('low');
      if (i === REVIEW_PLAYER_SLOT && continuousPlayer && plates[i]) plates[i]!.visible = false;
    }
  }

  return {
    group,
    rigs,
    setTeams,
    apply,
    setDetail,
    dispose() {
      if (disposed) return;
      disposed = true;
      continuousPlayer?.dispose();
      reviewBody?.dispose();
      for (const head of heads) head?.dispose();
      for (const boot of boots) boot?.dispose();
      for (const o of owned) o.dispose();
      owned = [];
      for (const r of rigs) r.dispose();
      firstLook.dispose();
      if (anatomical) disposePlayerGeometry(anatomical);
      reviewAssets?.dispose();
      continuousAssets?.dispose();
      sharedHeadMaterial?.dispose();
      skinMaps?.dispose();
      fabricMaps?.dispose();
      placeholder.dispose();
      group.removeFromParent();
    },
  };
}

function clampAbs(v: number, max: number) {
  return Math.max(-max, Math.min(max, v));
}

function handControls(actor: ActorState, phase: number, time: number): number[] {
  const anim = actor.anim;
  let clip: AuthoredMotionName =
    anim.kind === 'run' ? 'run' : anim.kind === 'keeperReady' ? 'keeperReady' : 'idle';
  let at = anim.kind === 'run' ? phase : time;
  let mirror = false;
  if (anim.kind === 'kick') {
    clip = 'kick';
    at = anim.t;
    mirror = anim.spec.foot === 'L';
  }
  if (anim.kind === 'keeperDive') {
    clip = 'keeperDive';
    at = anim.t;
    mirror = anim.spec.direction < 0;
  }
  if (anim.kind === 'celebrate') {
    clip = (
      {
        ARMS_UP: 'celebrate',
        WINGS: 'celebrateWings',
        KNEE_SLIDE: 'celebrateSlide',
        LEAP: 'celebrateLeap',
        HUG: 'celebrateHug',
        DEJECTED: 'dejected',
      } as const
    )[anim.celebration];
    at = anim.t;
  }
  const values = sampleAuthoredControl(clip, 'hands', at);
  if (mirror && values.length >= 2) [values[0], values[1]] = [values[1], values[0]];
  return values;
}
