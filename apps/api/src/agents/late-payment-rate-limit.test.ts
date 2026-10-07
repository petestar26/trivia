import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
const report=vi.hoisted(()=>vi.fn(async()=>({id:'fixture'})));
vi.mock('../middleware/index.js',()=>({authenticate:async(req:any)=>{req.user={sub:'fixture',iat:1};},requirePermission:()=>async()=>{}}));
vi.mock('./late-payment-service.js',()=>({reportLatePayment:report,listLatePayments:vi.fn(async()=>[]),claimLatePayment:vi.fn(),recordLatePaymentRefund:vi.fn(),superviseLatePayment:vi.fn()}));
import {latePaymentRoutes} from './late-payment-routes.js';
const server=Fastify();
beforeAll(async()=>{await server.register(rateLimit,{max:1000});await server.register(latePaymentRoutes,{prefix:'/late-payments'});await server.ready();});
afterAll(()=>server.close());
it('caps report creation independently of the global request allowance',async()=>{
  for(let i=0;i<20;i++)expect((await server.inject({method:'POST',url:'/late-payments',payload:{}})).statusCode).toBe(200);
  expect((await server.inject({method:'POST',url:'/late-payments',payload:{}})).statusCode).toBe(429);
  expect(report).toHaveBeenCalledTimes(20);
  expect((await server.inject({url:'/late-payments/me'})).statusCode).toBe(200);
});
