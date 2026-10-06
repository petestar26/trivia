import type { FastifyInstance } from 'fastify';
import {
  PublicSpinProofUnavailable,
  readPublicSpinProof,
} from '../economics/house-public-proof.js';
import type { PrismaClient } from '@prisma/client';
import { readPublicPublicationArchive } from '../economics/publication-store.js';
import { PublicationWitnessUnavailable } from '../economics/publication-witness.js';

export function registerPublicProofRoutes(
  server: FastifyInstance,
  client: Pick<PrismaClient, '$queryRaw'>
) {
  server.get<{ Params: { roundId: string } }>(
    '/scheduled/spin-win/proofs/:roundId/publication',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        params: {
          type: 'object',
          required: ['roundId'],
          additionalProperties: false,
          properties: {
            roundId: { type: 'string', pattern: '^[A-Za-z0-9_:-]{1,128}$', maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const data = await readPublicPublicationArchive(client, request.params.roundId);
        if (!data)
          return reply.code(404).send({
            success: false,
            error: { code: 'PUBLICATION_NOT_FOUND', message: 'Publication archive not found' },
          });
        return { success: true, data };
      } catch (error) {
        if (!(error instanceof PublicationWitnessUnavailable)) throw error;
        return reply.code(503).send({
          success: false,
          error: {
            code: 'PUBLICATION_UNAVAILABLE',
            message: 'Publication archive cannot be verified',
          },
        });
      }
    }
  );
  server.get<{ Params: { roundId: string } }>(
    '/scheduled/spin-win/proofs/:roundId',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: {
          type: 'object',
          required: ['roundId'],
          additionalProperties: false,
          properties: {
            roundId: { type: 'string', pattern: '^[A-Za-z0-9_:-]{1,128}$', maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const proof = await readPublicSpinProof(client, request.params.roundId);
        if (!proof)
          return reply.code(404).send({
            success: false,
            error: { code: 'ROUND_PROOF_NOT_FOUND', message: 'Round proof not found' },
          });
        return { success: true, data: proof };
      } catch (error) {
        if (!(error instanceof PublicSpinProofUnavailable)) throw error;
        return reply.code(503).send({
          success: false,
          error: { code: 'ROUND_PROOF_UNAVAILABLE', message: 'Round proof cannot be verified' },
        });
      }
    }
  );
}
