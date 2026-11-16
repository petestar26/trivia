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
vi.mock('../auth/password-reset.js', () => ({ completePasswordReset: vi.fn() }));
import { authRoutes } from './auth.js';
import { completePasswordReset } from '../auth/password-reset.js';
import { config } from '@socialplay/config';


let server: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  server = Fastify();
  server.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof ApiError ? error.statusCode : error.statusCode ?? 500)
      .send({ success: false, error: { message: error.message } });
  });
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  server.get('/health', async () => ({ healthy: true }));
});
afterEach(async () => { await server.close(); });
const paths = [
  '/api/v1/auth/password-reset',
  '/api/v1/auth/password-reset?token=synthetic',
  '/api/v1/auth/password%2Dreset',
  '/api/v1/auth/password-reset/',
  '/api/v1/auth//password-reset',
];
describe('temporary unconditional reset cutover barrier', () => {
  it.each(paths)('never executes redemption for direct request %s', async url => {
    const result = await server.inject({ method: 'POST', url,
      payload: { token: 'synthetic', password: 'Synthetic123!' } });
    if (url === paths[0] || url === paths[1]) expect(result.statusCode).toBe(503);
    else expect([404, 503]).toContain(result.statusCode);
    expect(completePasswordReset).not.toHaveBeenCalled();
  });
  it('denies before parsing a malformed body and does not clear cookies', async () => {
    const result = await server.inject({ method: 'POST', url: paths[0],
      headers: { 'content-type': 'application/json' }, payload: '{' });
    expect(result.statusCode).toBe(503);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(completePasswordReset).not.toHaveBeenCalled();
  });
  it('does not disable an unrelated health route', async () => {
    expect((await server.inject('/health')).statusCode).toBe(200);
  });
  it('covers the real web gateway as well as the direct API', async () => {
    // @ts-expect-error The web gateway is a plain JavaScript deployment entrypoint.
    const { createWebServer } = await import('../../../web/server.mjs');
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address() as { port: number };
    const gateway = createWebServer({ apiOrigin: `http://127.0.0.1:${address.port}` });
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${gateway.address().port}`;
    const previousOrigin = config.FRONTEND_URL;
    config.FRONTEND_URL = origin;
    try {
      const result = await fetch(origin + paths[0] + '?synthetic=1', {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'synthetic', password: 'Synthetic123!' }),
      });
      expect(result.status).toBe(503);
      expect(result.headers.get('cache-control')).toContain('no-store');
      expect(completePasswordReset).not.toHaveBeenCalled();
    } finally {
      config.FRONTEND_URL = previousOrigin;
      gateway.closeAllConnections();
      await new Promise<void>(resolve => gateway.close(resolve));
    }
  });
});
