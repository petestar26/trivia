import * as THREE from 'three';
import { RACING_DOGS } from '@socialplay/shared';

/** Original articulated greyhound: deep ribcage, tucked waist, long limbs and muzzle.
 * All geometry is authored here; no vendor models, footage or remote assets. */
export function createGreyhound(index: number) {
  const dog = RACING_DOGS[index];
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const resources: { dispose(): void }[] = [];
  const material = (color: string, roughness = 0.72) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness });
    resources.push(m);
    return m;
  };
  const coat = material(dog.coat),
    nose = material('#151719', 0.38),
    pale = material('#e4d7be');
  const eye = material('#090b0c', 0.18);
  const sphere = new THREE.SphereGeometry(1, 20, 14);
  resources.push(sphere);
  function oval(parent: THREE.Object3D, m: THREE.Material, pos: number[], scale: number[]) {
    const mesh = new THREE.Mesh(sphere, m);
    mesh.position.set(...(pos as [number, number, number]));
    mesh.scale.set(...(scale as [number, number, number]));
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }
  // Smooth loft through anatomical cross sections, with independent vertical and lateral radii.
  function loft(parent: THREE.Object3D, sections: number[][], m: THREE.Material) {
    const p: number[] = [],
      ids: number[] = [],
      ring = 24;
    const paths = [0, 1, 2, 3].map(
      (col) => new THREE.CatmullRomCurve3(sections.map((s) => new THREE.Vector3(s[0], s[col], 0)))
    );
    const steps = sections.length * 5;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps,
        x = paths[0].getPoint(t).x,
        y = paths[1].getPoint(t).y;
      const ry = Math.max(0.002, paths[2].getPoint(t).y),
        rz = Math.max(0.002, paths[3].getPoint(t).y);
      for (let j = 0; j <= ring; j++) {
        const a = (j / ring) * Math.PI * 2;
        p.push(x, y + Math.cos(a) * ry, Math.sin(a) * rz);
        if (i < steps && j < ring) {
          const n = i * (ring + 1) + j;
          ids.push(n, n + 1, n + ring + 1, n + 1, n + ring + 2, n + ring + 1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setIndex(ids);
    g.computeVertexNormals();
    resources.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }
  const torso = loft(
    body,
    [
      [-0.79, 0.91, 0.025, 0.025],
      [-0.61, 0.96, 0.17, 0.15],
      [-0.34, 0.98, 0.17, 0.135],
      [-0.08, 0.91, 0.25, 0.18],
      [0.27, 0.91, 0.32, 0.22],
      [0.49, 0.97, 0.26, 0.18],
      [0.65, 1.04, 0.1, 0.09],
    ],
    coat
  );
  // Paint the racing vest on the same continuous surface: no intersecting cloth shell.
  const positions = torso.geometry.getAttribute('position'),
    colors: number[] = [];
  const coatColor = new THREE.Color(dog.coat),
    vestColor = new THREE.Color(dog.color);
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const c = x > -0.16 && x < 0.39 ? vestColor : coatColor;
    colors.push(c.r, c.g, c.b);
  }
  torso.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.74 });
  resources.push(bodyMaterial);
  torso.material = bodyMaterial;
  const neck = oval(body, coat, [0.59, 1.16, 0], [0.155, 0.32, 0.13]);
  neck.rotation.z = -0.6;
  const head = new THREE.Group();
  head.position.set(0.8, 1.35, 0);
  body.add(head);
  loft(
    head,
    [
      [-0.11, 0, 0.04, 0.045],
      [0.0, 0.0, 0.14, 0.1],
      [0.17, -0.035, 0.1, 0.071],
      [0.38, -0.07, 0.047, 0.047],
      [0.43, -0.07, 0.024, 0.032],
    ],
    coat
  );
  oval(head, nose, [0.42, -0.069, 0], [0.031, 0.035, 0.045]);
  oval(head, pale, [0.22, -0.1, 0], [0.18, 0.025, 0.048]);
  for (const side of [-1, 1]) {
    oval(head, eye, [0.078, 0.037, side * 0.085], [0.017, 0.017, 0.01]);
    oval(head, pale, [0.086, 0.044, side * 0.097], [0.004, 0.004, 0.003]);
    const ear = new THREE.Shape();
    ear.moveTo(0, 0);
    ear.quadraticCurveTo(-0.12, 0.15, -0.22, 0.05);
    ear.quadraticCurveTo(-0.11, -0.04, 0, -0.06);
    const g = new THREE.ExtrudeGeometry(ear, {
      depth: 0.018,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: 0.018,
      bevelThickness: 0.012,
    });
    resources.push(g);
    const e = new THREE.Mesh(g, coat);
    e.position.set(-0.03, 0.075, side * 0.055);
    e.rotation.x = side * 0.5;
    head.add(e);
  }
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = dog.color;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = dog.ink;
  ctx.font = 'bold 94px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(index + 1), 64, 70);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  resources.push(tex);
  const nm = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
  resources.push(nm);
  for (const side of [-1, 1]) {
    const g = new THREE.PlaneGeometry(0.27, 0.27);
    resources.push(g);
    const label = new THREE.Mesh(g, nm);
    label.position.set(0.12, 0.98, side * 0.224);
    label.rotation.y = side === 1 ? 0 : Math.PI;
    body.add(label);
  }
  const legs: {
    hip: THREE.Vector3;
    upper: THREE.Mesh;
    lower: THREE.Mesh;
    joint: THREE.Mesh;
    paw: THREE.Mesh;
    side: number;
    rear: boolean;
  }[] = [];
  function segment(radiusTop: number, radiusBottom: number) {
    const profile = [
      new THREE.Vector2(0.005, -0.5),
      new THREE.Vector2(radiusBottom, -0.47),
      new THREE.Vector2(radiusBottom * 1.07, -0.3),
      new THREE.Vector2(radiusTop * 0.88, 0),
      new THREE.Vector2(radiusTop, 0.28),
      new THREE.Vector2(radiusTop * 0.85, 0.42),
      new THREE.Vector2(0.005, 0.5),
    ];
    const g = new THREE.LatheGeometry(profile, 16);
    resources.push(g);
    const mesh = new THREE.Mesh(g, coat);
    mesh.castShadow = true;
    body.add(mesh);
    return mesh;
  }
  for (const rear of [false, true])
    for (const side of [-1, 1]) {
      const hip = new THREE.Vector3(
        rear ? -0.57 : 0.44,
        rear ? 0.94 : 0.91,
        side * (rear ? 0.13 : 0.15)
      );
      oval(body, coat, [hip.x, hip.y, hip.z], [rear ? 0.15 : 0.09, rear ? 0.25 : 0.22, 0.084]);
      legs.push({
        hip,
        upper: segment(rear ? 0.095 : 0.052, rear ? 0.055 : 0.034),
        lower: segment(0.034, 0.019),
        joint: oval(body, coat, [0, 0, 0], [0.047, 0.06, 0.043]),
        paw: oval(body, coat, [0, 0, 0], [0.09, 0.042, 0.044]),
        side,
        rear,
      });
    }
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.68, 1, 0),
    new THREE.Vector3(-0.98, 0.86, 0),
    new THREE.Vector3(-1.18, 0.62, 0),
    new THREE.Vector3(-1.37, 0.58, 0),
  ]);
  const tg = new THREE.TubeGeometry(tailCurve, 24, 0.024, 8, false);
  resources.push(tg);
  const tail = new THREE.Mesh(tg, coat);
  body.add(tail);
  const groundInverse = new THREE.Matrix4();
  legs.forEach((leg) => {
    leg.paw.name = `${leg.rear ? 'rear' : 'front'}-${leg.side}-paw`;
  });
  const up = new THREE.Vector3(0, 1, 0),
    delta = new THREE.Vector3(),
    mid = new THREE.Vector3();
  function connect(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
    delta.subVectors(b, a);
    m.position.copy(mid.addVectors(a, b).multiplyScalar(0.5));
    m.scale.y = delta.length();
    m.quaternion.setFromUnitVectors(up, delta.normalize());
  }
  function pose(phase: number, moving: boolean) {
    const q = moving ? phase : 0;
    body.position.y = moving ? 0.065 + Math.sin(q * 2) * 0.045 : 0;
    body.rotation.z = moving ? Math.sin(q) * 0.045 : 0;
    body.scale.x = moving ? 1 + Math.cos(q) * 0.04 : 1;
    head.rotation.z = moving ? -0.2 + Math.cos(q) * 0.03 : Math.sin(phase * 0.22) * 0.045;
    tail.rotation.x = moving ? Math.sin(q) * 0.14 : Math.sin(phase * 0.35) * 0.06;
    body.updateMatrix();
    groundInverse.copy(body.matrix).invert();
    for (const leg of legs) {
      const a = q + (leg.rear ? Math.PI * 0.78 : 0) + (leg.side === 1 ? 0.5 : 0);
      const foot = new THREE.Vector3(
        leg.hip.x + (moving ? -Math.cos(a) * 0.55 : leg.rear ? -0.16 : 0.06),
        moving ? Math.max(0.045, Math.sin(a) * 0.32) : 0.045,
        leg.hip.z
      ).applyMatrix4(groundInverse);
      const upperLength = leg.rear ? 0.49 : 0.43,
        lowerLength = leg.rear ? 0.49 : 0.47;
      const dx = foot.x - leg.hip.x,
        dy = foot.y - leg.hip.y;
      const d = Math.min(upperLength + lowerLength - 0.002, Math.sqrt(dx * dx + dy * dy));
      const direction = Math.atan2(dy, dx),
        bend = Math.acos(
          THREE.MathUtils.clamp(
            (upperLength ** 2 + d * d - lowerLength ** 2) / (2 * upperLength * d),
            -1,
            1
          )
        );
      const angle = direction + (leg.rear ? -bend : bend);
      const knee = new THREE.Vector3(
        leg.hip.x + Math.cos(angle) * upperLength,
        leg.hip.y + Math.sin(angle) * upperLength,
        leg.hip.z
      ).applyMatrix4(groundInverse);
      connect(leg.upper, leg.hip, knee);
      connect(leg.lower, knee, foot);
      leg.joint.position.copy(knee);
      leg.paw.position.copy(foot);
      leg.paw.rotation.z = moving ? Math.max(-0.7, Math.min(0.6, Math.sin(a) * 0.7)) : 0;
    }
  }
  pose(0, false);
  return { root, pose, dispose: () => resources.forEach((r) => r.dispose()) };
}
