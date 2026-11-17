import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requirePermission } from '../middleware/index.js';
import {
  adjudicateHeldDeposit,
  claimHeldCase,
  declareHeldPayment,
  getHeldCase,
  listHeldCases,
  markHeldCaseUnknown,
  releaseHeldCase,
} from './held-deposit-recovery-service.js';

const context = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers['user-agent'] });
type Order = { Params: { orderId: string } };

/**
 * Held-deposit recovery. The permission only admits platform staff to the
 * queue; the service and the database separately require an active main
 * administrator (SUPER_ADMIN) who is not a party to the order for every
 * case detail and every decision.
 */
export async function heldDepositRoutes(server: FastifyInstance) {
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  const auth = [authenticate],
    admin = [authenticate, requirePermission('agent:review')];
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: '15 minutes' } });
  server.get('/', { preHandler: admin, config: limit(300) }, async (req) => ({
    success: true, data: await listHeldCases(req.user!.sub, req.query),
  }));
  server.get<Order>('/:orderId', { preHandler: admin, config: limit(300) }, async (req) => ({
    success: true, data: await getHeldCase(req.user!.sub, req.params.orderId),
  }));
  server.post<Order>('/:orderId/claim', { preHandler: admin, config: limit(60) }, async (req) => ({
    success: true, data: await claimHeldCase(req.user!.sub, req.params.orderId, context(req)),
  }));
  server.post<Order>('/:orderId/release', { preHandler: admin, bodyLimit: 16384, config: limit(60) }, async (req) => ({
    success: true, data: await releaseHeldCase(req.user!.sub, req.params.orderId, req.body, context(req)),
  }));
  server.post<Order>('/:orderId/investigate', { preHandler: admin, bodyLimit: 16384, config: limit(60) }, async (req) => ({
    success: true, data: await markHeldCaseUnknown(req.user!.sub, req.params.orderId, req.body, context(req)),
  }));
  server.post<Order>('/:orderId/adjudicate', { preHandler: admin, bodyLimit: 65536, config: limit(30) }, async (req) => ({
    success: true, data: await adjudicateHeldDeposit(req.user!.sub, req.user!.iat!, req.params.orderId, req.body, context(req)),
  }));
  // The member's own statement about their own order.
  server.post<Order>('/:orderId/declaration', { preHandler: auth, bodyLimit: 4096, config: limit(20) }, async (req) => ({
    success: true, data: await declareHeldPayment(req.user!.sub, req.params.orderId, req.body, context(req)),
  }));
}
