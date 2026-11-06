import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { DERBY_HORSES } from '@socialplay/shared';
import { createHorse } from '@/components/derby/horse-model';
import { createGreyhound } from '@/components/dog-racing/greyhound';

/** Adapts the existing authored runners to released shared-round checkpoints.
 * No standalone race scheduler, outcome generator, or wallet is mounted here. */
export default function SharedRaceScene({
  positions,
  elapsed,
  dogs,
  running,
  fallback,
}: {
  positions: number[];
  elapsed: number;
  dogs: boolean;
  running: boolean;
  fallback: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ positions, elapsed, running });
  live.current = { positions, elapsed, running };
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    } catch {
      setFailed(true);
      return;
    }
    const element = host.current;
    const resources = {
      materials: [] as THREE.Material[],
      geometries: [] as THREE.BufferGeometry[],
      textures: [] as THREE.Texture[],
    };
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#071e18');
    scene.add(new THREE.HemisphereLight('#ffefd3', '#174d3c', 2));
    const sun = new THREE.DirectionalLight('#fff6dd', 2.2);
    sun.position.set(8, 18, 8);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(85, 24),
      new THREE.MeshStandardMaterial({ color: dogs ? '#c5aa7c' : '#246347', roughness: 1 })
    );
    resources.geometries.push(floor.geometry);
    resources.materials.push(floor.material);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(30, -0.03, 0);
    scene.add(floor);
    for (let lane = 0; lane < 9; lane++) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(80, 0.015, 0.025),
        new THREE.MeshBasicMaterial({ color: '#dfce9e' })
      );
      resources.geometries.push(line.geometry);
      resources.materials.push(line.material);
      line.position.set(30, 0, lane * 2 - 8);
      scene.add(line);
    }
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
      const horse = dogs
        ? null
        : createHorse(coats[i], DERBY_HORSES[i].color, i, resources, () => {});
      const dog = dogs ? createGreyhound(i) : null;
      const root = (horse ?? dog)!.root;
      root.position.z = i * 2 - 7;
      scene.add(root);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d');
      if (context) {
        context.fillStyle = DERBY_HORSES[i].color;
        context.fillRect(0, 0, 64, 64);
        context.fillStyle = '#111';
        context.font = 'bold 44px sans-serif';
        context.textAlign = 'center';
        context.fillText(String(i + 1), 32, 48);
      }
      const texture = new THREE.CanvasTexture(canvas);
      resources.textures.push(texture);
      const material = new THREE.SpriteMaterial({ map: texture });
      resources.materials.push(material);
      const marker = new THREE.Sprite(material);
      marker.position.set(0, dogs ? 2 : 3.5, 0);
      marker.scale.set(0.65, 0.65, 1);
      root.add(marker);
      return {
        root,
        pose: (seconds: number, moving: boolean) => {
          horse?.animate(seconds, moving);
          dog?.pose(seconds * 2, moving);
        },
        dispose: () => dog?.dispose(),
      };
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    element.appendChild(renderer.domElement);
    const resize = () => {
      const w = Math.max(1, element.clientWidth),
        h = Math.max(230, Math.min(430, w * 0.55));
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    let frame = 0,
      stopped = false,
      last = 0;
    const lost = (event: Event) => {
      event.preventDefault();
      stopped = true;
      setFailed(true);
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    const draw = (time: number) => {
      if (stopped) return;
      frame = requestAnimationFrame(draw);
      if (time - last < 32) return;
      last = time;
      try {
        const value = live.current;
        runners.forEach((runner, i) => {
          runner.root.position.x = (value.positions[i] ?? 0) * 60;
          runner.pose(value.elapsed / 1000 + i * 0.12, value.running);
        });
        const leader = Math.max(0, ...value.positions) * 60;
        camera.position.set(leader + 7, 12, 21);
        camera.lookAt(leader - 1, 0, 0);
        renderer.render(scene, camera);
      } catch {
        stopped = true;
        setFailed(true);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      runners.forEach((r) => r.dispose());
      Object.values(resources)
        .flat()
        .forEach((r) => r.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [dogs]);
  return failed ? (
    <>{fallback}</>
  ) : (
    <div ref={host} className="tg-live-race-canvas" aria-hidden="true" />
  );
}
