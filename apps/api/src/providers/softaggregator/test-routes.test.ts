import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { providerTestRoutes } from './test-routes.js';
const launch = vi.hoisted(() =>
  vi.fn(async () => ({ mode: 'virtual-test', url: 'https://games.example.com/x' }))
);
vi.mock('@socialplay/database', () => ({ prisma: {} }));
vi.mock('../../middleware/auth.js', () => ({
  authenticate: async (req: any) => {
    if (!req.headers.authorization)
      throw Object.assign(Error('Private token'), { statusCode: 401 });
    req.user = { sub: req.headers.authorization };
  },
}));
vi.mock('./test-client.js', () => ({
  createProviderTest: () => ({
    enabledFor: (id: string) => id === 'tester',
    launchReady: () => true,
    games: async (id: string) => {
      if (id !== 'tester') throw Object.assign(Error('Forbidden'), { statusCode: 404 });
      return [];
    },
    launch,
    wallet: { snapshot: vi.fn(async () => ({ balanceCents: 100000 })) },
  }),
}));
it('requires auth and hides wallet data from non-testers', async () => {
  const s = Fastify();
  await s.register(providerTestRoutes, { prefix: '/provider-test' });
  try {
    expect((await s.inject('/provider-test/status')).statusCode).toBe(401);
    expect(
      (
        await s.inject({ url: '/provider-test/status', headers: { authorization: 'customer' } })
      ).json().data.enabled
    ).toBe(false);
    expect(
      (await s.inject({ url: '/provider-test/wallet', headers: { authorization: 'customer' } }))
        .statusCode
    ).toBe(404);
    const own = await s.inject({
      url: '/provider-test/wallet',
      headers: { authorization: 'tester' },
    });
    expect(own.json().data.balanceCents).toBe(100000);
    expect(own.headers['cache-control']).toContain('no-store');
  } finally {
    await s.close();
  }
});
it('sets Ethiopia on the server and never accepts a caller-selected wallet, market or host-discovery switch', async () => {
  const s = Fastify();
  await s.register(providerTestRoutes, { prefix: '/provider-test' });
  try {
    expect(
      (
        await s.inject({
          method: 'POST',
          url: '/provider-test/launch',
          headers: { authorization: 'tester' },
          payload: { gameId: 'slot' },
        })
      ).statusCode
    ).toBe(200);
    expect(launch).toHaveBeenLastCalledWith('tester', 'slot', 'ET', undefined);
    const good = await s.inject({
      method: 'POST',
      url: '/provider-test/launch',
      headers: { authorization: 'tester' },
      payload: { gameId: 'slot', country: 'LA', userId: 'customer', inspectHost: true },
    });
    expect(good.statusCode).toBe(200);
    expect(launch).toHaveBeenLastCalledWith('tester', 'slot', 'ET', undefined);
  } finally {
    await s.close();
  }
});
