import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { providerDemoRoutes } from './routes.js';

vi.mock('../../middleware/auth.js', () => ({
  authenticate: async (request: { headers: Record<string, string>; user: { sub: string } }) => {
    if (!request.headers.authorization)
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    request.user = { sub: request.headers.authorization };
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
});

it('requires authentication and preserves disabled status without calling upstream', async () => {
  vi.stubEnv('SOFTAGGREGATOR_DEMO_ENABLED', 'false');
  const server = Fastify();
  await server.register(providerDemoRoutes, { prefix: '/provider-demo' });
  try {
    expect((await server.inject('/provider-demo/status')).statusCode).toBe(401);
    const status = await server.inject({
      url: '/provider-demo/status',
      headers: { authorization: 'tester' },
    });
    expect(status.json().data).toEqual({ enabled: false, mode: 'demo' });
    expect(status.headers['cache-control']).toBe('private, no-store');
    const catalogue = await server.inject({
      url: '/provider-demo/games',
      headers: { authorization: 'tester' },
    });
    expect(catalogue.statusCode).toBe(404);
    const launch = await server.inject({
      method: 'POST',
      url: '/provider-demo/launch',
      headers: { authorization: 'tester' },
      payload: { gameId: 'studio/slot' },
    });
    expect(launch.statusCode).toBe(404);
    const invalid = await server.inject({
      method: 'POST',
      url: '/provider-demo/launch',
      headers: { authorization: 'tester' },
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect((await server.inject('/provider-demo/callback')).statusCode).toBe(404);
  } finally {
    await server.close();
  }
});
