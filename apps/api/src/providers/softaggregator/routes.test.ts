import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, expect, it, vi } from 'vitest';
import { providerDemoRoutes } from './routes.js';

vi.mock('../../middleware/auth.js', () => ({
  authenticate: async (request: { headers: Record<string, string>; user: { sub: string } }) => {
    if (!request.headers.authorization)
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    if (request.headers.authorization === 'suspended')
      throw Object.assign(new Error('Private suspension details'), { statusCode: 403 });
    request.user = { sub: request.headers.authorization };
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
});

it('preserves forbidden status without exposing authentication details', async () => {
  const server = Fastify();
  await server.register(providerDemoRoutes, { prefix: '/provider-demo' });
  try {
    const response = await server.inject({
      url: '/provider-demo/status',
      headers: { authorization: 'suspended' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('Private suspension details');
  } finally {
    await server.close();
  }
});

it('preserves rate-limit rejection as 429', async () => {
  vi.stubEnv('SOFTAGGREGATOR_DEMO_ENABLED', 'false');
  const server = Fastify();
  await server.register(rateLimit, { global: false });
  await server.register(providerDemoRoutes, { prefix: '/provider-demo' });
  try {
    for (let i = 0; i < 20; i++) {
      const response = await server.inject({
        url: '/provider-demo/games',
        headers: { authorization: 'tester' },
      });
      expect(response.statusCode).toBe(404);
    }
    const limited = await server.inject({
      url: '/provider-demo/games',
      headers: { authorization: 'tester' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  } finally {
    await server.close();
  }
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
