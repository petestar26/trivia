import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { authRoutes } from './auth';
import { groupRoutes } from './groups';
import { chatRoutes } from './chat';
import { storageRoutes } from './storage';

export async function registerRoutes(server: FastifyInstance): Promise<void> {
  await server.register(healthRoutes, { prefix: '/health' });
  await server.register(authRoutes, { prefix: '/auth' });
  await server.register(groupRoutes, { prefix: '/groups' });
  await server.register(chatRoutes, { prefix: '/groups' });
  await server.register(storageRoutes, { prefix: '/storage' });

  server.get('/', async () => ({
    success: true,
    data: {
      name: 'SocialPlay API',
      version: '0.0.1',
      status: 'running',
    },
  }));

  server.setNotFoundHandler(async (request, reply) => {
    reply.status(404).send({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
      },
    });
  });
}