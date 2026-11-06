import { createServer } from 'node:http';
import { prisma } from '@socialplay/database';
import { createTogetherService } from '../games/play-together/service.js';

// Separate supervised service. It does not run provider/payment jobs or admit
// entries. Accepted rounds keep their pinned version even when admission stops.
async function main() {
  if (process.env.SHARED_ROUND_WORKER_ENABLED !== 'true')
    throw new Error('Shared round worker is not enabled');
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid health port');
  const [identity] = await prisma.$queryRawUnsafe<
    { allowed: boolean; cash: boolean; owner: boolean }[]
  >(
    "SELECT public.together_is_practice_worker() AS allowed,has_column_privilege(current_user,'public.wallets','coinsBalance','UPDATE') AS cash," +
      '(SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS owner'
  );
  if (!identity?.allowed || identity.cash || identity.owner)
    throw new Error('Restricted shared practice worker identity required');
  const service = createTogetherService(prisma, { practiceWorker: true });
  let stopped = false,
    healthyAt = 0;
  const health = createServer(async (request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    const ready = !stopped && Date.now() - healthyAt < 30000;
    response.writeHead(ready ? 200 : 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(
      JSON.stringify({ status: ready ? 'ok' : 'recovering', service: 'shared-round-worker' })
    );
  });
  health.listen(port, '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      stopped = true;
      health.close();
    });
  while (!stopped) {
    try {
      await service.tick();
      healthyAt = Date.now();
    } catch {
      console.error(JSON.stringify({ event: 'SHARED_ROUND_WORKER_RETRY' }));
    }
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await prisma.$disconnect();
}
void main().catch(() => {
  console.error('Shared round worker could not start');
  process.exitCode = 1;
});
