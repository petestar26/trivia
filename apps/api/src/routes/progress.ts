import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/index.js';
import { getProgress } from '../progress/progress-service.js';

export async function progressRoutes(server: FastifyInstance): Promise<void> {
  // GET /progress — read-only XP/level snapshot for the authenticated user
  server.get(
    '/',
    { preHandler: [authenticate] },
    async (request) => {
      const progress = await getProgress(request.user!.sub);
      return { success: true, data: progress };
    }
  );
}
