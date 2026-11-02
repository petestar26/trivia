import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { WebGLAttributes } from 'three/src/renderers/webgl/WebGLAttributes.js';
import { createContinuousKit, syncContinuousBootFlex } from './continuous-kit';
import { createRig, kitFromClub, type Look } from './rig';
import { kickGeometry, poseIdle, poseKick } from './poses';

const look = {
  skin: '#b97c57',
  kit: kitFromClub({ primary: '#7a253d', secondary: '#14151a', pattern: 'solid' }),
} as Look;

function fixture() {
  const kit = createContinuousKit(look),
    material = new THREE.MeshBasicMaterial();
  const rig = createRig(material, new THREE.BufferGeometry());
  const mesh = new THREE.SkinnedMesh(kit.geometries.boots, material);
  rig.root.add(mesh);
  mesh.bind(rig.skeleton, rig.mesh.bindMatrix);
  return {
    kit,
    rig,
    mesh,
    dispose() {
      rig.dispose();
      kit.dispose();
      material.dispose();
    },
  };
}

// Independently inspect complete rendered triangles, including degenerate edge/point faces.
function triangleSphereGap(mesh: THREE.SkinnedMesh, center: THREE.Vector3, radius: number) {
  const p = mesh.geometry.getAttribute('position'),
    ix = mesh.geometry.index!;
  const vertices = Array.from({ length: p.count }, (_, i) =>
    mesh
      .applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(p, i))
      .applyMatrix4(mesh.matrixWorld)
  );
  const triangle = new THREE.Triangle(),
    q = new THREE.Vector3(),
    edge = new THREE.Line3();
  let distance = Infinity;
  for (let j = 0; j < ix.count; j += 3) {
    const points = [vertices[ix.getX(j)], vertices[ix.getX(j + 1)], vertices[ix.getX(j + 2)]];
    triangle.set(points[0], points[1], points[2]);
    let d = triangle.closestPointToPoint(center, q).distanceTo(center);
    if (triangle.getArea() < 1e-13 || !Number.isFinite(d)) {
      d = Infinity;
      for (let k = 0; k < 3; k++) {
        const a = points[k],
          b = points[(k + 1) % 3];
        edge.set(a, b);
        const segment = edge.closestPointToPoint(center, true, q).distanceTo(center);
        d = Math.min(
          d,
          Number.isFinite(segment) ? segment : Infinity,
          a.distanceTo(center),
          b.distanceTo(center)
        );
      }
    }
    expect(Number.isFinite(d)).toBe(true);
    distance = Math.min(distance, d);
  }
  return distance - radius;
}

function sample(foot: 'L' | 'R', scale: number, heading: number, time: number) {
  const f = fixture();
  f.rig.root.scale.setScalar(scale);
  f.rig.root.rotation.y = heading;
  const spec = {
    foot,
    power: 0.75,
    loft: 0.2,
    ball: new THREE.Vector3(0, 0.11, 0),
    dir: new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)),
  };
  f.rig.root.position.copy(kickGeometry(spec).root);
  poseKick(f.rig, time, spec, { reviewFollowThrough: true });
  f.rig.root.updateMatrixWorld(true);
  f.rig.skeleton.update();
  const visibleBall = spec.ball.clone();
  // Exact existing player-lab display law, not an official match trajectory.
  if (time > 0.3) {
    visibleBall.addScaledVector(spec.dir, (time - 0.3) * 5);
    visibleBall.y += Math.sin(Math.min(1, (time - 0.3) / 1.5) * Math.PI) * 0.5;
  }
  return { ...f, spec, visibleBall };
}

describe('review-player visual boot and current ball through follow-through', () => {
  it.each(
    (['L', 'R'] as const).flatMap((foot) =>
      [0.96, 1, 1.04].flatMap((scale) =>
        [-1.1, 0, 1.1].map((heading) => ({ foot, scale, heading }))
      )
    )
  )(
    '$foot scale=$scale heading=$heading clears the reviewed 0.34s triangle overlap',
    ({ foot, scale, heading }) => {
      const f = sample(foot, scale, heading, 0.34);
      try {
        const facts = {
          ball: f.visibleBall.toArray(),
          specBall: f.spec.ball.toArray(),
          bones: [f.rig.root, ...f.rig.skeleton.bones].map((o) => ({
            local: o.matrix.toArray(),
            world: o.matrixWorld.toArray(),
          })),
        };
        syncContinuousBootFlex(f.mesh, f.rig, { center: f.visibleBall, radius: 0.11 });
        const gap = triangleSphereGap(f.mesh, f.visibleBall, 0.11);
        console.info('reviewed follow-through triangle gap', { foot, scale, heading, gap });
        expect(gap).toBeGreaterThanOrEqual(0.003 - 2e-6);
        expect(f.visibleBall.toArray()).toEqual(facts.ball);
        expect(f.spec.ball.toArray()).toEqual(facts.specBall);
        [f.rig.root, ...f.rig.skeleton.bones].forEach((o, i) => {
          expect(o.matrix.toArray()).toEqual(facts.bones[i].local);
          expect(o.matrixWorld.toArray()).toEqual(facts.bones[i].world);
        });
        expect(f.mesh.geometry.userData.maxVisualBootDisplacementMetres).toBeLessThan(0.18);
        for (const retreat of f.mesh.geometry.userData.visualBallFit.retreatMetres)
          expect(retreat).toBeLessThanOrEqual(0.055 * scale + 1e-9);
      } finally {
        f.dispose();
      }
    }
  );

  it.each(['L', 'R'] as const)(
    '%s fitting retains the existing contact pose and forefoot section shape',
    (foot) => {
      const f = sample(foot, 1, 0, 0.34);
      try {
        const p = f.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        const neutral = p.array.slice();
        syncContinuousBootFlex(f.mesh, f.rig);
        const unfitted = p.array.slice();
        syncContinuousBootFlex(f.mesh, f.rig, { center: f.visibleBall, radius: 0.11 });
        const side = foot === 'L' ? 1 : -1;
        for (let i = 0; i < p.count; i++) {
          if (Math.sign(neutral[i * 3]) !== side || neutral[i * 3 + 2] > 0.025000001) continue;
          // Bind/world inverse round trips can differ below Float32 spatial precision.
          expect(
            new THREE.Vector3()
              .fromBufferAttribute(p, i)
              .distanceTo(new THREE.Vector3().fromArray(unfitted, i * 3))
          ).toBeLessThan(1e-7);
        }
        for (const z of [0.105, 0.15, 0.178, 0.197, 0.204]) {
          const section = Array.from({ length: p.count }, (_, i) => i).filter(
            (i) => Math.sign(neutral[i * 3]) === side && Math.abs(neutral[i * 3 + 2] - z) < 1e-7
          );
          expect(section.length).toBeGreaterThan(30);
          const anchor = section[0];
          const a = new THREE.Vector3().fromArray(unfitted, anchor * 3);
          const b = new THREE.Vector3().fromBufferAttribute(p, anchor);
          for (const i of section) {
            const before = a.distanceTo(new THREE.Vector3().fromArray(unfitted, i * 3));
            const after = b.distanceTo(new THREE.Vector3().fromBufferAttribute(p, i));
            expect(Math.abs(after - before), `section ${z}, vertex ${i}`).toBeLessThan(1e-6);
          }
        }
        poseKick(f.rig, 0.3, f.spec, { reviewFollowThrough: true });
        f.rig.root.updateMatrixWorld(true);
        f.rig.skeleton.update();
        syncContinuousBootFlex(f.mesh, f.rig, { center: f.spec.ball, radius: 0.11 });
        expect(triangleSphereGap(f.mesh, f.spec.ball, 0.11)).toBeGreaterThanOrEqual(0.003 - 2e-6);
      } finally {
        f.dispose();
      }
    }
  );

  it('restores boot geometry/normals after removing the ball and keeps a nearby clear idle ball unchanged', () => {
    const f = sample('L', 1, 0, 0.34);
    try {
      const geometry = f.mesh.geometry,
        p = geometry.getAttribute('position') as THREE.BufferAttribute;
      const n = geometry.getAttribute('normal') as THREE.BufferAttribute;
      syncContinuousBootFlex(f.mesh, f.rig);
      const baselineP = p.array.slice(),
        baselineN = n.array.slice();
      syncContinuousBootFlex(f.mesh, f.rig, { center: f.visibleBall, radius: 0.11 });
      const versions = [p.version, n.version];
      syncContinuousBootFlex(f.mesh, f.rig, { center: f.visibleBall, radius: 0.11 });
      expect([p.version, n.version]).toEqual(versions);
      syncContinuousBootFlex(f.mesh, f.rig);
      expect(Array.from(p.array)).toEqual(Array.from(baselineP));
      expect(Array.from(n.array)).toEqual(Array.from(baselineN));
      poseIdle(f.rig, 0, 0);
      f.rig.root.position.set(0, 0, 0);
      f.rig.root.updateMatrixWorld(true);
      f.rig.skeleton.update();
      syncContinuousBootFlex(f.mesh, f.rig);
      const idleP = p.array.slice(),
        idleN = n.array.slice();
      const clear = { center: new THREE.Vector3(0.26, 0.128, -0.05), radius: 0.11 };
      expect(triangleSphereGap(f.mesh, clear.center, clear.radius)).toBeGreaterThan(0.003);
      const idleVersions = [p.version, n.version];
      syncContinuousBootFlex(f.mesh, f.rig, clear);
      expect(Array.from(p.array)).toEqual(Array.from(idleP));
      expect(Array.from(n.array)).toEqual(Array.from(idleN));
      expect([p.version, n.version]).toEqual(idleVersions);
      expect(geometry.getAttribute('position')).toBe(p);
      expect(geometry.getAttribute('normal')).toBe(n);
    } finally {
      f.dispose();
    }
  });
});

it('uploads changed contact fitting to the existing position/normal buffers after their first upload', () => {
  const f = sample('R', 1, 0, 0.3);
  let bound: object;
  const uploaded = new Map<object, Float32Array>();
  const gl = {
    FLOAT: 5126,
    ARRAY_BUFFER: 34962,
    createBuffer: () => ({}),
    bindBuffer: (_type: number, buffer: object) => {
      bound = buffer;
    },
    bufferData: (_type: number, values: Float32Array) => uploaded.set(bound, values.slice()),
    bufferSubData: (_type: number, offset: number, values: Float32Array) =>
      uploaded.get(bound)!.set(values, offset / 4),
    deleteBuffer: (buffer: object) => uploaded.delete(buffer),
  };
  const attributes = new WebGLAttributes(gl as unknown as WebGLRenderingContext);
  const p = f.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const n = f.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
  const read = (attribute: THREE.BufferAttribute) => {
    attributes.update(attribute, gl.ARRAY_BUFFER);
    return uploaded.get(attributes.get(attribute)!.buffer)!;
  };
  try {
    const initial = [read(p).slice(), read(n).slice()];
    const versions = [p.version, n.version];
    poseKick(f.rig, 0.34, f.spec, { reviewFollowThrough: true });
    f.rig.root.updateMatrixWorld(true);
    f.rig.skeleton.update();
    const ball = f.spec.ball.clone().addScaledVector(f.spec.dir, 0.2);
    ball.y += Math.sin((0.04 / 1.5) * Math.PI) * 0.5;
    syncContinuousBootFlex(f.mesh, f.rig, { center: ball, radius: 0.11 });
    expect(p.version).toBeGreaterThan(versions[0]);
    expect(n.version).toBeGreaterThan(versions[1]);
    expect(Array.from(read(p))).toEqual(Array.from(p.array));
    expect(Array.from(read(n))).toEqual(Array.from(n.array));
    expect(Array.from(read(p))).not.toEqual(Array.from(initial[0]));
    expect(Array.from(read(n))).not.toEqual(Array.from(initial[1]));
    expect(triangleSphereGap(f.mesh, ball, 0.11)).toBeGreaterThanOrEqual(0.003 - 2e-6);
    expect(f.mesh.geometry.getAttribute('position')).toBe(p);
    expect(f.mesh.geometry.getAttribute('normal')).toBe(n);
    expect(uploaded.size).toBe(2);
    const stable = [p.version, n.version];
    syncContinuousBootFlex(f.mesh, f.rig, { center: ball, radius: 0.11 });
    expect([p.version, n.version]).toEqual(stable);
  } finally {
    f.dispose();
  }
});
