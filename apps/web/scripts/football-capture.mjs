#!/usr/bin/env node
// Deterministic motion capture of the Virtual Football 3D scene, for review.
//
//   pnpm --filter web dev                       # in one terminal (serves /football-lab.html)
//   node apps/web/scripts/football-capture.mjs --out /tmp/vf-clip --start 5.5 --end 10.5 \
//        --goals 6000H --key vf-s1-w01-f05 --home 5 --away 14 --video /tmp/vf-clip/goal.mp4
//
// The dev lab renders the real engine with the real director at an exact clock (`renderAt`),
// so the same arguments always give the same frames. Frames are advanced 1/fps apart, which
// is what live play does, so the camera smoothing, foot planting and keeper dive are shown
// as they move. This is software-rendered evidence of motion, not device performance.
//
// Requires Playwright with a Chromium build (not a project dependency: install it, or point
// NODE_PATH at an existing install) and optionally ffmpeg for --video.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, i, all) => {
    if (token.startsWith('--'))
      pairs.push([
        token.slice(2),
        all[i + 1] !== undefined && !all[i + 1].startsWith('--') ? all[i + 1] : 'true',
      ]);
    return pairs;
  }, [])
);
const num = (name, fallback) => (args[name] === undefined ? fallback : Number(args[name]));
const out = args.out ?? './football-capture';
const start = num('start', 5.5);
const end = num('end', 10.5);
const fps = num('fps', 30);
const [width, height] = (args.size ?? '960x540').split('x').map(Number);
const base = args.base ?? 'http://127.0.0.1:5173';
const key = args.key ?? 'vf-s1-w01-f05';
const home = num('home', 5);
const away = num('away', 14);
const goalSpec = args.goals ?? '6000H';
const goals = goalSpec
  .split(',')
  .filter(Boolean)
  .map((g, i) => ({ n: i + 1, side: g.endsWith('A') ? 'A' : 'H', atMs: Number(g.slice(0, -1)) }));

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'Playwright is not installed. Install it (for example `pnpm dlx playwright install chromium`) and rerun.'
  );
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: { width, height } });
// The lab deliberately throws `lab:match-ready` after exposing `window.__lab`.
page.on('pageerror', (e) => {
  if (!e.message.includes('lab:match-ready')) console.error('[pageerror]', e.message);
});
const url = `${base}/football-lab.html?scene=match&t=${start}&settle=1&hud=0&key=${key}&home=${home}&away=${away}`;
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__lab?.ready, null, { timeout: 120000 });

const frames = Math.round((end - start) * fps);
let released = -1;
for (let i = 0; i <= frames; i++) {
  const ms = Math.round((start + i / fps) * 1000);
  // Release goals exactly when the server would: once their time has elapsed.
  const visible = goals.filter((g) => g.atMs <= ms);
  if (visible.length !== released) {
    released = visible.length;
    await page.evaluate((g) => window.__lab.setGoals(g), visible);
  }
  await page.evaluate((t) => window.__lab.renderAt(t, 1 / 30), ms);
  await page.screenshot({ path: join(out, `frame-${String(i).padStart(4, '0')}.png`) });
}
await browser.close();
writeFileSync(
  join(out, 'capture.json'),
  JSON.stringify(
    { start, end, fps, size: [width, height], key, home, away, goals, frames: frames + 1 },
    null,
    2
  )
);
console.log(`wrote ${frames + 1} frames to ${out}`);

if (args.video) {
  const run = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      String(fps),
      '-i',
      join(out, 'frame-%04d.png'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '26',
      '-movflags',
      '+faststart',
      args.video,
    ],
    { stdio: 'inherit' }
  );
  if (run.status !== 0)
    console.error('ffmpeg failed or is not installed; the PNG sequence is still in', out);
  else console.log('video', args.video);
}
