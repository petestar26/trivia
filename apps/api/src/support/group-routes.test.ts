import Fastify from 'fastify';
import { afterEach, it, expect, vi } from 'vitest';
import { groupPvpRoutes } from '../games/group-pvp/routes.js';
const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  snapshot: vi.fn().mockResolvedValue({ enabled: true, hasWithdrawn: true, round: null }),
  create: vi.fn(),
  withdraw: vi.fn(),
  cancel: vi.fn(),
  join: vi.fn(),
  start: vi.fn(),
  readyAction: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: {} }));
vi.mock('../middleware/auth.js', () => ({
  authenticate: async (req: any) => {
    req.user = { sub: 'member' };
  },
}));
vi.mock('../games/group-pvp/runtime.js', () => ({ groupPvpWorkerReady: mocks.ready }));
vi.mock('../games/group-pvp/service.js', () => ({
  createGroupPvpService: () => ({ ...mocks, ready: mocks.readyAction }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
});
it('can show the authenticated room while disabled, but refuses new entries', async () => {
  vi.stubEnv('GROUP_PVP_GAME_POINTS_ENABLED', 'false');
  const app = Fastify();
  await app.register(groupPvpRoutes, { prefix: '/groups' });
  try {
    const read = await app.inject('/groups/group/pvp');
    expect(read.json().data).toMatchObject({
      enabled: false,
      hasWithdrawn: true,
      availability: 'DISABLED',
    });
    expect(
      (await app.inject({ method: 'POST', url: '/groups/group/pvp/round/join' })).statusCode
    ).toBe(403);
  } finally {
    await app.close();
  }
});
it('pauses admission when the worker is unhealthy while allowing a full-refund request', async () => {
  vi.stubEnv('GROUP_PVP_GAME_POINTS_ENABLED', 'true');
  mocks.ready.mockReturnValue(false);
  const app = Fastify();
  await app.register(groupPvpRoutes, { prefix: '/groups' });
  try {
    expect((await app.inject('/groups/group/pvp')).json().data.availability).toBe(
      'PROCESSING_UNAVAILABLE'
    );
    expect(
      (await app.inject({ method: 'POST', url: '/groups/group/pvp/round/start' })).statusCode
    ).toBe(503);
    expect(
      (await app.inject({ method: 'POST', url: '/groups/group/pvp/round/withdraw' })).statusCode
    ).toBe(200);
  } finally {
    await app.close();
  }
});
