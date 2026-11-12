import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate } from '../../middleware/auth.js';
import { ProviderDemoError } from './demo.js';
import { createProviderTest, TestLaunchFailure, TestProviderFailure } from './test-client.js';

export async function providerTestRoutes(server: FastifyInstance) {
  const pilot = createProviderTest(prisma);
  server.addHook('onRequest', async (_req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
  });
  server.addHook('preHandler', authenticate);
  server.setErrorHandler((err, req, reply) => {
    const status =
      err instanceof ProviderDemoError
        ? err.statusCode
        : err.validation
          ? 400
          : err.statusCode && err.statusCode >= 400 && err.statusCode < 500
            ? err.statusCode
            : 500;
    let code = 'PROVIDER_TEST_UNAVAILABLE';
    if (err instanceof TestLaunchFailure) {
      code =
        err.reason === 'UNAPPROVED_HOST'
          ? 'CASINO_GAME_ADDRESS_PENDING'
          : 'CASINO_PROVIDER_UNAVAILABLE';
      req.log.warn({
        event: 'CASINO_LAUNCH_FAILED',
        reason: err.reason,
        ...(err.host ? { launchHost: err.host } : {}),
      });
    } else if (err instanceof TestProviderFailure) {
      code =
        err.reason === 'COUNTRY_RESTRICTED'
          ? 'CASINO_GAME_REGION_UNAVAILABLE'
          : err.reason === 'CURRENCY_UNSUPPORTED'
            ? 'CASINO_GAME_CURRENCY_UNAVAILABLE'
            : err.reason === 'TIMEOUT'
              ? 'CASINO_PROVIDER_TIMEOUT'
              : err.httpStatus === 429
                ? 'CASINO_PROVIDER_BUSY'
                : 'CASINO_PROVIDER_UNAVAILABLE';
      // Do not log the provider response, request body, player identity or bearer URL.
      req.log.warn({
        event: 'CASINO_LAUNCH_FAILED',
        method: err.method,
        reason: err.reason,
        httpStatus: err.httpStatus,
        providerCode: err.providerCode,
      });
    } else if (status === 429) code = 'CASINO_PROVIDER_BUSY';
    return reply.code(status).send({
      success: false,
      error: {
        code,
        message:
          err instanceof ProviderDemoError
            ? err.message
            : status === 401
              ? 'Sign in to continue.'
              : 'Casino practice is temporarily unavailable.',
      },
    });
  });
  server.get('/status', async (req) => ({
    success: true,
    data: {
      enabled: pilot.enabledFor(req.user.sub),
      unavailableReason: pilot.unavailableReasonFor(req.user.sub),
      mode: 'virtual-test',
      launchReady: pilot.launchReady(),
      currency: 'ETB',
      country: 'ET',
    },
  }));
  server.get(
    '/wallet',
    { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (req) => {
      if (!pilot.enabledFor(req.user.sub))
        throw new ProviderDemoError(404, 'Provider testing is not available for this account.');
      return { success: true, data: await pilot.wallet.snapshot(req.user.sub) };
    }
  );
  server.get(
    '/games',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => ({ success: true, data: await pilot.games(req.user.sub) })
  );
  server.post<{ Body: { gameId: string; country?: string; mobile?: boolean } }>(
    '/launch',
    {
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['gameId'],
          properties: {
            gameId: { type: 'string', minLength: 1, maxLength: 256 },
            country: { type: 'string', pattern: '^[A-Z]{2}$' },
            mobile: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => ({
      success: true,
      // Salem currently serves Ethiopia. Accept the old client's country field
      // during rollout, but do not let it override the platform's market.
      data: await pilot.launch(req.user.sub, req.body.gameId, 'ET', req.body.mobile),
    })
  );
}
