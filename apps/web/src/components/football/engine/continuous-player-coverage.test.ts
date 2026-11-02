import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { continuousShirtCoverage } from './continuous-player-coverage';
import { BONES } from './rig';

async function body() {
  const raw = Uint8Array.from(readFileSync('public/models/football/continuous-body.glb')).buffer;
  const gltf = await new GLTFLoader().parseAsync(raw, '');
  const mesh = gltf.scene.getObjectByName('continuous-body') as THREE.SkinnedMesh;
  return {
    geometry: mesh.geometry,
    dispose() {
      mesh.geometry.dispose();
      mesh.skeleton.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        material.dispose();
    },
  };
}

describe('MHCLO correspondence shirt coverage', () => {
  it('covers MHCLO-defined proximal sleeve and upper-back regions while preserving neck, bare distal arms and hands', async () => {
    const source = await body();
    try {
      const g = source.geometry,
        p = g.getAttribute('position');
      const before = Uint8Array.from(
        new Uint8Array(p.array.buffer, p.array.byteOffset, p.array.byteLength)
      );
      const mask = continuousShirtCoverage(g),
        joints = g.getAttribute('skinIndex'),
        weights = g.getAttribute('skinWeight');
      let proximalSleeve = 0,
        back = 0,
        seam = 0,
        bareArm = 0,
        hands = 0;
      for (let i = 0; i < p.count; i++) {
        let arm = 0,
          hand = 0;
        for (let k = 0; k < 4; k++) {
          const name = BONES[joints.getComponent(i, k)],
            w = weights.getComponent(i, k);
          if (/^(upperArm|foreArm)/.test(name)) arm += w;
          if (/^(hand|thumb|index|middle|ring|pinky)/.test(name)) hand += w;
        }
        const y = p.getY(i),
          x = Math.abs(p.getX(i));
        if (arm > 0.5 && y > 1.25 && y < 1.3 && mask[i]) proximalSleeve++;
        if (y > 1.485 && y < 1.505 && x > 0.08 && p.getZ(i) < 0 && mask[i]) back++;
        if (Math.abs(y - 1.53) < 1e-6) {
          expect(mask[i]).toBe(0);
          seam++;
        }
        if (arm > 0.5 && y < 1.24355) {
          expect(mask[i]).toBe(0);
          bareArm++;
        }
        if (hand >= 0.1) {
          expect(mask[i]).toBe(0);
          hands++;
        }
      }
      expect(proximalSleeve).toBeGreaterThan(10);
      expect(back).toBeGreaterThan(0);
      expect(seam).toBe(87);
      expect(bareArm).toBeGreaterThan(100);
      expect(hands).toBeGreaterThan(100);
      expect(new Uint8Array(p.array.buffer, p.array.byteOffset, p.array.byteLength)).toEqual(
        before
      );
    } finally {
      source.dispose();
    }
  });

  it('rejects a changed vertex, same-size reordered topology, and a changed vertex count', async () => {
    const source = await body();
    try {
      for (const change of ['position', 'index', 'count']) {
        const g = source.geometry.clone();
        try {
          if (change === 'position') g.getAttribute('position').setX(0, 0.125);
          if (change === 'index') {
            const index = g.index!,
              a = index.getX(0),
              b = index.getX(1);
            index.setX(0, b);
            index.setX(1, a);
          }
          if (change === 'count')
            g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3), 3));
          expect(() => continuousShirtCoverage(g)).toThrow('coverage topology mismatch');
        } finally {
          g.dispose();
        }
      }
    } finally {
      source.dispose();
    }
  });
});
