import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { it, expect, vi } from 'vitest';
import { supportRoutes } from './routes.js';
const mocks = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ id: 'request' }),
  list: vi.fn().mockResolvedValue({ tickets: [] }),
  read: vi.fn(),
  reply: vi.fn(),
  setStatus: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: {} }));
vi.mock('./service.js', () => ({ createSupportService: () => mocks }));
vi.mock('../middleware/auth.js', () => ({
  authenticate: async (req: any) => {
    if (!req.headers.authorization) throw Object.assign(Error('Auth'), { statusCode: 401 });
    req.user = { sub: req.headers.authorization };
  },
  requireRole: () => async (req: any) => {
    if (req.user.sub !== 'admin') throw Object.assign(Error('Forbidden'), { statusCode: 403 });
  },
}));
it('authenticates support and isolates admin routes', async () => {
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  await app.register(supportRoutes, { prefix: '/support' });
  try {
    expect((await app.inject('/support/tickets')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/support/admin/tickets', headers: { authorization: 'member' } }))
        .statusCode
    ).toBe(403);
    const response = await app.inject({
      url: '/support/tickets',
      headers: { authorization: 'member' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(mocks.list).toHaveBeenCalledWith('member', false, 0, 'ALL');
  } finally {
    await app.close();
  }
});
it('validates empty messages and identifiers before persistence', async () => {
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  await app.register(supportRoutes, { prefix: '/support' });
  try {
    for (const body of ['', '   ']) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/support/tickets',
            headers: { authorization: 'member' },
            payload: {
              subject: 'Question',
              category: 'GENERAL',
              body,
              requestId: 'bd346811-31de-40ea-9371-573bcd087524',
            },
          })
        ).statusCode
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          url: '/support/tickets/not-an-id',
          headers: { authorization: 'member' },
        })
      ).statusCode
    ).toBe(400);
  } finally {
    await app.close();
  }
});
