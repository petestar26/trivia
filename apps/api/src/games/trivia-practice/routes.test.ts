import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { triviaPracticeRoutes } from './routes.js';

const db = vi.hoisted(() => ({ findMany: vi.fn(), findFirst: vi.fn() }));
vi.mock('@socialplay/database', () => ({ prisma: { triviaQuestion: db } }));
vi.mock('../../middleware/auth.js', () => ({
  authenticate: async (request: { headers: Record<string, string>; user: { sub: string } }) => {
    if (!request.headers.authorization)
      throw Object.assign(new Error('Sign in required'), { statusCode: 401 });
    if (request.headers.authorization === 'inactive')
      throw Object.assign(new Error('Active account required'), { statusCode: 403 });
    request.user = { sub: 'member' };
  },
}));
const row = {
  id: 'question-1',
  question: 'What is 2 + 2?',
  choices: ['3', '4', '5'],
  correctIndex: 1,
  category: 'math',
  difficulty: 1,
};
const headers = { authorization: 'active' };
beforeEach(() => {
  db.findMany.mockResolvedValue([row]);
  db.findFirst.mockResolvedValue({ choices: row.choices, correctIndex: row.correctIndex });
});
afterEach(() => {
  vi.clearAllMocks();
});
async function server() {
  const instance = Fastify();
  await instance.register(triviaPracticeRoutes, { prefix: '/games/trivia-practice' });
  return instance;
}

it.each(['/questions', '/answers'])('requires authentication for %s', async (path) => {
  const app = await server();
  try {
    const response = await app.inject({
      url: '/games/trivia-practice' + path,
      method: path === '/answers' ? 'POST' : 'GET',
      ...(path === '/answers' ? { payload: { questionId: row.id, answerIndex: 1 } } : {}),
    });
    expect(response.statusCode).toBe(401);
    expect(db.findMany).not.toHaveBeenCalled();
    expect(db.findFirst).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it('rejects inactive users before question access', async () => {
  const app = await server();
  try {
    expect(
      (
        await app.inject({
          url: '/games/trivia-practice/questions',
          headers: { authorization: 'inactive' },
        })
      ).statusCode
    ).toBe(403);
    expect(db.findMany).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it('returns only active questions without any answer key', async () => {
  const app = await server();
  try {
    const response = await app.inject({ url: '/games/trivia-practice/questions', headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({
      success: true,
      data: {
        mode: 'practice',
        rewards: false,
        questions: [
          {
            id: row.id,
            question: row.question,
            choices: row.choices,
            category: row.category,
            difficulty: row.difficulty,
          },
        ],
      },
    });
    expect(response.body).not.toContain('correctIndex');
    expect(db.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
    expect(db.findMany.mock.calls[0][0].select).not.toHaveProperty('correctIndex');
  } finally {
    await app.close();
  }
});
it('skips malformed choices instead of returning an unusable question', async () => {
  db.findMany.mockResolvedValue([{ ...row, choices: { bad: true } }, row]);
  const app = await server();
  try {
    const response = await app.inject({ url: '/games/trivia-practice/questions', headers });
    expect(response.json().data.questions).toHaveLength(1);
  } finally {
    await app.close();
  }
});
it('uses a read-only practice-specific fallback when the active bank is empty', async () => {
  db.findMany.mockResolvedValue([]);
  const app = await server();
  try {
    const response = await app.inject({ url: '/games/trivia-practice/questions', headers });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data).toMatchObject({ mode: 'practice', rewards: false });
    expect(data.questions).toHaveLength(12);
    expect(new Set(data.questions.map((question: { id: string }) => question.id)).size).toBe(12);
    for (const question of data.questions) {
      expect(question.id).toMatch(/^builtin-practice-/);
      expect(question.choices).toHaveLength(4);
      expect(question).not.toHaveProperty('correctIndex');
    }
    expect(response.body).not.toContain('correctIndex');
    expect(db.findMany).toHaveBeenCalledTimes(1);
    expect(db.findFirst).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it('uses the fallback when every active database question has unusable choices', async () => {
  db.findMany.mockResolvedValue([{ ...row, choices: [] }]);
  const app = await server();
  try {
    const response = await app.inject({ url: '/games/trivia-practice/questions', headers });
    expect(response.json().data.questions[0].id).toBe('builtin-practice-001');
    expect(response.body).not.toContain('correctIndex');
  } finally {
    await app.close();
  }
});
it.each([0, 1])(
  'grades fallback answer %i only on the server without reading or writing reward data',
  async (answerIndex) => {
    const app = await server();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/games/trivia-practice/answers',
        headers,
        payload: { questionId: 'builtin-practice-001', answerIndex },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual({
        questionId: 'builtin-practice-001',
        answerIndex,
        correctIndex: 1,
        correct: answerIndex === 1,
        mode: 'practice',
        rewards: false,
      });
      expect(db.findFirst).not.toHaveBeenCalled();
      expect(db.findMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }
);
it('rejects an out-of-range fallback answer', async () => {
  const app = await server();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/games/trivia-practice/answers',
      headers,
      payload: { questionId: 'builtin-practice-001', answerIndex: 4 },
    });
    expect(response.statusCode).toBe(400);
    expect(db.findFirst).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it('does not resolve unknown builtin practice IDs against the reward question bank', async () => {
  const app = await server();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/games/trivia-practice/answers',
      headers,
      payload: { questionId: 'builtin-practice-unknown', answerIndex: 1 },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('correctIndex');
    expect(db.findFirst).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it.each([0, 1])(
  'validates answer %i on the server with no reward or persistence',
  async (answerIndex) => {
    const app = await server();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/games/trivia-practice/answers',
        headers,
        payload: { questionId: row.id, answerIndex },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        data: {
          questionId: row.id,
          answerIndex,
          correctIndex: 1,
          correct: answerIndex === 1,
          mode: 'practice',
          rewards: false,
        },
      });
      expect(db.findFirst).toHaveBeenCalledWith({
        where: { id: row.id, isActive: true },
        select: { choices: true, correctIndex: true },
      });
      // The mocked database exposes only these two read methods. Any write or
      // wallet access would fail this request rather than silently passing.
    } finally {
      await app.close();
    }
  }
);
it.each([
  {},
  { questionId: row.id },
  { questionId: '', answerIndex: 0 },
  { questionId: row.id, answerIndex: '1' },
  { questionId: row.id, answerIndex: -1 },
  { questionId: row.id, answerIndex: 1.5 },
  { questionId: row.id, answerIndex: 20 },
  { questionId: row.id, answerIndex: 1, correctIndex: 1 },
])('rejects malformed answer input %# before reading the bank', async (payload) => {
  const app = await server();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/games/trivia-practice/answers',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(db.findFirst).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it('rejects an answer index outside the selected question choices', async () => {
  const app = await server();
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/games/trivia-practice/answers',
          headers,
          payload: { questionId: row.id, answerIndex: 3 },
        })
      ).statusCode
    ).toBe(400);
  } finally {
    await app.close();
  }
});
it('does not accept missing or newly inactive questions', async () => {
  db.findFirst.mockResolvedValue(null);
  const app = await server();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/games/trivia-practice/answers',
      headers,
      payload: { questionId: row.id, answerIndex: 1 },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('correctIndex');
  } finally {
    await app.close();
  }
});
it('refuses a malformed answer key rather than grading against it', async () => {
  db.findFirst.mockResolvedValue({ choices: row.choices, correctIndex: 9 });
  const app = await server();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/games/trivia-practice/answers',
      headers,
      payload: { questionId: row.id, answerIndex: 1 },
    });
    expect(response.statusCode).toBe(503);
  } finally {
    await app.close();
  }
});
