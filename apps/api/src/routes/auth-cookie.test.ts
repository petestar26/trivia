import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { ApiError } from '../middleware/api-error.js';

const db = vi.hoisted(() => ({ session: {
  findUnique: vi.fn(), delete: vi.fn(), create: vi.fn(), deleteMany: vi.fn(),
}, $transaction: vi.fn() }));
vi.mock('@socialplay/database', () => ({ prisma: db }));
vi.mock('@socialplay/config', () => ({ config: {
  FRONTEND_URL: 'https://app.example.test', CORS_ORIGIN: 'https://app.example.test,https://other.example.test',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
  JWT_ACCESS_EXPIRY: '15m', JWT_REFRESH_EXPIRY: '30d', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test',
  COOKIE_SECURE: true, COOKIE_SAME_SITE: 'lax', RATE_LIMIT_AUTH_MAX_REQUESTS: 10, RATE_LIMIT_AUTH_WINDOW_MS: 900000,
} }));
vi.mock('../middleware', async () => {
  const { ApiError } = await import('../middleware/api-error.js');
  return { ApiError, authenticate: async (request: any) => {
    try { request.user = await request.jwtVerify(); } catch { throw ApiError.unauthorized('Expired'); }
  } };
});
vi.mock('../rewards/activity-service', () => ({ safeRecordActivity: vi.fn() }));
vi.mock('../referrals/referral-service.js', () => ({ canonicalizeReferralCode: vi.fn(), isValidReferralCode: vi.fn(), generateUniqueReferralCode: vi.fn() }));
import { authRoutes } from './auth.js';
import { generateTokens } from '../utils/auth.js';
import { config } from '@socialplay/config';

let server: FastifyInstance;
let token: string;
beforeEach(async () => {
  vi.resetAllMocks();
  server = Fastify();
  await server.register(cookie);
  await server.register(jwt, { secret: config.JWT_ACCESS_SECRET, cookie: { cookieName: 'sp_access_token', signed: false } });
  await server.register(rateLimit, {max:1000});
  server.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof ApiError ? error.statusCode : error.statusCode ?? 500).send({ error: { message: error.message } });
  });
  await server.register(authRoutes, { prefix: '/auth' });
  token = generateTokens('alice', 'fixture@example.test', 'fixture', ['USER'], 0).refreshToken;
  db.session.findUnique.mockResolvedValue({ id: 'session', userId: 'alice', expiresAt: new Date(Date.now() + 60000),
    user: { id: 'alice', email: 'fixture@example.test', username: 'fixture', role: 'USER', status: 'ACTIVE', tokenVersion: 0 } });
  db.$transaction.mockImplementation((action: any) => action(db));
});
afterEach(async () => { await server.close(); });
const headers = () => ({ origin: 'https://app.example.test', cookie: `sp_refresh_token=${token}` });

describe('browser cookie renewal and logout', () => {
  it.each(['cookie','json'])('a rotated %s token cannot exhaust the live account refresh quota',async mode=>{
    let currentToken:string|null=token;
    const staleToken=token;
    const session={id:'live-session',userId:'alice',expiresAt:new Date(Date.now()+60000),
      user:{id:'alice',username:'alice',role:'USER',status:'ACTIVE',tokenVersion:0}};
    db.session.findUnique.mockImplementation(async({where})=>where.refreshToken===currentToken?session:null);
    db.session.delete.mockImplementation(async()=>{currentToken=null;});
    db.session.create.mockImplementation(async({data})=>{currentToken=data.refreshToken;return data;});
    const refresh=(value:string)=>server.inject({method:'POST',url:'/auth/refresh',
      payload:mode==='json'?{refreshToken:value}:{},
      headers:mode==='cookie'?{origin:config.FRONTEND_URL,cookie:`sp_refresh_token=${value}`}:{}});
    expect((await refresh(staleToken)).statusCode).toBe(200);
    expect(currentToken).not.toBe(staleToken);
    for(let i=0;i<10;i++)expect((await refresh(staleToken)).statusCode).toBe(401);
    expect((await refresh(staleToken)).statusCode).toBe(429);
    const valid=await refresh(currentToken!);
    expect(valid.statusCode,valid.body).toBe(200);
    expect(valid.cookies.some((c:{name:string})=>c.name==='sp_refresh_token')).toBe(true);
  });
  it('isolates 20 refresh accounts behind one proxy and retains the quota across token rotations', async () => {
    const tokens=Array.from({length:20},(_,i)=>generateTokens(`user-${i}`,null,`user-${i}`,['USER'],0).refreshToken);
    db.session.findUnique.mockImplementation(async({where})=>{
      const decoded=server.jwt.verify(where.refreshToken,{key:config.JWT_REFRESH_SECRET}) as {sub:string};
      return {id:`session-${decoded.sub}`,userId:decoded.sub,expiresAt:new Date(Date.now()+60000),
        user:{id:decoded.sub,username:decoded.sub,role:'USER',status:'ACTIVE',tokenVersion:0}};
    });
    for(let i=0;i<tokens.length;i++){
      const r=await server.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:tokens[i]}});
      expect(r.statusCode,r.body).toBe(200);tokens[i]=r.json().data.refreshToken;
    }
    // Alternate JSON and cookie clients; fresh jti values keep the same bucket.
    for(let i=1;i<10;i++){
      const r=await server.inject({method:'POST',url:'/auth/refresh',payload:i%2?{}:{refreshToken:tokens[0]},headers:i%2?{origin:config.FRONTEND_URL,cookie:`sp_refresh_token=${tokens[0]}`}:{}});
      expect(r.statusCode,r.body).toBe(200);tokens[0]=r.cookies.find((c:{name:string;value:string})=>c.name==='sp_refresh_token')!.value;
    }
    expect((await server.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:tokens[0]}})).statusCode).toBe(429);
    expect((await server.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:tokens[1]}})).statusCode).toBe(200);
  });
  it('keeps forged, expired and access-only tokens in the anonymous refresh allowance', async () => {
    db.session.findUnique.mockResolvedValue(null);
    const access=generateTokens('alice',null,'alice',['USER']).accessToken;
    const expired=server.jwt.sign({sub:'fake',tokenVersion:0,exp:1},{key:config.JWT_REFRESH_SECRET});
    for(let i=0;i<11;i++){
      const r=await server.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:i===0?access:i===1?expired:`forged-${i}`},headers:{'x-forwarded-for':`203.0.113.${i}`}});
      expect(r.statusCode,r.body).toBe(i<10?401:429);
    }
  });
  it('rotates a valid HttpOnly session with no token in body or response', async () => {
    const r = await server.inject({ method: 'POST', url: '/auth/refresh', headers: headers(), payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true, data: { expiresIn: 900 } });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.cookies.map(c => c.name)).toEqual(['sp_access_token', 'sp_refresh_token']);
    expect(r.cookies.every(c => c.httpOnly && c.secure && c.sameSite === 'Lax')).toBe(true);
    expect(db.session.delete).toHaveBeenCalledWith({ where: { id: 'session' } });
    expect(db.session.create).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 'null', '*', 'https://evil.test', 'https://app.example.test.evil.test'])('rejects untrusted cookie origin %s before looking up credentials', async (origin) => {
    const r = await server.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: `sp_refresh_token=${token}`, ...(origin ? { origin } : {}) }, payload: {} });
    expect(r.statusCode).toBe(403); expect(db.session.findUnique).not.toHaveBeenCalled();
  });
  it('preserves explicit token clients without Origin and does not use a cookie fallback', async () => {
    const r = await server.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: token } });
    expect(r.statusCode).toBe(200); expect(r.json().data.refreshToken).toBeTruthy();
    db.session.findUnique.mockResolvedValue(null);
    const bad = await server.inject({ method: 'POST', url: '/auth/refresh', headers: headers(), payload: { refreshToken: 'invalid' } });
    expect(bad.statusCode).toBe(401);
    expect(db.session.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({ where: { refreshToken: 'invalid' } }));
  });
  it('rejects expired, revoked and inactive sessions without setting cookies', async () => {
    for (const session of [null,
      { expiresAt: new Date(0) },
      { expiresAt: new Date(Date.now()+60000), user: { status: 'BANNED' } },
      { expiresAt: new Date(Date.now()+60000), user: { status: 'ACTIVE', tokenVersion: 1 } },
    ]) {
      db.session.findUnique.mockResolvedValue(session);
      const r = await server.inject({ method: 'POST', url: '/auth/refresh', headers: headers(), payload: {} });
      expect([401,403]).toContain(r.statusCode); expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('keeps a losing concurrent rotation unauthorized and never overwrites the winner cookie', async () => {
    db.$transaction.mockRejectedValue({ code: 'P2025' });
    const r = await server.inject({ method: 'POST', url: '/auth/refresh', headers: headers(), payload: {} });
    expect(r.statusCode).toBe(401); expect(r.headers['set-cookie']).toBeUndefined();
  });
  it('revokes and clears cookies after access expiry using the stored refresh session', async () => {
    const r = await server.inject({ method: 'POST', url: '/auth/logout', headers: headers() });
    expect(r.statusCode).toBe(200);
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'alice' } });
    expect(r.cookies).toHaveLength(2); expect(r.cookies.every(c => c.value === '')).toBe(true);
  });
  it('rejects cross-origin logout without revocation or cookie changes', async () => {
    const r = await server.inject({ method: 'POST', url: '/auth/logout', headers: { ...headers(), origin: 'https://evil.test' } });
    expect(r.statusCode).toBe(403); expect(db.session.deleteMany).not.toHaveBeenCalled(); expect(r.cookies).toHaveLength(0);
  });
});
