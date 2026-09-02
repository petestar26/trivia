import Fastify, { FastifyInstance } from 'fastify';
import { config } from '@socialplay/config';
import { prisma } from '@socialplay/database';
import { registerPlugins } from './plugins';
import { registerRoutes } from './routes';
import { healthRoutes } from './routes/health';
import { registerWebSocket } from './ws';
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';

async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport: config.LOG_PRETTY
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        // `coerceTypes: true` allows string→integer coercion for query
        // params (e.g. ?page=2 → 2). The previous 'array' value disabled
        // scalar coercion, causing paginated endpoints to 400.
        coerceTypes: true,
      },
    },
  });

  server.setErrorHandler(errorHandler);
  server.addHook('onRequest', requestLogger);

  await registerPlugins(server);

  // README.md documents `GET /health` (and `/health?detailed`) as a bare,
  // unprefixed infrastructure endpoint, distinct from the versioned /api/v1
  // business routes listed right below it in the same doc. Registered here,
  // directly on the top-level server and before the API_PREFIX wrapper, so
  // the actual path matches that documented contract instead of resolving
  // to /api/v1/health.
  await server.register(healthRoutes, { prefix: '/health' });

  // Product decision: the root service-info endpoint is a bare top-level
  // route, not a versioned /api/v1 resource — same reasoning as /health
  // above. Registered directly on the top-level server, before the
  // API_PREFIX wrapper, so it resolves to / rather than /api/v1. Payload
  // unchanged from the handler this replaces in routes/index.ts.
  server.get('/', async () => ({
    success: true,
    data: {
      name: 'SocialPlay API',
      version: '0.0.1',
      status: 'running',
    },
  }));

  // Mount all REST routes under the configured API prefix (e.g. /api/v1)
  // so that the frontend's /api/v1/* requests resolve correctly.
  await server.register(
    async (instance) => {
      await registerRoutes(instance);
    },
    { prefix: config.API_PREFIX }
  );

  registerWebSocket(server);

  return server;
}

async function start(): Promise<void> {
  try {
    const server = await buildServer();

    await server.listen({ port: config.PORT, host: config.HOST });

    server.log.info(`🚀 Server running at http://${config.HOST}:${config.PORT}`);
    server.log.info(`📚 API docs available at http://${config.HOST}:${config.PORT}${config.API_PREFIX}/docs`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export { buildServer, start };