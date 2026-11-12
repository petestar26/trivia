import { useEffect, useRef, useState } from 'react';
import { RACING_DOGS, type DerbyRound } from '@socialplay/shared';
import * as THREE from 'three';
import { trackPoint } from './track';
import { createRaceMotion } from '../derby/race-motion';
import { dogLapProgress, type DogProgressMode } from './progress';
import { createRaceWorld, laneOffset } from './world';
import { createCameraRig, type DogCamera } from './camera';
import { createFrameGovernor } from './frame-governor';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export type { DogCamera };
type Quality = 'high' | 'balanced' | 'low';
/** Drawing-buffer pixel budgets: phones get a sharp image at the same cost as a desktop. */
const PIXEL_BUDGET: Record<Quality, number> = { high: 1_100_000, balanced: 360_000, low: 220_000 };
const FRAME_MS: Record<Quality, number> = { high: 16, balanced: 32, low: 32 };

export function pixelRatioFor(quality: Quality, width: number, height: number, device: number) {
  const fit = Math.sqrt(PIXEL_BUDGET[quality] / Math.max(1, width * height));
  return Math.max(quality === 'low' ? 0.75 : 1, Math.min(device, 2.5, fit));
}

export default function DogRaceScene({
  round,
  running,
  reduced,
  cameraMode = 'trackside',
  synchronized = false,
  progressMode = 'solo',
  quality,
  adaptive = false,
  onSlow,
}: {
  round: Pick<DerbyRound, 'id' | 'field' | 'positions' | 'order'>;
  running: boolean;
  reduced: boolean;
  cameraMode?: DogCamera;
  synchronized?: boolean;
  progressMode?: DogProgressMode;
  quality?: Quality;
  /** Automatic quality: adapt resolution to measured frame times and report overload. */
  adaptive?: boolean;
  /** Called when the scene stays overloaded at its lowest resolution (Auto only). */
  onSlow?: () => void;
}) {
  const { t: translateUi } = useInterfaceLanguage();
  const tier: Quality = quality ?? 'balanced';
  const host = useRef<HTMLDivElement>(null),
    tags = useRef<HTMLDivElement>(null),
    live = useRef({
      round,
      running,
      reduced,
      cameraMode,
      synchronized,
      progressMode,
      adaptive,
      onSlow,
    });
  live.current = {
    round,
    running,
    reduced,
    cameraMode,
    synchronized,
    progressMode,
    adaptive,
    onSlow,
  };
  const [failed, setFailed] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!host.current) return;
    setFailed(false);
    let renderer: THREE.WebGLRenderer;
    // Multisampling is skipped on Balanced where the pixel density is already high
    // (phones): there it cost about a third of the frame for little visible gain.
    const density = pixelRatioFor(
      tier,
      host.current.clientWidth,
      host.current.clientHeight,
      window.devicePixelRatio || 1
    );
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: tier === 'high' || (tier === 'balanced' && density < 1.5),
        powerPreference: 'low-power',
      });
    } catch {
      setFailed(true);
      return;
    }
    const container = host.current;
    container.insertBefore(renderer.domElement, container.firstChild);
    renderer.shadowMap.enabled = tier !== 'low';
    // Soft filtering only on High; Balanced uses the cheaper hardware PCF lookup.
    renderer.shadowMap.type = tier === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.4, 600);
    let world: ReturnType<typeof createRaceWorld>;
    try {
      world = createRaceWorld(scene, { quality: tier, renderer });
    } catch {
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      setFailed(true);
      return;
    }
    const rig = createCameraRig();
    const chipOffset = new Float32Array(16);
    // Measured frame delivery drives resolution in Automatic mode (see frame-governor).
    const governor = createFrameGovernor({
      targetMs: FRAME_MS[tier] === 16 ? 1000 / 60 : 1000 / 30,
    });
    let width = 0,
      height = 0,
      baseRatio = 1,
      appliedScale = 1,
      settleGovernor = true;
    container.dataset.renderTier = tier;
    const applyScale = (scale: number) => {
      appliedScale = scale;
      renderer.setPixelRatio(baseRatio * scale);
      container.dataset.renderScale = scale.toFixed(2);
    };
    const resize = () => {
      const w = container.clientWidth,
        h = container.clientHeight;
      if (!w || !h) return;
      width = w;
      height = h;
      baseRatio = pixelRatioFor(tier, w, h, window.devicePixelRatio || 1);
      renderer.setSize(w, h);
      applyScale(live.current.adaptive ? governor.scale : 1);
      settleGovernor = true;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      wake();
    };
    let disposed = false,
      visible = true,
      lastTime = 0,
      lastActive = false,
      raf = 0,
      priorRound = '',
      motion = createRaceMotion(live.current.round.positions);
    const fail = () => {
      disposed = true;
      setFailed(true);
      cancelAnimationFrame(raf);
    };
    const lost = (event: Event) => {
      event.preventDefault();
      fail();
    };
    const restored = () => setRevision((v) => v + 1);
    renderer.domElement.addEventListener('webglcontextlost', lost);
    renderer.domElement.addEventListener('webglcontextrestored', restored);
    const anchor = new THREE.Vector3();
    // Nearby slots a chip may take when its own spot is taken, nearest first; upward
    // slots are preferred so numbers stay above the runners.
    const SLOTS: number[][] = [];
    for (let sy = -3; sy <= 2; sy++) for (let sx = -3; sx <= 3; sx++) SLOTS.push([sx, sy]);
    SLOTS.sort(
      (a, b) =>
        Math.hypot(a[0], a[1] < 0 ? a[1] * 0.95 : a[1] * 1.3) -
        Math.hypot(b[0], b[1] < 0 ? b[1] * 0.95 : b[1] * 1.3)
    );
    const CHIP_W = 22,
      CHIP_H = 20;
    function placeChips(views: ReturnType<typeof world.update>['views']) {
      // Project each runner's number above its head, then move overlapping chips to the
      // nearest free slot inside the course view, so a bunched field forms a compact,
      // fully visible cluster instead of a tower that runs off the top.
      const chips = (tags.current?.children ?? []) as HTMLCollectionOf<HTMLElement>;
      const placed: { x: number; y: number }[] = [];
      // Project with this frame's camera even if the renderer has not refreshed it.
      camera.updateMatrixWorld();
      const order = views
        .map((v) => {
          anchor.set(v.x, 1.7, v.z).project(camera);
          return {
            v,
            x: (anchor.x * 0.5 + 0.5) * width,
            y: (0.5 - anchor.y * 0.5) * height,
            z: anchor.z,
          };
        })
        .sort((a, b) => b.y - a.y);
      const inside = (x: number, y: number) =>
        y - CHIP_H >= 2 && y <= height - 2 && x >= CHIP_W / 2 + 2 && x <= width - CHIP_W / 2 - 2;
      const free = (x: number, y: number) =>
        !placed.some((p) => Math.abs(p.x - x) < CHIP_W - 1 && Math.abs(p.y - y) < CHIP_H - 1);
      for (const item of order) {
        const i = item.v.index,
          chip = chips[i];
        if (!chip) continue;
        const show = item.v.visible && item.z < 1 && item.x > -20 && item.x < width + 20;
        chip.style.visibility = show ? 'visible' : 'hidden';
        if (!show) continue;
        const x0 = Math.min(width - CHIP_W / 2 - 2, Math.max(CHIP_W / 2 + 2, item.x)),
          y0 = Math.min(height - 2, Math.max(CHIP_H + 2, item.y));
        const slot =
          SLOTS.find(([sx, sy]) => {
            const x = x0 + sx * CHIP_W,
              y = y0 + sy * CHIP_H;
            return inside(x, y) && free(x, y);
          }) ?? SLOTS[0];
        // Ease between slots so chips do not flicker as runners swap places.
        chipOffset[i * 2] += (slot[0] * CHIP_W - chipOffset[i * 2]) * 0.35;
        chipOffset[i * 2 + 1] += (slot[1] * CHIP_H - chipOffset[i * 2 + 1]) * 0.35;
        const x = x0 + chipOffset[i * 2],
          y = y0 + chipOffset[i * 2 + 1];
        placed.push({ x: x0 + slot[0] * CHIP_W, y: y0 + slot[1] * CHIP_H });
        // The published lap the runner is drawn at, for synchronisation checks.
        chip.dataset.lap = item.v.lap.toFixed(4);
        chip.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      }
    }
    function animate(time: number) {
      if (disposed) return;
      raf = 0;
      if (!visible || document.hidden) return;
      raf = requestAnimationFrame(animate);
      const state = live.current,
        r = state.round;
      const idle = !state.running && !rig.moving();
      const active = !(state.reduced || idle);
      const interval = active ? FRAME_MS[tier] : 100;
      if (time - lastTime < interval) return;
      const dt = Math.min(0.25, lastTime ? (time - lastTime) / 1000 : 1 / 30);
      if (settleGovernor) {
        governor.reset(time);
        settleGovernor = false;
      }
      // Only consecutive full-rate frames are evidence about this device's capacity.
      if (state.adaptive && active && lastActive && lastTime) {
        const decision = governor.sample(time - lastTime, time);
        if (decision?.scale) applyScale(decision.scale);
        if (decision?.tier === 'down') state.onSlow?.();
      } else if (!state.adaptive && appliedScale !== 1) applyScale(1);
      lastTime = time;
      lastActive = active;
      if (priorRound !== r.id) {
        priorRound = r.id;
        motion = createRaceMotion(r.positions);
        world.reset();
        rig.reset();
      }
      const positions = state.synchronized
        ? r.positions
        : motion(time, r.positions, state.reduced || !!r.order || !state.running);
      const laps = positions.map((p) => dogLapProgress(p || 0, state.progressMode));
      const result = world.update({
        laps,
        field: r.field,
        running: state.running,
        reduced: state.reduced,
        dt,
        time: time / 1000,
      });
      rig.update(
        camera,
        state.cameraMode,
        {
          lead: result.lead,
          trail: result.trail,
          running: state.running,
          runners: result.views.filter((v) => v.visible),
        },
        dt,
        state.reduced
      );
      world.view(camera, renderer.domElement.height);
      try {
        renderer.render(scene, camera);
      } catch {
        fail();
        return;
      }
      placeChips(result.views);
    }
    function wake() {
      if (!disposed && !raf && visible && !document.hidden) {
        lastTime = 0;
        lastActive = false;
        raf = requestAnimationFrame(animate);
      }
    }
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    // Stop drawing entirely when the course is scrolled away or the tab is hidden.
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            visible = entries.some((e) => e.isIntersecting);
            wake();
          });
    io?.observe(container);
    document.addEventListener('visibilitychange', wake);
    resize();
    wake();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io?.disconnect();
      document.removeEventListener('visibilitychange', wake);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.domElement.removeEventListener('webglcontextrestored', restored);
      world.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [revision, tier]);
  return (
    <div
      ref={host}
      className="hounds-scene"
      role="img"
      aria-label={translateUi('Animated greyhounds on the Salem oval racecourse')}
    >
      {!failed && (
        <div ref={tags} className="hounds-scene-tags" aria-hidden="true">
          {RACING_DOGS.map((dog, i) => (
            <span
              key={dog.name}
              style={{ background: dog.color, color: dog.ink, visibility: 'hidden' }}
            >
              {i + 1}
            </span>
          ))}
        </div>
      )}
      {failed && (
        <div className="hounds-scene-fallback">
          <svg
            viewBox="-90 -45 180 90"
            aria-label={translateUi('Published runner positions on the oval track')}
            role="img"
          >
            <rect x="-90" y="-45" width="180" height="90" fill="#263f30" />
            <path
              d="M -48 23 H 48 A 23 23 0 0 0 48 -23 H -48 A 23 23 0 0 0 -48 23"
              fill="none"
              stroke="#bca07a"
              strokeWidth="12"
            />
            <path
              d="M -48 30 H 48 A 30 30 0 0 0 48 -30 H -48 A 30 30 0 0 0 -48 30"
              fill="none"
              stroke="#e8e5d7"
              strokeWidth=".6"
            />
            <path d="M -48 17 V 29" stroke="#fff" strokeWidth="1" />
            <text x="0" y="1" textAnchor="middle" fill="#d6e2d3" fontSize="5" letterSpacing="1">
              {translateUi('SALEM OVAL')}
            </text>
            {RACING_DOGS.slice(0, round.field).map((dog, i) => {
              const p = trackPoint(
                dogLapProgress(round.positions[i] || 0, progressMode),
                laneOffset(i, round.field)
              );
              return (
                <g key={dog.name} transform={`translate(${p.x} ${p.z})`}>
                  <circle r="2.7" fill={dog.color} stroke="#fff" strokeWidth=".4" />
                  <text textAnchor="middle" y="1" fontSize="3" fontWeight="bold" fill={dog.ink}>
                    {i + 1}
                  </text>
                </g>
              );
            })}
          </svg>
          <p role="status">{translateUi('Track view · 3D graphics unavailable on this device')}</p>
        </div>
      )}
    </div>
  );
}
