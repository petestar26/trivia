import { prisma } from '@socialplay/database';
import { createGroupPvpService } from '../games/group-pvp/service.js';

if(process.env.GROUP_PVP_GAME_POINTS_ENABLED !== 'true') throw new Error('Group PVP worker is disabled');
const service = createGroupPvpService(prisma);
let stopped = false;
process.once('SIGTERM',()=>{stopped=true;});
process.once('SIGINT',()=>{stopped=true;});
try {
  while(!stopped) {
    try { await service.tick((roundId)=>console.error(JSON.stringify({event:'PVP_PAYOUT_PENDING',roundId}))); }
    catch { console.error(JSON.stringify({event:'PVP_WORKER_RETRY'})); }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
} finally { await prisma.$disconnect(); }
