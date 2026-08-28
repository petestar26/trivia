import Fastify, { FastifyInstance } from 'fastify';
import { config } from '@socialplay/config';
import { prisma } from '@socialplay/database';
import { registerPlugins } from './plugins';
import { registerRoutes } from './routes';
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
        coerceTypes: 'array',
      },
    },
  });

  server.setErrorHandler(errorHandler);
  server.addHook('onRequest', requestLogger);

  await registerPlugins(server);
  await registerRoutes(server);
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