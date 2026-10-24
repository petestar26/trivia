import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { createPlayerPool, type PlayerPool } from './players';
import { directorFrame } from './director';
import { sampleReviewArmTargets } from './review-player-motion';
import { Region, type HumanGeometry, type Rig } from './rig';
import { headGeometry } from './player-assets';
import type { HeadVisual, PlayerDetail } from './player-appearance';
import type { ReviewPlayerAssets } from './review-player';
import type { ContinuousPlayerAssets } from './continuous-player';

const hooks = vi.hoisted(() => ({
  legacy: vi.fn(),
  upgrade: vi.fn(),
  review: vi.fn(),
  continuous: vi.fn(),
  attach: vi.fn(),
  fallback: vi.fn(),
}));
vi.mock('./human-model', () => ({ loadPlayerGeometry: () => hooks.legacy() }));
vi.mock('./player-assets', async (original) => ({
  ...(await original<typeof import('./player-assets')>()),
  loadPlayerUpgrade: () => hooks.upgrade(),
}));
vi.mock('./review-player', async (original) => ({
  ...(await original<typeof import('./review-player')>()),
  loadReviewPlayerAssets: () => hooks.review(),
}));
vi.mock('./continuous-player', () => ({
  loadContinuousPlayerAssets: () => hooks.continuous(),
  attachContinuousPlayer: (...args: unknown[]) => hooks.attach(...args),
}));
vi.mock('./review-player-body', () => ({
  attachReviewBody: (...args: unknown[]) => hooks.fallback(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const pools: PlayerPool[] = [];
const release: Array<() => void> = [];
const morphNames = [
  'blinkLeft',
  'blinkRight',
  'jawOpen',
  'browRaise',
  'smile',
  'noseWidth',
  'lipFullness',
  'earSize',
];
let acceptedHeads: { head: THREE.BufferGeometry; continuousHead: THREE.BufferGeometry };
beforeAll(async () => {
  // Parse/clip the unchanged accepted input once. Each test receives independent
  // geometry clones and actor morph state, without repeating source processing.
  const parsed = await new GLTFLoader().parseAsync(
    Uint8Array.from(readFileSync('public/models/football/review-head-high.glb')).buffer,
    ''
  );
  acceptedHeads = {
    head: headGeometry({ status: 'fulfilled', value: parsed }, true),
    continuousHead: headGeometry({ status: 'fulfilled', value: parsed }, 'continuous'),
  };
  parsed.scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) =>
        material.dispose()
      );
    }
  });
});
afterAll(() => {
  acceptedHeads?.head.dispose();
  acceptedHeads?.continuousHead.dispose();
});

function minimalHead() {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.03, 1.76, 0.08, 0.03, 1.76, 0.08, 0, 1.82, 0.07], 3)
  );
  g.setAttribute('_part', new THREE.Float32BufferAttribute([0, 0, 0], 1));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
  g.setAttribute('uv1', g.getAttribute('uv').clone());
  g.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute([4, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0], 4)
  );
  g.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4)
  );
  g.setIndex([0, 1, 2]);
  g.computeVertexNormals();
  g.morphTargetsRelative = true;
  g.morphAttributes.position = morphNames.map(
    () => new THREE.Float32BufferAttribute(new Float32Array(9), 3)
  );
  g.morphAttributes.normal = morphNames.map(
    () => new THREE.Float32BufferAttribute(new Float32Array(9), 3)
  );
  g.userData.morphNames = Object.fromEntries(morphNames.map((name, i) => [name, i]));
  return g;
}
function baseline(): HumanGeometry {
  // These tests exercise asynchronous pool ownership and the real selected head.
  // A tiny bound stand-in avoids rebuilding unrelated full roster body buffers
  // on every load/team change; production body/contact geometry has its own tests.
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([-0.1, 0.9, 0, 0.1, 0.9, 0, 0, 1.2, 0]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4)
  );
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  const source: HumanGeometry = {
    geometry,
    positions,
    region: new Float32Array(3).fill(Region.SKIN),
    theta: new Float32Array(3),
    uvShirt: new Float32Array(6),
  };
  return {
    ...source,
    geometry,
    bodyLods: {
      mid: { ...source, geometry: source.geometry.clone() },
      low: { ...source, geometry: source.geometry.clone() },
    },
    heads: { high: minimalHead(), mid: minimalHead(), low: minimalHead() },
  };
}
async function reviewAssets(): Promise<ReviewPlayerAssets> {
  // Actual accepted head and actual head/facial implementation; only the optional
  // continuous body attachment is replaced with an observable interface fixture.
  const head = acceptedHeads.head.clone(),
    continuousHead = acceptedHeads.continuousHead.clone();
  const hair = minimalHead(),
    brows = minimalHead();
  const skin = new THREE.Texture(),
    hairMap = new THREE.Texture(),
    browMap = new THREE.Texture(),
    environment = new THREE.Texture();
  const dispose = vi.fn(() =>
    [head, continuousHead, hair, brows, skin, hairMap, browMap, environment].forEach((o) =>
      o.dispose()
    )
  );
  release.push(() => {
    if (!dispose.mock.calls.length) dispose();
  });
  return { head, continuousHead, hair, brows, skin, hairMap, browMap, environment, dispose };
}
function continuousAssets(): ContinuousPlayerAssets {
  const body = minimalHead(),
    jersey = minimalHead();
  const dispose = vi.fn(() => {
    body.dispose();
    jersey.dispose();
  });
  release.push(() => {
    if (!dispose.mock.calls.length) dispose();
  });
  return { body, jersey, dispose };
}
function face(head: HeadVisual) {
  return Object.fromEntries(
    Object.entries(head.mesh.morphTargetDictionary ?? {}).map(([name, i]) => [
      name,
      head.mesh.morphTargetInfluences?.[i] ?? 0,
    ])
  );
}
interface VisualFixture {
  rig: Rig;
  head: HeadVisual;
  marker: THREE.Group;
  captured: Record<string, number>;
  syncFace: Mock<[], void>;
  setDetail: Mock<[PlayerDetail], void>;
  setNumberTexture: Mock<[THREE.Texture], void>;
  dispose: Mock<[], void>;
}
const visuals: VisualFixture[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  visuals.length = 0;
  hooks.legacy.mockRejectedValue(new Error('legacy fixture unavailable'));
  hooks.upgrade.mockRejectedValue(new Error('upgrade fixture unavailable'));
  hooks.review.mockRejectedValue(new Error('review fixture unavailable'));
  hooks.continuous.mockRejectedValue(new Error('continuous fixture unavailable'));
  hooks.fallback.mockImplementation(() => ({ setDetail: vi.fn(), dispose: vi.fn(), meshes: {} }));
  hooks.attach.mockImplementation(
    (rig: Rig, _source, _look, _material, _assets, _review, _maps, head: HeadVisual) => {
      const marker = new THREE.Group();
      marker.name = 'continuous-pool-fixture';
      rig.root.add(marker);
      const visual: VisualFixture = {
        rig,
        head,
        marker,
        captured: {},
        syncFace: vi.fn(() => {
          visual.captured = face(head);
        }),
        setDetail: vi.fn((detail: PlayerDetail) => {
          marker.visible = detail !== 'low';
          visual.syncFace();
        }),
        setNumberTexture: vi.fn(),
        dispose: vi.fn(() => {
          marker.removeFromParent();
        }),
      };
      visuals.push(visual);
      return visual;
    }
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      new Proxy(
        {},
        {
          get: (_target, name) =>
            name === 'createImageData'
              ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
              : name === 'createLinearGradient' || name === 'createRadialGradient'
                ? () => ({ addColorStop: vi.fn() })
                : () => {},
          set: () => true,
        }
      ) as ReturnType<HTMLCanvasElement['getContext']>
  );
});
afterEach(() => {
  pools.splice(0).forEach((pool) => pool.dispose());
  release
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.restoreAllMocks();
});
function pool() {
  const result = createPlayerPool();
  pools.push(result);
  result.setTeams(1, 6);
  return result;
}
async function loaded() {
  const review = await reviewAssets(),
    continuous = continuousAssets();
  hooks.upgrade.mockResolvedValue(baseline());
  hooks.review.mockResolvedValue(review);
  hooks.continuous.mockResolvedValue(continuous);
  const result = pool();
  await settled();
  return { pool: result, review, continuous, visual: visuals.at(-1)! };
}

const armBones = ['upperArmL', 'foreArmL', 'handL', 'upperArmR', 'foreArmR', 'handR'] as const;
const armPose = (rig: Rig) => armBones.map((name) => rig.bones[name].quaternion.clone());
function expectArmPose(rig: Rig, expected: THREE.Quaternion[]) {
  armBones.forEach((name, i) =>
    expect(rig.bones[name].quaternion.angleTo(expected[i]), name).toBeLessThan(1e-6)
  );
}
function transitionFrame() {
  return directorFrame({
    matchKey: 'fixed-review-arm-transition',
    elapsedMs: 4000,
    status: 'FIRST_HALF',
    goals: [],
    fullTime: null,
  });
}

describe('fixed review actor arm transitions', () => {
  for (const celebration of ['ARMS_UP', 'HUG', 'WINGS', 'DEJECTED'] as const)
    for (const kind of ['idle', 'run'] as const)
      it(`preserves ${celebration} → ${kind} at zero time, then converges continuously`, async () => {
        const { pool: current } = await loaded();
        const frame = transitionFrame();
        frame.actors[1] = {
          ...frame.actors[1],
          speed: 0,
          anim: { kind: 'celebrate', celebration, t: 0.5 },
        };
        current.apply(frame, 0, 4, true);
        const rig = current.rigs[1],
          outgoing = armPose(rig);
        frame.actors[1] = { ...frame.actors[1], speed: kind === 'run' ? 2.4 : 0, anim: { kind } };
        const facts = JSON.stringify(frame);
        current.apply(frame, 0, 4, true);
        const jump = THREE.MathUtils.radToDeg(outgoing[0].angleTo(rig.bones.upperArmL.quaternion));
        console.info(JSON.stringify({ celebration, kind, zeroTimeUpperArmJumpDegrees: jump }));
        expectArmPose(rig, outgoing);
        let previous = outgoing;
        for (let step = 1; step <= 15; step++) {
          current.apply(frame, 1 / 60, 4 + step / 60, true);
          armBones.forEach((name, i) =>
            expect(rig.bones[name].quaternion.angleTo(previous[i]), name).toBeLessThan(0.7)
          );
          previous = armPose(rig);
        }
        const targets = sampleReviewArmTargets({
          kind,
          time: 4.25,
          phase: 0,
          speed: frame.actors[1].speed,
        });
        expectArmPose(
          rig,
          armBones.map((name) =>
            new THREE.Quaternion().setFromEuler(new THREE.Euler(...targets[name]!))
          )
        );
        expect(JSON.stringify(frame)).toBe(facts);
      });

  for (const first of ['idle', 'run'] as const)
    it(`preserves an interrupted celebration → ${first} introduction`, async () => {
      const { pool: current } = await loaded();
      const frame = transitionFrame(),
        rig = current.rigs[1];
      frame.actors[1] = {
        ...frame.actors[1],
        anim: { kind: 'celebrate', celebration: 'ARMS_UP', t: 0.5 },
      };
      current.apply(frame, 0, 4, true);
      frame.actors[1] = {
        ...frame.actors[1],
        speed: first === 'run' ? 2.4 : 0,
        anim: { kind: first },
      };
      current.apply(frame, 0, 4, true);
      current.apply(frame, 0.05, 4.05, true);
      const partial = armPose(rig);
      const second = first === 'idle' ? 'run' : 'idle';
      frame.actors[1] = {
        ...frame.actors[1],
        speed: second === 'run' ? 2.4 : 0,
        anim: { kind: second },
      };
      current.apply(frame, 0, 4.05, true);
      expectArmPose(rig, partial);
      current.apply(frame, 0.02, 4.07, true);
      const interrupted = armPose(rig);
      frame.actors[1] = {
        ...frame.actors[1],
        anim: { kind: 'celebrate', celebration: 'WINGS', t: 0.5 },
      };
      current.apply(frame, 0, 4.07, true);
      // The existing additive rest-abduction offset also blends into the
      // celebration. Keep that sub-degree correction; wrists/elbows stay exact.
      armBones.forEach((name, i) =>
        expect(rig.bones[name].quaternion.angleTo(interrupted[i]), name).toBeLessThan(
          name.startsWith('upperArm') ? 0.02 : 1e-6
        )
      );
      current.apply(frame, 0.05, 4.12, true);
      const celebration = armPose(rig);
      frame.actors[1] = { ...frame.actors[1], speed: 0, anim: { kind: 'idle' } };
      current.apply(frame, 0, 4.12, true);
      expectArmPose(rig, celebration);
    });

  for (const kind of ['idle', 'run'] as const)
    it(`introduces ${kind} continuously when its first frame has positive elapsed time`, async () => {
      const { pool: current } = await loaded();
      const frame = transitionFrame(),
        rig = current.rigs[1];
      frame.actors[1] = {
        ...frame.actors[1],
        speed: 0,
        anim: { kind: 'celebrate', celebration: 'ARMS_UP', t: 0.5 },
      };
      current.apply(frame, 0, 4, true);
      const outgoing = armPose(rig);
      frame.actors[1] = { ...frame.actors[1], speed: kind === 'run' ? 2.4 : 0, anim: { kind } };
      const facts = JSON.stringify(frame);
      current.apply(frame, 1 / 60, 4 + 1 / 60, true);
      armBones.forEach((name, i) =>
        expect(rig.bones[name].quaternion.angleTo(outgoing[i]), name).toBeLessThan(0.4)
      );
      expect(JSON.stringify(frame)).toBe(facts);
    });

  for (const reset of ['teams', 'rewind'] as const)
    it(`discards a partial arm introduction on explicit ${reset} reset`, async () => {
      const { pool: current } = await loaded();
      const frame = transitionFrame(),
        rig = current.rigs[1];
      frame.actors[1] = {
        ...frame.actors[1],
        anim: { kind: 'celebrate', celebration: 'ARMS_UP', t: 0.5 },
      };
      current.apply(frame, 0, 4, true);
      frame.actors[1] = { ...frame.actors[1], speed: 0, anim: { kind: 'idle' } };
      current.apply(frame, 0.02, 4.02, true);
      if (reset === 'teams') current.setTeams(1, 6);
      const time = reset === 'rewind' ? 2 : 4.02;
      current.apply(frame, 0, time, true);
      const targets = sampleReviewArmTargets({ kind: 'idle', time, phase: 0, speed: 0 });
      expectArmPose(
        rig,
        armBones.map((name) =>
          new THREE.Quaternion().setFromEuler(new THREE.Euler(...targets[name]!))
        )
      );
    });
});

describe('optional continuous character pool lifecycle', () => {
  for (const first of ['review', 'continuous'] as const)
    it(`adopts exactly fixed slot 1 when ${first} resolves first`, async () => {
      const upgrade = deferred<HumanGeometry>(),
        review = deferred<ReviewPlayerAssets>(),
        continuous = deferred<ContinuousPlayerAssets>();
      hooks.upgrade.mockReturnValue(upgrade.promise);
      hooks.review.mockReturnValue(review.promise);
      hooks.continuous.mockReturnValue(continuous.promise);
      const current = pool();
      expect(hooks.review).not.toHaveBeenCalled();
      expect(hooks.continuous).not.toHaveBeenCalled();
      upgrade.resolve(baseline());
      await settled();
      expect(hooks.review).toHaveBeenCalledOnce();
      expect(hooks.continuous).toHaveBeenCalledOnce();
      const names = current.rigs.map((r) => r.root.userData.playerIdentity.name);
      const reviewValue = await reviewAssets(),
        continuousValue = continuousAssets();
      if (first === 'review') review.resolve(reviewValue);
      else continuous.resolve(continuousValue);
      await settled();
      expect(hooks.attach).not.toHaveBeenCalled();
      expect(hooks.fallback).toHaveBeenCalledTimes(first === 'review' ? 1 : 0);
      if (first === 'review') continuous.resolve(continuousValue);
      else review.resolve(reviewValue);
      await settled();
      expect(hooks.attach).toHaveBeenCalledOnce();
      expect(visuals[0].rig).toBe(current.rigs[1]);
      expect(
        current.rigs.flatMap((r, i) =>
          r.root.getObjectByName('continuous-pool-fixture') ? [i] : []
        )
      ).toEqual([1]);
      expect(current.rigs.map((r) => r.root.userData.playerIdentity.name)).toEqual(names);
      expect(visuals[0].head.mesh.geometry.getAttribute('position')).toBe(
        reviewValue.continuousHead!.getAttribute('position')
      );
      if (first === 'review')
        expect(hooks.fallback.mock.results[0].value.dispose).toHaveBeenCalledOnce();
      expect(reviewValue.dispose).not.toHaveBeenCalled();
      expect(continuousValue.dispose).not.toHaveBeenCalled();
    });

  it('keeps the already mounted review character when the new body load fails', async () => {
    const review = await reviewAssets(),
      pending = deferred<ContinuousPlayerAssets>();
    hooks.upgrade.mockResolvedValue(baseline());
    hooks.review.mockResolvedValue(review);
    hooks.continuous.mockReturnValue(pending.promise);
    const current = pool();
    await settled();
    const fallback = hooks.fallback.mock.results[0].value;
    const geometry = current.rigs.map((r) => r.mesh.geometry);
    pending.reject(new Error('body download failed'));
    await settled();
    expect(hooks.attach).not.toHaveBeenCalled();
    expect(hooks.fallback).toHaveBeenCalledOnce();
    expect(fallback.dispose).not.toHaveBeenCalled();
    expect(current.rigs.map((r) => r.mesh.geometry)).toEqual(geometry);
    expect(current.rigs.flatMap((r, i) => (r.root.userData.reviewPlayer ? [i] : []))).toEqual([1]);
  });

  for (const reviewFirst of [false, true])
    it(`releases a late body after disposal without adoption (review already mounted: ${reviewFirst})`, async () => {
      const review = await reviewAssets(),
        continuous = continuousAssets();
      const pendingReview = deferred<ReviewPlayerAssets>(),
        pendingBody = deferred<ContinuousPlayerAssets>();
      hooks.upgrade.mockResolvedValue(baseline());
      hooks.review.mockReturnValue(pendingReview.promise);
      hooks.continuous.mockReturnValue(pendingBody.promise);
      const current = pool();
      await settled();
      if (reviewFirst) {
        pendingReview.resolve(review);
        await settled();
      }
      current.dispose();
      pendingBody.resolve(continuous);
      if (!reviewFirst) pendingReview.resolve(review);
      await settled();
      expect(hooks.attach).not.toHaveBeenCalled();
      expect(continuous.dispose).toHaveBeenCalledOnce();
      expect(review.dispose).toHaveBeenCalledOnce();
      expect(current.group.children).toHaveLength(0);
    });

  it('rebuilds only the character instance for new teams and releases shared assets once at final disposal', async () => {
    const { pool: current, review, continuous, visual: first } = await loaded();
    current.setTeams(2, 7);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(first.marker.parent).toBeNull();
    expect(hooks.attach).toHaveBeenCalledTimes(2);
    expect(visuals[1].rig).toBe(current.rigs[1]);
    expect(review.dispose).not.toHaveBeenCalled();
    expect(continuous.dispose).not.toHaveBeenCalled();
    expect(hooks.review).toHaveBeenCalledOnce();
    expect(hooks.continuous).toHaveBeenCalledOnce();
    current.dispose();
    current.dispose();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(visuals[1].dispose).toHaveBeenCalledOnce();
    expect(review.dispose).toHaveBeenCalledOnce();
    expect(continuous.dispose).toHaveBeenCalledOnce();
  });

  it('ignores a late legacy body after continuous adoption', async () => {
    const legacy = deferred<HumanGeometry>();
    hooks.legacy.mockReturnValue(legacy.promise);
    const { pool: current, visual } = await loaded();
    const old = baseline(),
      disposed = vi.spyOn(old.geometry, 'dispose');
    legacy.resolve(old);
    await settled();
    expect(disposed).toHaveBeenCalledOnce();
    expect(hooks.attach).toHaveBeenCalledOnce();
    expect(visual.dispose).not.toHaveBeenCalled();
    expect(visual.marker.parent).toBe(current.rigs[1].root);
  });

  it('syncs real facial state after animation, reduced motion and immediate detail changes', async () => {
    const { pool: current, visual } = await loaded();
    const plate = current.rigs[1].bones.chest.children.find(
      (object): object is THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> =>
        object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial
    )!;
    expect(plate).toBeDefined();
    expect(visual.setNumberTexture).toHaveBeenCalledOnce();
    expect(visual.setNumberTexture).toHaveBeenCalledWith(plate.material.map);
    expect(plate.visible).toBe(false);
    const frame = directorFrame({
      matchKey: 'continuous-lifecycle',
      elapsedMs: 4000,
      status: 'FIRST_HALF',
      goals: [],
      fullTime: null,
    });
    frame.actors[1] = { ...frame.actors[1], speed: 2.4, anim: { kind: 'run' } };
    const facts = JSON.stringify(frame);
    current.apply(frame, 1 / 60, 4, true);
    expect(visual.captured).toEqual(face(visual.head));
    expect(visual.captured.jawOpen).toBe(0.08);
    current.rigs.forEach((rig, i) => {
      if (i !== 1) rig.root.position.x = 1000 + i * 3;
    });
    const at = current.rigs[1].root.position;
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
    camera.position.set(at.x, 1.2, at.z + 4);
    camera.lookAt(at.x, 0.9, at.z);
    camera.updateProjectionMatrix();
    current.setDetail!(camera, 1);
    expect(current.rigs[1].root.userData.playerDetail).toBe('low');
    expect(plate.visible).toBe(false);
    expect(visual.captured.jawOpen).toBe(0);
    expect(visual.captured).toEqual(face(visual.head));
    current.setDetail!(camera, 120);
    expect(current.rigs[1].root.userData.playerDetail).toBe('mid');
    expect(plate.visible).toBe(false);
    expect(visual.captured.jawOpen).toBe(0.08);
    current.setDetail!(camera, 900);
    expect(current.rigs[1].root.userData.playerDetail).toBe('high');
    expect(plate.visible).toBe(false);
    expect(visual.captured.jawOpen).toBe(0.08);
    expect(visual.captured).toEqual(face(visual.head));
    current.apply(frame, 1 / 60, 4, false);
    expect(visual.captured.jawOpen).toBe(0);
    expect(visual.captured.blinkLeft).toBe(0);
    expect(visual.captured).toEqual(face(visual.head));
    const bones = Object.values(current.rigs[1].bones).map((bone) => bone.quaternion.toArray());
    current.apply(frame, 1 / 60, 5, false);
    expect(Object.values(current.rigs[1].bones).map((bone) => bone.quaternion.toArray())).toEqual(
      bones
    );
    current.setDetail!(camera, 1);
    current.setDetail!(camera, 900);
    expect(visual.captured.jawOpen).toBe(0);
    expect(visual.captured).toEqual(face(visual.head));
    expect(JSON.stringify(frame)).toBe(facts);
  });
});
