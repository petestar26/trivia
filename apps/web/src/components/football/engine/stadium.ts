import { spectatorGeometry } from './spectator';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PITCH } from './director';

/**
 * Original procedural stadium: striped turf with markings, goals with deformable netting,
 * stands with an instanced crowd, advertising boards and floodlights. No external textures
 * or models; every texture is drawn into a canvas here and disposed with the stadium.
 */
export interface Net {
  group: THREE.Group;
  /** Starts a ripple at a world point. */
  impact(x: number, y: number, z: number): void;
  update(dt: number): void;
}
export interface Stadium {
  group: THREE.Group;
  nets: Record<'-1' | '1', Net>;
  update(dt: number, crowdExcite: number): void;
  dispose(): void;
}

const LINE = '#f3f6ef';

function turfTexture(): THREE.CanvasTexture {
  const margin = 5;
  const lengthM = PITCH.halfLength * 2 + margin * 2;
  const widthM = PITCH.halfWidth * 2 + margin * 2;
  const ppm = 20;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(lengthM * ppm);
  canvas.height = Math.round(widthM * ppm);
  const ctx = canvas.getContext('2d')!;
  const X = (x: number) => (x + lengthM / 2) * ppm;
  const Z = (z: number) => (z + widthM / 2) * ppm;
  // Mown stripes along the length, with a little grain.
  const stripe = 7.5;
  for (let i = 0; i * stripe < lengthM; i++) {
    ctx.fillStyle = i % 2 ? '#2f7d3a' : '#35893f';
    ctx.fillRect(i * stripe * ppm, 0, stripe * ppm, canvas.height);
  }
  let seed = 4242;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 26000; i++) {
    ctx.fillStyle = `rgba(${rand() < 0.5 ? '20,70,25' : '90,150,80'},0.08)`;
    ctx.fillRect(rand() * canvas.width, rand() * canvas.height, 2, 5);
  }
  ctx.strokeStyle = LINE;
  ctx.fillStyle = LINE;
  ctx.lineWidth = 0.13 * ppm;
  const rect = (x0: number, z0: number, x1: number, z1: number) =>
    ctx.strokeRect(X(x0), Z(z0), (x1 - x0) * ppm, (z1 - z0) * ppm);
  const hl = PITCH.halfLength;
  const hw = PITCH.halfWidth;
  rect(-hl, -hw, hl, hw);
  ctx.beginPath();
  ctx.moveTo(X(0), Z(-hw));
  ctx.lineTo(X(0), Z(hw));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(X(0), Z(0), 9.15 * ppm, 0, Math.PI * 2);
  ctx.stroke();
  const dot = (x: number, z: number) => {
    ctx.beginPath();
    ctx.arc(X(x), Z(z), 0.22 * ppm, 0, Math.PI * 2);
    ctx.fill();
  };
  dot(0, 0);
  for (const s of [-1, 1]) {
    rect(s > 0 ? hl - 16.5 : -hl, -20.15, s > 0 ? hl : -hl + 16.5, 20.15);
    rect(s > 0 ? hl - 5.5 : -hl, -9.16, s > 0 ? hl : -hl + 5.5, 9.16);
    dot(s * (hl - 11), 0);
    ctx.beginPath();
    ctx.arc(
      X(s * (hl - 11)),
      Z(0),
      9.15 * ppm,
      s > 0 ? Math.PI - 0.93 : -0.93,
      s > 0 ? Math.PI + 0.93 : 0.93
    );
    ctx.stroke();
    for (const c of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(X(s * hl), Z(c * hw), 1 * ppm, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function adTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const brands: Array<[string, string, string]> = [
    ['PLAYQUBE', '#10243f', '#7fd4ff'],
    ['NORTHQUAY AIR', '#f2f2f2', '#c61f2b'],
    ['EMBER BANK', '#ffb81c', '#2a1500'],
    ['HIGHCREST LABS', '#0f6b4f', '#eafff6'],
    ['TIDEWELL FOODS', '#1a3ea8', '#ffffff'],
    ['MERIDIAN TELECOM', '#2b2d31', '#ffd23f'],
  ];
  const w = canvas.width / brands.length;
  brands.forEach(([text, bg, fg], i) => {
    ctx.fillStyle = bg;
    ctx.fillRect(i * w, 0, w, 64);
    ctx.fillStyle = fg;
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, i * w + w / 2, 34);
    ctx.fillRect(i * w, 0, 3, 64);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.repeat.set(2, 1);
  return texture;
}

function skyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#07101f');
  g.addColorStop(0.55, '#1a3358');
  g.addColorStop(1, '#6f86a8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

class NetImpl implements Net {
  group = new THREE.Group();
  private geometry: THREE.BufferGeometry;
  private base: Float32Array;
  private energy = 0;
  private origin = new THREE.Vector3();
  private time = 0;
  private lines: THREE.LineSegments;
  constructor(
    private side: 1 | -1,
    material: THREE.LineBasicMaterial
  ) {
    const gw = PITCH.goalHalfWidth;
    const gh = PITCH.goalHeight;
    const gd = PITCH.goalDepth;
    const pts: number[] = [];
    const seg = (a: number[], b: number[]) => pts.push(...a, ...b);
    const nx = 18;
    const ny = 7;
    const nz = 5;
    // Local frame: +x is out of the goal (behind the line), +y up, z across.
    for (let i = 0; i <= nx; i++) {
      const z = -gw + (2 * gw * i) / nx;
      seg([gd, 0, z], [gd, gh, z]); // back, vertical
      seg([0, gh, z], [gd, gh, z]); // roof, along depth
    }
    for (let j = 0; j <= ny; j++) {
      const y = (gh * j) / ny;
      seg([gd, y, -gw], [gd, y, gw]); // back, horizontal
    }
    for (let k = 0; k <= nz; k++) {
      const x = (gd * k) / nz;
      seg([x, gh, -gw], [x, gh, gw]); // roof, across
      for (const zz of [-gw, gw]) seg([x, 0, zz], [x, gh, zz]); // sides
    }
    for (let j = 0; j <= ny; j++) {
      const y = (gh * j) / ny;
      for (const zz of [-gw, gw]) seg([0, y, zz], [gd, y, zz]);
    }
    this.base = new Float32Array(pts);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    this.lines = new THREE.LineSegments(this.geometry, material);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
    this.group.position.x = side * PITCH.halfLength;
    this.group.scale.x = side;
  }
  impact(x: number, y: number, z: number) {
    this.origin.set(Math.abs(x - this.side * PITCH.halfLength), y, z);
    this.energy = 1;
    this.time = 0;
  }
  update(dt: number) {
    if (this.energy <= 0.002) return;
    this.time += dt;
    this.energy *= Math.exp(-dt * 2.1);
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const bx = this.base[i];
      const by = this.base[i + 1];
      const bz = this.base[i + 2];
      const d = Math.hypot(by - this.origin.y, bz - this.origin.z);
      const wave = Math.cos(this.time * 22 - d * 3.2) * Math.exp(-d * d * 0.28);
      // Bulge outwards (away from the pitch), strongest at the back netting.
      const depth = bx / PITCH.goalDepth;
      arr[i] = bx + wave * this.energy * 0.55 * (0.25 + 0.75 * depth);
      arr[i + 1] = by + wave * this.energy * 0.12 * depth;
      arr[i + 2] = bz + wave * this.energy * 0.1 * Math.sign(bz - this.origin.z) * depth;
    }
    pos.needsUpdate = true;
  }
  dispose() {
    this.geometry.dispose();
  }
}

export function buildStadium(): Stadium {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T) => (geometries.push(g), g);
  const mat = <T extends THREE.Material>(m: T) => (materials.push(m), m);

  // --- turf ---------------------------------------------------------------------------
  const turf = turfTexture();
  textures.push(turf);
  const margin = 5;
  const pitch = new THREE.Mesh(
    track(
      new THREE.PlaneGeometry(PITCH.halfLength * 2 + margin * 2, PITCH.halfWidth * 2 + margin * 2)
    ),
    mat(new THREE.MeshStandardMaterial({ map: turf, roughness: 0.95 }))
  );
  pitch.rotation.x = -Math.PI / 2;
  pitch.receiveShadow = true;
  group.add(pitch);
  const apron = new THREE.Mesh(
    track(new THREE.PlaneGeometry(400, 300)),
    mat(new THREE.MeshStandardMaterial({ color: '#1f4f2c', roughness: 1 }))
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.02;
  group.add(apron);

  // --- goals --------------------------------------------------------------------------
  const post = mat(
    new THREE.MeshStandardMaterial({ color: '#f7f7f4', roughness: 0.35, metalness: 0.2 })
  );
  const netMaterial = mat(
    new THREE.LineBasicMaterial({ color: '#f1f5f0', transparent: true, opacity: 0.55 })
  );
  const nets = {} as Record<'-1' | '1', NetImpl>;
  for (const s of [-1, 1] as const) {
    const frame = new THREE.Group();
    const upright = track(new THREE.CylinderGeometry(0.06, 0.06, PITCH.goalHeight, 10));
    const bar = track(new THREE.CylinderGeometry(0.06, 0.06, PITCH.goalHalfWidth * 2 + 0.12, 10));
    for (const z of [-1, 1]) {
      const p = new THREE.Mesh(upright, post);
      p.position.set(0, PITCH.goalHeight / 2, z * PITCH.goalHalfWidth);
      p.castShadow = true;
      frame.add(p);
    }
    const b = new THREE.Mesh(bar, post);
    b.rotation.x = Math.PI / 2;
    b.position.set(0, PITCH.goalHeight, 0);
    b.castShadow = true;
    frame.add(b);
    frame.position.x = s * PITCH.halfLength;
    group.add(frame);
    const net = new NetImpl(s, netMaterial);
    geometries.push((net as unknown as { geometry: THREE.BufferGeometry }).geometry);
    group.add(net.group);
    nets[String(s) as '-1' | '1'] = net;
  }
  // Corner flags
  const flagPole = track(new THREE.CylinderGeometry(0.02, 0.02, 1.6, 6));
  const flagCloth = track(new THREE.PlaneGeometry(0.4, 0.28));
  const clothMat = mat(
    new THREE.MeshStandardMaterial({ color: '#ffd23f', side: THREE.DoubleSide })
  );
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const pole = new THREE.Mesh(flagPole, post);
      pole.position.set(sx * PITCH.halfLength, 0.8, sz * PITCH.halfWidth);
      group.add(pole);
      const cloth = new THREE.Mesh(flagCloth, clothMat);
      cloth.position.set(sx * PITCH.halfLength - sx * 0.2, 1.45, sz * PITCH.halfWidth);
      cloth.rotation.y = Math.PI / 2;
      group.add(cloth);
    }

  // --- advertising boards ---------------------------------------------------------------
  const ads = adTexture();
  textures.push(ads);
  const adMat = mat(new THREE.MeshBasicMaterial({ map: ads }));
  const boardLong = track(new THREE.BoxGeometry(PITCH.halfLength * 2 + 6, 0.9, 0.15));
  const boardEnd = track(new THREE.BoxGeometry(0.15, 0.9, PITCH.halfWidth * 2 + 6));
  for (const sz of [-1, 1]) {
    const m = new THREE.Mesh(boardLong, adMat);
    m.position.set(0, 0.45, sz * (PITCH.halfWidth + 3.2));
    group.add(m);
  }
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(boardEnd, adMat);
    m.position.set(sx * (PITCH.halfLength + 4.2), 0.45, 0);
    group.add(m);
  }

  // --- stands -------------------------------------------------------------------------
  const seats = mat(new THREE.MeshStandardMaterial({ color: '#2b3f66', roughness: 0.9 }));
  const concrete = mat(new THREE.MeshStandardMaterial({ color: '#59616d', roughness: 1 }));
  const roofMat = mat(
    new THREE.MeshStandardMaterial({ color: '#2a2f38', roughness: 0.8, metalness: 0.3 })
  );
  const tierParts: THREE.BufferGeometry[] = [];
  const crowdSpots: THREE.Matrix4[] = [];
  const addStand = (cx: number, cz: number, length: number, rotationY: number, tiers: number) => {
    for (let i = 0; i < tiers; i++) {
      const step = new THREE.BoxGeometry(length, 1.1, 1.2);
      const local = new THREE.Matrix4().makeRotationY(rotationY);
      const along = new THREE.Vector3(0, 0.55 + i * 1.05, 8 + i * 1.15).applyMatrix4(
        new THREE.Matrix4().makeRotationY(rotationY)
      );
      local.setPosition(cx + along.x, along.y, cz + along.z);
      step.applyMatrix4(local);
      tierParts.push(step);
      // Seated fans, with occasional empty seats; each stand faces the pitch.
      for (let f = 0; f < length / 1.1; f++) {
        if ((f * 13 + i * 7) % 11 === 0 || (f + i) % 2) continue; // a few empty seats; every other seat to bound triangles
        const lx = -length / 2 + 0.6 + f * 1.1;
        const p = new THREE.Vector3(lx, 1.5 + i * 1.05, 8 + i * 1.15 - 0.15).applyMatrix4(
          new THREE.Matrix4().makeRotationY(rotationY)
        );
        crowdSpots.push(
          new THREE.Matrix4()
            .makeRotationY(rotationY + Math.PI)
            .setPosition(cx + p.x, p.y - 0.3, cz + p.z)
        );
      }
    }
  };
  // Far stand (the camera looks at it), then the two ends. The near stand is behind the camera.
  const farZ = -(PITCH.halfWidth + 5.5);
  addStand(0, farZ, 130, Math.PI, 12);
  // Tiers rise AWAY from the pitch: local +z must map to -x at the left end and +x at the right end.
  addStand(-(PITCH.halfLength + 6), 0, 70, -Math.PI / 2, 8);
  addStand(PITCH.halfLength + 6, 0, 70, Math.PI / 2, 8);
  const standMesh = new THREE.Mesh(track(mergeGeometries(tierParts)!), seats);
  tierParts.forEach((g) => g.dispose());
  group.add(standMesh);
  const wall = new THREE.Mesh(track(new THREE.BoxGeometry(140, 16, 0.5)), concrete);
  wall.position.set(0, 8, farZ - 22);
  group.add(wall);
  const roof = new THREE.Mesh(track(new THREE.BoxGeometry(136, 0.6, 16)), roofMat);
  roof.position.set(0, 17, farZ - 14);
  group.add(roof);

  // --- crowd (instanced; bounce is driven by the excitement level) --------------------------------
  const fanParts = spectatorGeometry();
  const fanMaterial = mat(new THREE.MeshStandardMaterial({ roughness: 0.9 }));
  const crowd = new THREE.InstancedMesh(track(fanParts.clothes), fanMaterial, crowdSpots.length);
  const faces = new THREE.InstancedMesh(track(fanParts.skin), fanMaterial, crowdSpots.length);
  const trousers = new THREE.InstancedMesh(track(fanParts.dark), fanMaterial, crowdSpots.length);
  const crowdMeshes = [crowd, faces, trousers];
  const palette = ['#e9e6df', '#2c4a8c', '#b3122b', '#f2b134', '#222831', '#4d8b6a', '#c9d3df'];
  const skinPalette = ['#c99570', '#9a6243', '#e5b894', '#70452f', '#b67b56'];
  const tint = new THREE.Color();
  const phase = new Float32Array(crowdSpots.length);
  const pos = new THREE.Vector3();
  crowdSpots.forEach((m, i) => {
    crowdMeshes.forEach((mesh) => mesh.setMatrixAt(i, m));
    crowd.setColorAt(i, tint.set(palette[(i * 7 + (i >> 3)) % palette.length]));
    faces.setColorAt(i, tint.set(skinPalette[i % skinPalette.length]));
    trousers.setColorAt(i, tint.set(i % 3 ? '#252733' : '#55463b'));
    phase[i] = ((i * 2654435761) % 628) / 100;
  });
  crowdMeshes.forEach((mesh) => {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(mesh);
  });
  let crowdClock = 0;
  let crowdRefresh = 0;

  // --- floodlights ------------------------------------------------------------------------
  const lampMat = mat(new THREE.MeshBasicMaterial({ color: '#fff7dd' }));
  const mast = track(new THREE.CylinderGeometry(0.35, 0.5, 34, 8));
  const panel = track(new THREE.BoxGeometry(7, 4.5, 0.6));
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const m = new THREE.Mesh(mast, concrete);
      m.position.set(sx * 66, 17, sz * 46);
      group.add(m);
      const p = new THREE.Mesh(panel, lampMat);
      p.position.set(sx * 66, 35, sz * 46);
      p.lookAt(0, 8, 0);
      group.add(p);
    }
  // A skyline of lit towers far behind the far stand adds depth without geometry cost.
  const skylineParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 36; i++) {
    const h = 14 + ((i * 53) % 37);
    const w = 6 + ((i * 29) % 7);
    const g = new THREE.BoxGeometry(w, h, w);
    g.translate(-190 + i * 10.5, h / 2 - 2, farZ - 120 - ((i * 17) % 40));
    skylineParts.push(g);
  }
  const skyline = new THREE.Mesh(
    track(mergeGeometries(skylineParts)!),
    mat(
      new THREE.MeshStandardMaterial({
        color: '#101a2c',
        emissive: '#223457',
        emissiveIntensity: 0.6,
      })
    )
  );
  skylineParts.forEach((g) => g.dispose());
  group.add(skyline);

  return {
    group,
    nets: nets as unknown as Stadium['nets'],
    update(dt, excite) {
      nets['-1'].update(dt);
      nets['1'].update(dt);
      crowdClock += dt;
      crowdRefresh += dt;
      if (crowdRefresh < 0.09) return; // refresh the crowd at ~11 Hz
      crowdRefresh = 0;
      const amp = 0.004 + 0.065 * excite * excite;
      const rate = 3 + 7 * excite;
      const m = new THREE.Matrix4();
      for (let i = 0; i < crowdSpots.length; i++) {
        pos.setFromMatrixPosition(crowdSpots[i]);
        m.copy(crowdSpots[i]).setPosition(
          pos.x,
          pos.y + Math.abs(Math.sin(crowdClock * rate + phase[i])) * amp,
          pos.z
        );
        crowdMeshes.forEach((mesh) => mesh.setMatrixAt(i, m));
      }
      crowdMeshes.forEach((mesh) => {
        mesh.instanceMatrix.needsUpdate = true;
      });
    },
    dispose() {
      geometries.forEach((g) => g.dispose());
      materials.forEach((x) => x.dispose());
      textures.forEach((x) => x.dispose());
      crowdMeshes.forEach((mesh) => mesh.dispose());
    },
  };
}

export { skyTexture };
