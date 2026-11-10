import { broadcastFov } from './broadcast-fov';
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
import { buildStadium, type Stadium } from './stadium';
import { ballTexture } from './ball';
import { createContactShadows } from './contact-shadows';
import { createFloodlitEnvironment, nightSkyTexture } from './environment';
import { createCameraOperator, OPERATOR_GOAL, OPERATOR_PLAY } from './camera-operator';
import { frameShot } from './broadcast-framing';

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
  /** Low graphics quality retains the scene while omitting the extra shadow render pass. */
  shadows?: boolean;
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
  info(): {
    triangles: number;
    calls: number;
    geometries: number;
    textures: number;
    playerDetails?: { high: number; mid: number; low: number };
    reviewPlayers?: number;
  };
  dispose(): void;
}

/** A fixed view fitted to the pitch, nets and decorative aerial play, never to released events. */
function reducedPitchCamera(aspect: number): Frame['camera'] {
  const fov = broadcastFov(34, aspect);
  const centre = new THREE.Vector3(0, 0.9, 0);
  // An elevated fixed view gives the touchlines depth on portrait stages instead
  // of squeezing the pitch into a narrow horizon strip. It still depends only
  // on geometry/aspect, never the ball or a released goal.
  const direction = new THREE.Vector3(0, 64, 62).normalize();
  const right = new THREE.Vector3(1, 0, 0);
  const up = new THREE.Vector3().crossVectors(direction, right);
  const verticalTan = Math.tan((fov * Math.PI) / 360);
  const horizontalTan = verticalTan * aspect;
  let distance = Math.hypot(64, 62);
  // Include net depth/ripple, touchline clearance and the director's 8 m long-ball arc.
  for (const x of [-1, 1])
    for (const y of [-0.3, 9])
      for (const z of [-1, 1]) {
        const offset = new THREE.Vector3(
          x * (PITCH.halfLength + PITCH.goalDepth + 1.8),
          y,
          z * (PITCH.halfWidth + 1)
        ).sub(centre);
        distance = Math.max(
          distance,
          offset.dot(direction) +
            1.08 *
              Math.max(
                Math.abs(offset.dot(right)) / horizontalTan,
                Math.abs(offset.dot(up)) / verticalTan
              )
        );
      }
  const position = centre.clone().addScaledVector(direction, distance);
  return {
    x: position.x,
    y: position.y,
    z: position.z,
    lx: centre.x,
    ly: centre.y,
    lz: centre.z,
    fov,
  };
}

export function createEngine(options: EngineOptions): Engine {
  const { host } = options;
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'default',
  });
  const pixelRatioCap = options.maxPixelRatio ?? 1.5;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  const shadowMapped = options.shadows !== false;
  renderer.shadowMap.enabled = shadowMapped;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  host.appendChild(renderer.domElement);
  const anisotropy =
    (renderer as Partial<THREE.WebGLRenderer>).capabilities?.getMaxAnisotropy?.() ?? 4;

  // --- floodlit night: sky, haze, image-based reflections and the floodlight banks -----------
  const scene = new THREE.Scene();
  const sky = nightSkyTexture();
  scene.background = sky;
  scene.fog = new THREE.Fog('#141a24', 150, 520);
  const environment = createFloodlitEnvironment(renderer);
  if (environment.texture) {
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.55;
  }
  scene.add(new THREE.HemisphereLight('#aebbd6', '#2d4a2c', environment.texture ? 0.55 : 1.1));
  // Key: the main-stand roof bank behind the broadcast camera. It is the only light with a
  // shadow map; the shadow frustum follows the camera's framing and is snapped to whole shadow
  // texels, so shadows do not shimmer while the camera pans.
  const KEY_OFFSET = new THREE.Vector3(10, 36, 62);
  const RIM_OFFSET = new THREE.Vector3(-6, 30, -55);
  const SIDE_OFFSET = new THREE.Vector3(-60, 28, 4);
  const sun = new THREE.DirectionalLight('#f4f6ff', 2.35);
  sun.castShadow = shadowMapped;
  // 2048² only for the explicit high setting; the default/phone path keeps the previous 1024².
  const shadowSize = pixelRatioCap >= 1.75 ? 2048 : 1024;
  const shadowHalf = 38;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.camera.left = -shadowHalf;
  sun.shadow.camera.right = shadowHalf;
  sun.shadow.camera.top = shadowHalf;
  sun.shadow.camera.bottom = -shadowHalf;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 160;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  // Opposite-roof rim light and an end-stand side light give players shape and separation.
  const fill = new THREE.DirectionalLight('#e3e9f7', 1.05);
  scene.add(fill, fill.target);
  const side = new THREE.DirectionalLight('#eef1fb', 0.6);
  scene.add(side, side.target);
  const keyDir = KEY_OFFSET.clone().normalize();
  const shadowRight = new THREE.Vector3()
    .crossVectors(new THREE.Vector3(0, 1, 0), keyDir)
    .normalize();
  const shadowUp = new THREE.Vector3().crossVectors(keyDir, shadowRight).normalize();
  const shadowTexel = (shadowHalf * 2) / shadowSize;
  const focus = new THREE.Vector3();
  const placeLights = (look: THREE.Vector3) => {
    focus.set(look.x, 0, look.z);
    const r = focus.dot(shadowRight);
    const u = focus.dot(shadowUp);
    focus
      .addScaledVector(shadowRight, Math.round(r / shadowTexel) * shadowTexel - r)
      .addScaledVector(shadowUp, Math.round(u / shadowTexel) * shadowTexel - u);
    sun.target.position.copy(focus);
    sun.position.copy(focus).add(KEY_OFFSET);
    fill.target.position.set(look.x, 0.8, look.z);
    fill.position.copy(fill.target.position).add(RIM_OFFSET);
    side.target.position.set(look.x, 0.8, look.z);
    side.position.copy(side.target.position).add(SIDE_OFFSET);
  };

  const stadium: Stadium = buildStadium({ anisotropy });
  scene.add(stadium.group);
  const pool: PlayerPool = createPlayerPool();
  scene.add(pool.group);
  // Floodlight "star" shadows and contact patches for every actor and the ball.
  const decals = createContactShadows(ACTOR_COUNT, { toLight: KEY_OFFSET, strength: 0.34 }, [
    { toLight: RIM_OFFSET, strength: 0.16 },
    { toLight: SIDE_OFFSET, strength: 0.12 },
    { toLight: new THREE.Vector3(60, 28, 4), strength: 0.12 },
  ]);
  decals.setKeyShadowMapped(shadowMapped);
  scene.add(decals.group);

  const ballTex = ballTexture();
  const ballGeo = new THREE.SphereGeometry(0.11, 28, 18);
  const ballMat = new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.38 });
  const ball = new THREE.Mesh(ballGeo, ballMat);
  // Keep the drawn surface at the same 0.11 m radius used by contact fitting.
  // Enlarging it for broadcast legibility made a physically clear boot look embedded.
  ball.castShadow = true;
  scene.add(ball);

  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.5, 700);
  const camPos = new THREE.Vector3(0, 18, 58);
  const camLook = new THREE.Vector3(0, 0.9, 3);
  let camFov = 30;
  camera.position.copy(camPos);
  const operator = createCameraOperator();

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

  const fitReducedCamera = () => {
    const target = reducedPitchCamera(camera.aspect);
    camPos.set(target.x, target.y, target.z);
    camLook.set(target.lx, target.ly, target.lz);
    camFov = camera.fov = target.fov;
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    camera.far = Math.max(700, camPos.distanceTo(camLook) + 100);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };
  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    if (reduced) fitReducedCamera();
    else camera.updateProjectionMatrix();
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

    // Camera: the operator eases the fixed broadcast camera toward the director's framing.
    // Entering or leaving a goal sequence is a cut (the dissolve covers the restaged players).
    const cut =
      lastMode !== null &&
      lastMode !== frame.mode &&
      (frame.mode === 'GOAL' || lastMode === 'GOAL');
    if (reduced) {
      const target = reducedPitchCamera(camera.aspect);
      operator.cut(target);
    } else {
      // The director's framing intent, fitted to this stage's real CSS size and shape.
      const target = frameShot(frame.camera, {
        width: host.clientWidth || 16,
        height: host.clientHeight || 9,
      });
      if (cut || lastMode === null) operator.cut(target);
      else operator.follow(target, dt, frame.mode === 'GOAL' ? OPERATOR_GOAL : OPERATOR_PLAY);
    }
    const shot = operator.shot;
    camPos.set(shot.x, shot.y, shot.z);
    camLook.set(shot.lx, shot.ly, shot.lz);
    camFov = shot.fov;
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    if (Math.abs(camera.fov - camFov) > 0.01) {
      camera.fov = camFov;
      camera.updateProjectionMatrix();
    }
    if (cut) host.dispatchEvent(new CustomEvent('football-cut'));
    lastMode = frame.mode;
    placeLights(camLook);
    decals.update(frame.actors, ball.position);
    camera.updateMatrixWorld(true);
    pool.setDetail?.(camera, host.clientHeight);
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
      if (reduced) fitReducedCamera();
      else {
        camera.far = 700;
        camera.updateProjectionMatrix();
      }
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
      ...(pool.rigs
        ? {
            reviewPlayers: pool.rigs.filter((r) => r.root.userData.reviewPlayer).length,
            playerDetails: pool.rigs.reduce(
              (counts, rig) => {
                const detail: unknown = rig.root.userData.playerDetail;
                if (detail === 'high' || detail === 'mid' || detail === 'low') counts[detail]++;
                return counts;
              },
              { high: 0, mid: 0, low: 0 }
            ),
          }
        : {}),
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
      decals.dispose();
      environment.dispose();
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
