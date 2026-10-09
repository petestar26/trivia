import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { skyCrashRoutes } from './routes.js';
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  snapshot: vi.fn(),
  enter: vi.fn(),
  cashout: vi.fn(),
  activity: vi.fn(),
  leaderboard: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: { user: { findUnique: mocks.actor } } }));
vi.mock('./service.js', () => ({ createSkyCrashService: () => mocks }));
let app: ReturnType<typeof Fastify>;
let authorization: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('SKY_CRASH_PRACTICE_ENABLED', 'true');
  mocks.actor.mockResolvedValue({ status: 'ACTIVE' });
  mocks.snapshot.mockResolvedValue({ balance: 1000 });
  app = Fastify();
  await app.register(jwt, { secret: 'disposable-sky-crash-route-test-key' });
  await app.register(skyCrashRoutes, { prefix: '/games/sky-crash' });
  await app.ready();
  authorization = `Bearer ${app.jwt.sign({ sub: 'authenticated-member', roles: ['USER'] })}`;
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});
it('requires valid authentication even for practice reads', async () => {
  expect((await app.inject('/games/sky-crash')).statusCode).toBe(401);
  expect(mocks.snapshot).not.toHaveBeenCalled();
});
it.each(['', 'false', 'TRUE', '1'])(
  'fails closed for flag %j, independently of Crash Point',
  async (flag) => {
    vi.stubEnv('SKY_CRASH_PRACTICE_ENABLED', flag);
    vi.stubEnv('CRASH_POINT_PRACTICE_ENABLED', 'true');
    expect(
      (await app.inject({ url: '/games/sky-crash', headers: { authorization } })).statusCode
    ).toBe(403);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  }
);
it.each(['SUSPENDED', 'BANNED', 'DELETED'])(
  'denies currently %s members despite valid JWT',
  async (status) => {
    mocks.actor.mockResolvedValue({ status });
    expect(
      (await app.inject({ url: '/games/sky-crash', headers: { authorization } })).statusCode
    ).toBe(403);
  }
);
it('uses the authenticated member for ticket and cash-out ownership, never a submitted identity', async () => {
  const entered = await app.inject({
    method: 'POST',
    url: '/games/sky-crash/tickets',
    headers: { authorization },
    payload: {
      roundId: 'sky-minute-1',
      stake: 25,
      autoCents: 200,
      slot: 2,
      userId: 'someone-else',
    },
  });
  expect(entered.statusCode).toBe(200);
  expect(mocks.enter).toHaveBeenCalledWith('authenticated-member', 'sky-minute-1', 25, 200, 2);
  const paid = await app.inject({
    method: 'POST',
    url: '/games/sky-crash/cashout',
    headers: { authorization },
    payload: { roundId: 'sky-minute-1', slot: 2, payout: 99999 },
  });
  expect(paid.statusCode).toBe(200);
  expect(mocks.cashout).toHaveBeenCalledWith('authenticated-member', 'sky-minute-1', 2);
  expect(paid.headers['cache-control']).toBe('private, no-store');
});
it('rejects invalid ticket bounds before the service', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/games/sky-crash/tickets',
    headers: { authorization },
    payload: { roundId: 'x', stake: 501, autoCents: 200, slot: 3 },
  });
  expect(response.statusCode).toBe(400);
  expect(mocks.enter).not.toHaveBeenCalled();
});
