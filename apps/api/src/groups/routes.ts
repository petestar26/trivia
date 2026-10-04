import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate } from '../middleware/auth.js';
import { lockSocialGroup } from './lifecycle.js';

export async function socialGroupRoutes(server: FastifyInstance) {
  server.addHook('preHandler',authenticate);
  server.addHook('preHandler',async(_request,reply)=>{reply.header('Cache-Control','private, no-store');});
  server.get<{Querystring:{archived?:boolean;query?:string;page?:number}}>('/inbox',{
    schema:{querystring:{type:'object',properties:{archived:{type:'boolean'},query:{type:'string',maxLength:100},page:{type:'integer',minimum:1,maximum:10000}}}},
  },async request=>{
    const {archived=false,query='',page=1}=request.query;
    const data=await prisma.$queryRaw`
      SELECT g.id,g.name,g."imageUrl",g."isPrivate",g."expiresAt",g.status::text,m."archivedAt",
        g."expiresAt"<=clock_timestamp() OR g.status<>'ACTIVE' AS closed,
        (SELECT count(*)::integer FROM group_members WHERE "groupId"=g.id AND status='ACTIVE') AS "memberCount",
        last_message.content AS "lastMessage",last_message.type AS "lastType",last_message."createdAt" AS "lastMessageAt",
        clock_timestamp() AS "serverTime"
      FROM group_members m JOIN groups g ON g.id=m."groupId"
      LEFT JOIN LATERAL (SELECT content,type::text,"createdAt" FROM messages WHERE "groupId"=g.id AND NOT "isDeleted" ORDER BY "createdAt" DESC,id DESC LIMIT 1) last_message ON true
      WHERE m."userId"=${request.user.sub} AND m.status='ACTIVE'
        AND EXISTS (SELECT 1 FROM users WHERE id=m."userId" AND status='ACTIVE')
        AND (m."archivedAt" IS NOT NULL OR g."expiresAt"<=clock_timestamp() OR g.status<>'ACTIVE')=${archived}
        AND position(lower(${query}) in lower(g.name))>0
      ORDER BY COALESCE(last_message."createdAt",g."createdAt") DESC,g.id LIMIT 30 OFFSET ${(page-1)*30}`;
    return {success:true,data};
  });
  server.get<{Params:{id:string}}>('/:id/lifecycle',async request=>({success:true,data:await prisma.$transaction(async tx=>{
    const {group,member}=await lockSocialGroup(tx,request.params.id,request.user.sub,false);
    return {name:group.name,expiresAt:group.expiresAt.getTime(),serverTime:group.now.getTime(),closed:group.status!=='ACTIVE'||group.now>=group.expiresAt,archived:!!member.archivedAt,canModerate:['OWNER','ADMIN'].includes(member.role)};
  })}));
  server.post<{Params:{id:string};Body:{archived:boolean}}>('/:id/archive',{
    schema:{body:{type:'object',required:['archived'],additionalProperties:false,properties:{archived:{type:'boolean'}}}},
  },async request=>{
    await prisma.$transaction(async tx=>{
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`archive:${request.params.id}:${request.user.sub}`},0))`;
      await lockSocialGroup(tx,request.params.id,request.user.sub,false);
      await tx.groupMember.update({where:{groupId_userId:{groupId:request.params.id,userId:request.user.sub}},data:{archivedAt:request.body.archived?new Date():null}});
    });
    return {success:true,data:{archived:request.body.archived}};
  });
}
