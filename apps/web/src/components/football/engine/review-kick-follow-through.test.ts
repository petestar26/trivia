import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createRig, type Side } from './rig';
import { KICK, kickGeometry, poseKick, reviewKickFollowThroughProgress } from './poses';

// Independently captured from accepted b264922b's default pose, not the new profile.
// Quantize complete root +49 world matrices to 1e-9 scalar precision.
const acceptedDefault = [
  {
    foot: 'L',
    time: 0,
    sha256: '27898b20aee2ec55e1a8d2ef5dd81ba0c4622840ce759674bfde6e43dd6161bc',
  },
  {
    foot: 'L',
    time: 0.1,
    sha256: 'c79be04ca643fb0af8b0f5a8e0d11c31f746cb090df69af480e565bf2d114cff',
  },
  {
    foot: 'L',
    time: 0.29,
    sha256: 'fb431388ebf452a3ee496f6c686865b7a866722005f57c055e4baae36d0ba63d',
  },
  {
    foot: 'L',
    time: 0.3,
    sha256: '17efc4bec5ca8e1afff73ed8c1b251638e8deec405ddaf71bd883e7e0be294e2',
  },
  {
    foot: 'L',
    time: 0.31,
    sha256: 'd7da8ebc22a64ee2bdf29f50e54b7ad67d983f5aa7048d1c42ac44f88ce8ad18',
  },
  {
    foot: 'L',
    time: 0.34,
    sha256: '07b84d5fe753191aa6f7f0d5c176749a0170d768dc73266faf091f67e0e39467',
  },
  {
    foot: 'L',
    time: 0.45,
    sha256: 'f4807ebc9bc6d72b5a18027f9ae5483658ecbaf1c289feed4d245461ac0ad1c6',
  },
  {
    foot: 'L',
    time: 0.64,
    sha256: 'c636dbcf85703f35cb863f01df3327b44c4f838d115dcd23f1f97d1e5b3de497',
  },
  {
    foot: 'L',
    time: 0.7,
    sha256: '90e58c25f9918e55522531fa585af67365f252798e03b0081bf3e595823db758',
  },
  {
    foot: 'L',
    time: 0.85,
    sha256: '83b3960b01d7ab80cae415995b87ffff90b0a1c36bc4ebe539684525db93b8eb',
  },
  {
    foot: 'R',
    time: 0,
    sha256: '2fe5de799ac9531188c06a99c4c79fb2b1fec8a5279b4ffe8fc63d2018534f90',
  },
  {
    foot: 'R',
    time: 0.1,
    sha256: 'de4288de863bb14f978c912bedaea28d5b2ae1814b75ec4016f06b323c3afba0',
  },
  {
    foot: 'R',
    time: 0.29,
    sha256: '55d3ee9cc4025024cbc88efec1881d5f766b1457bddff05313538184a49e92de',
  },
  {
    foot: 'R',
    time: 0.3,
    sha256: '0277f9e8ee7c3d40fc4ec9084d9f1c941cf0141d3ff301746c014995eae4a666',
  },
  {
    foot: 'R',
    time: 0.31,
    sha256: '2c1bcbb0b2e31f228e7420ea21d18610f416f6b3531c6e3ed4ea8529b01884a6',
  },
  {
    foot: 'R',
    time: 0.34,
    sha256: 'dd93e4281aaa5419c87aa0e451d8dfc1d428f852bf0e3cdce2ca6b0c924b8ac8',
  },
  {
    foot: 'R',
    time: 0.45,
    sha256: '09ffcf35efe1ca776009dba96324b767c60dd3be1313f060faeab6776ea5c666',
  },
  {
    foot: 'R',
    time: 0.64,
    sha256: '5b71679ca39d48b8865b73af96ba5d8fae16ac273ce2b62ee8bb71f3de78c49d',
  },
  {
    foot: 'R',
    time: 0.7,
    sha256: '77f212513ad7f8c46334c885632f1c3e8dd26070cbb754598fb26f5fb199ed5f',
  },
  {
    foot: 'R',
    time: 0.85,
    sha256: 'c8b8386dd2561f737aba83223ddc49cb89854c0a60d47f629c2bcb919082c872',
  },
] as const;

function fixture(foot: Side) {
  const material = new THREE.MeshBasicMaterial();
  const rig = createRig(material, new THREE.BufferGeometry());
  const spec = {
    foot,
    power: 0.75,
    loft: 0.2,
    ball: new THREE.Vector3(2, 0.11, -3),
    dir: new THREE.Vector3(Math.sin(0.7), 0, Math.cos(0.7)),
  };
  rig.root.scale.setScalar(0.96);
  rig.root.rotation.y = 0.7;
  rig.root.position.copy(kickGeometry(spec).root);
  return {
    rig,
    spec,
    dispose() {
      rig.dispose();
      material.dispose();
    },
  };
}
function matrices(f: ReturnType<typeof fixture>) {
  f.rig.root.updateMatrixWorld(true);
  f.rig.skeleton.update();
  return [f.rig.root, ...f.rig.skeleton.bones].map((o) => o.matrixWorld.toArray());
}
function sameMatrices(a: number[][], b: number[][]) {
  expect(a.length).toBe(50);
  for (let i = 0; i < a.length; i++)
    expect(Math.max(...a[i].map((v, j) => Math.abs(v - b[i][j]))), `matrix ${i}`).toBeLessThan(
      1e-12
    );
}

describe('selected review-player airborne follow-through contract', () => {
  it('has fixed endpoints and smoothly decelerates from unchanged strike speed', () => {
    expect(KICK).toEqual({ contact: 0.3, duration: 0.85, through: 0.34 });
    expect(reviewKickFollowThroughProgress(-1)).toBe(0);
    expect(reviewKickFollowThroughProgress(0)).toBe(0);
    expect(reviewKickFollowThroughProgress(1)).toBe(1);
    expect(reviewKickFollowThroughProgress(2)).toBe(1);
    const h = 1e-6;
    expect(reviewKickFollowThroughProgress(h) / h).toBeCloseTo(3, 3);
    expect((1 - reviewKickFollowThroughProgress(1 - h)) / h).toBeLessThan(1e-5);
    let previousPosition = 0,
      previousSpeed = 3;
    for (let i = 1; i < 1000; i++) {
      const s = i / 1000,
        position = reviewKickFollowThroughProgress(s);
      const speed =
        (reviewKickFollowThroughProgress(s + h) - reviewKickFollowThroughProgress(s - h)) / (2 * h);
      expect(position).toBeGreaterThan(previousPosition);
      expect(position).toBeLessThan(1);
      expect(speed).toBeGreaterThanOrEqual(-1e-8);
      expect(speed).toBeLessThanOrEqual(previousSpeed + 1e-8);
      previousPosition = position;
      previousSpeed = speed;
    }
  });

  it.each(acceptedDefault)(
    'keeps the default roster pose identical: $foot at $time',
    ({ foot, time, sha256 }) => {
      const f = fixture(foot);
      try {
        poseKick(f.rig, time, f.spec);
        const quantized = matrices(f).flatMap((m) => m.map((v) => Math.round(v * 1e9)));
        expect(createHash('sha256').update(JSON.stringify(quantized)).digest('hex')).toBe(sha256);
      } finally {
        f.dispose();
      }
    }
  );

  it.each(['L', 'R'] as const)(
    '%s preserves every joint through strike and at recovery endpoints',
    (foot) => {
      const f = fixture(foot);
      try {
        const facts = JSON.stringify(f.spec);
        for (const time of [0, 0.075, 0.1, 0.175, 0.299999, 0.3, 0.64, 0.68, 0.7, 0.85, 1]) {
          poseKick(f.rig, time, f.spec);
          const expected = matrices(f);
          poseKick(f.rig, time, f.spec, { reviewFollowThrough: true });
          sameMatrices(matrices(f), expected);
          expect(JSON.stringify(f.spec)).toBe(facts);
        }
      } finally {
        f.dispose();
      }
    }
  );

  it.each(['L', 'R'] as const)(
    '%s changes only the airborne chain, preserving planted foot/toe, root and ball',
    (foot) => {
      const f = fixture(foot);
      try {
        const facts = JSON.stringify(f.spec);
        const freeNames = new Set([
          `upperLeg${foot}`,
          `lowerLeg${foot}`,
          `foot${foot}`,
          `toe${foot}`,
        ]);
        let moved = false;
        for (let i = 0; i <= 170; i++) {
          const time = i * 0.005;
          poseKick(f.rig, time, f.spec);
          const expected = matrices(f);
          poseKick(f.rig, time, f.spec, { reviewFollowThrough: true });
          const actual = matrices(f);
          for (const [joint, object] of [f.rig.root, ...f.rig.skeleton.bones].entries()) {
            const difference = Math.max(
              ...actual[joint].map((v, k) => Math.abs(v - expected[joint][k]))
            );
            if (!freeNames.has(object.name))
              expect(difference, `${time}, ${object.name}`).toBeLessThan(1e-12);
            else if (difference > 1e-5) moved = true;
          }
          expect(JSON.stringify(f.spec)).toBe(facts);
        }
        expect(moved).toBe(true);
      } finally {
        f.dispose();
      }
    }
  );
});
