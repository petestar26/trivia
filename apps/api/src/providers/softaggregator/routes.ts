import type { FastifyInstance } from 'fastify';
import type {} from '@fastify/rate-limit';
import { authenticate } from '../../middleware/auth.js';
import { createProviderDemo, ProviderDemoError } from './demo.js';

export async function providerDemoRoutes(server: FastifyInstance) {
  const demo = createProviderDemo();
  server.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
  });
  server.addHook('preHandler', authenticate);
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProviderDemoError)
      return reply
        .code(error.statusCode)
        .send({
          success: false,
          error: { code: 'PROVIDER_DEMO_UNAVAILABLE', message: error.message },
        });
    if (error.validation)
      return reply
        .code(400)
        .send({ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid demo request.' } });
    // Preserve auth failures; other unexpected errors must not leak provider details.
    return reply
      .code(error.statusCode === 401 ? 401 : 500)
      .send({
        success: false,
        error: {
          code: 'PROVIDER_DEMO_ERROR',
          message:
            error.statusCode === 401 ? 'Sign in to continue.' : 'Provider demo is unavailable.',
        },
      });
  });
  server.get('/status', async (request) => ({
    success: true,
    data: { enabled: demo.enabledFor(request.user.sub), mode: 'demo' },
  }));
  server.get(
    '/games',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => ({ success: true, data: await demo.games(request.user.sub) })
  );
  server.post<{ Body: { gameId: string; mobile?: boolean } }>(
    '/launch',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['gameId'],
          additionalProperties: false,
          properties: {
            gameId: { type: 'string', minLength: 1, maxLength: 256 },
            mobile: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await demo.launch(request.user.sub, request.body.gameId, request.body.mobile),
    })
  );
}
