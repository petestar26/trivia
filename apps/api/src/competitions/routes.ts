import { FastifyInstance } from 'fastify';
import { authenticate, ApiError } from '../middleware';
import {
  createCompetition,
  updateCompetition,
  cancelCompetition,
  joinCompetition,
  playCompetition,
  finalizeCompetition,
  getCompetitionForGroup,
  listCompetitionsForGroup,
} from './competition-service';

export async function competitionRoutes(server: FastifyInstance): Promise<void> {
  const authHandler = [authenticate];

  // GET /competitions/:groupId — list competitions for a group
  server.get<{
    Params: { groupId: string };
  }>(
    '/:groupId',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const competitions = await listCompetitionsForGroup(request.params.groupId, userId);
      return reply.send({ success: true, data: competitions });
    }
  );

  // POST /competitions/:groupId — create a competition in a group
  server.post<{
    Params: { groupId: string };
    Body: {
      gameKey: string;
      title: string;
      description?: string;
      startsAt: string;
      endsAt: string;
      entryAmount?: number;
      maxParticipants?: number;
      rewardGamePoints?: number;
      rewardCoins?: number;
    };
  }>(
    '/:groupId',
    { preHandler: authHandler },
    async (request, reply) => {
      const result = await createCompetition(request.user!.sub, {
        groupId: request.params.groupId,
        ...request.body,
      });
      return reply.status(201).send({ success: true, data: result });
    }
  );

  // GET /competitions/:groupId/:competitionId — competition detail with leaderboard
  server.get<{
    Params: { groupId: string; competitionId: string };
  }>(
    '/:groupId/:competitionId',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const comp = await getCompetitionForGroup(
        request.params.groupId,
        request.params.competitionId,
        userId
      );
      return reply.send({ success: true, data: comp });
    }
  );

  // PATCH /competitions/:groupId/:competitionId — update (OWNER/ADMIN only)
  server.patch<{
    Params: { groupId: string; competitionId: string };
    Body: {
      title?: string;
      description?: string;
      startsAt?: string;
      endsAt?: string;
      entryAmount?: number;
      rewardGamePoints?: number;
      rewardCoins?: number;
    };
  }>(
    '/:groupId/:competitionId',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const result = await updateCompetition(userId, request.params.competitionId, request.body);
      return reply.send({ success: true, data: result });
    }
  );

  // DELETE /competitions/:groupId/:competitionId — cancel competition (OWNER/ADMIN only)
  server.delete<{
    Params: { groupId: string; competitionId: string };
  }>(
    '/:groupId/:competitionId',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const result = await cancelCompetition(userId, request.params.competitionId);
      return reply.send({ success: true, data: result });
    }
  );

  // POST /competitions/:groupId/:competitionId/join
  server.post<{
    Params: { groupId: string; competitionId: string };
  }>(
    '/:groupId/:competitionId/join',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const result = await joinCompetition(userId, request.params.competitionId);
      return reply.status(201).send({ success: true, data: result });
    }
  );

  // POST /competitions/:groupId/:competitionId/play
  server.post<{
    Params: { groupId: string; competitionId: string };
    Body: { clientData?: Record<string, unknown> };
  }>(
    '/:groupId/:competitionId/play',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const result = await playCompetition(userId, request.params.competitionId, request.body.clientData);
      return reply.send({ success: true, data: result });
    }
  );

  // POST /competitions/:groupId/:competitionId/finalize (OWNER/ADMIN only)
  server.post<{
    Params: { groupId: string; competitionId: string };
  }>(
    '/:groupId/:competitionId/finalize',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const result = await finalizeCompetition(userId, request.params.competitionId);
      return reply.send({ success: true, data: result });
    }
  );
}