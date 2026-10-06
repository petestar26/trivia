import { PrismaClient } from '@prisma/client';
import { prismaRoundDatabase } from '../games/scheduled/prisma-round-store.js';
import { tickPracticeStream } from '../games/scheduled/round-store.js';
import {
  closePracticeHealth,
  listenPracticeHealth,
  PracticeWorkerHealth,
  runPracticeWorker,
  watchPracticeWorker,
} from '../games/scheduled/practice-worker-runtime.js';
import type { Server } from 'node:http';

const usage =
  'scheduled-practice-worker (--once|--loop) [--stream=id]; requires SCHEDULED_PRACTICE_WORKER_ENABLED=true and DATABASE_URL; loop health uses optional SCHEDULED_PRACTICE_HEALTH_PORT';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return 0;
  }
  const modes = args.filter((arg) => arg === '--once' || arg === '--loop');
  const streams = args.filter((arg) => arg.startsWith('--stream='));
  if (modes.length !== 1 || streams.length > 1 || args.length !== modes.length + streams.length) {
    console.error(usage);
    return 2;
  }
  const streamId = streams[0]?.slice('--stream='.length) ?? 'spin-win-practice-v1';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(streamId)) return 2;
  if (process.env.SCHEDULED_PRACTICE_WORKER_ENABLED !== 'true' || !process.env.DATABASE_URL) {
    console.error('Practice worker is disabled or lacks its database configuration.');
    return 2;
  }
  const once = modes[0] === '--once';
  const rawPort = once ? undefined : process.env.SCHEDULED_PRACTICE_HEALTH_PORT;
  if (
    rawPort !== undefined &&
    (!/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)
  ) {
    console.error('Invalid practice health port.');
    return 2;
  }
  const client = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [] });
  const controller = new AbortController();
  const health = new PracticeWorkerHealth();
  let server: Server | undefined;
  let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
  // Railway deployment healthchecks do not continuously restart unhealthy workers.
  // A separate watchdog exits a stalled process so the restart policy can recover it.
  const stopWatchdog = once
    ? undefined
    : watchPracticeWorker(health, () => {
        console.error(
          'Practice worker stalled; restarting without publishing an uncommitted result.'
        );
        process.exit(1);
      });
  const stop = () => {
    health.stop();
    controller.abort();
    shutdownDeadline ??= setTimeout(() => process.exit(1), 25_000);
    shutdownDeadline.unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    if (rawPort !== undefined) server = await listenPracticeHealth(health, Number(rawPort));
    const db = prismaRoundDatabase(client);
    return await runPracticeWorker({
      tick: () => tickPracticeStream(db, streamId),
      signal: controller.signal,
      once,
      health,
      publish: (result) =>
        console.log(JSON.stringify({ mode: 'PRACTICE', coinsAccepted: false, ...result })),
      // Database exceptions can contain connection details. Never log them.
      reportFailure: () =>
        console.error('Practice round tick failed; no result published by this tick.'),
    });
  } finally {
    health.stop();
    stopWatchdog?.();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    try {
      if (server) await closePracticeHealth(server);
    } finally {
      await client.$disconnect();
      if (shutdownDeadline) clearTimeout(shutdownDeadline);
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error('Practice worker could not start.');
    process.exitCode = 1;
  });
