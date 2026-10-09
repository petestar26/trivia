import { skyCrashRoutes } from '../games/sky-crash/routes.js';
import { cryptoPaymentRoutes } from '../crypto-payments/routes.js';
import { latePaymentRoutes } from '../agents/late-payment-routes.js';
import { crashPointRoutes } from '../games/crash-point/routes.js';
import { adminAgentAccountRoutes } from '../agents/admin-account-routes.js';
import { workspaceRoutes } from './workspaces.js';
import { socialGroupRoutes } from '../groups/routes.js';
import { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';
import { groupRoutes } from './groups.js';
import { chatRoutes } from './chat.js';
import { storageRoutes } from './storage.js';
import { walletRoutes } from './wallet.js';
import { giftRoutes } from './gifts.js';
import { vipRoutes } from './vip.js';
import { progressRoutes } from './progress.js';
import { taskRoutes } from './tasks.js';
import { achievementRoutes } from './achievements.js';
import { gameRoutes } from './games.js';
import { challengeRoutes } from '../challenges/routes.js';
import { competitionRoutes } from '../competitions/routes.js';
import { agentRoutes } from '../agents/routes.js';
import { agentOrderRoutes } from '../agents/order-routes.js';
import { agentDisputeRoutes } from '../agents/dispute-routes.js';
import { agentConversationRoutes } from '../agents/conversation-routes.js';
import { agentConfigRoutes } from '../agents/config-routes.js';
import { securityRoutes } from '../security/routes.js';
import { withdrawalRoutes } from '../withdrawals/routes.js';
import { userRoutes } from './users.js';
import { notificationRoutes } from './notifications.js';
import { ledgerAdminRoutes } from '../economy/ledger-admin-routes.js';
import { groupPvpRoutes } from '../games/group-pvp/routes.js';
import { systemDiceRoutes } from '../games/group-pvp/system-dice-routes.js';
import { systemKenoRoutes } from '../games/group-pvp/system-keno-routes.js';
import { giftCollectionRoutes } from '../gift-collection/routes.js';

export async function registerRoutes(server: FastifyInstance): Promise<void> {
  // healthRoutes is registered directly in server.ts, outside this
  // API_PREFIX-wrapped block — see the comment there. Not registered here.
  await server.register(workspaceRoutes, { prefix: '/workspaces' });
  await server.register(authRoutes, { prefix: '/auth' });
  await server.register(socialGroupRoutes, { prefix: '/groups' });
  await server.register(groupRoutes, { prefix: '/groups' });
  await server.register(groupPvpRoutes, { prefix: '/groups' });
  await server.register(skyCrashRoutes, { prefix: '/games/sky-crash' });
  await server.register(crashPointRoutes, { prefix: '/games/crash-point' });
  await server.register(systemDiceRoutes, { prefix: '/games/system-dice' });
  await server.register(systemKenoRoutes, { prefix: '/games/system-keno' });
  await server.register(chatRoutes, { prefix: '/groups' });
  await server.register(storageRoutes, { prefix: '/storage' });
  await server.register(cryptoPaymentRoutes, { prefix: '/crypto-payments' });
  await server.register(walletRoutes, { prefix: '/wallet' });
  await server.register(giftRoutes, { prefix: '/gifts' });
  await server.register(giftCollectionRoutes, { prefix: '/gift-collection' });
  await server.register(vipRoutes, { prefix: '/vip' });
  await server.register(progressRoutes, { prefix: '/progress' });
  await server.register(taskRoutes, { prefix: '/tasks' });
  await server.register(achievementRoutes, { prefix: '/achievements' });
  await server.register(gameRoutes, { prefix: '/games' });
  await server.register(challengeRoutes, { prefix: '/challenges' });
  await server.register(competitionRoutes, { prefix: '/competitions' });
  await server.register(adminAgentAccountRoutes, { prefix: '/agents' });
  await server.register(agentRoutes, { prefix: '/agents' });
  await server.register(agentOrderRoutes, { prefix: '/agent-orders' });
  await server.register(latePaymentRoutes, { prefix: '/late-payments' });
  await server.register(agentDisputeRoutes, { prefix: '/agent-disputes' });
  await server.register(agentConversationRoutes, { prefix: '/agent-conversations' });
  await server.register(agentConfigRoutes, { prefix: '/agent-config' });
  await server.register(securityRoutes, { prefix: '/security' });
  await server.register(withdrawalRoutes, { prefix: '/withdrawals' });
  await server.register(userRoutes, { prefix: '/users' });
  await server.register(notificationRoutes, { prefix: '/notifications' });
  await server.register(ledgerAdminRoutes, { prefix: '/ledger-admin' });

  // Root service-info handler is registered directly in server.ts, outside
  // this API_PREFIX-wrapped block — see the comment there. Not registered
  // here.

  server.setNotFoundHandler(async (_request, reply) => {
    reply.status(404).send({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
      },
    });
  });
}
