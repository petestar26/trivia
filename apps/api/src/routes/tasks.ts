import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware';
import { listTasks, claimTaskReward } from '../tasks/task-service';

export async function taskRoutes(server: FastifyInstance): Promise<void> {
  // GET /tasks — list task definitions + the user's progress (read-only)
  server.get(
    '/',
    { preHandler: [authenticate] },
    async (request) => {
      const tasks = await listTasks(request.user!.sub);
      return { success: true, data: tasks };
    }
  );

  // POST /tasks/:taskId/claim — claim the Coin/GamePoint reward for an
  // already-completed task. Completion is server-verified; the claim is granted
  // exactly once.
  server.post<{ Params: { taskId: string } }>(
    '/:taskId/claim',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['taskId'],
          properties: { taskId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const result = await claimTaskReward(request.user!.sub, request.params.taskId);
      return reply.send({ success: true, data: result });
    }
  );
}
