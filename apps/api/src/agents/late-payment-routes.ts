import { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/index.js';
import {
  reportLatePayment,
  listLatePayments,
  claimLatePayment,
  recordLatePaymentRefund,
} from './late-payment-service.js';
export async function latePaymentRoutes(server: FastifyInstance) {
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  const auth = [authenticate],
    admin = [authenticate, requirePermission('agent:review')];
  server.post('/', { preHandler: auth }, async (req) => ({
    success: true,
    data: await reportLatePayment(req.user!.sub, req.body),
  }));
  server.get('/me', { preHandler: auth }, async (req) => ({
    success: true,
    data: await listLatePayments(req.user!.sub),
  }));
  server.get('/pending', { preHandler: admin }, async (req) => ({
    success: true,
    data: await listLatePayments(req.user!.sub, true),
  }));
  server.post<{ Params: { id: string } }>('/:id/claim', { preHandler: admin }, async (req) => ({
    success: true,
    data: await claimLatePayment(req.user!.sub, req.params.id),
  }));
  server.post<{ Params: { id: string } }>('/:id/refund', { preHandler: admin }, async (req) => ({
    success: true,
    data: await recordLatePaymentRefund(req.user!.sub, req.user!.iat!, req.params.id, req.body),
  }));
}
