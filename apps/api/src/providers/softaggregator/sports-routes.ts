import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate } from '../../middleware/auth.js';
import { ProviderDemoError } from './demo.js';
import { createSportsbook } from './sports-client.js';

export async function sportsRoutes(server: FastifyInstance) {
  const sports = createSportsbook(prisma);
  server.addHook('onRequest', async (_req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
  });
  server.addHook('preHandler', authenticate);
  server.setErrorHandler((error, _req, reply) => {
    const status =
      error instanceof ProviderDemoError
        ? error.statusCode
        : error.statusCode && error.statusCode < 500
          ? error.statusCode
          : 500;
    return reply
      .code(status)
      .send({
        success: false,
        error: {
          code: 'SPORTS_UNAVAILABLE',
          message:
            error instanceof ProviderDemoError
              ? error.message
              : status === 401
                ? 'Sign in to continue.'
                : 'Sports is temporarily unavailable. Please try again.',
        },
      });
  });
  server.get(
    '/status',
    { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (req) => ({
      success: true,
      data: {
        ...(await sports.wallet.snapshot(req.user.sub)),
        browseReady: sports.browseReady(),
        mode: 'real-wallet',
      },
    })
  );
  server.get(
    '/activity',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => ({
      success: true,
      data: await prisma.$queryRaw`
      SELECT m.call_id AS id,m.action,m.amount_minor AS "amountMinor",m.balance_minor AS "balanceMinor",
        m.round_id AS "roundId",m.rollback,m.created_at AS "createdAt"
      FROM sg_sports_movements m JOIN sg_sports_players p ON p.username=m.username
      WHERE p.user_id=${req.user.sub} AND m.error=0 ORDER BY m.created_at DESC,m.call_id DESC LIMIT 20`,
    })
  );
  server.post<{ Body: { mobile?: boolean } }>(
    '/launch',
    {
      preValidation: async (req) => {
        if (req.body && Object.keys(req.body).some(key => key !== 'mobile'))
          throw new ProviderDemoError(400, 'Unsupported sports launch option.');
      },
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { mobile: { type: 'boolean' } },
        },
      },
    },
    async (req) => ({ success: true, data: await sports.launch(req.user.sub, req.body.mobile) })
  );
}
