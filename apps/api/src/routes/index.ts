import { FastifyInstance } from 'fastify';
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
import { agentRoutes } from '../agents/routes';
import { agentOrderRoutes } from '../agents/order-routes';
import { agentDisputeRoutes } from '../agents/dispute-routes';
import { agentConversationRoutes } from '../agents/conversation-routes';
import { agentConfigRoutes } from '../agents/config-routes';
import { securityRoutes } from '../security/routes';
import { withdrawalRoutes } from '../withdrawals/routes';

export async function registerRoutes(server: FastifyInstance): Promise<void> {
  // healthRoutes is registered directly in server.ts, outside this
  // API_PREFIX-wrapped block — see the comment there. Not registered here.
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
  await server.register(agentRoutes, { prefix: '/agents' });
  await server.register(agentOrderRoutes, { prefix: '/agent-orders' });
  await server.register(agentDisputeRoutes, { prefix: '/agent-disputes' });
  await server.register(agentConversationRoutes, { prefix: '/agent-conversations' });
  await server.register(agentConfigRoutes, { prefix: '/agent-config' });
  await server.register(securityRoutes, { prefix: '/security' });
  await server.register(withdrawalRoutes, { prefix: '/withdrawals' });

  // Root service-info handler is registered directly in server.ts, outside
  // this API_PREFIX-wrapped block — see the comment there. Not registered
  // here.

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