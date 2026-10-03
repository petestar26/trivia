import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/api-error.js';
import { createSystemDiceService } from './system-dice.js';
export async function systemDiceRoutes(server: FastifyInstance) {
  const service = createSystemDiceService(prisma);
  server.addHook('preHandler',authenticate);
  server.addHook('preHandler',async(_request,reply)=>{
    reply.header('Cache-Control','private, no-store');
    if(process.env.SYSTEM_DICE_PRACTICE_ENABLED!=='true') throw ApiError.forbidden('System Dice practice is not enabled yet');
  });
  server.get('/',{config:{rateLimit:{max:90,timeWindow:'1 minute'}}},async request=>({success:true,data:await service.snapshot(request.user.sub)}));
  server.post<{Body:{roundId:string;stake:number}}>('/tickets',{
    config:{rateLimit:{max:20,timeWindow:'1 minute'}},schema:{body:{type:'object',additionalProperties:false,required:['roundId','stake'],properties:{
      roundId:{type:'string',minLength:1,maxLength:64},stake:{type:'integer',minimum:35,maximum:490,multipleOf:35},
    }}},
  },async request=>({success:true,data:await service.enter(request.user.sub,request.body.roundId,request.body.stake)}));
}
