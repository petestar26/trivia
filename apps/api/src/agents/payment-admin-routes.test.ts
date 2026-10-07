import Fastify, { type FastifyError, type FastifyRequest, type FastifyReply } from 'fastify';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  agent: { findUnique: vi.fn() },
  fund: vi.fn(),
  adjust: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: m }));
vi.mock('../withdrawals/liquidity-service.js', () => ({
  getAgentFiatLiquidity: vi.fn(),
  fundAgentFiatLiquidity: m.fund,
  adjustAgentFiatLiquidity: m.adjust,
}));
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
import { agentRoutes } from './routes.js';
let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  vi.clearAllMocks();
  m.user.findUnique.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE' });
  m.agent.findUnique.mockResolvedValue(null);
  m.fund.mockResolvedValue({ totalBalance: 12345n });
  app = Fastify();
  app.setErrorHandler((e: FastifyError, _req: FastifyRequest, reply: FastifyReply) =>
    reply.status(e.statusCode ?? 500).send({ message: e.message })
  );
  await app.register(agentRoutes, { prefix: '/agents' });
});
afterEach(() => app.close());
const payload = { fiatCurrency: 'ETB', amountMinor: '12345', idempotencyKey: 'funding-key-123' };
it('requires authentication and current admin permission for funding', async () => {
  expect(
    (await app.inject({ method: 'POST', url: '/agents/a/liquidity/fund', payload })).statusCode
  ).toBe(401);
  m.user.findUnique.mockResolvedValue({ role: 'USER', status: 'ACTIVE' });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/agents/a/liquidity/fund',
        headers: { authorization: 'test' },
        payload,
      })
    ).statusCode
  ).toBe(403);
  expect(m.fund).not.toHaveBeenCalled();
});
it('passes exact minor units and the same idempotency key into the ledger service', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/agents/a/liquidity/fund',
    headers: { authorization: 'test' },
    payload,
  });
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('private, no-store');
  expect(r.json().data.totalBalance).toBe('12345');
  expect(m.fund).toHaveBeenCalledWith(
    'actor',
    'a',
    'ETB',
    12345n,
    'funding-key-123',
    expect.any(Object)
  );
});
it.each(['1.5', '1e6', '90071992547409930', '0'])(
  'rejects invalid/out-of-range minor unit input %s',
  async (amountMinor) => {
    const r = await app.inject({
      method: 'POST',
      url: '/agents/a/liquidity/fund',
      headers: { authorization: 'test' },
      payload: { ...payload, amountMinor },
    });
    expect(r.statusCode).toBe(400);
    expect(m.fund).not.toHaveBeenCalled();
  }
);
it('requires adjustment reason and preserves signed values', async () => {
  const req = {
    method: 'POST' as const,
    url: '/agents/a/liquidity/adjust',
    headers: { authorization: 'test' },
  };
  expect((await app.inject({ ...req, payload })).statusCode).toBe(400);
  m.adjust.mockResolvedValue({ totalBalance: 5n });
  expect(
    (
      await app.inject({
        ...req,
        payload: { ...payload, amountMinor: '-50', reason: 'Verified correction' },
      })
    ).statusCode
  ).toBe(200);
  expect(m.adjust).toHaveBeenCalledWith(
    'actor',
    'a',
    'ETB',
    -50n,
    'Verified correction',
    'funding-key-123',
    expect.any(Object)
  );
});
it('returns a nullable onboarding profile only for the authenticated owner', async () => {
  const r = await app.inject({ url: '/agents/me/setup', headers: { authorization: 'test' } });
  expect(r.statusCode).toBe(200);
  expect(r.json().data).toBeNull();
  expect(m.agent.findUnique).toHaveBeenCalledWith(
    expect.objectContaining({ where: { userId: 'actor' } })
  );
});
