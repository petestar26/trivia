import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/index.js';
import * as payments from './service.js';
export async function cryptoPaymentRoutes(server: FastifyInstance) {
  server.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  const member = {
    preHandler: [authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  };
  const write = {
    preHandler: [authenticate],
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  };
  const admin = {
    preHandler: [authenticate, requirePermission('agent:review')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  };
  const ok = (data: unknown) => ({ success: true, data });
  server.get('/options', member, async (r) => ok(await payments.options(r.user!.sub)));
  server.get('/me', member, async (r) =>
    ok(await payments.listPayments(r.user!.sub, false, r.query))
  );
  server.post('/deposits', write, async (r) =>
    ok(await payments.createDeposit(r.user!.sub, r.body))
  );
  server.post('/withdrawals', write, async (r) =>
    ok(await payments.createWithdrawal(r.user!.sub, r.user!.iat!, r.body))
  );
  server.post<{ Params: { id: string } }>('/withdrawals/:id/cancel', { ...write, config: {...write.config, allowOwnFundsReturn: true} }, async (r) =>
    ok(
      await payments.processWithdrawal(
        r.user!.sub,
        r.user!.iat!,
        r.params.id,
        'cancel',
        r.body,
        false
      )
    )
  );
  server.get('/admin', admin, async (r) =>
    ok(await payments.listPayments(r.user!.sub, true, r.query))
  );
  server.post('/admin/addresses', admin, async (r) =>
    ok(await payments.addAddress(r.user!.sub, r.user!.iat!, r.body))
  );
  server.post<{ Params: { address: string } }>(
    '/admin/addresses/:address/retire',
    admin,
    async (r) => ok(await payments.retireAddress(r.user!.sub, r.params.address))
  );
  for (const action of ['claim', 'cancel', 'confirm'] as const)
    server.post<{ Params: { id: string } }>(`/admin/withdrawals/:id/${action}`, admin, async (r) =>
      ok(
        await payments.processWithdrawal(
          r.user!.sub,
          r.user!.iat!,
          r.params.id,
          action,
          r.body,
          true
        )
      )
    );
}
