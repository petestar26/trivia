import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/api-error.js';
import { createSystemKenoService } from './system-keno.js';
export async function systemKenoRoutes(server:FastifyInstance) {
  const service=createSystemKenoService(prisma);
  server.addHook('preHandler',authenticate);
  server.addHook('preHandler',async(_request,reply)=>{reply.header('Cache-Control','private, no-store');if(process.env.SYSTEM_KENO_PRACTICE_ENABLED!=='true')throw ApiError.forbidden('System Keno is not enabled yet');});
  server.get('/',{config:{rateLimit:{max:90,timeWindow:'1 minute'}}},async request=>({success:true,data:await service.snapshot(request.user.sub)}));
  server.post<{Body:{roundId:string;picks:number[];stakePerNumber:number}}>('/tickets',{config:{rateLimit:{max:20,timeWindow:'1 minute'}},schema:{body:{type:'object',required:['roundId','picks','stakePerNumber'],additionalProperties:false,
    properties:{roundId:{type:'string',maxLength:64},picks:{type:'array',minItems:1,maxItems:10,items:{type:'integer',minimum:1,maximum:80}},stakePerNumber:{type:'integer',minimum:5,maximum:480,multipleOf:5}}}}},async request=>({success:true,data:await service.enter(request.user.sub,request.body.roundId,request.body.picks,request.body.stakePerNumber)}));
}