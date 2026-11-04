import { PrismaClient } from '@prisma/client';
import { createSystemDiceService } from '../games/group-pvp/system-dice.js';
import { createSystemKenoService } from '../games/group-pvp/system-keno.js';
import { createLuckySixService } from '../games/lucky-six/service.js';
import { createRouletteKenoService } from '../games/roulette-keno/service.js';
import { createNumberTimedService } from '../games/number-challenge/timed-service.js';
import { createSkyCrashService } from '../games/sky-crash/service.js';
import { createCrashPointService } from '../games/crash-point/service.js';
import { createDerbyService } from '../games/thunder-derby/service.js';
import { createFootballService } from '../games/virtual-football/service.js';
import { prismaRoundDatabase } from '../games/scheduled/prisma-round-store.js';
import { tickPracticeStream } from '../games/scheduled/round-store.js';
import {
  closePracticeHealth,
  listenPracticeHealth,
  watchPracticeWorker,
} from '../games/scheduled/practice-worker-runtime.js';
import {
  enabledPracticeTasks,
  observePracticeTick,
  PracticeGamesHealth,
  runPracticeGamesWorker,
} from '../games/practice-worker/runtime.js';
import { numberWorkerTarget } from './number-worker-target.js';

/** Opt-in practice only: no API configuration, JWT secrets or financial jobs. */
async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(
      'practice-games-worker; requires enabled practice flags and restricted DATABASE_URL; Number also requires distinct NUMBER_WORKER_DATABASE_URL; health uses PRACTICE_WORKER_HEALTH_PORT or PORT (default 8080).'
    );
    return;
  }
  if (process.argv.length !== 2) throw new Error('Unexpected worker arguments');
  const enabled = enabledPracticeTasks(process.env);
  if (!enabled.length || !process.env.DATABASE_URL)
    throw new Error('Practice worker is not configured');
  const rawPort = process.env.PRACTICE_WORKER_HEALTH_PORT ?? process.env.PORT ?? '8080';
  if (!/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)
    throw new Error('Invalid practice health port');

  // Imported services use @socialplay/database only for types. No shared API
  // client or API environment parser is initialized by this executable.
  const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [] });
  const numberDb = enabled.includes('NUMBER')
    ? new PrismaClient({ datasourceUrl: numberWorkerTarget(process.env), log: [] })
    : null;
  const health = new PracticeGamesHealth(enabled);
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    health.stop();
    controller.abort();
    deadline ??= setTimeout(() => process.exit(1), 25_000);
    deadline.unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const stopWatchdog = watchPracticeWorker(health, () => {
    console.error(
      JSON.stringify({ event: 'PRACTICE_WORKER_STALLED', mode: 'PRACTICE', coinsAccepted: false })
    );
    process.exit(1);
  });
  let server: Awaited<ReturnType<typeof listenPracticeHealth>> | undefined;
  try {
    server = await listenPracticeHealth(health, Number(rawPort));
    await runPracticeGamesWorker({
      health,
      signal: controller.signal,
      ticks: {
        DICE: observePracticeTick(createSystemDiceService(db).tick),
        KENO: observePracticeTick(createSystemKenoService(db).tick),
        LUCKY_SIX: observePracticeTick(createLuckySixService(db).tick),
        ROULETTE_KENO: observePracticeTick(createRouletteKenoService(db).tick),
        NUMBER: async () => {
          if (!numberDb) throw new Error('Number worker is not configured');
          await createNumberTimedService(numberDb).tick();
        },
        SKY_CRASH: observePracticeTick(createSkyCrashService(db).tick),
        CRASH_POINT: observePracticeTick(createCrashPointService(db).tick),
        DERBY: observePracticeTick(createDerbyService(db).tick),
        DOG_RACING: observePracticeTick(createDerbyService(db, 'hounds').tick),
        FOOTBALL: observePracticeTick(createFootballService(db).tick),
        SPIN: async () => {
          await tickPracticeStream(prismaRoundDatabase(db), 'spin-win-practice-v1');
        },
      },
      report: (event) => console.error(JSON.stringify(event)),
    });
  } finally {
    health.stop();
    stopWatchdog();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    try {
      if (server) await closePracticeHealth(server);
    } finally {
      await Promise.allSettled([db.$disconnect(), numberDb?.$disconnect()]);
      if (deadline) clearTimeout(deadline);
    }
  }
}

main().catch(() => {
  console.error(
    JSON.stringify({
      event: 'PRACTICE_WORKER_START_FAILED',
      mode: 'PRACTICE',
      coinsAccepted: false,
    })
  );
  process.exitCode = 1;
});
