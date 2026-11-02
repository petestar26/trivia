import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachReviewBody, buildReviewBody } from './review-player-body';
import { BONES, Region, createRig, kitFromClub, type HumanGeometry, type Look } from './rig';
import { poseRun } from './poses';
import { poseFingers } from './player-appearance';
import { headGeometry } from './player-assets';

const look: Look = {
  kit: kitFromClub({ primary: '#ba132b', secondary: '#faf5ef', pattern: 'solid' }),
  skin: '#a86b45',
  hair: '#201a18',
};
let source: HumanGeometry;
const release: Array<() => void> = [];
afterEach(() => {
  release
    .splice(0)
    .reverse()
    .forEach((f) => f());
  vi.restoreAllMocks();
});
async function loadBody(level: string): Promise<HumanGeometry> {
  const bytes = readFileSync(`public/models/football/player-body-${level}.glb`);
  const parsed = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, '');
  let geometry!: THREE.BufferGeometry;
  parsed.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      geometry = o.geometry;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    }
    if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
  });
  return {
    geometry,
    positions: geometry.getAttribute('position').array as Float32Array,
    region: geometry.getAttribute('_region').array as Float32Array,
    theta: geometry.getAttribute('_theta').array as Float32Array,
    uvShirt: geometry.getAttribute('uv').array as Float32Array,
  };
}
beforeAll(async () => {
  source = await loadBody('high');
  source.bodyLods = { mid: await loadBody('mid'), low: await loadBody('low') };
});
afterAll(() => {
  source.geometry.dispose();
  Object.values(source.bodyLods!).forEach((body) => body.geometry.dispose());
});
function owned<T extends { dispose(): void }>(o: T): T {
  release.push(() => o.dispose());
  return o;
}
function fingerprint(g: THREE.BufferGeometry) {
  const hash = createHash('sha256');
  for (const a of [...Object.values(g.attributes), g.index!])
    hash.update(Buffer.from(a.array.buffer, a.array.byteOffset, a.array.byteLength));
  return hash.digest('hex');
}

describe('one fitted review body', () => {
  it('contains the upper internal neck seal inside the actual textured anatomical neck', async () => {
    const bytes = readFileSync('public/models/football/review-head-high.glb');
    const parsed = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, '');
    parsed.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        owned(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(owned);
      }
    });
    const head = owned(headGeometry({ status: 'fulfilled', value: parsed }, true));
    const material = owned(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const surface = new THREE.Mesh(head, material);
    surface.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    for (const detail of ['high', 'mid'] as const) {
      const body = owned(
        buildReviewBody(detail === 'high' ? source : source.bodyLods!.mid, look, detail)
      );
      const points = body.shells.neck.getAttribute('position');
      let checked = 0;
      for (let i = 0; i < points.count; i++) {
        const y = points.getY(i);
        if (y < 1.5) continue;
        const origin = new THREE.Vector3(0, y, 0.008);
        const outward = new THREE.Vector3(points.getX(i), 0, points.getZ(i) - 0.008);
        const radius = outward.length();
        ray.set(origin, outward.normalize());
        const intersections = ray.intersectObject(surface);
        expect(intersections.length).toBeGreaterThan(0);
        expect(intersections[0].distance - radius, `${detail} seal vertex ${i}`).toBeGreaterThan(
          0.0001
        );
        checked++;
      }
      expect(checked).toBeGreaterThan(40);
    }
  });

  it('derives bounded separate cloth shells and an elliptical neck from the pinned CC0 high body', () => {
    expect(
      createHash('sha256')
        .update(readFileSync('public/models/football/player-body-high.glb'))
        .digest('hex')
    ).toBe('fddf4548b0d875970e87f38e28daa7e3af8682a3042653023bb4b24718777dc3');
    const before = fingerprint(source.geometry),
      body = owned(buildReviewBody(source, look));
    expect(body.geometry.getAttribute('position').count).toBeGreaterThan(body.sourceVertexCount);
    expect(body.triangleCount).toBeLessThan(25000);
    expect(body.triangleCount).toBeGreaterThan(source.geometry.index!.count / 3);
    for (const part of ['jersey', 'sleeves', 'shorts', 'neck'] as const) {
      const g = body.shells[part];
      expect(g).not.toBe(body.geometry);
      expect(g.index!.count / 3).toBeGreaterThan(40);
      expect(g.boundingBox!.min.y).toBeGreaterThan(0.63);
      expect(g.boundingBox!.max.x).toBeLessThan(0.3);
      expect(g.boundingBox!.max.y).toBeLessThan(1.61);
    }
    const neck = body.shells.neck.getAttribute('position');
    const bottom = [],
      middle = [];
    for (let i = 0; i < neck.count; i++) {
      if (neck.getY(i) < 1.46) bottom.push(Math.abs(neck.getX(i)));
      if (Math.abs(neck.getY(i) - 1.48) < 0.004) middle.push(Math.abs(neck.getX(i)));
    }
    expect(bottom.length).toBeGreaterThan(30);
    expect(middle.length).toBeGreaterThan(30);
    expect(body.shells.neck.boundingBox!.max.y).toBeLessThan(1.512);
    expect(Math.max(...bottom) - Math.max(...middle)).toBeGreaterThan(0.008);
    const top = body.shells.jersey.getAttribute('position');
    // The curved yoke retains a fitted inner opening and bridges the wider
    // source jersey edge. Above-view coverage is checked separately below.
    const narrowBand = Array.from({ length: top.count }, (_, i) => i).filter(
      (i) => top.getY(i) > 1.445 && Math.abs(top.getX(i)) < 0.08 && top.getZ(i) > 0.06
    );
    expect(narrowBand.length).toBeGreaterThan(10);
    expect(fingerprint(source.geometry)).toBe(before);
  });

  it('covers the wide source jersey opening with the curved yoke across high/mid dressed scales', () => {
    const material = owned(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const downward = new THREE.Vector3(0, -1, 0),
      ray = new THREE.Raycaster();
    const misses: Array<{
      detail: string;
      scale: number;
      fraction: number;
      step: number;
      height?: number;
    }> = [];
    for (const [detail, input] of [
      ['high', source],
      ['mid', source.bodyLods!.mid],
    ] as const) {
      const body = owned(buildReviewBody(input, look, detail));
      const jersey = new THREE.Mesh(body.shells.jersey, material);
      for (const scale of [0.96, 1.04]) {
        jersey.scale.setScalar(scale);
        jersey.updateMatrixWorld(true);
        for (const fraction of [0.25, 0.5, 0.85])
          for (let step = 0; step < 16; step++) {
            const angle = (step / 16) * Math.PI * 2;
            const xRadius = 0.061 + (0.17 - 0.061) * fraction;
            const zOuter = Math.cos(angle) >= 0 ? 0.103 : 0.154;
            const zRadius = 0.053 + (zOuter - 0.053) * fraction;
            ray.set(
              new THREE.Vector3(
                Math.sin(angle) * xRadius * scale,
                1.65 * scale,
                (0.008 + Math.cos(angle) * zRadius) * scale
              ),
              downward
            );
            // A fitted front edge drapes onto upper chest below shoulder height;
            // require a real upper-shirt hit rather than a flat collar plane.
            const hit = ray.intersectObject(jersey, false)[0];
            if (!hit || hit.point.y < 1.37 * scale || hit.point.y > 1.49 * scale)
              misses.push({
                detail,
                scale,
                fraction,
                step,
                height: hit ? hit.point.y / scale : undefined,
              });
          }
      }
    }
    expect(misses).toEqual([]);
  });

  it('preserves every protected boot/palm/finger vertex and the weighted world contacts through running poses', () => {
    const before = fingerprint(source.geometry),
      body = owned(buildReviewBody(source, look));
    const material = owned(new THREE.MeshBasicMaterial());
    const original = owned(createRig(material, source.geometry)),
      fitted = owned(createRig(material, body.geometry));
    const p = source.geometry.getAttribute('position'),
      r = source.region;
    const weight = source.geometry.getAttribute('skinWeight'),
      index = source.geometry.getAttribute('skinIndex');
    const protectedIds = [...body.protectedVertices];
    expect(protectedIds.filter((i) => r[i] === Region.BOOT).length).toBeGreaterThan(200);
    expect(protectedIds.filter((i) => r[i] === Region.GLOVE).length).toBeGreaterThan(5000);
    const changes: number[] = [];
    for (const i of protectedIds) {
      for (const name of ['position', 'skinIndex', 'skinWeight'] as const) {
        const a = source.geometry.getAttribute(name),
          b = body.geometry.getAttribute(name);
        for (let k = 0; k < a.itemSize; k++)
          if (a.getComponent(i, k) !== b.getComponent(i, k)) changes.push(i);
      }
    }
    expect(changes).toHaveLength(0);
    const active = new Set(Array.from(body.geometry.index!.array));
    const oldSeal = Array.from({ length: p.count }, (_, i) => i).filter(
      (i) =>
        r[i] === Region.SKIN &&
        p.getY(i) >= 1.4549 &&
        p.getY(i) <= 1.5951 &&
        Math.abs(p.getX(i)) < 0.063 &&
        Math.abs(p.getZ(i) - 0.01) < 0.063 &&
        [0, 1, 2, 3].reduce(
          (sum, k) =>
            sum +
            (/^(neck|head)$/.test(BONES[index.getComponent(i, k)]) ? weight.getComponent(i, k) : 0),
          0
        ) > 0.99
    );
    expect(oldSeal.length).toBeGreaterThan(100);
    expect(oldSeal.filter((i) => active.has(i))).toHaveLength(0);
    const moved = Array.from({ length: p.count }, (_, i) =>
      new THREE.Vector3()
        .fromBufferAttribute(p, i)
        .distanceTo(
          new THREE.Vector3().fromBufferAttribute(body.geometry.getAttribute('position'), i)
        )
    ).filter((d) => d > 1e-8);
    expect(moved.length).toBeGreaterThan(100);
    expect(Math.max(...moved)).toBeLessThan(0.002501);
    const bootAndHand = protectedIds.filter(
      (i) =>
        r[i] === Region.BOOT ||
        [0, 1, 2, 3].some(
          (k) =>
            weight.getComponent(i, k) > 0.3 &&
            /^(hand|index1|thumb1)/.test(BONES[index.getComponent(i, k)])
        )
    );
    let worst = 0;
    for (const phase of [0, 0.24, 0.51, 0.77]) {
      for (const rig of [original, fitted]) {
        rig.root.scale.setScalar(0.97);
        rig.root.rotation.y = 0.83;
        poseRun(rig, phase, 6);
        poseFingers(rig, 'run', true, [0.6, 0.3, 0.2]);
        rig.root.updateMatrixWorld(true);
        rig.skeleton.update();
      }
      for (const i of bootAndHand)
        worst = Math.max(
          worst,
          original.mesh
            .getVertexPosition(i, new THREE.Vector3())
            .distanceTo(fitted.mesh.getVertexPosition(i, new THREE.Vector3()))
        );
      for (const name of ['footL', 'footR', 'handL', 'handR'] as const)
        expect(fitted.bones[name].matrixWorld.elements).toEqual(
          original.bones[name].matrixWorld.elements
        );
    }
    expect(worst).toBeLessThan(1e-10);
    const liveBoots = new Set<number>();
    for (const i of Array.from(body.geometry.index!.array))
      if (r[i] === Region.BOOT) liveBoots.add(i);
    expect(liveBoots.size).toBeGreaterThan(200);
    expect(fitted.mesh.bindMatrix.elements).toEqual(original.mesh.bindMatrix.elements);
    expect(fingerprint(source.geometry)).toBe(before);
    expect(p.count).toBe(body.sourceVertexCount);
  });

  it('fits real long keeper sleeves without changing protected gloves or contaminating the outfield look', () => {
    const before = fingerprint(source.geometry),
      outfield = owned(buildReviewBody(source, look));
    const keeperLook: Look = { ...look, kit: { ...look.kit, keeper: true, glove: '#f1c352' } };
    const keeper = owned(buildReviewBody(source, keeperLook));
    expect(keeper.shells.sleeves.boundingBox!.min.y).toBeLessThan(
      outfield.shells.sleeves.boundingBox!.min.y - 0.15
    );
    expect(keeper.shells.sleeves.boundingBox!.min.y).toBeLessThan(1.02);
    const gloveIds = Array.from(source.region).flatMap((region, i) =>
      region === Region.GLOVE ? [i] : []
    );
    expect(gloveIds.length).toBeGreaterThan(5000);
    let differences = 0;
    for (const i of gloveIds)
      for (const name of ['position', 'skinIndex', 'skinWeight'] as const) {
        const original = source.geometry.getAttribute(name),
          fitted = keeper.geometry.getAttribute(name);
        for (let k = 0; k < original.itemSize; k++)
          if (original.getComponent(i, k) !== fitted.getComponent(i, k)) differences++;
      }
    expect(differences).toBe(0);
    const active = new Set(Array.from(keeper.geometry.index!.array));
    expect(gloveIds.filter((i) => active.has(i))).toHaveLength(gloveIds.length);
    const forearms = Array.from(source.region).flatMap((region, i) =>
      region === Region.FOREARM ? [i] : []
    );
    expect(forearms.length).toBeGreaterThan(200);
    const retained = forearms.filter((i) => active.has(i));
    expect(retained.length).toBeLessThan(forearms.length * 0.15);
    // Keep the original mixed cuff edge at the protected glove boundary. Every
    // other forearm surface belongs to the fitted long sleeve.
    const cuff = new Set<number>(),
      sourceIndex = source.geometry.index!;
    for (let i = 0; i < sourceIndex.count; i += 3) {
      const ids = [sourceIndex.getX(i), sourceIndex.getX(i + 1), sourceIndex.getX(i + 2)];
      if (ids.some((i) => source.region[i] === Region.GLOVE))
        ids.filter((i) => source.region[i] === Region.FOREARM).forEach((i) => cuff.add(i));
    }
    expect(retained.sort((a, b) => a - b)).toEqual([...cuff].sort((a, b) => a - b));
    for (const i of [forearms[0], forearms[Math.floor(forearms.length / 2)], forearms.at(-1)!]) {
      expect(keeper.geometry.getAttribute('_region').getX(i)).toBe(Region.SHIRT);
      expect(outfield.geometry.getAttribute('_region').getX(i)).toBe(Region.FOREARM);
      expect(keeper.geometry.getAttribute('uv').getX(i)).toBe(source.uvShirt[i * 2]);
      expect(keeper.geometry.getAttribute('uv').getY(i)).toBe(source.uvShirt[i * 2 + 1]);
    }
    expect(fingerprint(source.geometry)).toBe(before);
    const unchanged = owned(buildReviewBody(source, look));
    expect(fingerprint(unchanged.geometry)).toBe(fingerprint(outfield.geometry));
    for (const part of ['jersey', 'sleeves', 'shorts', 'neck'] as const)
      expect(fingerprint(unchanged.shells[part])).toBe(fingerprint(outfield.shells[part]));
  });

  it('retains finite normalized four-bone skinning on real high and mid surfaces, including new shell edges and neck', () => {
    const stats = [];
    for (const [detail, input] of [
      ['high', source],
      ['mid', source.bodyLods!.mid],
    ] as const) {
      const body = owned(buildReviewBody(input, look, detail));
      let maxError = 0,
        invalid = 0;
      for (const g of [body.geometry, ...Object.values(body.shells)]) {
        const p = g.getAttribute('position'),
          j = g.getAttribute('skinIndex'),
          w = g.getAttribute('skinWeight');
        for (const a of Object.values(g.attributes))
          for (const value of a.array) if (!Number.isFinite(value)) invalid++;
        for (let i = 0; i < p.count; i++) {
          let total = 0;
          for (let k = 0; k < 4; k++) {
            const value = w.getComponent(i, k),
              joint = j.getComponent(i, k);
            total += value;
            if (value < 0 || joint < 0 || joint >= BONES.length || !Number.isInteger(joint))
              invalid++;
          }
          maxError = Math.max(maxError, Math.abs(total - 1));
        }
      }
      expect(invalid).toBe(0);
      expect(maxError).toBeLessThan(1e-6);
      expect(body.triangleCount).toBeLessThan(detail === 'high' ? 25000 : 14000);
      stats.push({
        detail,
        triangles: body.triangleCount,
        originalVertices: body.sourceVertexCount,
        bodyVertices: body.geometry.getAttribute('position').count,
        protectedVertices: body.protectedVertices.length,
        geometries: 1 + Object.keys(body.shells).length,
      });
    }
    console.info('review-body geometry budgets', JSON.stringify(stats));
  });

  it('releases the successful high sibling if a later detail cannot be built', () => {
    const material = owned(new THREE.MeshBasicMaterial()),
      rig = owned(createRig(material, source.geometry));
    const brokenMid = source.bodyLods!.mid.geometry.clone();
    brokenMid.deleteAttribute('normal');
    release.push(() => brokenMid.dispose());
    const bad = {
      ...source,
      bodyLods: { ...source.bodyLods!, mid: { ...source.bodyLods!.mid, geometry: brokenMid } },
    };
    const disposed = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    expect(() => attachReviewBody(rig, bad, look, material)).toThrow();
    expect(disposed).toHaveBeenCalledTimes(5);
    expect(rig.mesh.geometry).toBe(source.geometry);
    expect(rig.root.children.filter((o) => o instanceof THREE.SkinnedMesh)).toHaveLength(1);
  });

  it('binds only four owned shell meshes, honors low detail and cleans up once without disposing caller resources', () => {
    const material = owned(new THREE.MeshBasicMaterial()),
      rig = owned(createRig(material, source.geometry));
    const materialDispose = vi.spyOn(material, 'dispose'),
      skeletonDispose = vi.spyOn(rig.skeleton, 'dispose');
    const geometries = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const visual = attachReviewBody(rig, source, look, material),
      first = rig.mesh.geometry;
    expect(Object.values(visual.meshes)).toHaveLength(4);
    for (const mesh of Object.values(visual.meshes)) {
      expect(mesh.skeleton).toBe(rig.skeleton);
      expect(mesh.material).toBe(material);
      expect(mesh.bindMatrix.elements).toEqual(rig.mesh.bindMatrix.elements);
      expect(mesh.parent).toBe(rig.root);
    }
    visual.setDetail('mid');
    expect(rig.mesh.geometry).not.toBe(first);
    visual.setDetail('low');
    expect(rig.mesh.geometry.getAttribute('position')).toBe(
      source.bodyLods!.low.geometry.getAttribute('position')
    );
    expect(Object.values(visual.meshes).every((mesh) => !mesh.visible)).toBe(true);
    visual.setDetail('high');
    expect(rig.mesh.geometry).toBe(first);
    visual.dispose();
    visual.dispose();
    expect(rig.mesh.geometry).toBe(source.geometry);
    expect(Object.values(visual.meshes).every((mesh) => mesh.parent === null)).toBe(true);
    expect(geometries).toHaveBeenCalledTimes(11);
    expect(materialDispose).not.toHaveBeenCalled();
    expect(skeletonDispose).not.toHaveBeenCalled();
    visual.setDetail('high');
    expect(rig.mesh.geometry).toBe(source.geometry);
  });
});
