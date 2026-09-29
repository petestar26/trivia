import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import type { FastifyInstance } from 'fastify';

let prefix = `${process.env.API_PREFIX ?? '/api/v1'}/games/questions`;
const EMAIL_PREFIX = 'game-question-route-';

let dbAvailable = Boolean(
  process.env.DATABASE_URL && process.env.JWT_ACCESS_SECRET && process.env.JWT_REFRESH_SECRET,
);
if (dbAvailable) {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbAvailable = false;
  }
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: FastifyInstance | undefined;
const createdUserIds = new Set<string>();
const createdQuestionIds = new Set<string>();
let ipSequence = 1;

beforeAll(async () => {
  if (!dbAvailable) return;
  const [{ config }, { buildServer }] = await Promise.all([
    import('@socialplay/config'),
    import('../server.js'),
  ]);
  prefix = `${config.API_PREFIX}/games/questions`;
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  if (dbAvailable) {
    const questionIds = [...createdQuestionIds];
    const userIds = [...createdUserIds];
    if (questionIds.length) {
      await prisma.userTriviaAttempt.deleteMany({ where: { questionId: { in: questionIds } } });
      await prisma.competitionTriviaAttempt.deleteMany({ where: { questionId: { in: questionIds } } });
      await prisma.triviaQuestion.deleteMany({ where: { id: { in: questionIds } } });
    }
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (server) {
    await server.close();
    await prisma.$disconnect();
  }
});

async function createUser() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${suffix}@test.local`,
      username: `gqr_${suffix}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Question route ${suffix}`,
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  createdUserIds.add(user.id);
  if (!user.email) throw new Error('Expected test user email');
  return { ...user, email: user.email };
}

async function createQuestion(question: string, isActive = true) {
  const row = await prisma.triviaQuestion.create({
    data: {
      question,
      choices: ['A', 'B', 'C', 'D'],
      correctIndex: 1,
      category: 'route-test',
      isActive,
    },
  });
  createdQuestionIds.add(row.id);
  return row;
}

async function tokenFor(user: { id: string; email: string; username: string }) {
  if (!server) throw new Error('Test server was not initialized');
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

async function getQuestions(token: string, resumeQuestionId?: string) {
  if (!server) throw new Error('Test server was not initialized');
  const query = resumeQuestionId ? `?resumeQuestionId=${encodeURIComponent(resumeQuestionId)}` : '';
  const response = await server.inject({
    method: 'GET',
    url: `${prefix}${query}`,
    headers: {
      authorization: `Bearer ${token}`,
      'x-forwarded-for': `10.25.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}`,
    },
  });
  return {
    response,
    body: JSON.parse(response.body) as { success: boolean; data: Array<Record<string, unknown>> },
  };
}

describeIf('games/questions route', () => {
  it('requires authentication', async () => {
    if (!server) throw new Error('Test server was not initialized');
    const response = await server.inject({ method: 'GET', url: prefix });
    expect(response.statusCode).toBe(401);
  });

  it('returns only active, unanswered questions for the caller without revealing answers or writing attempts', async () => {
    const caller = await createUser();
    const otherUser = await createUser();
    const alreadyAnswered = await createQuestion('Caller has answered this');
    const answeredByOther = await createQuestion('Other player answered this');
    const available = await createQuestion('Still available');
    const inactive = await createQuestion('Inactive question', false);
    await prisma.userTriviaAttempt.create({ data: { userId: caller.id, questionId: alreadyAnswered.id } });
    await prisma.userTriviaAttempt.create({ data: { userId: otherUser.id, questionId: answeredByOther.id } });
    const attemptsBefore = await prisma.userTriviaAttempt.count({
      where: { userId: { in: [caller.id, otherUser.id] } },
    });

    const { response, body } = await getQuestions(await tokenFor(caller));

    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(true);
    const returnedIds = body.data.map((question) => question.id);
    expect(returnedIds).toContain(answeredByOther.id);
    expect(returnedIds).toContain(available.id);
    expect(returnedIds).not.toContain(alreadyAnswered.id);
    expect(returnedIds).not.toContain(inactive.id);
    expect(body.data.every((question) => !('correctIndex' in question))).toBe(true);
    expect(await prisma.userTriviaAttempt.count({ where: { userId: { in: [caller.id, otherUser.id] } } }))
      .toBe(attemptsBefore);
  });

  it('includes the exact active question needed to resume a durable pending answer, without its answer key', async () => {
    const caller = await createUser();
    const answered = await createQuestion('Pending answer question');
    const next = await createQuestion('Next available question');
    await prisma.userTriviaAttempt.create({ data: { userId: caller.id, questionId: answered.id } });

    const { response, body } = await getQuestions(await tokenFor(caller), answered.id);

    expect(response.statusCode).toBe(200);
    expect(body.data.filter((question) => question.id === answered.id)).toHaveLength(1);
    expect(body.data.some((question) => question.id === next.id)).toBe(true);
    expect(body.data.find((question) => question.id === answered.id)).not.toHaveProperty('correctIndex');
  });

  it('does not return an inactive question requested for resume', async () => {
    const caller = await createUser();
    const inactive = await createQuestion('Inactive resume question', false);

    const { response, body } = await getQuestions(await tokenFor(caller), inactive.id);

    expect(response.statusCode).toBe(200);
    expect(body.data.some((question) => question.id === inactive.id)).toBe(false);
  });
});
