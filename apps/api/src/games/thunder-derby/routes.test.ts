import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { derbyRoutes } from './routes.js';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), snapshot: vi.fn(), enter: vi.fn() }));
vi.mock('@socialplay/database', () => ({ prisma: { user: { findUnique: mocks.actor } } }));
vi.mock('./service.js', () => ({ createDerbyService: () => mocks }));
let app: ReturnType<typeof Fastify>, authorization: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('THUNDER_DERBY_PRACTICE_ENABLED', 'true');
  mocks.actor.mockResolvedValue({ status: 'ACTIVE' });
  mocks.snapshot.mockResolvedValue({ balance: 1000 });
  app = Fastify();
  await app.register(jwt, { secret: 'disposable-derby-route-test-key' });
  await app.register(derbyRoutes, { prefix: '/derby' });
  await app.ready();
  authorization = `Bearer ${app.jwt.sign({ sub: 'member', roles: ['USER'] })}`;
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});
it('requires authentication for race information', async () => {
  expect((await app.inject('/derby?field=6')).statusCode).toBe(401);
  expect(mocks.snapshot).not.toHaveBeenCalled();
});
it.each(['', 'false', 'TRUE', '1'])('fails closed for flag %j', async (flag) => {
  vi.stubEnv('THUNDER_DERBY_PRACTICE_ENABLED', flag);
  expect((await app.inject({ url: '/derby?field=6', headers: { authorization } })).statusCode).toBe(
    403
  );
  expect(mocks.snapshot).not.toHaveBeenCalled();
});
it.each(['SUSPENDED', 'BANNED', 'DELETED'])(
  'denies %s members with existing JWTs',
  async (status) => {
    mocks.actor.mockResolvedValue({ status });
    expect(
      (await app.inject({ url: '/derby?field=6', headers: { authorization } })).statusCode
    ).toBe(403);
  }
);
it('takes identity from authentication and never accepts caller-controlled odds', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/derby/tickets',
    headers: { authorization },
    payload: {
      roundId: 'r',
      field: 6,
      market: 'WIN',
      picks: [1],
      stake: 25,
      userId: 'other',
      oddsCents: 999999,
    },
  });
  expect(response.statusCode).toBe(200);
  expect(mocks.enter).toHaveBeenCalledWith('member', 'r', 6, 'WIN', [1], 25);
  expect(response.headers['cache-control']).toBe('private, no-store');
});
it.each([
  { field: 7, market: 'WIN', picks: [1], stake: 25 },
  { field: 6, market: 'INVALID', picks: [1], stake: 25 },
  { field: 6, market: 'WIN', picks: [1], stake: 501 },
  { field: 6, market: 'PERFECTA', picks: [1, 1], stake: 25 },
])('validates input before admission %#', async (payload) => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/derby/tickets',
        headers: { authorization },
        payload: { roundId: 'r', ...payload },
      })
    ).statusCode
  ).toBe(400);
  expect(mocks.enter).not.toHaveBeenCalled();
});
