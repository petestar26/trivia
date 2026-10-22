import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
// Exercise the installed renderer's real internal upload implementation.
import { WebGLAttributes } from 'three/src/renderers/webgl/WebGLAttributes.js';
import { createContinuousKit, syncContinuousBootFlex } from './continuous-kit';
import { createRig, humanGeometry, kitFromClub, type Look } from './rig';
import { resetPose, poseRun, plantRunFeet, poseKick, kickGeometry } from './poses';

const look = {
  skin: '#b97c57',
  kit: kitFromClub({ primary: '#7a253d', secondary: '#eee9e2', pattern: 'solid' }),
} as Look;
function uploadSink() {
  let bound: object;
  const uploads = new Map<object, Float32Array>();
  const gl = {
    FLOAT: 5126,
    ARRAY_BUFFER: 34962,
    createBuffer: vi.fn(() => ({})),
    bindBuffer: (_type: number, buffer: object) => {
      bound = buffer;
    },
    bufferData: vi.fn((_type: number, values: Float32Array) => uploads.set(bound, values.slice())),
    bufferSubData: vi.fn((_type: number, offset: number, values: Float32Array) =>
      uploads.get(bound)!.set(values, offset / 4)
    ),
    deleteBuffer: vi.fn((buffer: object) => uploads.delete(buffer)),
  };
  const manager = new WebGLAttributes(gl as unknown as WebGLRenderingContext);
  return {
    gl,
    read(attribute: THREE.BufferAttribute) {
      manager.update(attribute, gl.ARRAY_BUFFER);
      return uploads.get(manager.get(attribute)!.buffer)!;
    },
  };
}
function fixture() {
  const kit = createContinuousKit(look),
    source = humanGeometry(),
    material = new THREE.MeshStandardMaterial();
  const rig = createRig(material, source.geometry);
  const mesh = new THREE.SkinnedMesh(kit.geometries.boots, kit.materials.boots);
  rig.root.add(mesh);
  mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
  return {
    kit,
    source,
    rig,
    mesh,
    dispose() {
      mesh.removeFromParent();
      rig.dispose();
      source.geometry.dispose();
      material.dispose();
      kit.dispose();
    },
  };
}

describe('actual Three boot attribute uploads after the first render', () => {
  it.each([false, true])(
    'uploads neutral/run/kick/follow-through/reset/reduced, reverse=%s',
    (reverse) => {
      const f = fixture(),
        other = fixture(),
        sink = uploadSink();
      const g = f.mesh.geometry,
        p = g.getAttribute('position') as THREE.BufferAttribute;
      const sourceGeometry = new Float32Array(f.source.geometry.getAttribute('position').array);
      const otherNeutral = new Float32Array(other.mesh.geometry.getAttribute('position').array);
      const neutral = p.array.slice();
      const spec = {
        foot: 'L' as const,
        ball: new THREE.Vector3(0, 0.11, 1),
        dir: new THREE.Vector3(0, 0, 1),
        power: 1,
        loft: 0,
      };
      const states = [
        {
          name: 'neutral',
          pose() {
            resetPose(f.rig);
            f.rig.root.position.set(0, 0, 0);
          },
        },
        {
          name: 'run',
          pose() {
            poseRun(f.rig, 0.31, 4.4);
            plantRunFeet(f.rig, 0.31, 4.4, {});
          },
        },
        {
          name: 'kick',
          pose() {
            f.rig.root.position.copy(kickGeometry(spec).root);
            poseKick(f.rig, 0.3, spec);
          },
        },
        {
          name: 'follow-through',
          pose() {
            poseKick(f.rig, 0.66, spec);
          },
        },
        {
          name: 'reset',
          pose() {
            resetPose(f.rig);
            f.rig.root.position.set(0, 0, 0);
          },
        },
        {
          name: 'reduced',
          pose() {
            resetPose(f.rig);
            f.rig.root.position.set(0, 0, 0);
          },
        },
      ];
      if (reverse) states.reverse();
      const changedUploads: Float32Array[] = [];
      try {
        for (const state of states) {
          state.pose();
          f.rig.root.updateMatrixWorld(true);
          const bones = f.rig.skeleton.bones.map((b) => ({
            position: b.position.clone(),
            quaternion: b.quaternion.clone(),
          }));
          const rootPosition = f.rig.root.position.clone();
          syncContinuousBootFlex(f.mesh, f.rig);
          const uploaded = sink.read(p);
          // For the reviewed implementation the intended CPU result includes its
          // changing morph delta, but its ordinary uploaded positions stay neutral.
          // That old path fails this exact sequential renderer-upload comparison.
          const morph = g.morphAttributes.position?.[0],
            influence = f.mesh.morphTargetInfluences?.[0] ?? 0;
          for (let i = 0; i < p.count; i++)
            for (let axis = 0; axis < 3; axis++) {
              expect(uploaded[i * 3 + axis], `${state.name} vertex ${i}`).toBeCloseTo(
                p.getComponent(i, axis) + (morph?.getComponent(i, axis) ?? 0) * influence,
                7
              );
            }
          const n = g.getAttribute('normal') as THREE.BufferAttribute;
          expect(Array.from(sink.read(n))).toEqual(Array.from(n.array));
          expect(Array.from(n.array).every(Number.isFinite)).toBe(true);
          if (g.boundingBox)
            expect(
              g.boundingBox.containsPoint(new THREE.Vector3().fromBufferAttribute(p, 362))
            ).toBe(true);
          if (state.name === 'neutral' || state.name === 'reset' || state.name === 'reduced')
            expect(Array.from(uploaded)).toEqual(Array.from(neutral));
          else changedUploads.push(uploaded.slice());
          bones.forEach((b, i) => {
            expect(f.rig.skeleton.bones[i].position.equals(b.position)).toBe(true);
            expect(f.rig.skeleton.bones[i].quaternion.equals(b.quaternion)).toBe(true);
          });
          expect(f.rig.root.position.equals(rootPosition)).toBe(true);
          const version = p.version,
            uploads = sink.gl.bufferSubData.mock.calls.length;
          syncContinuousBootFlex(f.mesh, f.rig);
          sink.read(p);
          expect(p.version).toBe(version);
          expect(sink.gl.bufferSubData.mock.calls.length).toBe(uploads);
        }
        expect(
          changedUploads.some((values) => values.some((v, i) => Math.abs(v - neutral[i]) > 0.03))
        ).toBe(true);
        expect(p.usage).toBe(THREE.DynamicDrawUsage);
        expect(g.boundingBox).not.toBeNull();
        expect(g.morphAttributes.position).toBeUndefined();
        expect(sink.gl.createBuffer).toHaveBeenCalledTimes(2);
        expect(Array.from(f.source.geometry.getAttribute('position').array)).toEqual(
          Array.from(sourceGeometry)
        );
        expect(Array.from(other.mesh.geometry.getAttribute('position').array)).toEqual(
          Array.from(otherNeutral)
        );
      } finally {
        f.dispose();
        other.dispose();
      }
    }
  );
});

describe('released visual ball envelope boot uploads', () => {
  it.each(['L', 'R'] as const)(
    'fits %s footwear using read-only world geometry and invalidates only changed envelope inputs',
    (foot) => {
      const f = fixture(),
        other = fixture(),
        sink = uploadSink(),
        heading = 0.75,
        spec = {
          foot,
          ball: new THREE.Vector3(0, 0.11, 1),
          dir: new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)),
          power: 1,
          loft: 0,
        };
      f.rig.root.scale.setScalar(1.04);
      f.rig.root.rotation.y = heading;
      f.rig.root.position.copy(kickGeometry(spec).root);
      poseKick(f.rig, 0.3, spec);
      f.rig.root.updateMatrixWorld(true);
      f.rig.skeleton.update();
      const objects = [f.rig.root, ...f.rig.skeleton.bones],
        snapshot = objects.map((object) => ({
          local: object.matrix.elements.slice(),
          world: object.matrixWorld.elements.slice(),
          position: object.position.toArray(),
          quaternion: object.quaternion.toArray(),
          scale: object.scale.toArray(),
        })),
        source = new Float32Array(f.source.geometry.getAttribute('position').array),
        otherPosition = new Float32Array(other.mesh.geometry.getAttribute('position').array),
        otherNormal = new Float32Array(other.mesh.geometry.getAttribute('normal').array),
        otherVersion = (other.mesh.geometry.getAttribute('position') as THREE.BufferAttribute)
          .version,
        g = f.mesh.geometry,
        p = g.getAttribute('position') as THREE.BufferAttribute,
        n = g.getAttribute('normal') as THREE.BufferAttribute,
        neutralPosition = p.array.slice(),
        center = Object.freeze({ x: spec.ball.x, y: spec.ball.y, z: spec.ball.z }),
        envelope = Object.freeze({ center, radius: 0.11 });
      const assertUnchangedAuthority = () => {
        objects.forEach((object, i) => {
          expect(object.matrix.elements).toEqual(snapshot[i].local);
          expect(object.matrixWorld.elements).toEqual(snapshot[i].world);
          expect(object.position.toArray()).toEqual(snapshot[i].position);
          expect(object.quaternion.toArray()).toEqual(snapshot[i].quaternion);
          expect(object.scale.toArray()).toEqual(snapshot[i].scale);
        });
        expect(center).toEqual({ x: 0, y: 0.11, z: 1 });
        expect(envelope.radius).toBe(0.11);
        expect(spec.ball.toArray()).toEqual([0, 0.11, 1]);
        expect(Array.from(f.source.geometry.getAttribute('position').array)).toEqual(
          Array.from(source)
        );
        expect(Array.from(other.mesh.geometry.getAttribute('position').array)).toEqual(
          Array.from(otherPosition)
        );
        expect(Array.from(other.mesh.geometry.getAttribute('normal').array)).toEqual(
          Array.from(otherNormal)
        );
        expect(
          (other.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).version
        ).toBe(otherVersion);
      };
      const assertUploaded = () => {
        expect(Array.from(sink.read(p))).toEqual(Array.from(p.array));
        expect(Array.from(sink.read(n))).toEqual(Array.from(n.array));
        expect(Array.from(p.array).every(Number.isFinite)).toBe(true);
        expect(Array.from(n.array).every(Number.isFinite)).toBe(true);
        expect(p.usage).toBe(THREE.DynamicDrawUsage);
        expect(n.usage).toBe(THREE.DynamicDrawUsage);
        expect(g.morphAttributes.position).toBeUndefined();
        let measuredDisplacement = 0;
        for (let i = 0; i < p.count; i++)
          measuredDisplacement = Math.max(
            measuredDisplacement,
            Math.hypot(
              p.getX(i) - neutralPosition[i * 3],
              p.getY(i) - neutralPosition[i * 3 + 1],
              p.getZ(i) - neutralPosition[i * 3 + 2]
            )
          );
        expect(g.userData.maxVisualBootDisplacementMetres).toBeCloseTo(measuredDisplacement, 10);
        assertUnchangedAuthority();
      };
      try {
        syncContinuousBootFlex(f.mesh, f.rig);
        assertUploaded();
        const defaultPosition = p.array.slice(),
          defaultNormal = n.array.slice();
        syncContinuousBootFlex(f.mesh, f.rig, envelope);
        assertUploaded();
        const fittedPosition = p.array.slice(),
          fittedVersion = p.version,
          fittedNormalVersion = n.version,
          fittedUploads = sink.gl.bufferSubData.mock.calls.length;
        expect(fittedPosition.some((value, i) => Math.abs(value - defaultPosition[i]) > 1e-5)).toBe(
          true
        );
        expect(Math.max(...g.userData.visualBallFit.retreatMetres)).toBeGreaterThan(0);
        // Equal values in a different read-only object must share the cache.
        syncContinuousBootFlex(
          f.mesh,
          f.rig,
          Object.freeze({
            center: Object.freeze({ ...center }),
            radius: envelope.radius,
          })
        );
        assertUploaded();
        expect(p.version).toBe(fittedVersion);
        expect(n.version).toBe(fittedNormalVersion);
        expect(sink.gl.bufferSubData.mock.calls.length).toBe(fittedUploads);
        const movedCenter = Object.freeze({ x: center.x + 2, y: center.y, z: center.z }),
          movedEnvelope = Object.freeze({ center: movedCenter, radius: envelope.radius });
        syncContinuousBootFlex(f.mesh, f.rig, movedEnvelope);
        assertUploaded();
        expect(p.version).toBeGreaterThan(fittedVersion);
        expect(sink.gl.bufferSubData.mock.calls.length).toBeGreaterThan(fittedUploads);
        expect(Array.from(p.array)).toEqual(Array.from(defaultPosition));
        expect(movedCenter).toEqual({ x: 2, y: 0.11, z: 1 });
        const farPositionVersion = p.version,
          farNormalVersion = n.version,
          farUploads = sink.gl.bufferSubData.mock.calls.length;
        for (const offset of [1, 2, 4]) {
          syncContinuousBootFlex(f.mesh, f.rig, {
            center: { x: movedCenter.x + offset, y: movedCenter.y, z: movedCenter.z + offset },
            radius: movedEnvelope.radius,
          });
          assertUploaded();
          expect(p.version).toBe(farPositionVersion);
          expect(n.version).toBe(farNormalVersion);
          expect(sink.gl.bufferSubData.mock.calls.length).toBe(farUploads);
        }
        syncContinuousBootFlex(f.mesh, f.rig, envelope);
        assertUploaded();
        expect(Array.from(p.array)).toEqual(Array.from(fittedPosition));
        // Removing the optional scene input restores exact legacy geometry,
        // including normals, without any pose or actor-state reset.
        syncContinuousBootFlex(f.mesh, f.rig);
        assertUploaded();
        expect(Array.from(p.array)).toEqual(Array.from(defaultPosition));
        expect(Array.from(n.array)).toEqual(Array.from(defaultNormal));
        expect(g.userData.visualBallFit.retreatMetres).toEqual([0, 0]);
        const removedVersion = p.version,
          removedUploads = sink.gl.bufferSubData.mock.calls.length;
        syncContinuousBootFlex(f.mesh, f.rig);
        assertUploaded();
        expect(p.version).toBe(removedVersion);
        expect(sink.gl.bufferSubData.mock.calls.length).toBe(removedUploads);
        expect(sink.gl.createBuffer).toHaveBeenCalledTimes(2);
        expect(g.getAttribute('position')).toBe(p);
        expect(g.getAttribute('normal')).toBe(n);
        // Give the second actor the identical pose with a different envelope
        // state; its fitting/cache must stay independent of the first actor.
        other.rig.root.scale.copy(f.rig.root.scale);
        other.rig.root.rotation.copy(f.rig.root.rotation);
        other.rig.root.position.copy(f.rig.root.position);
        poseKick(other.rig, 0.3, spec);
        other.rig.root.updateMatrixWorld(true);
        const otherP = other.mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
          otherSink = uploadSink();
        syncContinuousBootFlex(other.mesh, other.rig, envelope);
        expect(Array.from(otherSink.read(otherP))).toEqual(Array.from(fittedPosition));
        expect(Array.from(p.array)).toEqual(Array.from(defaultPosition));
        expect(p.version).toBe(removedVersion);
        const secondActorVersion = otherP.version;
        syncContinuousBootFlex(other.mesh, other.rig, envelope);
        otherSink.read(otherP);
        expect(otherP.version).toBe(secondActorVersion);
        expect(otherSink.gl.bufferSubData).not.toHaveBeenCalled();
        syncContinuousBootFlex(other.mesh, other.rig);
        expect(Array.from(otherSink.read(otherP))).toEqual(Array.from(defaultPosition));
        expect(Array.from(p.array)).toEqual(Array.from(defaultPosition));
        expect(p.version).toBe(removedVersion);
      } finally {
        f.dispose();
        other.dispose();
      }
    }
  );
});

describe('distant released ball does not invalidate fixed idle footwear', () => {
  it.each([false, true])(
    'retains ordinary buffers and upload versions with reducedMotion=%s',
    async (reducedMotion) => {
      const { poseIdle } = await import('./poses'),
        { applyReviewPlayerMotion } = await import('./review-player-motion'),
        f = fixture(),
        sink = uploadSink();
      try {
        const time = reducedMotion ? 0 : 3;
        poseIdle(f.rig, time, 0);
        applyReviewPlayerMotion(f.rig, {
          kind: 'idle',
          time,
          phase: 0,
          speed: 0,
          reducedMotion,
        });
        f.rig.root.updateMatrixWorld(true);
        syncContinuousBootFlex(f.mesh, f.rig);
        const p = f.mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
          n = f.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute,
          defaultPosition = sink.read(p).slice(),
          defaultNormal = sink.read(n).slice(),
          positionVersion = p.version,
          normalVersion = n.version,
          objects = [f.rig.root, ...f.rig.skeleton.bones],
          worldMatrices = objects.map((object) => object.matrixWorld.elements.slice());
        for (const offset of [0, 1, 3, 7, 15]) {
          const center = Object.freeze({ x: 8 + offset, y: 0.11, z: 30 - offset }),
            envelope = Object.freeze({ center, radius: 0.11 });
          syncContinuousBootFlex(f.mesh, f.rig, envelope);
          expect(Array.from(sink.read(p))).toEqual(Array.from(defaultPosition));
          expect(Array.from(sink.read(n))).toEqual(Array.from(defaultNormal));
          expect(p.version).toBe(positionVersion);
          expect(n.version).toBe(normalVersion);
          expect(sink.gl.bufferSubData).not.toHaveBeenCalled();
          expect(center).toEqual({ x: 8 + offset, y: 0.11, z: 30 - offset });
          objects.forEach((object, i) =>
            expect(object.matrixWorld.elements).toEqual(worldMatrices[i])
          );
        }
        expect(sink.gl.createBuffer).toHaveBeenCalledTimes(2);
      } finally {
        f.dispose();
      }
    }
  );
});

describe('saturated ball fitting preserves forefoot longitudinal order', () => {
  const cases = (['L', 'R'] as const).flatMap((foot) =>
    [0.9, 1, 1.1].map((scale) => ({ foot, scale }))
  );
  it.each(cases)('keeps $foot sections monotone at root scale $scale', ({ foot, scale }) => {
    const f = fixture(),
      sink = uploadSink(),
      p = f.mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
      neutral = p.array.slice(),
      side = foot === 'L' ? 0 : 1,
      base = side * (p.count / 2),
      stressVertex = base + 5 * 33,
      heading = 0.4,
      spec = {
        foot,
        ball: new THREE.Vector3(0, 0.11, 1),
        dir: new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)),
        power: 1,
        loft: 0,
      },
      report = [];
    try {
      f.rig.root.scale.setScalar(scale);
      f.rig.root.rotation.y = heading;
      f.rig.root.position.copy(kickGeometry(spec).root);
      for (const time of [0.3, 0.55]) {
        poseKick(f.rig, time, spec);
        f.rig.root.updateMatrixWorld(true);
        f.rig.skeleton.update();
        syncContinuousBootFlex(f.mesh, f.rig);
        const unfitted = p.array.slice(),
          point = new THREE.Vector3().fromBufferAttribute(p, stressVertex),
          objects = [f.rig.root, ...f.rig.skeleton.bones],
          transforms = objects.map((object) => ({
            local: object.matrix.elements.slice(),
            world: object.matrixWorld.elements.slice(),
            position: object.position.toArray(),
            quaternion: object.quaternion.toArray(),
            scale: object.scale.toArray(),
          }));
        f.mesh.applyBoneTransform(stressVertex, point);
        point.applyMatrix4(f.mesh.matrixWorld);
        // Put the sphere on a current forefoot section, rather than relying on
        // incidental contact overlap, to force the retreat cap at every scale.
        const center = Object.freeze({ x: point.x, y: point.y, z: point.z }),
          envelope = Object.freeze({ center, radius: 0.11 });
        syncContinuousBootFlex(f.mesh, f.rig, envelope);
        const fit = f.mesh.geometry.userData.visualBallFit;
        expect(fit.limitBindMetres).toBeCloseTo(0.055, 10);
        expect(fit.maximumSectionDerivative).toBeCloseTo(0.825, 10);
        expect(fit.retreatMetres[side]).toBeCloseTo(0.055 * scale, 8);
        for (const retreat of fit.retreatMetres) {
          expect(retreat).toBeGreaterThanOrEqual(0);
          expect(retreat).toBeLessThanOrEqual(0.055 * scale + 1e-9);
        }
        expect(Array.from(p.array).every(Number.isFinite)).toBe(true);
        expect(Array.from(sink.read(p))).toEqual(Array.from(p.array));
        const n = f.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
        expect(Array.from(n.array).every(Number.isFinite)).toBe(true);
        expect(Array.from(sink.read(n))).toEqual(Array.from(n.array));
        let minimumSecant = Infinity;
        // The original boot last has eleven 33-vertex rings. Compare matching
        // angular vertices in adjacent rings in production foot-local space.
        // Subtract existing turf/flex deformation to isolate the new fit map:
        // z -> z + (fittedZ - unfittedZ). Its measured Lipschitz change must
        // remain <= .055 * max(smoothstep derivative) = .825, leaving .175
        // positive longitudinal slope even at saturation. Whole-face normal
        // comparisons would incorrectly reject legitimate section shear.
        for (let row = 0; row < 10; row++)
          for (let angular = 0; angular <= 32; angular++) {
            const a = base + row * 33 + angular,
              b = a + 33,
              dz = neutral[b * 3 + 2] - neutral[a * 3 + 2],
              da = p.getZ(a) - unfitted[a * 3 + 2],
              db = p.getZ(b) - unfitted[b * 3 + 2],
              secant = 1 + (db - da) / dz;
            expect(dz).toBeGreaterThan(0);
            expect(Math.abs((db - da) / dz)).toBeLessThanOrEqual(0.825 + 1e-5);
            expect(secant).toBeGreaterThanOrEqual(0.175 - 1e-5);
            minimumSecant = Math.min(minimumSecant, secant);
          }
        objects.forEach((object, i) => {
          expect(object.matrix.elements).toEqual(transforms[i].local);
          expect(object.matrixWorld.elements).toEqual(transforms[i].world);
          expect(object.position.toArray()).toEqual(transforms[i].position);
          expect(object.quaternion.toArray()).toEqual(transforms[i].quaternion);
          expect(object.scale.toArray()).toEqual(transforms[i].scale);
        });
        expect(center).toEqual({ x: point.x, y: point.y, z: point.z });
        point.fromBufferAttribute(p, stressVertex);
        f.mesh.applyBoneTransform(stressVertex, point);
        point.applyMatrix4(f.mesh.matrixWorld);
        report.push({
          time,
          saturatedRetreatWorldMetres: fit.retreatMetres[side],
          minimumMeasuredSectionSecant: minimumSecant,
          stressVertexSignedBallGapMetres:
            point.distanceTo(new THREE.Vector3(center.x, center.y, center.z)) - envelope.radius,
        });
      }
      console.log(
        'bounded saturated section probe; sampled overlap remains, no full collision claim',
        { foot, scale, report }
      );
    } finally {
      f.dispose();
    }
  });
});
