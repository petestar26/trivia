import { it, expect } from 'vitest';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const run = promisify(execFile);
const require = createRequire(import.meta.url);
it('executes ESM source imports and a real HTTP API smoke probe with default tsx resolution', async () => {
  const directory = await mkdtemp(resolve('.source-smoke-'));
  try {
    const file = join(directory, 'probe.mts');
    await writeFile(
      file,
      `
      import { requireCookieOrigin } from '../src/plugins/cookie-origin.js';
      import { buildServer } from '../src/server.js';
      import { getSocketServer } from '../src/realtime/broadcast.js';
      if (typeof requireCookieOrigin !== 'function') throw Error('import failed');
      const server = await buildServer();
      const origin = await server.listen({host:'127.0.0.1',port:0});
      const response = await fetch(origin+'/missing-source-smoke');
      if(response.status!==404)throw Error('HTTP smoke failed');
      await new Promise(resolve=>getSocketServer().close(resolve));
      await server.close();
      console.log('SOURCE_HTTP_OK');
    `
    );
    const result = await run(process.execPath, [require.resolve('tsx/cli'), file], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, LOG_PRETTY: 'false', NUMBER_CHALLENGE_PRACTICE_ENABLED: 'false' },
    });
    expect(result.stdout).toContain('SOURCE_HTTP_OK');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('starts the actual Node 20 tsx API entrypoint and answers HTTP', async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(process.execPath, [require.resolve('tsx/cli'), resolve('src/server.ts')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_PRETTY: 'false',
      NUMBER_CHALLENGE_PRACTICE_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-16384);
    });
  const stopped = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let status: number | undefined;
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        status = (
          await fetch(`http://127.0.0.1:${port}/missing-start-smoke`, {
            signal: AbortSignal.timeout(1000),
          })
        ).status;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(status, output).toBe(404);
  } finally {
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
    await stopped;
    clearTimeout(kill);
  }
}, 30000);
