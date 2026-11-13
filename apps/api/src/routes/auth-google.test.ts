import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyError, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
const db = vi.hoisted(() => ({ user: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }, userAuthIdentity: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }, session: { create: vi.fn() }, $transaction: vi.fn() }));
const verifier = vi.hoisted(() => vi.fn());
vi.mock('@socialplay/database', () => ({ prisma: db }));
vi.mock('@socialplay/config', () => ({ config: { GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', API_PREFIX: '/api/v1', JWT_ACCESS_SECRET: 'fixture-access-key', JWT_REFRESH_SECRET: 'fixture-refresh-key', JWT_ACCESS_EXPIRY: '15m', JWT_REFRESH_EXPIRY: '30d', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', NODE_ENV: 'production', COOKIE_SECURE: false, COOKIE_SAME_SITE: 'lax', FRONTEND_URL: 'https://app.example.test', CORS_ORIGIN: 'https://app.example.test' } }));
vi.mock('../auth/google-verifier.js', async original => ({ ...await original<typeof import('../auth/google-verifier.js')>(), googleIdTokenVerifier: verifier }));
vi.mock('../rewards/activity-service.js', () => ({ safeRecordActivity: vi.fn() }));
vi.mock('../referrals/referral-service.js', () => ({ canonicalizeReferralCode: vi.fn(), isValidReferralCode: vi.fn(), generateUniqueReferralCode: vi.fn().mockResolvedValue('fixture') }));
import { authRoutes } from './auth.js';
import { ApiError } from '../middleware/api-error.js';
import { config } from '@socialplay/config';
import { createGoogleVerifier, hashNonceSecret } from '../auth/google-verifier.js';
let server: ReturnType<typeof Fastify>;
const user = { id: 'fixture', username: 'fixture', email: null, displayName: 'Fixture', status: 'ACTIVE', role: 'USER', tokenVersion: 0, isVerified: false };
beforeEach(async () => {
  vi.resetAllMocks(); config.GOOGLE_CLIENT_ID = 'fixture.apps.googleusercontent.com';
  verifier.mockResolvedValue({ kind: 'verified', claims: { sub: 'google-sub', email: 'fixture@gmail.com', emailVerified: true } });
  db.user.findFirst.mockResolvedValue(null); db.user.create.mockResolvedValue(user); db.userAuthIdentity.findUnique.mockResolvedValue(null);
  db.$transaction.mockImplementation(fn => fn(db));
  server = Fastify(); await server.register(cookie);
  server.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => reply.code(err instanceof ApiError ? err.statusCode : err.statusCode ?? 500).send({ error: { message: err.message, code: (err as ApiError).code } }));
  await server.register(authRoutes, { prefix: '/api/v1/auth', db: db as never, credentialDb: db as never });
});
afterEach(async () => server.close());
const send = (body: object = { credential: 'signed-google-token', username: 'fixture' }, origin = 'https://app.example.test', cookieValue = 'sp_google_nonce=raw-fixture') => server.inject({ method: 'POST', url: '/api/v1/auth/google', headers: { origin, cookie: cookieValue }, payload: body });
describe('Google modern cookie integration', () => {
  it('issues a secure HttpOnly nonce and returns only its hash', async () => {
    const r = await server.inject('/api/v1/auth/google/nonce');
    expect(r.statusCode).toBe(200); const c = r.cookies.find((c: { name: string; value: string }) => c.name === 'sp_google_nonce')!;
    expect(c).toMatchObject({ secure: true, httpOnly: true, path: '/api/v1/auth/google', maxAge: 300 });
    expect(r.json().data.nonce).toBe(hashNonceSecret(c.value)); expect(r.headers['cache-control']).toContain('no-store');
  });
  it('registers Google ownership with secure cookies, no browser bearer tokens and no fake email/password', async () => {
    const r = await send(); expect(r.statusCode, r.body).toBe(201);
    expect(verifier).toHaveBeenCalledWith('signed-google-token', hashNonceSecret('raw-fixture'));
    expect(db.user.create.mock.calls[0][0].data).toMatchObject({ email: null, passwordHash: null });
    expect(db.userAuthIdentity.create.mock.calls[0][0].data).toMatchObject({ provider: 'GOOGLE', providerSubject: 'google-sub' });
    expect(r.json().data.accessToken).toBeUndefined(); expect(r.json().data.refreshToken).toBeUndefined();
    expect(r.cookies.find((c: { name: string; value: string }) => c.name === 'sp_access_token')).toMatchObject({ secure: true, httpOnly: true });
    expect(r.cookies.find((c: { name: string; value: string }) => c.name === 'sp_google_nonce')?.value).toBe('');
  });
  it('returning identities use the canonical account, preserve token version and omit browser tokens', async () => {
    db.userAuthIdentity.findUnique.mockResolvedValue({ id: 'identity', user });
    const r = await send({ credential: 'signed-google-token' }); expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data.user.id).toBe('fixture'); expect(r.json().data.accessToken).toBeUndefined();
    expect(db.user.create).not.toHaveBeenCalled(); expect(db.session.create).toHaveBeenCalledOnce();
  });
  it('requires username before any write and retains nonce for the second step', async () => {
    const r = await send({ credential: 'signed-google-token' }); expect(r.statusCode).toBe(422); expect(r.json().error.code).toBe('USERNAME_REQUIRED');
    expect(db.$transaction).not.toHaveBeenCalled(); expect(r.cookies).toHaveLength(0);
  });
  it('never auto-links an existing email owner', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'email-owner' }); const r = await send();
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('ACCOUNT_LINK_REQUIRED'); expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rejects foreign origin before verification or DB access', async () => {
    expect((await send(undefined, 'https://attacker.test')).statusCode).toBe(403); expect(verifier).not.toHaveBeenCalled(); expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each(['invalid','unavailable'])('denies %s verification without writes', async kind => {
    verifier.mockResolvedValue({ kind }); expect((await send()).statusCode).toBe(kind === 'invalid' ? 401 : 503); expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rejects missing nonce before verification', async () => {
    expect((await send(undefined, undefined, '')).statusCode).toBe(401); expect(verifier).not.toHaveBeenCalled();
  });
  it('rejects suspended Google accounts', async () => {
    db.userAuthIdentity.findUnique.mockResolvedValue({ id: 'identity', user: { ...user, status: 'SUSPENDED' } });
    expect((await send()).statusCode).toBe(403); expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('fails closed when no client is configured', async () => {
    config.GOOGLE_CLIENT_ID = undefined; expect((await send()).statusCode).toBe(503); expect((await server.inject('/api/v1/auth/google/nonce')).statusCode).toBe(503); expect(verifier).not.toHaveBeenCalled();
  });
  it.each([{}, { sub: 'id' }, { sub: 'id', nonce: 'wrong' }])('verifier rejects missing identity/nonce or mismatched nonce', async payload => {
    expect(await createGoogleVerifier(async () => payload, 'client')('token','expected')).toEqual({ kind: 'invalid' });
  });
  it('passes the configured audience to official verification and binds the nonce', async () => {
    const verify = vi.fn().mockResolvedValue({ sub: 'id', nonce: 'expected', email_verified: true });
    expect((await createGoogleVerifier(verify, 'client')('token','expected')).kind).toBe('verified'); expect(verify).toHaveBeenCalledWith({ idToken: 'token', audience: 'client' });
  });
});
