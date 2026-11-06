import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DERBY_HORSES } from '@socialplay/shared';
import { createHorse } from '@/components/derby/horse-model';
import {
  loadHorseAssets,
  createRiggedHorse,
  type HorseAssets,
  type RaceHorse,
} from '@/components/derby/rigged-horse';
import { CONTACT_FRACTION, STRIDE_SECONDS } from '@/components/derby/gallop';
import { createGreyhound } from '@/components/dog-racing/greyhound';

const TRACK = 180;
/** Render-only adapter: course, rigs and cameras consume released checkpoints. */
export default function SharedRaceScene({
  positions,
  elapsed,
  duration,
  dogs,
  running,
  quality,
  fallback,
}: {
  positions: number[];
  elapsed: number;
  duration: number;
  dogs: boolean;
  running: boolean;
  quality: 'high' | 'balanced';
  fallback: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null),
    live = useRef({ positions, elapsed, duration, running });
  live.current = { positions, elapsed, duration, running };
  const [failed, setFailed] = useState(false),
    [authored, setAuthored] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: quality === 'high',
        powerPreference: 'low-power',
      });
    } catch {
      setFailed(true);
      return;
    }
    let disposed = false,
      frame = 0,
      last = 0,
      assets: HorseAssets | undefined;
    const resources = {
      materials: [] as THREE.Material[],
      geometries: [] as THREE.BufferGeometry[],
      textures: [] as THREE.Texture[],
    };
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(dogs ? '#182d48' : '#9fbac8');
    scene.fog = new THREE.Fog(dogs ? '#182d48' : '#9fbac8', 100, 280);
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.75 : 1.15)
    );
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = dogs ? 1.2 : 1.05;
    renderer.shadowMap.enabled = quality === 'high';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    scene.add(
      new THREE.HemisphereLight(
        dogs ? '#b1d8ff' : '#e9f2ff',
        dogs ? '#3a3936' : '#475e38',
        dogs ? 1.9 : 2.1
      )
    );
    const sun = new THREE.DirectionalLight(dogs ? '#c7e4ff' : '#fff0cc', dogs ? 2.2 : 2.7);
    sun.position.set(35, 70, 30);
    sun.castShadow = quality === 'high';
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -28;
    sun.shadow.camera.right = 28;
    sun.shadow.camera.top = 28;
    sun.shadow.camera.bottom = -28;
    sun.shadow.camera.far = 140;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 350);
    const material = (color: string, roughness = 0.8) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness });
      resources.materials.push(m);
      return m;
    };
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      resources.geometries.push(g);
      const obj = new THREE.Mesh(g, m);
      obj.position.set(x, y, z);
      obj.receiveShadow = true;
      scene.add(obj);
      return obj;
    };
    const box = (
      w: number,
      h: number,
      d: number,
      m: THREE.Material,
      x: number,
      y: number,
      z: number
    ) => add(new THREE.BoxGeometry(w, h, d), m, x, y, z);
    const grass = material(dogs ? '#283e42' : '#4e7650'),
      track = material(dogs ? '#a38c6b' : '#48794e'),
      white = material('#e3e4d3'),
      dark = material('#34454a'),
      sand = material(dogs ? '#776449' : '#6a7955'),
      stands = material(dogs ? '#33465a' : '#6f7473');
    box(280, 0.2, 120, grass, 80, -0.25, 0);
    box(205, 0.1, 18, track, 85, -0.1, 0);
    // Authored mown strips / sand seams, with low-cost detail rather than a blank plane.
    for (let i = 0; i < 40; i++) box(4.9, 0.012, 18, i % 2 ? track : sand, i * 5 - 10, -0.035, 0);
    for (const z of [-9.2, 9.2]) {
      box(210, 0.12, 0.12, white, 85, 1.15, z);
      box(210, 0.09, 0.09, white, 85, 0.65, z);
      for (let x = -18; x < 190; x += 5) box(0.14, 1.25, 0.14, white, x, 0.6, z);
    }
    for (let lane = 1; lane < 8; lane++) box(198, 0.013, 0.025, white, 89, -0.012, lane * 2 - 8);
    // Grandstands, seats and a long cantilever canopy sit beyond the course.
    for (let block = 0; block < 8; block++) {
      const x = block * 27 - 12;
      for (let row = 0; row < 5; row++) {
        box(24, 0.6, 1.6, stands, x, 0.3 + row * 0.65, -14 - row * 1.7);
        for (let seat = 0; seat < 12; seat++)
          box(
            0.85,
            0.35,
            0.6,
            seat % 3 ? dark : white,
            x - 11 + seat * 2,
            0.8 + row * 0.65,
            -14 - row * 1.7
          );
      }
      box(25, 0.28, 11, dark, x, 6.8, -18);
      box(0.25, 6.6, 0.25, dark, x - 11, 3.3, -21);
      box(0.25, 6.6, 0.25, dark, x + 11, 3.3, -21);
    }
    const gate = material(dogs ? '#315667' : '#476260'),
      glow = new THREE.MeshBasicMaterial({ color: dogs ? '#86f5e3' : '#e3e9d4' });
    resources.materials.push(glow);
    for (let i = 0; i < 8; i++) {
      box(3, 2.2, 0.15, gate, -2, 1.1, i * 2 - 8);
      box(3, 2.2, 0.15, gate, -2, 1.1, i * 2 - 6.2);
      box(3, 0.15, 1.8, gate, -2, 2.25, i * 2 - 7.1);
    }
    // Finish arch and checker strip are physically in the track's coordinate system.
    for (const z of [-9.5, 9.5]) box(0.65, 5.5, 0.65, white, TRACK, 2.75, z);
    box(0.8, 0.75, 20, gate, TRACK, 5.3, 0);
    for (let i = 0; i < 36; i++)
      box(0.36, 0.018, 0.5, i % 2 ? dark : white, TRACK, 0.008, -8.75 + i * 0.5);
    for (let i = 0; i < 14; i++)
      box(0.06, 0.5, 1.2, i % 2 ? dark : white, TRACK + 0.43, 5.3, -8.4 + i * 1.25);
    for (let x = 0; x <= 180; x += 30) {
      box(0.18, 12, 0.18, dark, x, 6, -26);
      box(0.35, 1.3, 4, white, x, 12, -26);
      box(0.4, 0.8, 3.6, glow, x + 0.2, 12, -26);
      if (dogs && quality === 'high') {
        const light = new THREE.PointLight('#b0e6ed', 18, 28, 2);
        light.position.set(x, 10, -13);
        scene.add(light);
      }
    }
    // Batch static course geometry by material; hundreds of seats/rails must not
    // become hundreds of draw calls on a phone.
    const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const object of [...scene.children])
      if (object instanceof THREE.Mesh) {
        object.updateMatrix();
        const copy = object.geometry.clone().applyMatrix4(object.matrix);
        const mat = object.material as THREE.Material;
        batches.set(mat, [...(batches.get(mat) ?? []), copy]);
        scene.remove(object);
      }
    for (const [mat, parts] of batches) {
      const geometry = mergeGeometries(parts);
      parts.forEach((p) => p.dispose());
      if (geometry) {
        resources.geometries.push(geometry);
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.receiveShadow = true;
        scene.add(mesh);
      }
    }
    // Scene-owned soft contact shadow, retained for procedural-to-rig replacement.
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 64;
    const sc = shadowCanvas.getContext('2d');
    if (sc) {
      const g = sc.createRadialGradient(32, 32, 1, 32, 32, 31);
      g.addColorStop(0, 'rgba(0,0,0,.45)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      sc.fillStyle = g;
      sc.fillRect(0, 0, 64, 64);
    }
    const st = new THREE.CanvasTexture(shadowCanvas);
    resources.textures.push(st);
    const sm = new THREE.MeshBasicMaterial({ map: st, transparent: true, depthWrite: false });
    resources.materials.push(sm);
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
    const runners = Array.from({ length: 8 }, (_, i) => {
      let horse: RaceHorse | null = dogs
        ? null
        : createHorse(coats[i], DERBY_HORSES[i].color, i, resources, () => {});
      const dog = dogs ? createGreyhound(i) : null;
      const root = (horse ?? dog)!.root;
      root.position.z = i * 2 - 7;
      scene.add(root);
      const shadow = add(new THREE.PlaneGeometry(dogs ? 3 : 4, 1.6), sm, 0, 0.012, i * 2 - 7);
      shadow.rotation.x = -Math.PI / 2;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const c = canvas.getContext('2d');
      if (c) {
        c.fillStyle = DERBY_HORSES[i].color;
        c.fillRect(0, 0, 64, 64);
        c.fillStyle = i === 0 ? '#17252d' : '#fff';
        c.font = 'bold 42px sans-serif';
        c.textAlign = 'center';
        c.fillText(String(i + 1), 32, 47);
      }
      const tex = new THREE.CanvasTexture(canvas);
      resources.textures.push(tex);
      const mat = new THREE.SpriteMaterial({ map: tex });
      resources.materials.push(mat);
      const marker = new THREE.Sprite(mat);
      marker.position.set(0, dogs ? 1.5 : 2.8, 0);
      marker.scale.set(0.55, 0.55, 1);
      root.add(marker);
      return { root, horse, dog, shadow, marker };
    });
    if (!dogs)
      void loadHorseAssets()
        .then((loaded) => {
          if (disposed) {
            loaded.dispose();
            return;
          }
          assets = loaded;
          const replacements: RaceHorse[] = [];
          try {
            for (let i = 0; i < 8; i++)
              replacements.push(createRiggedHorse(loaded, coats[i], DERBY_HORSES[i].color, i));
          } catch {
            replacements.forEach((r) => r.dispose?.());
            loaded.dispose();
            assets = undefined;
            return;
          }
          replacements.forEach((horse, i) => {
            const old = runners[i];
            horse.root.position.set(old.root.position.x, 0, old.root.position.z);
            horse.root.add(old.marker);
            scene.remove(old.root);
            scene.add(horse.root);
            old.horse?.dispose?.();
            old.horse = horse;
            old.root = horse.root;
          });
          setAuthored(true);
        })
        .catch(() => {});
    element.appendChild(renderer.domElement);
    const resize = () => {
      const w = Math.max(1, element.clientWidth),
        h = Math.max(260, Math.min(560, w * 0.57));
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const lost = (e: Event) => {
      e.preventDefault();
      setFailed(true);
      disposed = true;
      cancelAnimationFrame(frame);
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    const smooth = (v: number) => {
      const x = Math.min(1, Math.max(0, v));
      return x * x * (3 - 2 * x);
    };
    const draw = (time: number) => {
      if (disposed) return;
      frame = requestAnimationFrame(draw);
      if (time - last < (quality === 'high' ? 16 : 32)) return;
      last = time;
      try {
        const s = live.current,
          lead = Math.max(0, ...s.positions) * TRACK,
          progress = s.elapsed / s.duration;
        runners.forEach((r, i) => {
          const distance = (s.positions[i] ?? 0) * TRACK;
          r.root.position.x = distance;
          r.shadow.position.x = distance;
          const phase = (distance / (1.04 / CONTACT_FRACTION)) * STRIDE_SECONDS + i * 0.12;
          r.horse?.animate(phase, s.running);
          r.dog?.pose(s.elapsed / 500 + i * 0.2, s.running);
        });
        const wide = 1 - smooth((progress - 0.06) / 0.12),
          finish = smooth((progress - 0.72) / 0.2);
        const x = (lead + 9 + wide * 12) * (1 - finish) + (TRACK + 12) * finish;
        camera.position.set(x, 13 + wide * 15 - finish * 3, 25 + wide * 12);
        camera.lookAt(lead - 2, 1, 0);
        sun.position.x = lead + 30;
        sun.target.position.set(lead, 0, 0);
        renderer.render(scene, camera);
      } catch {
        setFailed(true);
        disposed = true;
        cancelAnimationFrame(frame);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      runners.forEach((r) => {
        r.horse?.dispose?.();
        r.dog?.dispose();
      });
      assets?.dispose();
      new Set(Object.values(resources).flat()).forEach((r) => r.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [dogs, quality]);
  return failed ? (
    <>{fallback}</>
  ) : (
    <div
      ref={host}
      className="tg-live-race-canvas"
      data-runners={dogs ? 'greyhounds' : authored ? 'authored-rigs' : 'procedural-loading'}
      aria-hidden="true"
    />
  );
}
