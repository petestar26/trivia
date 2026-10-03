import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/api-error.js';
import { createGroupPvpService } from './service.js';
import type { GroupPvpGame } from '@socialplay/shared';

export async function groupPvpRoutes(server: FastifyInstance) {
  const service = createGroupPvpService(prisma);
  server.addHook('preHandler', authenticate);
  server.addHook('preHandler', async (_request, reply) => {
    reply.header('Cache-Control','private, no-store');
    if(process.env.GROUP_PVP_GAME_POINTS_ENABLED !== 'true') throw ApiError.forbidden('Group PVP is not enabled yet');
  });
  const params = {type:'object',required:['groupId'],properties:{groupId:{type:'string',minLength:1,maxLength:128},roundId:{type:'string',minLength:1,maxLength:128}}};
  const limit = {rateLimit:{max:90,timeWindow:'1 minute'}};
  server.get<{Params:{groupId:string}}>('/:groupId/pvp',{schema:{params},config:limit},async request=>
    ({success:true,data:await service.snapshot(request.params.groupId,request.user.sub)}));
  server.post<{Params:{groupId:string};Body:{game:GroupPvpGame;entryAmount:number;requestId:string}}>('/:groupId/pvp',{
    config:{rateLimit:{max:10,timeWindow:'1 minute'}},schema:{params,body:{type:'object',required:['game','entryAmount','requestId'],additionalProperties:false,
      properties:{game:{enum:['spin_win','turbo_keno']},entryAmount:{type:'integer',minimum:100,maximum:10000,multipleOf:100},requestId:{type:'string',format:'uuid'}}}}},
    async request=>({success:true,data:{roundId:await service.create(request.params.groupId,request.user.sub,request.body.game,request.body.entryAmount,request.body.requestId)}}));
  for(const action of ['join','withdraw','start','cancel'] as const) {
    server.post<{Params:{groupId:string;roundId:string}}>(`/:groupId/pvp/:roundId/${action}`,{schema:{params},config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async request=>{
      await service[action](request.params.groupId,request.user.sub,request.params.roundId);
      return {success:true,data:{accepted:true}};
    });
  }
  server.post<{Params:{groupId:string;roundId:string};Body:{selection:number[];policyId:string;entryAmount:number}}>('/:groupId/pvp/:roundId/ready',{
    config:{rateLimit:{max:20,timeWindow:'1 minute'}},schema:{params,body:{type:'object',required:['selection','policyId','entryAmount'],additionalProperties:false,
      properties:{selection:{type:'array',minItems:1,maxItems:5,items:{type:'integer',minimum:0,maximum:80}},policyId:{type:'string',maxLength:64},entryAmount:{type:'integer',minimum:100,maximum:10000}}}}},
    async request=>{await service.ready(request.params.groupId,request.user.sub,request.params.roundId,request.body.selection,request.body.policyId,request.body.entryAmount);return {success:true,data:{accepted:true}};});
}
