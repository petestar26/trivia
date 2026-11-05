import type { FastifyInstance } from 'fastify';
import type {} from '@fastify/rate-limit';
import { prisma } from '@socialplay/database';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/api-error.js';
import {
  BUILTIN_PRACTICE_PREFIX,
  findBuiltInPracticeQuestion,
  publicBuiltInPracticeQuestions,
} from './fallback-bank.js';

const choicesSchema = z.array(z.string().min(1).max(1000)).min(2).max(20);
const answerSchema = z
  .object({
    questionId: z.string().min(1).max(128),
    answerIndex: z.number().int().min(0).max(19),
  })
  .strict();

/** Read-only practice: no attempts, scores, rewards or wallet transactions are stored. */
export async function triviaPracticeRoutes(server: FastifyInstance) {
  server.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
  });
  // The existing authentication middleware also checks the user's active status.
  server.addHook('preHandler', authenticate);

  server.get(
    '/questions',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async () => {
      const rows = await prisma.triviaQuestion.findMany({
        where: { isActive: true },
        select: { id: true, question: true, choices: true, category: true, difficulty: true },
        orderBy: { id: 'asc' },
        take: 20,
      });
      const questions = rows.flatMap((row) => {
        const choices = choicesSchema.safeParse(row.choices);
        if (!choices.success) return [];
        // Explicit projection also prevents an over-broad database/mock result from
        // accidentally adding its answer key to this response.
        return [
          {
            id: row.id,
            question: row.question,
            choices: choices.data,
            category: row.category,
            difficulty: row.difficulty,
          },
        ];
      });
      // Keep practice usable when the existing bank is empty, without seeding
      // production data or creating normal reward-game question identities.
      return {
        success: true,
        data: {
          questions: questions.length ? questions : publicBuiltInPracticeQuestions(),
          mode: 'practice',
          rewards: false,
        },
      };
    }
  );

  server.post<{ Body: unknown }>(
    '/answers',
    {
      bodyLimit: 2048,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      // Validate with Zod after parsing so number strings and unknown fields are
      // rejected, rather than coerced or silently removed by JSON-schema defaults.
      schema: { body: { type: 'object' } },
    },
    async (request) => {
      const parsed = answerSchema.safeParse(request.body);
      if (!parsed.success) throw ApiError.badRequest('Choose a question and one valid answer.');
      const { questionId, answerIndex } = parsed.data;
      const question = questionId.startsWith(BUILTIN_PRACTICE_PREFIX)
        ? findBuiltInPracticeQuestion(questionId)
        : await prisma.triviaQuestion.findFirst({
            where: { id: questionId, isActive: true },
            select: { choices: true, correctIndex: true },
          });
      if (!question) throw ApiError.notFound('This practice question is unavailable.');
      const choices = choicesSchema.safeParse(question.choices);
      if (
        !choices.success ||
        !Number.isInteger(question.correctIndex) ||
        question.correctIndex < 0 ||
        question.correctIndex >= choices.data.length
      ) {
        throw ApiError.serviceUnavailable('This practice question is unavailable.');
      }
      if (answerIndex >= choices.data.length)
        throw ApiError.badRequest('Choose one of the available answers.');
      return {
        success: true,
        data: {
          questionId,
          answerIndex,
          correctIndex: question.correctIndex,
          correct: answerIndex === question.correctIndex,
          mode: 'practice',
          rewards: false,
        },
      };
    }
  );
}
