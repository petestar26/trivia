import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { luckySixRoutes } from './routes.js';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), snapshot: vi.fn(), enter: vi.fn() }));
vi.mock('@socialplay/database', () => ({ prisma: { user: { findUnique: mocks.actor } } }));
vi.mock('./service.js', () => ({ createLuckySixService: () => mocks }));
let app: ReturnType<typeof Fastify>, authorization: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('LUCKY_SIX_PRACTICE_ENABLED', 'true');
  mocks.actor.mockResolvedValue({ status: 'ACTIVE' });
  mocks.snapshot.mockResolvedValue({ balance: 1000 });
  app = Fastify();
  await app.register(jwt, { secret: 'disposable-lucky-six-route-key' });
  await app.register(luckySixRoutes, { prefix: '/ls' });
  await app.ready();
  authorization = `Bearer ${app.jwt.sign({ sub: 'member', roles: ['USER'] })}`;
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});
it('requires authentication and keeps responses private', async () => {
  expect((await app.inject('/ls')).statusCode).toBe(401);
  const r = await app.inject({ url: '/ls', headers: { authorization } });
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('private, no-store');
  expect(mocks.snapshot).toHaveBeenCalledWith('member');
});
it.each(['', 'false', 'TRUE', '1'])('fails closed for flag %j', async (flag) => {
  vi.stubEnv('LUCKY_SIX_PRACTICE_ENABLED', flag);
  expect((await app.inject({ url: '/ls', headers: { authorization } })).statusCode).toBe(403);
  expect(mocks.snapshot).not.toHaveBeenCalled();
});
it.each(['SUSPENDED', 'BANNED', 'DELETED'])('rejects %s accounts', async (status) => {
  mocks.actor.mockResolvedValue({ status });
  expect((await app.inject({ url: '/ls', headers: { authorization } })).statusCode).toBe(403);
});
it('uses authenticated identity and strips caller-controlled payout fields', async () => {
  const payload = { roundId: 'r', slot: 2, market: 'SIX', picks: [1, 2, 3, 4, 5, 48], amount: 10 };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/ls/tickets',
        headers: { authorization },
        payload: { ...payload, userId: 'other', payout: 9999 },
      })
    ).statusCode
  ).toBe(200);
  expect(mocks.enter).toHaveBeenCalledWith('member', payload);
});
it.each([
  { slot: 11 },
  { picks: [49] },
  { picks: [1, 1] },
  { market: 'JACKPOT' },
  { amount: 7 },
  { amount: 501 },
  { roundId: '' },
])('validates malformed entries %#', async (invalid) => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/ls/tickets',
        headers: { authorization },
        payload: { roundId: 'r', slot: 1, market: 'PRE_NUMBER', picks: [1], amount: 5, ...invalid },
      })
    ).statusCode
  ).toBe(400);
  expect(mocks.enter).not.toHaveBeenCalled();
});
