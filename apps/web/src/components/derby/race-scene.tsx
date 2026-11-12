import { useEffect, useRef, useState } from 'react';
import type { DerbyRound } from '@socialplay/shared';
import { DERBY_HORSES } from '@socialplay/shared';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createBroadcastDirector, type DerbyCameraMode } from './broadcast-camera';
import { createDerbyNumberLayout } from './number-layout';
import { createRaceMotion } from './race-motion';
import { createHorse } from './horse-model';
import {
  COURSE_LENGTH,
  courseX,
  createRacecourse,
  laneZ,
  RUNNER_GROUND_Y,
  type Racecourse,
} from './racecourse';
import {
  createRiggedHorse,
  loadHorseAssets,
  prepareHorseAssets,
  type HorseAssets,
  type RaceHorse,
} from './rigged-horse';
import { runnerLook } from './runner-identity';
import { createStrideClock } from './stride-clock';
import { createFrameGovernor } from '../dog-racing/frame-governor';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export type { DerbyCameraMode };
type Quality = 'high' | 'balanced' | 'low';
/** Drawing-buffer pixel budgets: phones stay sharp at a bounded cost. */
const PIXEL_BUDGET: Record<Quality, number> = { high: 1_150_000, balanced: 380_000, low: 220_000 };
const FRAME_MS: Record<Quality, number> = { high: 16, balanced: 33, low: 33 };
/** Standing runners breathe at a lower rate while waiting at the stalls. */
const STANDING_FRAME_MS = 50;
const NUMBER_HEIGHT = 3.6;

export function derbyPixelRatio(quality: Quality, width: number, height: number, device: number) {
  const fit = Math.sqrt(PIXEL_BUDGET[quality] / Math.max(1, width * height));
  return Math.max(quality === 'low' ? 0.75 : 1, Math.min(device, 2.5, fit));
}

/** Locally hosted CC0 rigs, an original racecourse and server-authoritative race progress. */
export default function RaceScene({
  round,
  running,
  reduced,
  synchronized = false,
  quality,
  fallback,
  cameraMode = 'trackside',
  adaptive = false,
  onSlow,
}: {
  round: Pick<DerbyRound, 'id' | 'field' | 'positions'> & { order?: number[] | null };
  running: boolean;
  reduced: boolean;
  synchronized?: boolean;
  quality?: Quality;
  fallback?: React.ReactNode;
  cameraMode?: DerbyCameraMode;
  /** Automatic quality: adapt resolution to measured frame times and report overload. */
  adaptive?: boolean;
  /** Called when the scene stays overloaded at its lowest resolution (Automatic only). */
  onSlow?: () => void;
}) {
  const { t: translateUi } = useInterfaceLanguage();

  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ round, running, reduced, synchronized, cameraMode, adaptive, onSlow });
  live.current = { round, running, reduced, synchronized, cameraMode, adaptive, onSlow };
  const [failed, setFailed] = useState(false);
  const [authored, setAuthored] = useState(false);
  const [contextRevision, setContextRevision] = useState(0);
  const tier: Quality = quality ?? 'balanced';
  useEffect(() => {
    if (!host.current) return;
    setAuthored(false);
    setFailed(false);
    const container = host.current;
    const density = derbyPixelRatio(
      tier,
      container.clientWidth,
      container.clientHeight,
      window.devicePixelRatio || 1
    );
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        // Multisampling is skipped where pixel density already smooths edges (phones).
        antialias: tier === 'high' || (tier === 'balanced' && density < 1.5),
        alpha: false,
        powerPreference: 'low-power',
      });
    } catch {
      setFailed(true);
      return;
    }
    renderer.shadowMap.enabled = tier !== 'low';
    renderer.shadowMap.type = tier === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.insertBefore(renderer.domElement, container.firstChild);
    container.dataset.renderTier = tier;
    let disposed = false;
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
    const camera = new THREE.PerspectiveCamera(36, 1, 0.3, 3000);
    const materials: THREE.Material[] = [];
    const geometries: THREE.BufferGeometry[] = [];
    const textures: THREE.Texture[] = [];
    let course: Racecourse;
    try {
      course = createRacecourse(scene, { quality: tier, renderer, field: round.field });
    } catch {
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.domElement.removeEventListener('webglcontextrestored', restored);
      renderer.dispose();
      renderer.domElement.remove();
      setFailed(true);
      return;
    }
    const director = createBroadcastDirector(course.obstacles);
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
    const looks = Array.from({ length: round.field }, (_, i) => runnerLook(i));
    const numbers: THREE.Sprite[] = [];
    const horses: RaceHorse[] = Array.from({ length: round.field }, (_, i) => {
      const horse = createHorse(
        looks[i].coat.base,
        DERBY_HORSES[i].color,
        i,
        { materials, geometries, textures },
        mergeStatic
      );
      const { root } = horse;
      scene.add(root);
      // A crisp broadcast badge: the runner's cloth colour, legible ink and a dark
      // keyline so it reads against sky, turf and silks alike. Not tone-mapped.
      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = 128;
      labelCanvas.height = 128;
      const ctx = labelCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'rgba(12,18,16,0.92)';
        ctx.beginPath();
        ctx.arc(64, 64, 62, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = looks[i].cloth;
        ctx.beginPath();
        ctx.arc(64, 64, 53, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(255,250,236,0.95)';
        ctx.stroke();
        ctx.fillStyle = looks[i].ink;
        ctx.font = '900 84px system-ui, -apple-system, Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), 64, 70);
      }
      const texture = new THREE.CanvasTexture(labelCanvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.push(texture);
      const labelMat = new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      });
      materials.push(labelMat);
      const label = new THREE.Sprite(labelMat);
      label.name = `runner-number-${i + 1}`;
      label.renderOrder = 10;
      label.position.set(0, NUMBER_HEIGHT, 0);
      label.scale.set(1.6, 1.6, 1);
      root.add(label);
      numbers.push(label);
      // The track box top is the gait's local ground datum.
      root.position.set(0, RUNNER_GROUND_Y, laneZ(i, round.field));
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
      opacity: 0.8,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
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
    const numberLayout = createDerbyNumberLayout();
    function placeNumbers(dt: number) {
      const width = container.clientWidth,
        height = container.clientHeight;
      if (!width || !height) return;
      const pixels = horses.map((horse, i) => {
        anchors[i].set(0, NUMBER_HEIGHT, 0);
        horse.root.localToWorld(anchors[i]);
        projections[i].copy(anchors[i]).project(camera);
        return {
          x: ((projections[i].x + 1) * width) / 2,
          y: ((1 - projections[i].y) * height) / 2,
        };
      });
      const badges = numberLayout.update(pixels, width, height, dt);
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
      .then(async (loaded) => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        assets = loaded;
        try {
          // Fit contacts and tack in slices so the fallback keeps racing meanwhile.
          await prepareHorseAssets(loaded);
        } catch {
          /* createRiggedHorse falls back to a synchronous fit. */
        }
        if (disposed) return; // Cleanup already released `assets`.
        const replacements: RaceHorse[] = [];
        try {
          for (let i = 0; i < horses.length; i++)
            replacements.push(
              createRiggedHorse(loaded, looks[i].coat, looks[i].silks, i, {
                look: looks[i],
                quality: tier,
                environment: course.environment,
              })
            );
        } catch {
          replacements.forEach((horse) => horse.dispose?.());
          loaded.dispose();
          assets = undefined;
          return; // Keep the complete procedural fallback if a model is unavailable.
        }
        replacements.forEach((horse, i) => {
          const previous = horses[i];
          // The procedural fallback bounces its entire root, while the authored
          // rig carries vertical gait in its bones. Preserve displayed progress
          // and lane only; adopting its temporary root Y would float the hooves.
          horse.root.position.set(
            previous.root.position.x,
            RUNNER_GROUND_Y,
            previous.root.position.z
          );
          const label = previous.root.children.find((child) => child instanceof THREE.Sprite);
          if (label) horse.root.add(label);
          scene.remove(previous.root);
          scene.add(horse.root);
          horses[i] = horse;
        });
        setAuthored(true);
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
      gradient.addColorStop(0, `rgba(20,18,12,${tier === 'low' ? 0.42 : 0.26})`);
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
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    materials.push(contactMaterial);
    const contactGeometry = new THREE.PlaneGeometry(4.6, 1.7);
    geometries.push(contactGeometry);
    const contacts = horses.map((horse) => {
      const contact = new THREE.Mesh(contactGeometry, contactMaterial);
      contact.rotation.x = -Math.PI / 2;
      contact.position.set(0, RUNNER_GROUND_Y + 0.006, horse.root.position.z);
      contact.renderOrder = 1;
      scene.add(contact);
      return contact;
    });
    // Measured frame delivery drives resolution in Automatic mode (see frame-governor).
    const governor = createFrameGovernor({
      targetMs: FRAME_MS[tier] === 16 ? 1000 / 60 : 1000 / 30,
    });
    let baseRatio = 1,
      appliedScale = 1,
      settleGovernor = true,
      lastActive = false;
    const applyScale = (scale: number) => {
      appliedScale = scale;
      renderer.setPixelRatio(baseRatio * scale);
      container.dataset.renderScale = scale.toFixed(2);
    };
    let frame = 0,
      last = 0,
      freshFraming = true,
      visible = true;
    let displayed = round.positions.map(courseX);
    let sampleMotion = createRaceMotion(displayed);
    let renderedRound = round.id;
    let strides = horses.map(() => createStrideClock());
    const resize = () => {
      const w = container.clientWidth,
        h = container.clientHeight;
      if (!w || !h) return;
      baseRatio = derbyPixelRatio(tier, w, h, window.devicePixelRatio || 1);
      renderer.setSize(w, h);
      applyScale(live.current.adaptive ? governor.scale : 1);
      settleGovernor = true;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      numberLayout.reset();
      freshFraming = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    // Stop drawing while the course is scrolled out of view.
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            visible = entries.some((e) => e.isIntersecting);
          });
    io?.observe(container);
    resize();
    const draw = (time: number) => {
      if (disposed) return;
      frame = requestAnimationFrame(draw);
      const state = live.current,
        moving = state.running && !state.reduced;
      const interval = state.reduced
        ? 1000
        : state.running || director.moving()
          ? FRAME_MS[tier]
          : STANDING_FRAME_MS;
      if (document.hidden || !visible || time - last < interval) return;
      const dt = last ? Math.min(0.25, (time - last) / 1000) : 0;
      if (settleGovernor) {
        governor.reset(time);
        settleGovernor = false;
      }
      // Only consecutive full-rate frames are evidence about this device's capacity.
      const active = moving;
      if (state.adaptive && active && lastActive && last) {
        const decision = governor.sample(time - last, time);
        if (decision?.scale) applyScale(decision.scale);
        if (decision?.tier === 'down') state.onSlow?.();
      } else if (!state.adaptive && appliedScale !== 1) applyScale(1);
      lastActive = active;
      last = time;
      try {
        // Reuse the scene and GPU resources across rounds. Reset only interpolation.
        if (renderedRound !== state.round.id) {
          renderedRound = state.round.id;
          displayed = state.round.positions.map(courseX);
          sampleMotion = createRaceMotion(displayed);
          strides = horses.map(() => createStrideClock());
          numberLayout.reset();
          director.reset();
          freshFraming = true;
        }
        const previous = displayed;
        const published = state.round.positions.map(courseX);
        displayed = state.synchronized ? published : sampleMotion(time, published, !moving);
        const idleSeconds = state.reduced ? 0 : time / 1000;
        horses.forEach((horse, i) => {
          horse.root.position.x = displayed[i];
          contacts[i].position.x = displayed[i] - 0.15;
          // Keep the running pose across polling jitter. Travel controls gait phase;
          // stale data, reduced motion and round status still stop the presentation.
          const travelled = displayed[i] - previous[i];
          const phase = strides[i](travelled, moving);
          const progress = displayed[i] / COURSE_LENGTH;
          // Riders push in the closing stages and sit still once past the post.
          const drive = progress < 1 ? THREE.MathUtils.smoothstep(progress, 0.6, 0.92) : 0;
          horse.animate(phase, moving && travelled > 0.0001, { idle: idleSeconds, drive });
        });
        const framed = director.update(
          camera,
          state.cameraMode,
          {
            positions: displayed,
            field: round.field,
            running: state.running,
            finished: !!state.round.order?.length,
            reduced: state.reduced,
            time: time / 1000,
          },
          state.reduced || freshFraming ? 0 : dt
        );
        freshFraming = false;
        if (container.dataset.camera !== framed.shot) container.dataset.camera = framed.shot;
        course.update({
          center: framed.center,
          spread: Math.max(...displayed) - Math.min(...displayed) + 6,
          camera,
          time: idleSeconds,
          field: round.field,
          gateOpen: state.running || Math.max(...displayed) > 3,
        });
        placeNumbers(state.reduced ? 0 : dt);
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
      io?.disconnect();
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
      course.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [round.field, contextRevision, tier]);
  return (
    <div
      className="derby-scene"
      data-runners={authored ? 'authored-rigs' : 'procedural'}
      data-adaptive={adaptive ? 'true' : 'false'}
      ref={host}
      aria-label={translateUi(
        'Three-dimensional horse race. Official finishing order appears above.'
      )}
      role="img"
    >
      {failed &&
        (fallback ?? (
          <div className="derby-scene-fallback">
            {translateUi(
              '3D view unavailable on this device. Follow the numbered race progress and official results above.'
            )}{' '}
            <button type="button" onClick={() => setContextRevision((r) => r + 1)}>
              {translateUi('Retry 3D view')}
            </button>
          </div>
        ))}
    </div>
  );
}
