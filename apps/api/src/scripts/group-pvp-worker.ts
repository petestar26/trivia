import { prisma } from '@socialplay/database';
import { createGroupPvpService } from '../games/group-pvp/service.js';
import { createSystemKenoService } from '../games/group-pvp/system-keno.js';

if(process.env.GROUP_PVP_GAME_POINTS_ENABLED !== 'true') throw new Error('Group PVP worker is disabled');
const service = createGroupPvpService(prisma);
const keno=createSystemKenoService(prisma);
let stopped = false;
process.once('SIGTERM',()=>{stopped=true;});
process.once('SIGINT',()=>{stopped=true;});
async function pvpLoop(){
  while(!stopped){
    try { await service.tick((roundId)=>console.error(JSON.stringify({event:'PVP_PAYOUT_PENDING',roundId}))); }
    catch { console.error(JSON.stringify({event:'PVP_WORKER_RETRY'})); }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
}
async function kenoLoop(){
  if(process.env.SYSTEM_KENO_PRACTICE_ENABLED!=='true')return;
  while(!stopped){
    try{await keno.tick(id=>console.error(JSON.stringify({event:'KENO_PRACTICE_RETRY',id})));}catch{console.error(JSON.stringify({event:'KENO_PRACTICE_RETRY'}));}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
}
try { await Promise.all([pvpLoop(),kenoLoop()]); } finally { await prisma.$disconnect(); }