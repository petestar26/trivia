import {afterAll,beforeAll,expect,it,vi} from 'vitest';
vi.mock('@socialplay/database',()=>({prisma:{user:{findUnique:vi.fn(async()=>({status:'ACTIVE'}))}}}));
import Fastify from 'fastify';
import {registerPlugins} from './index.js';
import {config} from '@socialplay/config';
import {authenticate} from '../middleware/auth.js';
import {errorHandler} from '../middleware/error-handler.js';
const server=Fastify();
const mutation=vi.fn(async()=>({ok:true}));
let token:string;
beforeAll(async()=>{
  await registerPlugins(server);
  server.setErrorHandler(errorHandler);
  server.post('/write',{preHandler:authenticate},mutation);
  server.get('/read',{preHandler:authenticate},async()=>({ok:true}));
  token=server.jwt.sign({sub:'fixture'});
  await server.ready();
});
afterAll(()=>server.close());
it.each([undefined,'null','*','https://evil.example','https://localhost.evil.example'])('rejects cookie write from %s without reaching mutation',async origin=>{
  mutation.mockClear();
  const r=await server.inject({method:'POST',url:'/write',headers:{cookie:`sp_access_token=${token}`,...(origin?{origin}:{})}});
  expect(r.statusCode).toBe(403);expect(mutation).not.toHaveBeenCalled();
});
it('allows trusted cookie writes and safe cookie reads',async()=>{
  expect((await server.inject({method:'POST',url:'/write',headers:{cookie:`sp_access_token=${token}`,origin:new URL(config.FRONTEND_URL).origin}})).statusCode).toBe(200);
  expect((await server.inject({url:'/read',headers:{cookie:`sp_access_token=${token}`}})).statusCode).toBe(200);
});
it('retains bearer-only clients without ambient cookies',async()=>{
  expect((await server.inject({method:'POST',url:'/write',headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(200);
});
it('a bearer header cannot bypass origin enforcement when cookies are present',async()=>{
  expect((await server.inject({method:'POST',url:'/write',headers:{authorization:`Bearer ${token}`,cookie:`sp_refresh_token=fixture`,origin:'https://evil.example'}})).statusCode).toBe(403);
});
