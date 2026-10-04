import { publishUsdRate, saveCoinPackage, listCoinPackages, selectPaymentRate } from './usd-config-service.js';
import { parseUsdPolicy, priceUsdPayment } from './usd-pricing.js';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware/index.js';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requirePermission } from '../middleware/index.js';
import {
  createCountry,
  setCountryFlags,
  listCountries,
  createPaymentMethod,
  setPaymentMethodActive,
  listPaymentMethods,
  createExchangeRate,
  deactivateExchangeRate,
  getActiveExchangeRate,
  listExchangeRates,
  PaymentMethodTypeValue,
} from './config-service.js';

function requestContext(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

export async function agentConfigRoutes(server: FastifyInstance): Promise<void> {
  const auth = [authenticate];
  const admin = [authenticate, requirePermission('agent:review')];

  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  server.get('/coin-packages', { preHandler: auth }, async () => ({ success: true, data: await listCoinPackages() }));
  server.get('/admin/coin-packages', { preHandler: admin }, async () => ({ success: true, data: await listCoinPackages(true) }));
  server.post('/admin/coin-packages', { preHandler: admin }, async (request, reply) =>
    reply.status(201).send({ success: true, data: await saveCoinPackage(request.user!.sub, undefined, request.body) }));
  server.post<{ Params: { id: string } }>('/admin/coin-packages/:id', { preHandler: admin }, async request =>
    ({ success: true, data: await saveCoinPackage(request.user!.sub, request.params.id, request.body) }));
  server.post<{ Params: { countryId: string } }>('/countries/:countryId/usd-rates', { preHandler: admin }, async (request, reply) =>
    reply.status(201).send({ success: true, data: await publishUsdRate(request.user!.sub, request.params.countryId, request.body) }));
  server.get<{ Params: { countryId: string }; Querystring: { fiatAmount?: string } }>(
    '/countries/:countryId/deposit-preview', { preHandler: auth }, async request => {
      const country = await prisma.country.findUnique({ where: { id: request.params.countryId } });
      if (!country?.isActive || !country.agentPaymentEnabled || !country.usdPricingEnabled) {
        throw ApiError.badRequest('USD agent pricing is not available for this country');
      }
      const rate = await selectPaymentRate(prisma, country);
      const policy = parseUsdPolicy(rate.pricingPolicy);
      const price = request.query.fiatAmount === undefined ? null
        : priceUsdPayment(policy, 'deposit', Number(request.query.fiatAmount));
      return { success: true, data: { rateId: rate.id, policy, preview: price?.snapshot ?? null } };
    });

  // ── Countries ─────────────────────────────────────────────────
  // Read access to ACTIVE countries is any authenticated user (agents/
  // customers need this to discover valid config). Seeing inactive rows
  // too is an admin-only concern, served by a separate route below rather
  // than a role-conditional branch inside this one.

  server.get('/countries', { preHandler: auth }, async (_request, reply) => {
    const countries = await listCountries(false);
    return reply.send({ success: true, data: countries });
  });

  server.get('/admin/countries', { preHandler: admin }, async (_request, reply) => {
    const countries = await listCountries(true);
    return reply.send({ success: true, data: countries });
  });

  server.post<{ Body: { code: string; name: string; currencyCode: string; displayOrder?: number } }>(
    '/countries',
    { preHandler: admin },
    async (request, reply) => {
      const country = await createCountry(request.user!.sub, request.body, requestContext(request));
      return reply.status(201).send({ success: true, data: country });
    }
  );

  server.patch<{ Params: { id: string }; Body: { isActive?: boolean; agentPaymentEnabled?: boolean } }>(
    '/countries/:id',
    { preHandler: admin },
    async (request, reply) => {
      const country = await setCountryFlags(request.user!.sub, request.params.id, request.body, requestContext(request));
      return reply.send({ success: true, data: country });
    }
  );

  // ── Payment methods ──────────────────────────────────────────

  server.get<{ Params: { countryId: string }; Querystring: { includeInactive?: string } }>(
    '/countries/:countryId/payment-methods',
    { preHandler: admin },
    async (request, reply) => {
      const methods = await listPaymentMethods(request.params.countryId, request.query.includeInactive === 'true');
      return reply.send({ success: true, data: methods });
    }
  );

  server.get<{ Params: { countryId: string } }>(
    '/countries/:countryId/payment-methods/active',
    { preHandler: auth },
    async (request, reply) => {
      const methods = await listPaymentMethods(request.params.countryId, false);
      return reply.send({ success: true, data: methods });
    }
  );

  server.post<{
    Params: { countryId: string };
    Body: { type: PaymentMethodTypeValue; name: string; requiredFields: string[] };
  }>(
    '/countries/:countryId/payment-methods',
    { preHandler: admin },
    async (request, reply) => {
      const method = await createPaymentMethod(
        request.user!.sub,
        { countryId: request.params.countryId, ...request.body },
        requestContext(request)
      );
      return reply.status(201).send({ success: true, data: method });
    }
  );

  server.patch<{ Params: { id: string }; Body: { isActive: boolean } }>(
    '/payment-methods/:id',
    { preHandler: admin },
    async (request, reply) => {
      const method = await setPaymentMethodActive(request.user!.sub, request.params.id, request.body?.isActive, requestContext(request));
      return reply.send({ success: true, data: method });
    }
  );

  // ── Exchange rates ────────────────────────────────────────────

  server.get<{ Params: { countryId: string } }>(
    '/countries/:countryId/exchange-rates',
    { preHandler: admin },
    async (request, reply) => {
      const rates = await listExchangeRates(request.params.countryId);
      return reply.send({ success: true, data: rates });
    }
  );

  server.get<{ Params: { countryId: string }; Querystring: { fiatCurrency: string } }>(
    '/countries/:countryId/exchange-rates/active',
    { preHandler: auth },
    async (request, reply) => {
      const rate = await getActiveExchangeRate(request.params.countryId, request.query.fiatCurrency);
      return reply.send({ success: true, data: rate });
    }
  );

  server.post<{
    Params: { countryId: string };
    Body: { fiatCurrency: string; coinsPerUnit: number; effectiveAt?: string };
  }>(
    '/countries/:countryId/exchange-rates',
    { preHandler: admin },
    async (request, reply) => {
      const rate = await createExchangeRate(
        request.user!.sub,
        {
          countryId: request.params.countryId,
          fiatCurrency: request.body.fiatCurrency,
          coinsPerUnit: request.body.coinsPerUnit,
          effectiveAt: request.body.effectiveAt ? new Date(request.body.effectiveAt) : undefined,
        },
        requestContext(request)
      );
      return reply.status(201).send({ success: true, data: rate });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/exchange-rates/:id/deactivate',
    { preHandler: admin },
    async (request, reply) => {
      const rate = await deactivateExchangeRate(request.user!.sub, request.params.id, requestContext(request));
      return reply.send({ success: true, data: rate });
    }
  );
}
