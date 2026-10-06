import { afterAll, beforeAll, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '@socialplay/config';
import { registerPlugins } from './index.js';
import { anonymousRateLimitKey } from './rate-limit-identity.js';
// Real first-party gateway, not a reconstructed header-forwarding mock.
// @ts-ignore Node-only JS gateway has no declaration file.
import { createWebServer } from '../../../web/server.mjs';

const secret = 'disposable-gateway-review-key-for-tests-only';
const priorSecret = config.WEB_GATEWAY_SECRET;
const api = Fastify();
let edge:Server, socketGateway:Server, origin:string, socketOrigin:string;
const listen = (server:Server) => new Promise<string>(resolve => server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
beforeAll(async()=>{
  config.WEB_GATEWAY_SECRET=secret;
  await registerPlugins(api);
  api.get('/api/poll',{config:{rateLimit:{max:90,timeWindow:'1 minute'}}},async()=>({ok:true}));
  api.get('/api/public',{config:{rateLimit:{max:2,timeWindow:'1 minute'}}},async()=>({ok:true}));
  api.get('/api/sign-in',{config:{rateLimit:{max:2,timeWindow:'1 minute',keyGenerator:request=>anonymousRateLimitKey(request,secret)}}},async()=>({ok:true}));
  const upstream = await api.listen({port:0,host:'127.0.0.1'});
  edge=createWebServer({apiOrigin:upstream,gatewaySecret:secret,clientIpSource:'railway'});
  socketGateway=createWebServer({apiOrigin:upstream,gatewaySecret:secret});
  origin=await listen(edge);socketOrigin=await listen(socketGateway);
});
afterAll(async()=>{
  config.WEB_GATEWAY_SECRET=priorSecret;
  for(const server of [edge,socketGateway])if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  api.server.closeAllConnections();await api.close();
});
it('gives two authenticated users independent 90-per-minute allowances through one gateway',async()=>{
  const a=api.jwt.sign({sub:'review-a'}),b=api.jwt.sign({sub:'review-b'});
  for(let i=0;i<60;i++)for(const token of [a,b])expect((await fetch(`${origin}/api/poll`,{headers:{authorization:`Bearer ${token}`,'x-real-ip':'203.0.113.10'}})).status).toBe(200);
  for(let i=0;i<30;i++)expect((await fetch(`${origin}/api/poll`,{headers:{cookie:`sp_access_token=${a}`,'x-real-ip':'203.0.113.10'}})).status).toBe(200);
  expect((await fetch(`${origin}/api/poll`,{headers:{authorization:`Bearer ${a}`,'x-real-ip':'203.0.113.10'}})).status).toBe(429);
  expect((await fetch(`${origin}/api/poll`,{headers:{authorization:`Bearer ${b}`,'x-real-ip':'203.0.113.10'}})).status).toBe(200);
});
it('separates anonymous sign-in clients attested by the configured ingress',async()=>{
  for(const ip of ['198.51.100.20','198.51.100.21']){
    for(let i=0;i<2;i++)expect((await fetch(`${origin}/api/sign-in`,{headers:{'x-real-ip':ip}})).status).toBe(200);
    expect((await fetch(`${origin}/api/sign-in`,{headers:{'x-real-ip':ip}})).status).toBe(429);
  }
});
it('ignores forged forwarded identities and invalid JWTs on the direct API',async()=>{
  for(let i=0;i<3;i++){
    const response=await api.inject({url:'/api/public',remoteAddress:'192.0.2.15',headers:{authorization:`Bearer forged-${i}`,'x-forwarded-for':`198.51.100.${i}`,'x-playqube-client-ip':`198.51.100.${i}`,'x-playqube-client-time':String(Date.now()),'x-playqube-client-signature':'0'.repeat(64)}});
    expect(response.statusCode).toBe(i<2?200:429);
  }
});
it('the socket gateway strips client-supplied proxy identities before signing',async()=>{
  for(let i=0;i<3;i++){
    const response=await fetch(`${socketOrigin}/api/public`,{headers:{'x-forwarded-for':`203.0.113.${i}`,'x-real-ip':`203.0.113.${i}`,'x-playqube-client-ip':`203.0.113.${i}`}});
    expect(response.status).toBe(i<2?200:429);
  }
});
it('binds a gateway attestation to its address, method, path and short lifetime',()=>{
  const timestamp=String(Date.now()),ip='203.0.113.77',method='GET',url='/api/public';
  const signature=createHmac('sha256',secret).update(JSON.stringify([timestamp,method,url,ip])).digest('hex');
  const request={ip:'127.0.0.1',method,raw:{url},headers:{'x-playqube-client-ip':ip,'x-playqube-client-time':timestamp,'x-playqube-client-signature':signature}} as unknown as FastifyRequest;
  expect(anonymousRateLimitKey(request,secret)).toBe(`ip:${ip}`);
  for(const change of [{method:'POST'},{raw:{url:'/api/other'}},{headers:{...request.headers,'x-playqube-client-ip':'203.0.113.78'}},{headers:{...request.headers,'x-playqube-client-time':String(Date.now()-60000)}}]){
    expect(anonymousRateLimitKey({...request,...change} as FastifyRequest,secret)).toBe('ip:127.0.0.1');
  }
});
