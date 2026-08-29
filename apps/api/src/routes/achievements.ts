import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware';
import { listUnlocked } from '../rewards/achievement-service';

export async function achievementRoutes(server: FastifyInstance): Promise<void> {
  // GET /achievements — list the authenticated user's unlocked achievements
  server.get(
    '/',
    { preHandler: [authenticate] },
    async (request) => {
      const achievements = await listUnlocked(request.user!.sub);
      return { success: true, data: achievements };
    }
  );
}
