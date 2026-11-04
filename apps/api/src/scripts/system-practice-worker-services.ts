import { PrismaClient } from '@prisma/client';
import { createSkyCrashService } from '../games/sky-crash/service.js';
import { createCrashPointService } from '../games/crash-point/service.js';
import { createDerbyService } from '../games/thunder-derby/service.js';
import { createFootballService } from '../games/virtual-football/service.js';
import { createSystemDiceService } from '../games/group-pvp/system-dice.js';
import { createSystemKenoService } from '../games/group-pvp/system-keno.js';
import type { SystemPracticeConfiguration, SystemPracticeFamily, SystemPracticeServices, SystemPracticeTick } from './system-practice-worker-runtime.js';

/** Only the standalone admitted entrypoint imports this adapter. Importing it creates no client. */
export async function loadSystemPracticeServices(config: SystemPracticeConfiguration): Promise<SystemPracticeServices> {
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl, log: [] });
  const factories = {
    SKY_CRASH: createSkyCrashService,
    CRASH_POINT: createCrashPointService,
    THUNDER_DERBY: createDerbyService,
    VIRTUAL_FOOTBALL: createFootballService,
    SYSTEM_DICE: createSystemDiceService,
    SYSTEM_KENO: createSystemKenoService,
  } as const;
  const ticks: Partial<Record<SystemPracticeFamily, SystemPracticeTick>> = {};
  try {
    for (const family of config.families) ticks[family] = factories[family](db).tick;
  } catch (error) { await db.$disconnect(); throw error; }
  return { ticks, disconnect: () => db.$disconnect() };
}
