import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { anonymousRateLimitKey } from '../../plugins/rate-limit-identity.js';
import { callbackSalt, createTestWallet, verifyTestCallback } from './test-wallet.js';
import { createSportsWallet } from './sports-wallet.js';

/** Provider GET callback; application errors are JSON codes with HTTP 200. */
export async function providerTestCallbackRoutes(server: FastifyInstance) {
  const wallet = createTestWallet(prisma);
  const sports = createSportsWallet(prisma);
  server.setErrorHandler((_error, _request, reply) => {
    server.salemMonitor?.callback('failed');
    return reply.code(200).send({ error: 2, balance: 0 });
  });
  server.all('/sg/callback', { config: { rateLimit: false } }, async (request, reply) => {
    reply.code(200).header('Cache-Control', 'private, no-store');
    if (request.method !== 'GET') {
      server.salemMonitor?.callback('wrong_method');
      return { error: 2, balance: 0 };
    }
    if (
      process.env.SOFTAGGREGATOR_TEST_CALLBACK_ENABLED !== 'true' &&
      process.env.SOFTAGGREGATOR_SPORTS_CALLBACK_ENABLED !== 'true'
    ) {
      server.salemMonitor?.callback('disabled');
      return { error: 2, balance: 0 };
    }
    // Only accept the provider's fixed source, attested by our existing gateway.
    // Direct public API clients cannot manufacture the gateway's HMAC.
    if (anonymousRateLimitKey(request, process.env.WEB_GATEWAY_SECRET) !== 'ip:85.122.129.59') {
      server.salemMonitor?.callback('untrusted_source');
      return { error: 2, balance: 0 };
    }
    const signature = request.headers['x-signature'];
    const movement = verifyTestCallback(
      request.raw.url ?? '',
      typeof signature === 'string' ? signature : undefined,
      callbackSalt(process.env),
      Date.now(),
      'either'
    );
    if (!movement) {
      server.salemMonitor?.callback('invalid_signature_or_payload');
      return { error: 2, balance: 0 };
    }
    try {
      const result = await (movement.username.startsWith('sr_') ? sports : wallet).apply(movement);
      server.salemMonitor?.callback(result.error === 0 ? 'accepted' : 'wallet_rejected');
      return result;
    } catch {
      server.salemMonitor?.callback('failed');
      request.log.warn(
        { event: 'PROVIDER_TEST_CALLBACK_FAILED' },
        'Provider test callback could not be committed'
      );
      return { error: 2, balance: 0 };
    }
  });
}
