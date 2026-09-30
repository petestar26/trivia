import { PrismaClient } from '@prisma/client';
import { prismaRoundDatabase } from '../games/scheduled/prisma-round-store.js';
import { tickPracticeStream } from '../games/scheduled/round-store.js';

const usage = 'scheduled-practice-worker (--once|--loop) [--stream=id]; requires SCHEDULED_PRACTICE_WORKER_ENABLED=true and DATABASE_URL';

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
  const client = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [] });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const db = prismaRoundDatabase(client);
    do {
      try {
        const result = await tickPracticeStream(db, streamId);
        console.log(JSON.stringify({ mode: 'PRACTICE', coinsAccepted: false, ...result }));
      } catch {
        // Database exceptions can contain connection details. Do not log them.
        console.error('Practice round tick failed; no result published by this tick.');
        if (modes[0] === '--once') return 1;
      }
      if (modes[0] === '--once' || stopping) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (!stopping);
    return 0;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await client.$disconnect();
  }
}

main().then((code) => { process.exitCode = code; }).catch(() => {
  console.error('Practice worker could not start.');
  process.exitCode = 1;
});
