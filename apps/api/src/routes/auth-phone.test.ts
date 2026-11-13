import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyError, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { registerSchema, loginSchema } from '@socialplay/shared';
const db = vi.hoisted(() => ({ user: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() }, userAuthIdentity: { findUnique: vi.fn(), create: vi.fn() }, session: { create: vi.fn() }, $transaction: vi.fn() }));
vi.mock('@socialplay/database', () => ({ prisma: db }));
vi.mock('@socialplay/config', () => ({ config: { JWT_ACCESS_SECRET: 'fixture-access-key', JWT_REFRESH_SECRET: 'fixture-refresh-key', JWT_ACCESS_EXPIRY: '15m', JWT_REFRESH_EXPIRY: '30d', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', COOKIE_SECURE: true, COOKIE_SAME_SITE: 'lax', FRONTEND_URL: 'https://app.example.test', CORS_ORIGIN: 'https://app.example.test', RATE_LIMIT_AUTH_MAX_REQUESTS: 10, RATE_LIMIT_AUTH_WINDOW_MS: 900000 } }));
vi.mock('../rewards/activity-service.js', () => ({ safeRecordActivity: vi.fn() }));
vi.mock('../referrals/referral-service.js', () => ({ canonicalizeReferralCode: vi.fn(), isValidReferralCode: vi.fn(), generateUniqueReferralCode: vi.fn().mockResolvedValue('fixture') }));
import { authRoutes } from './auth.js';
import { ApiError } from '../middleware/api-error.js';
import { hashPassword } from '../utils/auth.js';
const password = 'Password123!';
let server: ReturnType<typeof Fastify>;
let user: any;
beforeEach(async () => {
  vi.clearAllMocks();
  user = { id: 'fixture', username: 'fixture', email: null, passwordHash: await hashPassword(password), status: 'ACTIVE', role: 'USER', tokenVersion: 0, isVerified: false };
  db.user.findFirst.mockResolvedValue(null); db.user.findUnique.mockResolvedValue(user); db.user.create.mockResolvedValue(user);
  db.userAuthIdentity.findUnique.mockResolvedValue(null); db.userAuthIdentity.create.mockResolvedValue({});
  db.$transaction.mockImplementation(fn => fn(db));
  server = Fastify(); await server.register(cookie); await server.register(rateLimit);
  server.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => reply.code(err instanceof ApiError ? err.statusCode : err.statusCode ?? 500).send({ message: err.message }));
  await server.register(authRoutes, { prefix: '/auth', db: db as never, credentialDb: db as never });
});
afterEach(async () => { await server.close(); });
const send = (route: string, payload: object) => server.inject({ method: 'POST', url: '/auth/' + route, payload });
describe('phone/password identities without verification', () => {
  it('registers a normalized unverified PHONE identity with no fake email', async () => {
    const result = await send('register', { username: 'fixture', phone: '+251 (911) 234-567', password });
    expect(result.statusCode, result.body).toBe(201);
    expect(db.user.create.mock.calls[0][0].data.email).toBeNull();
    expect(db.userAuthIdentity.create.mock.calls[0][0].data).toMatchObject({ provider: 'PHONE', providerSubject: '+251911234567', verifiedAt: null });
    expect(result.json().data.user.isVerified).toBe(false);
    expect(result.cookies.some((c: { name: string }) => c.name === 'sp_access_token')).toBe(true);
  });
  it('retains email registration', async () => {
    expect((await send('register', { username: 'fixture', email: 'a@example.test', password })).statusCode).toBe(201);
    expect(db.userAuthIdentity.create.mock.calls[0][0].data).toMatchObject({ provider: 'EMAIL', providerSubject: 'a@example.test', verifiedAt: null });
  });
  it.each(['register', 'login'])('rejects ambiguous/invalid identifiers at %s before DB access', async route => {
    for (const fields of [{}, { phone: '0911234567' }, { phone: '+0251911234567' }, { phone: '+251911234567', email: 'a@example.test' }, { phone: '+251911234567 ext 1' }]) {
      expect((await send(route, { username: 'fixture', password, ...fields })).statusCode).toBe(400);
    }
    expect(db.user.findUnique).not.toHaveBeenCalled(); expect(db.user.create).not.toHaveBeenCalled(); expect(db.userAuthIdentity.findUnique).not.toHaveBeenCalled();
  });
  it('does not link an existing phone identity', async () => {
    db.userAuthIdentity.findUnique.mockResolvedValue({ userId: 'other' });
    expect((await send('register', { username: 'fixture', phone: '+251911234567', password })).statusCode).toBe(409);
    expect(db.user.create).not.toHaveBeenCalled();
  });
  it('classifies concurrent identity conflicts without retry', async () => {
    db.$transaction.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['provider', 'providerSubject'] } });
    expect((await send('register', { username: 'fixture', phone: '+251911234567', password })).statusCode).toBe(409);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
  it('logs in via canonical PHONE identity and real password check', async () => {
    db.userAuthIdentity.findUnique.mockResolvedValue({ user });
    const result = await send('login', { phone: '+251 911 234567', password });
    expect(result.statusCode, result.body).toBe(200);
    expect(db.userAuthIdentity.findUnique).toHaveBeenCalledWith({ where: { provider_providerSubject: { provider: 'PHONE', providerSubject: '+251911234567' } }, select: { user: { select: { id: true, email: true, username: true, role: true, status: true, tokenVersion: true, passwordHash: true, displayName: true, createdAt: true, isVerified: true } } } });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
  it.each(['missing', 'wrong-password', 'provider-only', 'banned'])('denies %s without a session', async kind => {
    if (kind === 'provider-only') user.passwordHash = null;
    if (kind === 'banned') user.status = 'BANNED';
    db.userAuthIdentity.findUnique.mockResolvedValue(kind === 'missing' ? null : { user });
    expect((await send('login', { phone: '+251911234567', password: kind === 'wrong-password' ? 'wrong' : password })).statusCode).toBe(kind === 'banned' ? 403 : 401);
    expect(db.session.create).not.toHaveBeenCalled();
  });
  it('keeps browser tokens in cookies and rejects foreign origins', async () => {
    db.userAuthIdentity.findUnique.mockResolvedValue({ user });
    const result = await server.inject({ method: 'POST', url: '/auth/login', payload: { phone: '+251911234567', password }, headers: { origin: 'https://app.example.test' } });
    expect(result.statusCode).toBe(200); expect(result.json().data.accessToken).toBeUndefined();
    expect((await server.inject({ method: 'POST', url: '/auth/register', payload: { username: 'fixture', phone: '+251911234567', password }, headers: { origin: 'https://evil.example.test' } })).statusCode).toBe(403);
  });
  it('rate limits phone attempts', async () => {
    for (let i = 0; i < 10; i++) expect((await send('login', { phone: '+251911234567', password })).statusCode).toBe(401);
    expect((await send('login', { phone: '+251911234567', password })).statusCode).toBe(429);
  });
  it('shared schemas require exactly one identifier', () => {
    for (const schema of [registerSchema, loginSchema]) {
      expect(schema.safeParse({ username: 'fixture', phone: '+251911234567', password }).success).toBe(true);
      expect(schema.safeParse({ username: 'fixture', email: 'a@example.test', phone: '+251911234567', password }).success).toBe(false);
    }
  });
});
