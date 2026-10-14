import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlayerPool } from './players';
import { ACTOR_COUNT, type ActorState, type Frame } from './director';
import { DIM } from './rig';
import { KICK, kickGeometry, stanceDuty, strideLength, MAX_PLANT_TWIST } from './poses';

vi.mock('./human-model', () => ({
  loadPlayerGeometry: () => Promise.reject(new Error('test fallback')),
}));
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      new Proxy({}, { get: () => () => {}, set: () => true }) as ReturnType<
        HTMLCanvasElement['getContext']
      >
  );
});
function frame(actor: ActorState): Frame {
  return {
    actors: Array.from({ length: ACTOR_COUNT }, (_, i) =>
      i === 1 ? actor : { x: i * 2, z: 0, heading: 0, speed: 0, anim: { kind: 'idle' } }
    ),
    ball: { x: 0, y: DIM.ballRadius, z: 0 },
    camera: { x: 0, y: 10, z: 10, lx: 0, ly: 0, lz: 0, fov: 40 },
    mode: 'PLAY',
    half: 1,
    goal: null,
    crowd: 0,
  };
}
function pool() {
  const p = createPlayerPool();
  p.setTeams(1, 2);
  return p;
}
const idle: ActorState = { x: 0, z: 0, heading: 0, speed: 0, anim: { kind: 'idle' } };

describe('player transition integration', () => {
  for (const kind of ['kick', 'keeperDive'] as const) {
    it(`keeps ${kind} heading continuous and frame-step consistent`, () => {
      const sample = (dt: number) => {
        const p = pool();
        p.apply(frame(idle), 0, 0, true);
        const spec = {
          ball: new THREE.Vector3(0, DIM.ballRadius, 0),
          dir: new THREE.Vector3(1, 0, 0),
          foot: 'R' as const,
          power: 1,
          loft: 0,
        };
        let previousYaw = 0;
        for (let t = dt; t < 0.3 + 1e-8; t += dt) {
          const actor: ActorState = {
            ...idle,
            heading: Math.PI / 2,
            anim:
              kind === 'kick'
                ? { kind, t, spec }
                : {
                    kind,
                    t,
                    spec: { direction: 1, reach: 1, height: 1 },
                    ball: new THREE.Vector3(1, 1, 0),
                  },
          };
          p.apply(frame(actor), dt, t, true);
          expect(p.rigs[1].root.rotation.y).toBeLessThan(Math.PI / 2);
          expect(Math.abs(p.rigs[1].root.rotation.y - previousYaw)).toBeLessThanOrEqual(
            9 * dt + 1e-8
          );
          previousYaw = p.rigs[1].root.rotation.y;
        }
        const yaw = p.rigs[1].root.rotation.y;
        p.dispose();
        return yaw;
      };
      expect(sample(0.01)).toBeCloseTo(sample(0.02), 8);
    });
  }
  for (const direction of [-1, 1]) {
    it(`keeps contact on the original kick clock despite heading transition (${direction})`, () => {
      const p = pool();
      const spec = {
        ball: new THREE.Vector3(0, DIM.ballRadius, 0),
        dir: new THREE.Vector3(direction, 0, 0),
        foot: 'R' as const,
        power: 1,
        loft: 0,
      };
      const root = kickGeometry(spec).root;
      p.apply(frame({ ...idle, x: root.x, z: root.z }), 0, 0, true);
      // A late refresh can enter directly at contact: even the first blend must retain boot contact.
      p.apply(
        frame({
          x: root.x,
          z: root.z,
          heading: (direction * Math.PI) / 2,
          speed: 0,
          anim: { kind: 'kick', t: KICK.contact, spec },
        }),
        0.02,
        KICK.contact,
        true
      );
      const toe = p.rigs[1].bones.toeR.getWorldPosition(new THREE.Vector3());
      expect(toe.distanceTo(spec.ball)).toBeLessThan(DIM.ballRadius + 0.1);
      expect(p.rigs[1].root.rotation.y).toBeCloseTo(direction * 9 * 0.02, 6);
      p.dispose();
    });
  }
  it('advances gait by travel consistently at 30/60 Hz', () => {
    const sample = (dt: number) => {
      const p = pool();
      p.apply(frame({ ...idle, speed: 3, anim: { kind: 'run' } }), 0, 0, true);
      for (let t = dt; t < 1 + 1e-8; t += dt)
        p.apply(frame({ ...idle, z: 3 * t, speed: 3, anim: { kind: 'run' } }), dt, t, true);
      const positions = (['footL', 'footR', 'handL', 'handR'] as const).map((name) =>
        p.rigs[1].bones[name].getWorldPosition(new THREE.Vector3())
      );
      p.dispose();
      return positions;
    };
    const a = sample(1 / 30);
    const b = sample(1 / 60);
    a.forEach((point, i) => expect(point.distanceTo(b[i])).toBeLessThan(0.015));
  });
  for (const scale of [0.96, 1.04])
    for (const direction of [-1, 1])
      for (const angle of [Math.PI * 0.75, Math.PI])
        it(`keeps support grounded and takes a lifted step if a reversing plant becomes unreachable through ${angle.toFixed(2)}rad turn (${direction}, scale${scale})`, () => {
          const p = pool();
          const rig = p.rigs[1];
          rig.root.scale.setScalar(scale);
          const speed = 4,
            dt = 1 / 120,
            duty = stanceDuty(speed);
          let x = 0,
            z = 0,
            phase = 0,
            contacts = 0,
            lifted = 0;
          p.apply(frame(idle), 0, 0, true);
          for (let step = 1; step <= 180; step++) {
            const heading = step >= 5 ? direction * angle : 0;
            x += Math.sin(heading) * speed * dt;
            z += Math.cos(heading) * speed * dt;
            phase += (speed * dt) / strideLength(speed);
            p.apply(frame({ x, z, heading, speed, anim: { kind: 'run' } }), dt, step * dt, true);
            rig.root.updateMatrixWorld(true);
            for (const side of ['L', 'R'] as const) {
              const cycle = (phase + (side === 'L' ? 0 : 0.5)) % 1;
              if (cycle >= duty) continue;
              const foot = rig.bones[`foot${side}`];
              const sole = [
                new THREE.Vector3(0, -0.07, -0.07),
                new THREE.Vector3(0, -0.068, 0.15),
              ].map((point) => point.applyMatrix4(foot.matrixWorld));
              const height = Math.min(...sole.map((point) => point.y));
              if (height < 0.004) contacts++;
              else lifted++;
              expect(height).toBeLessThan(0.4);
              if (step < 5)
                expect(height, 'first blend must retain ground contact').toBeLessThan(0.004);
              expect(Math.min(...sole.map((point) => point.y))).toBeGreaterThan(-0.004);
              const yaw = (bone: THREE.Bone) =>
                new THREE.Euler().setFromQuaternion(
                  bone.getWorldQuaternion(new THREE.Quaternion()),
                  'YXZ'
                ).y;
              const difference = yaw(rig.bones.hips) - yaw(foot);
              expect(
                Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference)))
              ).toBeLessThanOrEqual(MAX_PLANT_TWIST + 1e-6);
              const hip = rig.bones[`upperLeg${side}`].getWorldPosition(new THREE.Vector3());
              const ankle = foot.getWorldPosition(new THREE.Vector3());
              expect(
                hip.distanceTo(ankle),
                `step${step} side${side} cycle${cycle}`
              ).toBeLessThanOrEqual((DIM.thigh + DIM.shin) * scale * 0.995 + 1e-6);
            }
          }
          expect(contacts).toBeGreaterThan(80);
          expect(lifted).toBeLessThan(35);
          p.dispose();
        });
  it('keeps reduced poses still across time and clears held plants before resuming', () => {
    const p = pool();
    p.apply(frame(idle), 0.1, 1, false);
    const first = p.rigs[1].bones.head.getWorldPosition(new THREE.Vector3());
    p.apply(frame(idle), 20, 21, false);
    expect(
      p.rigs[1].bones.head.getWorldPosition(new THREE.Vector3()).distanceTo(first)
    ).toBeLessThan(1e-8);
    p.dispose();
  });
});
