import * as THREE from 'three';
import { statusAt } from '../../../lib/football/reveal';
import {
  ACTOR_COUNT,
  GOAL_SEQUENCE,
  PITCH,
  directorFrame,
  type Frame,
  type Mode,
  type ReleasedGoal,
} from './director';
import { createPlayerPool, type PlayerPool } from './players';
import { buildStadium, skyTexture, type Stadium } from './stadium';

/** Everything the renderer is allowed to know about a match: released facts only. */
export interface MatchInput {
  matchKey: string;
  homeClub: number;
  awayClub: number;
  goals: ReleasedGoal[];
  fullTime: { home: number; away: number } | null;
}
export interface EngineOptions {
  host: HTMLElement;
  /** Server-synchronised match clock in ms after kickoff (negative before kickoff). */
  getElapsed: () => number;
  reduced?: boolean;
  /** Called once when the ball crosses the line in a goal sequence (or at once for old goals). */
  onGoalMoment?: (n: number) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
  /** Scheduled rendering failed; the owner should replace the scene with its text fallback. */
  onRenderError?: (error: unknown) => void;
  /** Frame cap and pixel ratio cap. */
  maxFps?: number;
  maxPixelRatio?: number;
}
export interface Engine {
  canvas: HTMLCanvasElement;
  setMatch(match: MatchInput): void;
  setReduced(reduced: boolean): void;
  start(): void;
  stop(): void;
  /** Deterministic single-frame render (used by tests, the lab and capture scripts). */
  renderAt(elapsedMs: number, dt?: number): Frame;
  resize(): void;
  info(): { triangles: number; calls: number; geometries: number; textures: number };
  dispose(): void;
}

function ballTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f6f6f2';
  ctx.fillRect(0, 0, 128, 64);
  ctx.fillStyle = '#1b1d22';
  for (const [x, y] of [
    [16, 20],
    [48, 44],
    [80, 18],
    [112, 42],
    [64, 8],
    [32, 58],
    [100, 62],
  ] as const) {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      const px = x + Math.cos(a) * 9;
      const py = y + Math.sin(a) * 9;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createEngine(options: EngineOptions): Engine {
  const { host } = options;
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'default',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.maxPixelRatio ?? 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const sky = skyTexture();
  scene.background = sky;
  scene.fog = new THREE.Fog('#243a5e', 140, 420);
  scene.add(new THREE.HemisphereLight('#c7dcff', '#27402b', 1.15));
  const sun = new THREE.DirectionalLight('#fff3d9', 2.4);
  sun.position.set(24, 52, 36);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -34;
  sun.shadow.camera.right = 34;
  sun.shadow.camera.top = 34;
  sun.shadow.camera.bottom = -34;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 140;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const stadium: Stadium = buildStadium();
  scene.add(stadium.group);
  const pool: PlayerPool = createPlayerPool();
  scene.add(pool.group);

  const ballTex = ballTexture();
  const ballGeo = new THREE.SphereGeometry(0.11, 20, 14);
  const ballMat = new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.45 });
  const ball = new THREE.Mesh(ballGeo, ballMat);
  // Broadcast scale: the ball is drawn ~1.4x for legibility; physics and contact use the real 0.11 m.
  ball.scale.setScalar(1.4);
  ball.castShadow = true;
  scene.add(ball);

  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.5, 700);
  const camPos = new THREE.Vector3(0, 18, 58);
  const camLook = new THREE.Vector3(0, 0.9, 3);
  let camFov = 30;
  camera.position.copy(camPos);

  let match: MatchInput | null = null;
  let reduced = options.reduced ?? false;
  let rafId = 0;
  let timer = 0;
  let running = false;
  let disposed = false;
  let renderFailed = false;
  let last = 0;
  let lastMode: Mode | null = null;
  let lastBall: THREE.Vector3 | null = null;
  let teamsKey = '';
  const momentFired = new Set<string>();
  const netFired = new Set<string>();
  let visible = true;
  let renderedOnce = false;

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  observer?.observe(host);
  const intersection =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => (visible = entries.some((e) => e.isIntersecting)))
      : null;
  intersection?.observe(host);
  const lost = (event: Event) => {
    event.preventDefault();
    stop();
    options.onContextLost?.();
  };
  const restored = () => options.onContextRestored?.();
  renderer.domElement.addEventListener('webglcontextlost', lost);
  renderer.domElement.addEventListener('webglcontextrestored', restored);
  resize();

  function renderAt(elapsedMs: number, dt = 1 / 30): Frame {
    const m = match;
    if (!m) throw new Error('No match set');
    if (teamsKey !== `${m.homeClub}|${m.awayClub}`) {
      teamsKey = `${m.homeClub}|${m.awayClub}`;
      pool.setTeams(m.homeClub, m.awayClub);
    }
    const frame = directorFrame({
      matchKey: m.matchKey,
      elapsedMs,
      status: statusAt(elapsedMs),
      goals: m.goals,
      fullTime: m.fullTime,
    });
    pool.apply(frame, dt, elapsedMs / 1000, !reduced);
    ball.position.set(frame.ball.x, frame.ball.y, frame.ball.z);
    if (lastBall && !reduced) {
      const dx = frame.ball.x - lastBall.x;
      const dz = frame.ball.z - lastBall.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.0001 && d < 3)
        ball.rotateOnWorldAxis(new THREE.Vector3(dz / d, 0, -dx / d), d / 0.11);
    }
    lastBall = new THREE.Vector3(frame.ball.x, frame.ball.y, frame.ball.z);

    // Goal bookkeeping: net ripple once, moment callback once (also for goals already old).
    for (const goal of m.goals) {
      const key = `${m.matchKey}#${goal.n}`;
      const age = elapsedMs / 1000 - goal.atMs / 1000;
      if (
        !momentFired.has(key) &&
        (age >= GOAL_SEQUENCE.moment || (frame.goal?.n === goal.n && frame.goal.scored))
      ) {
        momentFired.add(key);
        options.onGoalMoment?.(goal.n);
      }
    }
    if (frame.goal?.net && !netFired.has(`${m.matchKey}#${frame.goal.n}`)) {
      netFired.add(`${m.matchKey}#${frame.goal.n}`);
      const side = Math.sign(frame.goal.net.x) >= 0 ? '1' : '-1';
      stadium.nets[side].impact(frame.goal.net.x, frame.goal.net.y, frame.goal.net.z);
    }
    stadium.update(dt, reduced ? 0.2 : frame.crowd);

    // Camera: restrained tracking, with a hard cut when the director changes shot.
    const target = frame.camera;
    const cut =
      lastMode !== null &&
      lastMode !== frame.mode &&
      (frame.mode === 'GOAL' || lastMode === 'GOAL');
    const k =
      reduced || cut || lastMode === null
        ? 1
        : 1 - Math.exp(-dt * (frame.mode === 'GOAL' ? 4 : 1.8));
    camPos.x += (target.x - camPos.x) * k;
    camPos.y += (target.y - camPos.y) * k;
    camPos.z += (target.z - camPos.z) * k;
    camLook.x += (target.lx - camLook.x) * k;
    camLook.y += (target.ly - camLook.y) * k;
    camLook.z += (target.lz - camLook.z) * k;
    camFov += (target.fov - camFov) * k;
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    if (Math.abs(camera.fov - camFov) > 0.01) {
      camera.fov = camFov;
      camera.updateProjectionMatrix();
    }
    if (cut) host.dispatchEvent(new CustomEvent('football-cut'));
    lastMode = frame.mode;
    sun.position.set(camLook.x + 24, 52, camLook.z + 36);
    sun.target.position.set(camLook.x, 0, camLook.z);
    renderer.render(scene, camera);
    renderedOnce = true;
    return frame;
  }

  const minFrame = 1000 / (options.maxFps ?? 30);
  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
    window.clearInterval(timer);
    rafId = 0;
    timer = 0;
  }

  // React error boundaries cannot catch animation-frame or timer exceptions. Stop this
  // engine before notifying its owner, so a failed renderer cannot keep throwing or
  // resume until the member retries with a fresh engine. Direct renderAt remains a
  // throwing deterministic API for the lab and captures.
  function renderScheduled(dt: number) {
    if (!running || disposed || renderFailed) return;
    try {
      renderAt(options.getElapsed(), dt);
    } catch (error) {
      renderFailed = true;
      stop();
      options.onRenderError?.(error);
    }
  }

  const loop = (time: number) => {
    if (!running || disposed) return;
    rafId = requestAnimationFrame(loop);
    if (document.hidden || !visible || time - last < minFrame) return;
    const dt = last ? Math.min(0.1, (time - last) / 1000) : 1 / 30;
    last = time;
    if (!match) return;
    renderScheduled(dt);
  };

  function schedule() {
    cancelAnimationFrame(rafId);
    window.clearInterval(timer);
    if (disposed || !running || renderFailed) return;
    if (reduced) {
      // Reduced motion: no continuous animation or camera tracking, one refresh a second.
      const refresh = () => {
        if (match && !document.hidden && visible) renderScheduled(0.016);
      };
      refresh();
      if (running && !disposed && !renderFailed) timer = window.setInterval(refresh, 1000);
    } else rafId = requestAnimationFrame(loop);
  }

  return {
    canvas: renderer.domElement,
    setMatch(next) {
      const changed = !match || match.matchKey !== next.matchKey;
      match = next;
      if (changed) {
        lastMode = null;
        lastBall = null;
      }
      if (reduced && running && renderedOnce && match) renderScheduled(0.016);
    },
    setReduced(value) {
      if (reduced === value) return;
      reduced = value;
      schedule();
    },
    start() {
      if (running || disposed || renderFailed) return;
      running = true;
      schedule();
    },
    stop,
    renderAt,
    resize,
    info: () => ({
      triangles: renderer.info.render.triangles,
      calls: renderer.info.render.calls,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      observer?.disconnect();
      intersection?.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.domElement.removeEventListener('webglcontextrestored', restored);
      pool.dispose();
      stadium.dispose();
      ballGeo.dispose();
      ballMat.dispose();
      ballTex.dispose();
      sky.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
    },
  };
}
export { ACTOR_COUNT, PITCH };
