import { useEffect, useRef, useState } from 'react';
import type { DerbyRound } from '@socialplay/shared';
import { DERBY_HORSES } from '@socialplay/shared';
import * as THREE from 'three';
import { backdropSize } from './backdrop-fit';
import { frameDerbyField } from './field-camera';
import { layoutDerbyNumbers } from './number-layout';
import { createRaceMotion } from './race-motion';
import { createHorse } from './horse-model';
import {
  createRiggedHorse,
  loadHorseAssets,
  type HorseAssets,
  type RaceHorse,
} from './rigged-horse';
import { createStrideClock } from './stride-clock';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Locally hosted CC0 rigs, original racecourse and server-authoritative race progress. */
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
    scene.background = new THREE.Color('#c3d5dc');
    scene.fog = new THREE.Fog('#dce3d6', 72, 245);
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 2000);
    scene.add(new THREE.HemisphereLight('#e4eff6', '#788064', 1.25));
    // A broad unshadowed fill reveals the dark coats/rider silhouettes without
    // adding another shadow map, geometry or per-runner light.
    const fill = new THREE.DirectionalLight('#e3edf5', 0.85);
    fill.position.set(-15, 18, 24);
    scene.add(fill, fill.target);
    const sun = new THREE.DirectionalLight('#fff0d4', 2.35);
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
    const turf = mat('#bfcba7', 0.96),
      sand = mat('#d9debd', 0.94),
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
      texture.repeat.set(grass ? 90 : 45, grass ? 45 : 4);
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
    // The distant artwork shares the scene's atmospheric depth rather than
    // presenting a sharper, brighter surface than the nearby animated rigs.
    const backdropMat = new THREE.MeshBasicMaterial({ color: '#dce3d6', fog: true });
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
    const numbers: THREE.Sprite[] = [];
    const horses: RaceHorse[] = Array.from({ length: round.field }, (_, i) => {
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
        ctx.arc(64, 64, 54, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 5;
        ctx.strokeStyle = '#fff4da';
        ctx.stroke();
        const color = new THREE.Color(DERBY_HORSES[i].color);
        ctx.fillStyle =
          color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722 < 0.35 ? '#fff8e6' : '#111820';
        ctx.font = '900 90px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), 64, 67);
      }
      const texture = new THREE.CanvasTexture(labelCanvas);
      textures.push(texture);
      const labelMat = new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        depthWrite: false,
      });
      materials.push(labelMat);
      const label = new THREE.Sprite(labelMat);
      label.name = `runner-number-${i + 1}`;
      label.renderOrder = 10;
      label.position.set(0, 3.45, 0);
      label.scale.set(1.6, 1.6, 1);
      root.add(label);
      numbers.push(label);
      // The track box is centred at .01 with .05 height. The gait's local
      // ground datum is zero, so lift the complete runner to its .035 top.
      root.position.set(0, 0.035, (i - (round.field - 1) / 2) * 2.15);
      return horse;
    });
    // One stable dynamic buffer for all number leaders, shared in both the
    // authored and procedural presentations. No per-frame geometry/texture work.
    const leaderPositions = new Float32Array(round.field * 6);
    const leaderGeometry = new THREE.BufferGeometry();
    const leaderAttribute = new THREE.BufferAttribute(leaderPositions, 3).setUsage(
      THREE.DynamicDrawUsage
    );
    leaderGeometry.setAttribute('position', leaderAttribute);
    geometries.push(leaderGeometry);
    const leaderMaterial = new THREE.LineBasicMaterial({
      color: '#fff3d5',
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      depthWrite: false,
    });
    materials.push(leaderMaterial);
    const leaders = new THREE.LineSegments(leaderGeometry, leaderMaterial);
    leaders.name = 'runner-number-leaders';
    leaders.frustumCulled = false;
    leaders.renderOrder = 9;
    scene.add(leaders);
    const anchors = horses.map(() => new THREE.Vector3()),
      projections = horses.map(() => new THREE.Vector3());
    const worldPoint = new THREE.Vector3(),
      rootScale = new THREE.Vector3();
    function placeNumbers() {
      const width = container.clientWidth,
        height = container.clientHeight;
      if (!width || !height) return;
      const pixels = horses.map((horse, i) => {
        anchors[i].set(0, 3.45, 0);
        horse.root.localToWorld(anchors[i]);
        projections[i].copy(anchors[i]).project(camera);
        return {
          x: ((projections[i].x + 1) * width) / 2,
          y: ((1 - projections[i].y) * height) / 2,
        };
      });
      const badges = layoutDerbyNumbers(pixels, width, height);
      let changed = false;
      const write = (offset: number, point: THREE.Vector3) => {
        for (let k = 0; k < 3; k++) {
          const next = Math.fround(point.getComponent(k));
          if (leaderPositions[offset + k] !== next) {
            leaderPositions[offset + k] = next;
            changed = true;
          }
        }
      };
      badges.forEach((badge, i) => {
        const horse = horses[i],
          label = numbers[i],
          depth = projections[i].z;
        const viewDepth = -worldPoint.copy(anchors[i]).applyMatrix4(camera.matrixWorldInverse).z;
        const worldPixels =
          (2 * viewDepth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / height;
        worldPoint
          .set((badge.x / width) * 2 - 1, 1 - (badge.y / height) * 2, depth)
          .unproject(camera);
        label.position.copy(horse.root.worldToLocal(worldPoint));
        horse.root.getWorldScale(rootScale);
        label.scale.set(
          (badge.size * worldPixels) / rootScale.x,
          (badge.size * worldPixels) / rootScale.y,
          1
        );
        write(i * 6, anchors[i]);
        const dx = pixels[i].x - badge.x,
          dy = pixels[i].y - badge.y,
          distance = Math.hypot(dx, dy);
        if (distance <= badge.size / 2 + 2) write(i * 6 + 3, anchors[i]);
        else {
          const fraction = (badge.size * 0.45) / distance;
          worldPoint
            .set(
              ((badge.x + dx * fraction) / width) * 2 - 1,
              1 - ((badge.y + dy * fraction) / height) * 2,
              depth
            )
            .unproject(camera);
          write(i * 6 + 3, worldPoint);
        }
      });
      if (changed) leaderAttribute.needsUpdate = true;
    }
    let assets: HorseAssets | undefined;
    void loadHorseAssets()
      .then((loaded) => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        assets = loaded;
        const replacements: RaceHorse[] = [];
        try {
          for (let i = 0; i < horses.length; i++)
            replacements.push(createRiggedHorse(loaded, coats[i], DERBY_HORSES[i].color, i));
        } catch {
          replacements.forEach((horse) => horse.dispose?.());
          loaded.dispose();
          assets = undefined;
          return; // Keep the complete procedural fallback if a model is unavailable.
        }
        replacements.forEach((horse, i) => {
          const previous = horses[i];
          horse.root.position.copy(previous.root.position);
          const label = previous.root.children.find((child) => child instanceof THREE.Sprite);
          if (label) horse.root.add(label);
          scene.remove(previous.root);
          scene.add(horse.root);
          horses[i] = horse;
        });
      })
      .catch(() => {
        /* The already-rendered fallback remains usable offline. */
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
    let strides = horses.map(() => createStrideClock());
    let fittedDistance = Number.NaN;
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
      if (document.hidden || time - last < (live.current.reduced ? 1000 : 33)) return;
      const dt = last ? Math.min(0.25, (time - last) / 1000) : 0;
      last = time;
      try {
        const state = live.current,
          moving = state.running && !state.reduced;
        // Reuse the scene and GPU resources across rounds. Reset only interpolation.
        if (renderedRound !== state.round.id) {
          renderedRound = state.round.id;
          displayed = state.round.positions.map((p) => p * 180);
          sampleMotion = createRaceMotion(displayed);
          strides = horses.map(() => createStrideClock());
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
          // Keep the running pose across polling jitter. Travel controls gait phase;
          // stale data, reduced motion and round status still stop the presentation.
          const phase = strides[i](displayed[i] - previous[i], moving);
          horse.animate(phase, moving && displayed[i] - previous[i] > 0.0001);
        });
        const center = frameDerbyField(camera, displayed, round.field, state.reduced ? 0 : dt);
        backdrop.position.x = center - 35;
        if (fittedDistance !== camera.position.z || fittedAspect !== camera.aspect) {
          const size = backdropSize(camera, backdrop.position);
          backdrop.scale.set(size.width / 200, size.height / 66.67, 1);
          backdrop.position.y = size.centerY;
          backdrop.rotation.y = size.rotationY;
          fittedDistance = camera.position.z;
          fittedAspect = camera.aspect;
        }
        sun.position.set(center + 30, 40, 20);
        sun.target.position.set(center, 0, 0);
        fill.position.set(center - 15, 18, 24);
        fill.target.position.set(center, 1.2, 0);
        placeNumbers();
        renderer.render(scene, camera);
      } catch {
        disposed = true;
        cancelAnimationFrame(frame);
        setFailed(true);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.domElement.removeEventListener('webglcontextrestored', restored);
      horses.forEach((horse) => horse.dispose?.());
      assets?.dispose();
      // Keep renderer bookkeeping alive while its resource dispose listeners
      // release uploaded buffers, material textures and the owned shadow target.
      // renderer.dispose() clears WebGLProperties, making later texture events
      // unable to find the uploaded handles that still need gl.deleteTexture.
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      sun.shadow.dispose();
      renderer.dispose();
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
          above.{' '}
          <button type="button" onClick={() => setContextRevision((r) => r + 1)}>
            Retry 3D view
          </button>
        </div>
      )}
    </div>
  );
}
