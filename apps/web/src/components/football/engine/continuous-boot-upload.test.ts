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
