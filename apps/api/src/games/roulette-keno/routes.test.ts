import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rouletteKenoRoutes } from './routes.js';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), snapshot: vi.fn(), enter: vi.fn() }));
vi.mock('@socialplay/database', () => ({ prisma: { user: { findUnique: mocks.actor } } }));
vi.mock('./service.js', () => ({ createRouletteKenoService: () => mocks }));
let app: ReturnType<typeof Fastify>, authorization: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('ROULETTE_KENO_PRACTICE_ENABLED', 'true');
  mocks.actor.mockResolvedValue({ status: 'ACTIVE' });
  mocks.snapshot.mockResolvedValue({ balance: 1000 });
  app = Fastify();
  await app.register(jwt, { secret: 'disposable-roulette-keno-route-key' });
  await app.register(rouletteKenoRoutes, { prefix: '/rk' });
  await app.ready();
  authorization = `Bearer ${app.jwt.sign({ sub: 'member', roles: ['USER'] })}`;
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});
it('requires authentication and keeps responses private', async () => {
  expect((await app.inject('/rk')).statusCode).toBe(401);
  const r = await app.inject({ url: '/rk', headers: { authorization } });
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('private, no-store');
  expect(mocks.snapshot).toHaveBeenCalledWith('member');
});
it.each(['', 'false', 'TRUE', '1'])('fails closed for flag %j', async (flag) => {
  vi.stubEnv('ROULETTE_KENO_PRACTICE_ENABLED', flag);
  expect((await app.inject({ url: '/rk', headers: { authorization } })).statusCode).toBe(403);
  expect(mocks.snapshot).not.toHaveBeenCalled();
});
it.each(['SUSPENDED', 'BANNED', 'DELETED'])('rejects %s accounts', async (status) => {
  mocks.actor.mockResolvedValue({ status });
  expect((await app.inject({ url: '/rk', headers: { authorization } })).statusCode).toBe(403);
});
it('uses authenticated identity and strips caller-controlled payout fields', async () => {
  const payload = { roundId: 'r', slot: 2, market: 'NUMBERS', picks: [1, 72], amount: 10 };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/rk/tickets',
        headers: { authorization },
        payload: { ...payload, userId: 'other', payout: 9999 },
      })
    ).statusCode
  ).toBe(200);
  expect(mocks.enter).toHaveBeenCalledWith('member', payload);
});
it.each([
  { slot: 11 },
  { picks: [73] },
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
        url: '/rk/tickets',
        headers: { authorization },
        payload: { roundId: 'r', slot: 1, market: 'NUMBERS', picks: [1], amount: 5, ...invalid },
      })
    ).statusCode
  ).toBe(400);
  expect(mocks.enter).not.toHaveBeenCalled();
});
