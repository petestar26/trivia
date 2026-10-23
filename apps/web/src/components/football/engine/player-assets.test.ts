import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadPlayerUpgrade, disposePlayerGeometry } from './player-assets';
import { attachPlayerHead, headLook, playerIdentity, attachBootDetails } from './player-appearance';
import { createRig, BONES, Region } from './rig';
import { poseIdle, poseRun, stanceDuty } from './poses';

const parsed: Array<{ dispose(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  parsed.splice(0).forEach((o) => o.dispose());
});
function localLoads(fail?: string) {
  vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async function (
    this: GLTFLoader,
    url
  ) {
    if (String(url).includes(fail ?? 'never-fail')) throw new Error('Injected missing asset');
    const bytes = Uint8Array.from(readFileSync(`public${url}`));
    const gltf = await this.parseAsync(bytes.buffer, '');
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        parsed.push(o.geometry);
        parsed.push(...(Array.isArray(o.material) ? o.material : [o.material]));
      }
      if (o instanceof THREE.SkinnedMesh) parsed.push(o.skeleton);
    });
    return gltf;
  });
}
describe('local player surface pipeline', () => {
  it('loads three true body/head levels with normalized production skin and independent expressions', async () => {
    localLoads();
    const base = await loadPlayerUpgrade();
    expect(BONES).toHaveLength(49);
    const triangles = [base, base.bodyLods!.mid, base.bodyLods!.low].map(
      (b) => b.geometry.index!.count / 3
    );
    expect(triangles[0]).toBeGreaterThan(triangles[1]);
    expect(triangles[1]).toBeGreaterThan(triangles[2]);
    expect(triangles[1]).toBeLessThan(6500);
    expect(triangles[2]).toBeLessThan(3300);
    const identities = [playerIdentity(1, 1), playerIdentity(2, 2)],
      material = new THREE.MeshStandardMaterial({ vertexColors: true });
    const rigs = identities.map(() => createRig(material, base.geometry));
    const heads = rigs.map((rig, i) => attachPlayerHead(rig, base.heads!, identities[i], material));
    heads[0].setDetail('high');
    heads[1].setDetail('high');
    expect(heads[0].mesh.geometry.getAttribute('position')).toBe(
      heads[1].mesh.geometry.getAttribute('position')
    );
    expect(heads[0].mesh.geometry.getAttribute('color')).not.toBe(
      heads[1].mesh.geometry.getAttribute('color')
    );
    expect(heads[0].mesh.morphTargetInfluences).not.toBe(heads[1].mesh.morphTargetInfluences);
    poseIdle(rigs[1], 0);
    const still = rigs[1].bones.handL.matrixWorld.clone();
    for (let step = 0; step < 20; step++) {
      poseRun(rigs[0], step / 20, 5);
      heads[0].animate(step / 20, 'run', true);
      rigs[0].root.updateMatrixWorld(true);
      rigs[0].skeleton.update();
      for (let i = 0; i < heads[0].mesh.geometry.getAttribute('position').count; i += 83) {
        const vertex = heads[0].mesh.getVertexPosition(i, new THREE.Vector3());
        expect(vertex.toArray().every(Number.isFinite)).toBe(true);
        expect(vertex.length()).toBeLessThan(2.3);
      }
    }
    expect(rigs[1].bones.handL.matrixWorld.equals(still)).toBe(true);
    heads[0].setDetail('low');
    expect(heads[0].hair.visible).toBe(true);
    expect(heads[0].hair.geometry.index!.count / 3).toBeLessThan(900);
    heads[0].animate(0, 'celebrate', false);
    expect(heads[0].mesh.morphTargetInfluences![heads[0].mesh.morphTargetDictionary!.smile]).toBe(
      0
    );
    heads.forEach((h) => h.dispose());
    rigs.forEach((r) => r.dispose());
    material.dispose();
    disposePlayerGeometry(base);
  });
  it('keeps the actual boot surfaces and close-up sole overlays above turf through stance roll', async () => {
    localLoads();
    const base = await loadPlayerUpgrade();
    for (const body of [base, base.bodyLods!.mid, base.bodyLods!.low]) {
      const material = new THREE.MeshBasicMaterial(),
        rig = createRig(material, body.geometry),
        boots = attachBootDetails(rig);
      boots.setDetail('high');
      const p = body.geometry.getAttribute('position'),
        region = body.geometry.getAttribute('_region');
      for (const speed of [2, 6, 8])
        for (let step = 0; step < 80; step++) {
          const phase = step / 80;
          poseRun(rig, phase, speed);
          rig.root.updateMatrixWorld(true);
          rig.skeleton.update();
          for (const side of ['L', 'R'] as const)
            if ((phase + (side === 'L' ? 0 : 0.5)) % 1 < stanceDuty(speed)) {
              for (let i = 0; i < p.count; i++)
                if (region.getX(i) === Region.BOOT && p.getX(i) > 0 === (side === 'L'))
                  expect(rig.mesh.getVertexPosition(i, new THREE.Vector3()).y).toBeGreaterThan(
                    -0.003
                  );
              rig.bones[`foot${side}`].traverse((o) => {
                if (o instanceof THREE.Mesh) {
                  const a = o.geometry.getAttribute('position');
                  for (let i = 0; i < a.count; i++)
                    expect(
                      new THREE.Vector3().fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld).y
                    ).toBeGreaterThan(-0.003);
                }
              });
            }
        }
      boots.dispose();
      rig.dispose();
      material.dispose();
    }
    disposePlayerGeometry(base);
  });
  it('disposes successful asset siblings when one load fails', async () => {
    localLoads('body-mid');
    const disposals = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose'),
      materials = vi.spyOn(THREE.Material.prototype, 'dispose');
    await expect(loadPlayerUpgrade()).rejects.toThrow('Player detail unavailable');
    expect(disposals.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(materials.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
  it('retains all eight morph/normal arrays when creating an identity surface', async () => {
    localLoads();
    const base = await loadPlayerUpgrade(),
      look = headLook(base.heads!.high, playerIdentity(1, 2));
    expect(look.morphAttributes.position).toBe(base.heads!.high.morphAttributes.position);
    expect(look.morphAttributes.normal).toBe(base.heads!.high.morphAttributes.normal);
    expect(look.morphTargetsRelative).toBe(true);
    expect(Object.keys(look.userData.morphNames)).toHaveLength(8);
    look.dispose();
    disposePlayerGeometry(base);
  });
});
