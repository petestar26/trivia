import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
const db=vi.hoisted(()=>({user:{findUniqueOrThrow:vi.fn()},agent:{findUnique:vi.fn(),findMany:vi.fn()},country:{findMany:vi.fn()}}));
vi.mock('@socialplay/database',()=>({prisma:db}));
vi.mock('../middleware',()=>({authenticate:async(request:any)=>{request.user={sub:'customer'};}}));
vi.mock('../economy/wallet-service',()=>({getWalletBalance:vi.fn(),getWalletTransactions:vi.fn()}));
import {walletRoutes} from './wallet';
let server:ReturnType<typeof Fastify>;
beforeEach(async()=>{vi.clearAllMocks();db.user.findUniqueOrThrow.mockResolvedValue({role:'USER'});db.agent.findUnique.mockResolvedValue(null);db.country.findMany.mockResolvedValue([]);db.agent.findMany.mockResolvedValue([]);server=Fastify();await server.register(walletRoutes,{prefix:'/wallet'});});
afterEach(async()=>{await server.close();});
it('uses current database role and discloses no payout destinations in the directory',async()=>{
 const r=await server.inject('/wallet/payment-options');expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');expect(r.json().data).toMatchObject({isAgent:false,isAdmin:false});
 const query=db.agent.findMany.mock.calls[0][0];expect(query.where).toMatchObject({status:'ACTIVE',userId:{not:'customer'},user:{status:'ACTIVE'},country:{isActive:true,agentPaymentEnabled:true}});
 expect(JSON.stringify(query.select)).not.toContain('accountDetails');expect(JSON.stringify(query.select)).not.toContain('contactEmail');
});
it('filters mismatched payment methods even if a legacy row has inconsistent countries',async()=>{
 db.agent.findMany.mockResolvedValue([{id:'a',countryId:'c',paymentAccounts:[{id:'safe',countryId:'c',methodDef:{name:'Bank',countryId:'c'}},{id:'bad',countryId:'c',methodDef:{name:'Bank',countryId:'other'}}]}]);
 const r=await server.inject('/wallet/payment-options');expect(r.json().data.agents[0].paymentAccounts.map((p:any)=>p.id)).toEqual(['safe']);
});
