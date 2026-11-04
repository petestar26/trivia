import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { anonymousRateLimitKey } from '../../plugins/rate-limit-identity.js';
import { callbackSalt, createTestWallet, verifyTestCallback } from './test-wallet.js';

/** Provider GET callback; application errors are JSON codes with HTTP 200. */
export async function providerTestCallbackRoutes(server: FastifyInstance) {
  const wallet = createTestWallet(prisma);
  server.setErrorHandler((_error, _request, reply) =>
    reply.code(200).send({ error: 2, balance: 0 })
  );
  server.all('/sg/callback', { config: { rateLimit: false } }, async (request, reply) => {
    reply.code(200).header('Cache-Control', 'private, no-store');
    if (request.method !== 'GET' || process.env.SOFTAGGREGATOR_TEST_CALLBACK_ENABLED !== 'true')
      return { error: 2, balance: 0 };
    // Only accept the provider's fixed source, attested by our existing gateway.
    // Direct public API clients cannot manufacture the gateway's HMAC.
    if (anonymousRateLimitKey(request, process.env.WEB_GATEWAY_SECRET) !== 'ip:85.122.129.59')
      return { error: 2, balance: 0 };
    const signature = request.headers['x-signature'];
    const movement = verifyTestCallback(
      request.raw.url ?? '',
      typeof signature === 'string' ? signature : undefined,
      callbackSalt(process.env)
    );
    if (!movement) return { error: 2, balance: 0 };
    try {
      return await wallet.apply(movement);
    } catch {
      request.log.warn(
        { event: 'PROVIDER_TEST_CALLBACK_FAILED' },
        'Provider test callback could not be committed'
      );
      return { error: 2, balance: 0 };
    }
  });
}
