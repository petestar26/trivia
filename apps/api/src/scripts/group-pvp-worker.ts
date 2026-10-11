import { PrismaClient } from '@prisma/client';
import { numberWorkerTarget } from './number-worker-target.js';
import { createNumberTimedService } from '../games/number-challenge/timed-service.js';
import { createDerbyService } from '../games/thunder-derby/service.js';
import { createFootballService } from '../games/virtual-football/service.js';
import { createSkyCrashService } from '../games/sky-crash/service.js';
import { createCrashPointService } from '../games/crash-point/service.js';
import { prisma } from '@socialplay/database';
import { createGroupPvpService } from '../games/group-pvp/service.js';
import { createSystemDiceService } from '../games/group-pvp/system-dice.js';
import { createSystemKenoService } from '../games/group-pvp/system-keno.js';
import { enabledGroupWorkers, runGroupWorkerLoops } from './group-worker-runtime.js';
import { expireSocialGroups } from '../groups/lifecycle.js';

const numberDb =
  process.env.NUMBER_CHALLENGE_PRACTICE_ENABLED === 'true'
    ? new PrismaClient({ datasourceUrl: numberWorkerTarget(process.env) })
    : null;
let stopped = false;
process.once('SIGTERM', () => {
  stopped = true;
});
process.once('SIGINT', () => {
  stopped = true;
});
try {
  await runGroupWorkerLoops({
    enabled: enabledGroupWorkers(process.env),
    stopped: () => stopped,
    ticks: {
      NUMBER_PRACTICE: async () => {
        if (numberDb) await createNumberTimedService(numberDb).tick();
      },
      DERBY_PRACTICE: createDerbyService(prisma).tick,
      FOOTBALL_PRACTICE: createFootballService(prisma).tick,
      SKY_CRASH_PRACTICE: createSkyCrashService(prisma).tick,
      CRASH_PRACTICE: createCrashPointService(prisma).tick,
      SOCIAL_LIFECYCLE: async () => {
        await expireSocialGroups(prisma);
      },
      PVP: createGroupPvpService(prisma).tick,
      KENO_PRACTICE: createSystemKenoService(prisma).tick,
      DICE_PRACTICE: createSystemDiceService(prisma).tick,
    },
    wait: () => new Promise((resolve) => setTimeout(resolve, 1000)),
    report: (event) => console.error(JSON.stringify(event)),
  });
} finally {
  await numberDb?.$disconnect();
  await prisma.$disconnect();
}
