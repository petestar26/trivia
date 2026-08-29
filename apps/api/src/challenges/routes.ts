import { FastifyInstance } from 'fastify';
import { authenticate, ApiError } from '../middleware';
import {
  createChallenge,
  acceptChallenge,
  declineChallenge,
  cancelChallenge,
  playChallengeTurn,
  getUserChallenges,
  getChallengeById,
} from './challenge-service';

export async function challengeRoutes(server: FastifyInstance): Promise<void> {
  const authHandler = [authenticate];

  // POST /challenges — create a new challenge
  server.post<{
    Body: {
      challengedId: string;
      gameKey: string;
      entryAmount?: number;
    };
  }>(
    '/',
    { preHandler: authHandler },
    async (request, reply) => {
      const { challengedId, gameKey, entryAmount = 0 } = request.body;
      const userId = request.user!.sub;

      if (!challengedId || !gameKey) {
        throw ApiError.badRequest('challengedId and gameKey are required');
      }

      const result = await createChallenge(userId, challengedId, gameKey, entryAmount);
      return reply.status(201).send({ success: true, data: result });
    }
  );

  // GET /challenges — list user's challenges
  server.get(
    '/',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const challenges = await getUserChallenges(userId);
      return reply.send({ success: true, data: challenges });
    }
  );

  // GET /challenges/:id — get challenge detail
  server.get<{
    Params: { id: string };
  }>(
    '/:id',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const challenge = await getChallengeById(request.params.id, userId);
      return reply.send({ success: true, data: challenge });
    }
  );

  // POST /challenges/:id/accept — accept a challenge
  server.post<{
    Params: { id: string };
  }>(
    '/:id/accept',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const result = await acceptChallenge(userId, request.params.id);
      return reply.send({ success: true, data: result });
    }
  );

  // POST /challenges/:id/decline — decline a challenge
  server.post<{
    Params: { id: string };
  }>(
    '/:id/decline',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const result = await declineChallenge(userId, request.params.id);
      return reply.send({ success: true, data: result });
    }
  );

  // POST /challenges/:id/cancel — cancel a challenge
  server.post<{
    Params: { id: string };
  }>(
    '/:id/cancel',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const result = await cancelChallenge(userId, request.params.id);
      return reply.send({ success: true, data: result });
    }
  );

  // POST /challenges/:id/play — play your turn
  server.post<{
    Params: { id: string };
    Body: { clientData?: Record<string, unknown> };
  }>(
    '/:id/play',
    { preHandler: authHandler },
    async (request, reply) => {
      const userId = request.user!.sub;
      const result = await playChallengeTurn(userId, request.params.id, request.body.clientData);
      return reply.send({ success: true, data: result });
    }
  );
}