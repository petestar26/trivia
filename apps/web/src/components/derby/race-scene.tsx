import { useEffect, useRef, useState } from 'react';
import type { DerbyRound } from '@socialplay/shared';
import { DERBY_HORSES } from '@socialplay/shared';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Original procedural assets: no external model, tracker, CDN or licensed race footage. */
export default function RaceScene({
  round,
  running,
  reduced,
}: {
  round: DerbyRound;
  running: boolean;
  reduced: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ round, running, reduced });
  live.current = { round, running, reduced };
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'low-power',
      });
    } catch {
      setFailed(true);
      return;
    }
    const container = host.current;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);
    const lost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#c4d6d3');
    scene.fog = new THREE.Fog('#c4d6d3', 65, 230);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 350);
    scene.add(new THREE.HemisphereLight('#e4f4ff', '#80613d', 2.5));
    const sun = new THREE.DirectionalLight('#fff0cf', 3.5);
    sun.position.set(30, 40, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -40;
    sun.shadow.camera.right = 40;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.bottom = -40;
    scene.add(sun);
    scene.add(sun.target);
    const materials: THREE.Material[] = [];
    const geometries: THREE.BufferGeometry[] = [];
    const textures: THREE.Texture[] = [];
    const materialCache = new Map<string, THREE.MeshStandardMaterial>();
    function mat(color: string, roughness = 0.72, metalness = 0) {
      const key = `${color}:${roughness}:${metalness}`;
      const prior = materialCache.get(key);
      if (prior) return prior;
      const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      materials.push(m);
      materialCache.set(key, m);
      return m;
    }
    const turf = mat('#476849'),
      sand = mat('#b99468'),
      white = mat('#f5eee1'),
      dark = mat('#292d30'),
      wood = mat('#b18b54');
    function mesh(
      parent: THREE.Object3D,
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      x: number,
      y: number,
      z: number
    ) {
      geometries.push(geometry);
      const m = new THREE.Mesh(geometry, material);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    }
    function box(
      parent: THREE.Object3D,
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      m: THREE.Material
    ) {
      return mesh(parent, new THREE.BoxGeometry(w, h, d), m, x, y, z);
    }
    function ell(
      parent: THREE.Object3D,
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
      sz: number,
      m: THREE.Material
    ) {
      const o = mesh(parent, new THREE.SphereGeometry(1, 16, 12), m, x, y, z);
      o.scale.set(sx, sy, sz);
      return o;
    }
    function surfaceTexture(grass: boolean) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = grass ? '#6d8656' : '#c6ad86';
      ctx.fillRect(0, 0, 256, 256);
      let state = 731;
      const rand = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
      };
      for (let i = 0; i < 18000; i++) {
        const shade = Math.floor(rand() * 65);
        ctx.fillStyle = grass
          ? `rgba(${40 + shade},${70 + shade},${30 + shade},.45)`
          : `rgba(${105 + shade},${80 + shade},${50 + shade},.3)`;
        ctx.fillRect(rand() * 256, rand() * 256, grass ? 1 : 2, grass ? 4 : 1);
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(grass ? 60 : 45, grass ? 30 : 4);
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.push(texture);
      return texture;
    }
    turf.map = surfaceTexture(true);
    sand.map = surfaceTexture(false);
    box(scene, 80, -0.25, 0, 360, 0.5, 180, turf);
    box(scene, 85, 0.01, 0, 280, 0.05, 20, sand);
    for (let i = -20; i < 240; i += 4) {
      for (const z of [-10.5, 10.5]) {
        box(scene, i, 0.8, z, 0.12, 1.6, 0.12, white);
        box(scene, i, 1.35, z, 4, 0.11, 0.12, white);
        box(scene, i, 0.9, z, 4, 0.09, 0.1, white);
      }
    }
    for (let i = 0; i < 8; i++) box(scene, 90, 0.05, -8.7 + i * 2.5, 240, 0.01, 0.035, wood);
    // Grandstand terraces and roof, with a repeated restrained seat pattern.
    for (let level = 0; level < 5; level++) {
      box(
        scene,
        100,
        level * 0.65 + 0.3,
        -21 - level * 1.6,
        240,
        0.65,
        1.7,
        mat(level % 2 ? '#53665d' : '#75847a')
      );
    }
    box(scene, 100, 6.4, -24, 240, 0.22, 13, dark);
    for (let x = 15; x < 220; x += 15) box(scene, x, 3, -27, 0.22, 6, 0.22, white);
    for (let i = 0; i < 90; i++) {
      const x = 12 + (i % 30) * 3.6,
        z = -21 - Math.floor(i / 30) * 2.5;
      box(scene, x, 1.2 + Math.floor(i / 30), z, 1.3, 0.3, 0.6, i % 3 ? dark : wood);
    }
    for (let i = 0; i < 36; i++) {
      const x = -20 + i * 8,
        z = 23 + (i % 3) * 6;
      mesh(scene, new THREE.CylinderGeometry(0.2, 0.35, 4, 6), wood, x, 2, z);
      ell(scene, x, 5, z, 2.5, 3, 2.5, mat(i % 2 ? '#466452' : '#567454'));
    }
    // Finish line and its sculptural arch.
    for (let i = 0; i < 20; i++)
      box(scene, 180, 0.06, -9.5 + i, 1.2, 0.03, 1, i % 2 ? white : dark);
    for (const z of [-10, 10]) box(scene, 180, 3.3, z, 0.35, 6.6, 0.35, white);
    box(scene, 180, 6.4, 0, 0.5, 0.7, 20, wood);
    // Merge static geometry by material to keep mobile draw-call counts bounded.
    function mergeStatic(parent: THREE.Object3D) {
      const groups = new Map<THREE.Material, THREE.Mesh[]>();
      for (const child of parent.children) {
        if (child instanceof THREE.Mesh && !Array.isArray(child.material)) {
          const batch = groups.get(child.material) || [];
          batch.push(child);
          groups.set(child.material, batch);
        }
      }
      for (const [material, batch] of groups) {
        if (batch.length < 2) continue;
        const copies = batch.map((m) => {
          m.updateMatrix();
          return m.geometry.clone().applyMatrix4(m.matrix);
        });
        const joined = mergeGeometries(copies);
        copies.forEach((g) => g.dispose());
        if (!joined) continue;
        geometries.push(joined);
        const merged = new THREE.Mesh(joined, material);
        merged.castShadow = true;
        merged.receiveShadow = true;
        batch.forEach((m) => parent.remove(m));
        parent.add(merged);
      }
    }
    mergeStatic(scene);
    const coats = [
      '#773e26',
      '#302b28',
      '#c7b8a2',
      '#4c2a22',
      '#965b32',
      '#49332b',
      '#b47749',
      '#d2c6b6',
    ];
    const horses = Array.from({ length: round.field }, (_, i) => {
      const root = new THREE.Group();
      scene.add(root);
      const coat = mat(coats[i], 0.4),
        mane = mat('#211c19'),
        silk = mat(DERBY_HORSES[i].color, 0.35),
        skin = mat('#c99571');
      // Muscular barrel, shoulder, haunches; raised tapered neck and a long head.
      ell(root, 0, 1.75, 0, 1.08, 0.58, 0.43, coat);
      ell(root, 0.65, 1.8, 0, 0.5, 0.63, 0.45, coat);
      ell(root, -0.72, 1.76, 0, 0.56, 0.59, 0.46, coat);
      const neck = ell(root, 0.95, 2.25, 0, 0.37, 0.8, 0.32, coat);
      neck.rotation.z = -0.43;
      const head = ell(root, 1.4, 2.85, 0, 0.53, 0.3, 0.25, coat);
      head.rotation.z = 0.24;
      ell(root, 1.75, 2.69, 0, 0.26, 0.2, 0.24, mane);
      for (const z of [-0.17, 0.17]) {
        const ear = mesh(root, new THREE.ConeGeometry(0.095, 0.35, 8), coat, 1.15, 3.2, z);
        ear.rotation.z = 0.2;
        ell(root, 1.47, 2.96, z * 1.5, 0.047, 0.047, 0.02, dark);
      }
      for (let n = 0; n < 9; n++)
        ell(root, 0.72 + n * 0.055, 2.15 + n * 0.1, 0, 0.14, 0.17, 0.34, mane);
      const tail = ell(root, -1.2, 1.8, 0, 0.7, 0.12, 0.12, mane);
      tail.rotation.z = 0.4;
      const legs: Array<{ upper: THREE.Group; lower: THREE.Group }> = [];
      for (const x of [-0.72, 0.65])
        for (const z of [-0.29, 0.29]) {
          const upper = new THREE.Group();
          upper.position.set(x, 1.5, z);
          root.add(upper);
          mesh(upper, new THREE.CapsuleGeometry(0.115, 0.58, 4, 8), coat, 0, -0.34, 0);
          const lower = new THREE.Group();
          lower.position.y = -0.72;
          upper.add(lower);
          mesh(lower, new THREE.CapsuleGeometry(0.072, 0.5, 4, 8), coat, 0, -0.3, 0);
          box(lower, 0.045, -0.63, 0, 0.22, 0.14, 0.19, mane);
          legs.push({ upper, lower });
        }
      // Saddlecloth, leather saddle and crouched jockey.
      ell(root, -0.05, 2.21, 0, 0.52, 0.13, 0.49, silk);
      ell(root, -0.1, 2.3, 0, 0.38, 0.12, 0.32, dark);
      const rider = new THREE.Group();
      root.add(rider);
      const torso = ell(rider, 0.08, 2.7, 0, 0.22, 0.43, 0.25, silk);
      torso.rotation.z = -0.8;
      ell(rider, 0.43, 3.06, 0, 0.17, 0.19, 0.17, skin);
      ell(rider, 0.43, 3.18, 0, 0.2, 0.13, 0.2, silk);
      for (const z of [-0.35, 0.35]) {
        const thigh = ell(rider, -0.17, 2.45, z, 0.32, 0.12, 0.13, white);
        thigh.rotation.z = 0.4;
        const boot = ell(rider, -0.29, 2.1, z, 0.11, 0.29, 0.1, dark);
        boot.rotation.z = -0.3;
        const arm = ell(rider, 0.46, 2.72, z * 0.6, 0.3, 0.075, 0.075, silk);
        arm.rotation.z = -0.3;
      }
      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = 128;
      labelCanvas.height = 128;
      const ctx = labelCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = DERBY_HORSES[i].color;
        ctx.beginPath();
        ctx.arc(64, 64, 47, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#111';
        ctx.font = 'bold 64px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), 64, 67);
      }
      const texture = new THREE.CanvasTexture(labelCanvas);
      textures.push(texture);
      const labelMat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
      materials.push(labelMat);
      const label = new THREE.Sprite(labelMat);
      label.position.set(0, 4, 0);
      label.scale.set(0.9, 0.9, 1);
      root.add(label);
      root.position.set(0, 0, (i - (round.field - 1) / 2) * 2.15);
      mergeStatic(rider);
      // Keep the animated tail separate from static body geometry.
      root.remove(tail);
      mergeStatic(root);
      root.add(tail);
      return { root, legs, rider, tail };
    });
    let frame = 0,
      last = 0;
    const displayed = horses.map(() => 0);
    const resize = () => {
      const w = container.clientWidth,
        h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      if (document.hidden || time - last < 33) return;
      last = time;
      const state = live.current,
        moving = state.running && !state.reduced;
      horses.forEach((horse, i) => {
        const target = (state.round.positions[i] ?? 0) * 180;
        displayed[i] += (target - displayed[i]) * (state.reduced ? 1 : 0.1);
        horse.root.position.x = displayed[i];
        horse.root.position.y = moving ? Math.abs(Math.sin(time * 0.008 + i)) * 0.13 : 0;
        horse.legs.forEach((leg, j) => {
          const phase = time * 0.012 + i + j * Math.PI * 0.77;
          leg.upper.rotation.z = moving ? Math.sin(phase) * 0.65 : 0;
          leg.lower.rotation.z = moving ? Math.max(0, Math.sin(phase + 1)) * 0.95 : 0;
        });
        horse.rider.rotation.z = moving ? Math.sin(time * 0.012 + i) * 0.055 : 0;
        horse.tail.rotation.z = 0.4 + (moving ? Math.sin(time * 0.008 + i) * 0.12 : 0);
      });
      const lead = Math.max(...displayed),
        center = lead - 3;
      camera.position.set(center + 10, 7, 20);
      camera.lookAt(center, 1, 0);
      sun.position.set(center + 30, 40, 20);
      sun.target.position.set(center, 0, 0);
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.dispose();
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      renderer.domElement.remove();
    };
  }, [round.field, round.id]);
  return (
    <div
      className="derby-scene"
      ref={host}
      aria-label="Three-dimensional horse race. Official results appear below."
      role="img"
    >
      {failed && (
        <div className="derby-scene-fallback">
          3D view unavailable on this device. Follow the numbered race progress and official results
          below.
        </div>
      )}
    </div>
  );
}
