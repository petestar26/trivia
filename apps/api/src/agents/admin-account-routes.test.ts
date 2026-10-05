import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  pending: vi.fn(),
  reissue: vi.fn(),
  activate: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: { user: { findUnique: m.findUnique } } }));
vi.mock('./admin-account-service.js', () => ({
  createAdminAgent: m.create,
  listPendingAgentAccounts: m.pending,
  reissueAgentPassword: m.reissue,
  activateAdminAgent: m.activate,
}));
vi.mock('../middleware/index.js', async (original) => {
  const actual = await original<any>();
  return {
    ...actual,
    authenticate: async (req: any) => {
      if (!req.headers.authorization) throw actual.ApiError.unauthorized('Authentication required');
      req.user = { sub: 'actor', roles: ['ADMIN'] };
    },
  };
});
import { adminAgentAccountRoutes } from './admin-account-routes.js';
let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  vi.resetAllMocks();
  m.findUnique.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE' });
  m.create.mockResolvedValue({ username: 'agent' });
  m.pending.mockResolvedValue([]);
  m.reissue.mockResolvedValue({});
  m.activate.mockResolvedValue({ message: 'Done' });
  app = Fastify();
  app.setErrorHandler((e, _req, reply) =>
    reply.status(e.statusCode ?? 500).send({ message: e.message })
  );
  await app.register(rateLimit, { global: false });
  await app.register(adminAgentAccountRoutes, { prefix: '/agents' });
});
afterEach(() => app.close());
it.each([
  { method: 'POST' as const, url: '/agents/admin/accounts' },
  { method: 'GET' as const, url: '/agents/admin/accounts/pending' },
  { method: 'POST' as const, url: '/agents/admin/accounts/id/reissue' },
])('rejects anonymous, demoted and suspended administrators on $url', async (route) => {
  expect((await app.inject(route)).statusCode).toBe(401);
  m.findUnique.mockResolvedValue({ role: 'USER', status: 'ACTIVE' });
  expect((await app.inject({ ...route, headers: { authorization: 'fixture' } })).statusCode).toBe(
    403
  );
  m.findUnique.mockResolvedValue({ role: 'ADMIN', status: 'SUSPENDED' });
  expect((await app.inject({ ...route, headers: { authorization: 'fixture' } })).statusCode).toBe(
    403
  );
  expect(m.create).not.toHaveBeenCalled();
  expect(m.pending).not.toHaveBeenCalled();
  expect(m.reissue).not.toHaveBeenCalled();
});
it('keeps activation responses private and rate limits anonymous credential attempts', async () => {
  for (let i = 0; i < 5; i++) {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/activate-account',
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
  }
  expect(
    (await app.inject({ method: 'POST', url: '/agents/activate-account', payload: {} })).statusCode
  ).toBe(429);
  expect(m.activate).toHaveBeenCalledTimes(5);
});
it('passes only the authenticated actor to account creation and never caches the response', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/agents/admin/accounts',
    headers: { authorization: 'fixture' },
    payload: { username: 'agent' },
  });
  expect(response.statusCode).toBe(201);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(m.create).toHaveBeenCalledWith('actor', { username: 'agent' });
});
