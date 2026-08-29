import { FastifyInstance } from 'fastify';
import { ApiError, authenticate } from '../middleware';
import { getWalletBalance, getWalletTransactions } from '../economy/wallet-service';

export async function walletRoutes(server: FastifyInstance): Promise<void> {
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
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            currency: { type: 'string', enum: ['coins', 'gamePoints'] },
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
