import { cryptoPaymentCatalog } from '../agents/crypto-catalog.js';
import { etbRateView } from '../agents/etb-rate-service.js';
import { prisma } from '@socialplay/database';
import { FastifyInstance } from 'fastify';
import { ApiError, authenticate } from '../middleware/index.js';
import { getWalletBalance, getWalletTransactions } from '../economy/wallet-service.js';

export async function walletRoutes(server: FastifyInstance): Promise<void> {
  // Public reference data only; reads the shared cache and never calls the feed.
  server.get('/exchange-rate', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => ({ success: true, data: await etbRateView() }));
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  // Directory exposes approved method labels only. Payment destinations are
  // disclosed through the existing owner-authorized order detail after creation.
  server.get('/payment-options', { preHandler: [authenticate] }, async request => {
    const userId = request.user!.sub;
    const [user, ownAgent, countries, agents, withdrawalGate] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } }),
      prisma.agent.findUnique({ where: { userId }, select: { status: true } }),
      prisma.country.findMany({ where: { isActive: true },
        select: { id: true, name: true, currencyCode: true, agentPaymentEnabled: true, usdPricingEnabled: true }, orderBy: { displayOrder: 'asc' } }),
      prisma.agent.findMany({ where: { status: 'ACTIVE', userId: { not: userId },
          country: { isActive: true, agentPaymentEnabled: true }, user: { status: 'ACTIVE' } },
        select: { id: true, countryId: true, displayName: true, minOrderAmount: true, maxOrderAmount: true,
          paymentAccounts: { where: { status: 'APPROVED', safetyHold: false, methodDef: { isActive: true } },
            select: { id: true, countryId: true, methodDef: { select: { name: true, countryId: true } } } } },
        orderBy: { displayName: 'asc' }, take: 100 }),
      prisma.platformGate.findUnique({ where: { key: 'WITHDRAWAL_CREATE' }, select: { enabled: true } }),
    ]);
    return { success: true, data: {
      countries, withdrawalsEnabled: withdrawalGate?.enabled === true,
      crypto: { available: false, reason: 'Check current USDT availability in the Crypto tab', assets: cryptoPaymentCatalog }, isAgent: ownAgent?.status === 'ACTIVE', isAdmin: ['ADMIN', 'SUPER_ADMIN'].includes(user.role),
      agents: agents.map(a => ({ ...a, paymentAccounts: a.paymentAccounts.filter(p =>
        p.countryId === a.countryId && p.methodDef.countryId === a.countryId) })),
    } };
  });

  // GET /wallet — current balance
  server.get(
    '/',
    {
      preHandler: [authenticate],
    },
    async (request, reply) => {
      const wallet = await getWalletBalance(request.user!.sub);

      return reply.send({
        success: true,
        data: wallet,
      });
    }
  );

  // GET /wallet/transactions — transaction history
  server.get<{
    Querystring: { page?: number; limit?: number; currency?: string };
  }>(
    '/transactions',
    {
      preHandler: [authenticate],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            currency: { type: 'string', enum: ['etb', 'coins', 'gamePoints'] },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await getWalletTransactions(request.user!.sub, {
        page: request.query.page ?? 1,
        limit: request.query.limit ?? 20,
        currency: request.query.currency,
      });

      return reply.send({
        success: true,
        data: result.data,
        meta: {
          page: result.page,
          total: result.total,
          totalPages: result.totalPages,
        },
      });
    }
  );
}
