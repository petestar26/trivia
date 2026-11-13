import Fastify, { type FastifyError, type FastifyRequest, type FastifyReply } from 'fastify';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  agent: { findUnique: vi.fn(), count: vi.fn() },
  group: { count: vi.fn() },
  gameDefinition: { count: vi.fn(), findMany: vi.fn() },
  agentApplication: { count: vi.fn() },
  agentPaymentAccount: { count: vi.fn() },
  country: { count: vi.fn() },
  auditLog: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: m }));
// Explicit staff client: unauthorized requests must never open a staff transaction.
const staff = vi.hoisted(() => ({ mode: 'dormant', $transaction: vi.fn(), verify: vi.fn(), $disconnect: vi.fn() }));
vi.mock('../middleware/index.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    authenticate: async (req: any) => {
      if (!req.headers.authorization) throw actual.ApiError.unauthorized('Authentication required');
      req.user = { sub: 'actor', roles: ['ADMIN'] };
    },
  };
});
import { workspaceRoutes } from './workspaces.js';
let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  vi.resetAllMocks();
  m.user.findUnique.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE' });
  m.agent.findUnique.mockResolvedValue(null);
  m.$queryRaw.mockResolvedValue([{ count: 0 }]);
  for (const model of Object.values(m)) {
    if (typeof model === 'object' && 'count' in model) model.count.mockResolvedValue(0);
    if (typeof model === 'object' && 'findMany' in model) model.findMany.mockResolvedValue([]);
  }
  app = Fastify();
  app.setErrorHandler((e: FastifyError, _req: FastifyRequest, reply: FastifyReply) =>
    reply.status(e.statusCode ?? 500).send({ message: e.message })
  );
  await app.register(workspaceRoutes, { prefix: '/workspaces', staffDb: staff as never });
});
afterEach(() => app.close());
const read = (path: string) =>
  app.inject({ url: `/workspaces/${path}`, headers: { authorization: 'fixture' } });
it.each(['overview', 'accounts', 'agents', 'accounts/11111111-1111-4111-8111-111111111111', 'games', 'audit'])(
  'denies signed-out, demoted and suspended admins on %s',
  async (path) => {
    expect((await app.inject({ url: `/workspaces/admin/${path}` })).statusCode).toBe(401);
    m.user.findUnique.mockResolvedValue({ role: 'USER', status: 'ACTIVE' });
    expect((await read(`admin/${path}`)).statusCode).toBe(403);
    m.user.findUnique.mockResolvedValue({ role: 'ADMIN', status: 'SUSPENDED' });
    expect((await read(`admin/${path}`)).statusCode).toBe(403);
    expect(m.user.findMany).not.toHaveBeenCalled();
    expect(m.auditLog.findMany).not.toHaveBeenCalled();
  }
);
it('denies anonymous, demoted and suspended actors before member moderation', async () => {
  const route = { method: 'POST' as const, url: '/workspaces/admin/accounts/11111111-1111-4111-8111-111111111111/status', payload: { status: 'SUSPENDED' } };
  expect((await app.inject(route)).statusCode).toBe(401);
  for (const actor of [{ role: 'USER', status: 'ACTIVE' }, { role: 'ADMIN', status: 'SUSPENDED' }]) {
    m.user.findUnique.mockResolvedValue(actor);
    expect((await app.inject({ ...route, headers: { authorization: 'fixture' } })).statusCode).toBe(403);
  }
  expect(staff.$transaction).not.toHaveBeenCalled();
});
it('refuses to register without an explicit staff database', async () => {
  const bare = Fastify();
  await expect(bare.register(workspaceRoutes as never, { prefix: '/workspaces' }).ready()).rejects.toThrow(
    'STAFF_DATABASE_REQUIRED'
  );
  await bare.close();
});
it('requires authentication and an active assigned agent for the overview', async () => {
  expect((await app.inject({ url: '/workspaces/agent/overview' })).statusCode).toBe(401);
  expect((await read('agent/overview')).statusCode).toBe(403);
});
it('requires approved agent status; admin is not automatically an agent', async () => {
  expect((await read('access')).json().data).toMatchObject({ admin: true, agent: false });
  m.user.findUnique.mockResolvedValue({ role: 'USER', status: 'ACTIVE' });
  m.agent.findUnique.mockResolvedValue({ status: 'ACTIVE' });
  expect((await read('access')).json().data).toMatchObject({ admin: false, agent: true });
  m.agent.findUnique.mockResolvedValue({ status: 'TEMPORARILY_SUSPENDED' });
  expect((await read('access')).json().data.agent).toBe(false);
  m.user.findUnique.mockResolvedValue({ role: 'USER', status: 'BANNED' });
  expect((await read('access')).statusCode).toBe(403);
});
it('uses bounded account pages and explicit safe fields', async () => {
  const response = await read('admin/accounts?page=2&q=Peter');
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  const args = m.user.findMany.mock.calls[0][0];
  expect(args).toMatchObject({ take: 50, skip: 50 });
  expect(Object.keys(args.select).sort()).toEqual([
    'agentProfile',
    'createdAt',
    'email',
    'id',
    'role',
    'status',
    'username',
  ]);
  expect((await read('admin/accounts?page=0')).statusCode).toBe(400);
});
it('excludes game configuration and private audit payloads', async () => {
  expect((await read('admin/games')).statusCode).toBe(200);
  expect(m.gameDefinition.findMany.mock.calls[0][0].select.configuration).toBeUndefined();
  expect((await read('admin/audit')).statusCode).toBe(200);
  const args = m.auditLog.findMany.mock.calls[0][0];
  expect(args.take).toBe(100);
  expect(Object.keys(args.select).sort()).toEqual([
    'action',
    'createdAt',
    'entity',
    'entityId',
    'id',
    'userId',
  ]);
});
it('overview excludes expired groups and disabled agents', async () => {
  expect((await read('admin/overview')).statusCode).toBe(200);
  expect(m.group.count).toHaveBeenCalledWith({
    where: { status: 'ACTIVE', expiresAt: { gt: expect.any(Date) } },
  });
  expect(m.agent.count).toHaveBeenCalledWith({
    where: { status: 'ACTIVE', user: { status: 'ACTIVE' } },
  });
});
