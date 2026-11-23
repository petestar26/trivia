import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ApiError } from '../middleware/api-error.js';

const staffId = z.string().uuid();
const amountMinor = z.string().regex(/^[1-9][0-9]{0,9}$/).refine(x => BigInt(x)<=2147483647n);
const idempotencyKey = z.string().uuid();
const receipt = z.object({ managerId:staffId, amountMinor, receiptReference:z.string().trim().min(4).max(128)
  .refine(x=>!/[\u0000-\u001F\u007F]/.test(x)),idempotencyKey }).strict();
const allocation = z.object({ agentId:staffId, amountMinor,idempotencyKey }).strict();
const session = z.object({sub:staffId,tokenVersion:z.number().int().min(0).max(2147483647)});
export function createDepositFundingRoutes(db:Pick<PrismaClient,'$queryRaw'>, trustedOrigin:string):FastifyPluginAsync {
  const origin = new URL(trustedOrigin);
  if (origin.protocol!=='https:' || trustedOrigin!==origin.origin || origin.username || origin.password)
    throw new Error('Exact HTTPS staff origin required');
  return async app => {
    if (!app.hasDecorator('jwt') || !app.hasDecorator('rateLimit')) throw new Error('Authentication and rate limiting required');
    async function access(request:FastifyRequest, write = true) {
      if ((write ? request.headers.origin!==trustedOrigin || request.headers['x-staff-request']!=='1'
          : request.headers.origin!==undefined && request.headers.origin!==trustedOrigin) ||
          (request.headers['sec-fetch-site']!==undefined && request.headers['sec-fetch-site']!=='same-origin'))
        throw ApiError.forbidden();
      if (write && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(request.headers['content-type'] ?? '')))
        throw new ApiError('JSON required',415);
      if (!z.object({}).strict().safeParse(request.query).success) throw ApiError.badRequest('Invalid staff request');
      try { return session.parse(await request.jwtVerify()); }
      catch { throw ApiError.unauthorized(); }
    }
    app.addHook('onSend',async (_req,reply,payload)=>{
      reply.header('Cache-Control','private, no-store');
      return payload;
    });
    app.setErrorHandler((e,_request,reply)=>{
      const status = [400,401,403,413,415,429].includes(e.statusCode ?? 0) ? e.statusCode! : 503;
      const code = status===503 ? 'FUNDING_STATUS_UNKNOWN' : 'FUNDING_REQUEST_REFUSED';
      return reply.code(status).send({success:false,error:{code,message:status===503
        ? 'Confirmation unavailable. Retry the same request.'
        : 'Funding request refused.'}});
    });
    const config = {bodyLimit:4096,logLevel:'silent' as const,config:{rateLimit:{max:10,timeWindow:60_000}}};
    app.get('/targets',config,async request=>{
      const actor=await access(request,false);
      const [r]=await db.$queryRaw<{value:unknown}[]>`
        SELECT deposit_funding_entry.targets(${actor.sub}::text,${actor.tokenVersion}::int) AS value`;
      if(!r?.value) throw ApiError.forbidden();
      return {success:true,data:r.value};
    });
    app.post('/receipts',config,async request=>{
      const actor=await access(request);
      const body=receipt.safeParse(request.body);
      if(!body.success) throw ApiError.badRequest('Invalid receipt');
      const b=body.data;
      const [r]=await db.$queryRaw<{ok:boolean}[]>`SELECT deposit_funding_entry.record_receipt(
       ${actor.sub}::text,${actor.tokenVersion}::int,${b.managerId}::text,${BigInt(b.amountMinor)}::bigint,
       ${b.idempotencyKey}::text,${b.receiptReference}::text) AS ok`;
      if(r?.ok!==true) throw ApiError.forbidden();
      return {success:true,data:{recorded:true}};
    });
    app.post('/allocations',config,async request=>{
      const actor=await access(request);
      const body=allocation.safeParse(request.body);
      if(!body.success) throw ApiError.badRequest('Invalid allocation');
      const b=body.data;
      const [r]=await db.$queryRaw<{ok:boolean}[]>`SELECT deposit_funding_entry.allocate(
        ${actor.sub}::text,${actor.tokenVersion}::int,${b.agentId}::text,${BigInt(b.amountMinor)}::bigint,
        ${b.idempotencyKey}::text) AS ok`;
      if(r?.ok!==true) throw ApiError.forbidden();
      return {success:true,data:{allocated:true}};
    });
  };
}
