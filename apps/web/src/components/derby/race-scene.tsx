import { useEffect, useRef, useState } from 'react';
import type { DerbyRound } from '@socialplay/shared';
import { DERBY_HORSES } from '@socialplay/shared';
import * as THREE from 'three';
import { backdropSize } from './backdrop-fit';
import { createRaceMotion } from './race-motion';
import { createHorse } from './horse-model';
import { createStrideClock } from './stride-clock';
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
  const [contextRevision, setContextRevision] = useState(0);
  useEffect(() => {
    if (!host.current) return;
    setFailed(false);
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
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);
    const lost = (event: Event) => {
      event.preventDefault();
      disposed = true;
      setFailed(true);
    };
    const restored = () => {
      // Recreate GPU resources after the browser restores its context.
      if (disposed) setContextRevision((revision) => revision + 1);
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    renderer.domElement.addEventListener('webglcontextrestored', restored);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#bad1dc');
    scene.fog = new THREE.Fog('#d5d5bf', 80, 280);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
    scene.add(new THREE.HemisphereLight('#e4eff6', '#586333', 1.25));
    const sun = new THREE.DirectionalLight('#fff0d4', 2.7);
    sun.position.set(30, 40, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.normalBias = 0.025;
    sun.shadow.bias = -0.00015;
    sun.shadow.camera.left = -25;
    sun.shadow.camera.right = 25;
    sun.shadow.camera.top = 25;
    sun.shadow.camera.bottom = -25;
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
    const turf = mat('#bac89c'),
      sand = mat('#aaba80'),
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
    sand.map = surfaceTexture(true);
    sand.map.repeat.set(80, 8);
    box(scene, 80, -0.25, 0, 1000, 0.5, 500, turf);
    box(scene, 85, 0.01, 0, 280, 0.05, 20, sand);
    for (let i = -20; i < 240; i += 4) {
      for (const z of [-10.5, 10.5]) {
        box(scene, i, 0.8, z, 0.12, 1.6, 0.12, white);
        box(scene, i, 1.35, z, 4, 0.11, 0.12, white);
        box(scene, i, 0.9, z, 4, 0.09, 0.1, white);
      }
    }

    // Original sunlit racecourse artwork sits behind the real geometry. It is
    // decorative only; progress, runners and finish remain server-fed 3D objects.
    let disposed = false;
    const backdropMat = new THREE.MeshBasicMaterial({ color: '#ffffff', fog: false });
    materials.push(backdropMat);
    const backdrop = mesh(scene, new THREE.PlaneGeometry(200, 66.67), backdropMat, 90, 16, -65);
    backdrop.castShadow = backdrop.receiveShadow = false;
    const backgroundTexture = new THREE.TextureLoader().load(
      '/art/ruby-grand/derby-racecourse.webp',
      (texture) => {
        if (disposed) texture.dispose();
        else backdrop.visible = true;
      },
      undefined,
      () => {
        backdrop.visible = false;
      }
    );
    backdrop.visible = false;
    backgroundTexture.colorSpace = THREE.SRGBColorSpace;
    backdropMat.map = backgroundTexture;
    textures.push(backgroundTexture);
    // Nearby hedge and rail retain parallax as the camera tracks the field.
    for (let i = -20; i < 240; i += 3) {
      box(scene, i, 0.55, -16, 3, 1.1, 1.5, mat('#526a2e'));
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
      const horse = createHorse(
        coats[i],
        DERBY_HORSES[i].color,
        i,
        { materials, geometries, textures },
        mergeStatic
      );
      const { root } = horse;
      scene.add(root);
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
      return horse;
    });
    // Soft contact shadows anchor each horse to the turf between moving leg shadows.
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 64;
    const shadowContext = shadowCanvas.getContext('2d');
    if (shadowContext) {
      const gradient = shadowContext.createRadialGradient(32, 32, 2, 32, 32, 31);
      gradient.addColorStop(0, 'rgba(20,18,12,0.32)');
      gradient.addColorStop(1, 'rgba(20,18,12,0)');
      shadowContext.fillStyle = gradient;
      shadowContext.fillRect(0, 0, 64, 64);
    }
    const contactTexture = new THREE.CanvasTexture(shadowCanvas);
    textures.push(contactTexture);
    const contactMaterial = new THREE.MeshBasicMaterial({
      map: contactTexture,
      transparent: true,
      depthWrite: false,
    });
    materials.push(contactMaterial);
    const contactGeometry = new THREE.PlaneGeometry(4.5, 1.8);
    geometries.push(contactGeometry);
    const contacts = horses.map((horse) => {
      const contact = new THREE.Mesh(contactGeometry, contactMaterial);
      contact.rotation.x = -Math.PI / 2;
      contact.position.set(0, 0.047, horse.root.position.z);
      scene.add(contact);
      return contact;
    });
    let frame = 0,
      last = 0;
    let displayed = round.positions.map((p) => p * 180);
    let sampleMotion = createRaceMotion(displayed);
    let renderedRound = round.id;
    const lastTravel = horses.map(() => -Infinity);
    let strides = horses.map(() => createStrideClock());
    let fittedAspect = Number.NaN;
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
      if (disposed) return;
      frame = requestAnimationFrame(draw);
      if (document.hidden || time - last < 33) return;
      last = time;
      const state = live.current,
        moving = state.running && !state.reduced;
      // Reuse the scene and GPU resources across rounds. Reset only interpolation.
      if (renderedRound !== state.round.id) {
        renderedRound = state.round.id;
        displayed = state.round.positions.map((p) => p * 180);
        sampleMotion = createRaceMotion(displayed);
        strides = horses.map(() => createStrideClock());
        lastTravel.fill(-Infinity);
      }
      const previous = displayed;
      displayed = sampleMotion(
        time,
        state.round.positions.map((p) => p * 180),
        !moving
      );
      horses.forEach((horse, i) => {
        horse.root.position.x = displayed[i];
        contacts[i].position.x = displayed[i];
        if (Math.abs(displayed[i] - previous[i]) > 0.00001) lastTravel[i] = time;
        // Brief polling jitter must not switch the rig to a standing pose each update.
        horse.animate(
          strides[i](displayed[i] - previous[i], moving),
          moving && time - lastTravel[i] < 400
        );
      });
      const lead = Math.max(...displayed),
        center = lead - 3;
      camera.position.set(center + 8, 6.2, camera.aspect < 1.2 ? 26 : round.field === 8 ? 21 : 18);
      camera.lookAt(center, 2.2, 0);
      backdrop.position.x = center - 35;
      if (fittedAspect !== camera.aspect) {
        const size = backdropSize(camera, backdrop.position);
        backdrop.scale.set(size.width / 200, size.height / 66.67, 1);
        backdrop.position.y = size.centerY;
        fittedAspect = camera.aspect;
      }
      sun.position.set(center + 30, 40, 20);
      sun.target.position.set(center, 0, 0);
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.domElement.removeEventListener('webglcontextrestored', restored);
      renderer.dispose();
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      renderer.domElement.remove();
    };
  }, [round.field, contextRevision]);
  return (
    <div
      className="derby-scene"
      ref={host}
      aria-label="Three-dimensional horse race. Official finishing order appears above."
      role="img"
    >
      {failed && (
        <div className="derby-scene-fallback">
          3D view unavailable on this device. Follow the numbered race progress and official results
          above.
        </div>
      )}
    </div>
  );
}
