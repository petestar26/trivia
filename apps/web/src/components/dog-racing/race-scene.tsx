import { useEffect, useRef, useState } from 'react';
import { RACING_DOGS, type DerbyRound } from '@socialplay/shared';
import * as THREE from 'three';
import { createGreyhound } from './greyhound';
import { createTrack, trackPoint, TRACK_LENGTH } from './track';
import { createRaceMotion } from '../derby/race-motion';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export type DogCamera = 'trackside' | 'chase' | 'aerial';
export default function DogRaceScene({
  round,
  running,
  reduced,
  cameraMode = 'trackside',
}: {
  round: DerbyRound;
  running: boolean;
  reduced: boolean;
  cameraMode?: DogCamera;
}) {
  const { t: translateUi } = useInterfaceLanguage();

  const host = useRef<HTMLDivElement>(null),
    live = useRef({ round, running, reduced, cameraMode });
  live.current = { round, running, reduced, cameraMode };
  const [failed, setFailed] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!host.current) return;
    setFailed(false);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    } catch {
      setFailed(true);
      return;
    }
    const container = host.current;
    container.appendChild(renderer.domElement);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.innerWidth < 700 ? 1.5 : 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#b8ced5');
    scene.fog = new THREE.Fog('#c9d5cc', 100, 260);
    const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 500);
    scene.add(new THREE.HemisphereLight('#eff4ff', '#8d7956', 2));
    const sun = new THREE.DirectionalLight('#ffe0b3', 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -14;
    sun.shadow.camera.right = 14;
    sun.shadow.camera.top = 14;
    sun.shadow.camera.bottom = -14;
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far = 90;
    sun.shadow.normalBias = 0.025;
    scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight('#d4e6ff', 1);
    fill.position.set(-20, 10, -5);
    scene.add(fill);
    const track = createTrack(scene),
      dogs = Array.from({ length: 8 }, (_, i) => createGreyhound(i));
    dogs.forEach((d) => scene.add(d.root));
    // Floating numbers remain legible when the camera is far from the field.
    const labels: THREE.Sprite[] = [],
      labelResources: { dispose(): void }[] = [];
    for (let i = 0; i < 8; i++) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#121a20';
      ctx.beginPath();
      ctx.arc(32, 32, 27, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#f4e5ca';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = 'bold 34px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff8e9';
      ctx.fillText(String(i + 1), 32, 34);
      const t = new THREE.CanvasTexture(c),
        m = new THREE.SpriteMaterial({ map: t, depthTest: false });
      labelResources.push(t, m);
      const s = new THREE.Sprite(m);
      s.scale.set(0.55, 0.55, 0.55);
      scene.add(s);
      labels.push(s);
    }
    const resize = () => {
      const w = container.clientWidth,
        h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();
    let disposed = false,
      lastTime = 0,
      raf = 0,
      priorRound = '',
      motion = createRaceMotion(round.positions),
      prior: number[] = [],
      phases = dogs.map((_, i) => i * 0.71);
    const desired = new THREE.Vector3(),
      look = new THREE.Vector3(),
      target = new THREE.Vector3();
    let initialized = false;
    const lost = (event: Event) => {
      event.preventDefault();
      disposed = true;
      setFailed(true);
      cancelAnimationFrame(raf);
    };
    const restored = () => setRevision((v) => v + 1);
    renderer.domElement.addEventListener('webglcontextlost', lost);
    renderer.domElement.addEventListener('webglcontextrestored', restored);
    function animate(time: number) {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      if (time - lastTime < 32) return;
      const dt = Math.min(0.1, (time - lastTime) / 1000);
      lastTime = time;
      if (document.hidden) return;
      const state = live.current,
        r = state.round;
      if (priorRound !== r.id) {
        priorRound = r.id;
        motion = createRaceMotion(r.positions);
        prior = [...r.positions];
        initialized = false;
      }
      const positions = motion(time, r.positions, state.reduced || !!r.order || !state.running);
      const lead = Math.max(0, ...positions.slice(0, r.field));
      const center = trackPoint(lead / 1.06);
      for (let i = 0; i < 8; i++) {
        const visible = i < r.field;
        dogs[i].root.visible = labels[i].visible = visible;
        if (!visible) continue;
        const p = positions[i] || 0,
          lane = (i - (r.field - 1) / 2) * 0.87;
        const at = trackPoint(p / 1.06, lane);
        dogs[i].root.position.set(at.x, 0.004, at.z);
        dogs[i].root.rotation.y = at.heading;
        const travel = (Math.max(0, p - (prior[i] || 0)) * TRACK_LENGTH) / 1.06;
        prior[i] = p;
        phases[i] += (travel / 2.4) * Math.PI * 2;
        dogs[i].pose(
          state.running && !state.reduced ? phases[i] : time / 1000 + i,
          travel > 0.00005 && state.running && !state.reduced
        );
        labels[i].position.set(at.x, 2.1, at.z);
      }
      track.gates.forEach((g) => {
        g.position.y = state.running || r.order ? 1.8 : 0.48;
      });
      const angle = center.heading,
        forward = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle)),
        outward = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
      target.set(center.x, 0.7, center.z);
      const narrow = camera.aspect < 1.15,
        zoom = narrow ? 1.24 : 1;
      if (state.reduced || state.cameraMode === 'aerial') {
        desired.copy(target).addScaledVector(outward, 12 * zoom);
        desired.y = 29 * zoom;
      } else if (state.cameraMode === 'chase') {
        desired
          .copy(target)
          .addScaledVector(forward, -10 * zoom)
          .addScaledVector(outward, 6 * zoom);
        desired.y = 5.2 * zoom;
      } else {
        desired
          .copy(target)
          .addScaledVector(forward, 3)
          .addScaledVector(outward, 13 * zoom);
        desired.y = 6.0 * zoom;
      }
      if (!initialized) {
        camera.position.copy(desired);
        look.copy(target);
        initialized = true;
      } else {
        const blend = 1 - Math.exp(-dt * 3);
        camera.position.lerp(desired, blend);
        look.lerp(target, blend);
      }
      camera.lookAt(look);
      sun.position.set(center.x + 10, 24, center.z + 12);
      sun.target.position.copy(target);
      sun.target.updateMatrixWorld();
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(animate);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.domElement.removeEventListener('webglcontextrestored', restored);
      dogs.forEach((d) => d.dispose());
      track.dispose();
      labelResources.forEach((r) => r.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [revision]);
  return (
    <div
      ref={host}
      className="hounds-scene"
      role="img"
      aria-label={translateUi('Animated greyhounds on the Salem oval racecourse')}
    >
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
                (round.positions[i] || 0) / 1.06,
                (i - (round.field - 1) / 2) * 0.87
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
