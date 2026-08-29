import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { authRoutes } from './auth';
import { groupRoutes } from './groups';
import { chatRoutes } from './chat';
import { storageRoutes } from './storage';
import { walletRoutes } from './wallet';
import { giftRoutes } from './gifts';
import { vipRoutes } from './vip';
import { progressRoutes } from './progress';
import { taskRoutes } from './tasks';
import { achievementRoutes } from './achievements';
import { gameRoutes } from './games';
import { challengeRoutes } from '../challenges/routes';
import { competitionRoutes } from '../competitions/routes';

export async function registerRoutes(server: FastifyInstance): Promise<void> {
  await server.register(healthRoutes, { prefix: '/health' });
  await server.register(authRoutes, { prefix: '/auth' });
  await server.register(groupRoutes, { prefix: '/groups' });
  await server.register(chatRoutes, { prefix: '/groups' });
  await server.register(storageRoutes, { prefix: '/storage' });
  await server.register(walletRoutes, { prefix: '/wallet' });
  await server.register(giftRoutes, { prefix: '/gifts' });
  await server.register(vipRoutes, { prefix: '/vip' });
  await server.register(progressRoutes, { prefix: '/progress' });
  await server.register(taskRoutes, { prefix: '/tasks' });
  await server.register(achievementRoutes, { prefix: '/achievements' });
  await server.register(gameRoutes, { prefix: '/games' });
  await server.register(challengeRoutes, { prefix: '/challenges' });
  await server.register(competitionRoutes, { prefix: '/competitions' });

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