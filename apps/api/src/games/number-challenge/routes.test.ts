import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { errorHandler } from '../../middleware/error-handler.js';
import { numberPracticeRoutes } from './routes.js';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), snapshot: vi.fn(), play: vi.fn() }));
vi.mock('@socialplay/database', () => ({ prisma: { user: { findUnique: mocks.actor } } }));
vi.mock('./service.js', () => ({ createNumberService: () => mocks }));
let app: ReturnType<typeof Fastify>, authorization: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('NUMBER_CHALLENGE_PRACTICE_ENABLED', 'true');
  mocks.actor.mockResolvedValue({ status: 'ACTIVE' });
  mocks.snapshot.mockResolvedValue({ rounds: [] });
  app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(jwt, { secret: 'number-route-test-secret-000000000' });
  await app.register(numberPracticeRoutes, { prefix: '/number' });
  await app.ready();
  authorization = `Bearer ${app.jwt.sign({ sub: 'member', roles: ['USER'] })}`;
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});
const post = (headers = { authorization }) =>
  app.inject({
    method: 'POST',
    url: '/number/guesses',
    headers,
    payload: { guess: 50, requestId: 'abcdefghijklmnop', rulesId: 'number-challenge-practice-v1' },
  });
it('requires authentication and marks errors private', async () => {
  expect((await app.inject('/number')).statusCode).toBe(401);
  const r = await post({} as never);
  expect(r.statusCode).toBe(401);
  expect(r.headers['cache-control']).toBe('private, no-store');
  expect(mocks.play).not.toHaveBeenCalled();
});
it.each(['false', 'TRUE', '1', ' true', 'true ', ''])('fails closed for %s', async (flag) => {
  vi.stubEnv('NUMBER_CHALLENGE_PRACTICE_ENABLED', flag);
  expect((await post()).statusCode).toBe(403);
  expect((await app.inject({ url: '/number', headers: { authorization } })).statusCode).toBe(403);
  expect(mocks.play).not.toHaveBeenCalled();
});
it.each(['BANNED', 'SUSPENDED', 'DELETED'])('checks current account status %s', async (status) => {
  mocks.actor.mockResolvedValue({ status });
  expect((await post()).statusCode).toBe(403);
  expect(mocks.play).not.toHaveBeenCalled();
});
it('passes only authenticated identity and keeps unknown fields for strict service rejection', async () => {
  const payload = {
    guess: 50,
    requestId: 'abcdefghijklmnop',
    rulesId: 'number-challenge-practice-v1',
    target: 50,
    userId: 'other',
  };
  await app.inject({ method: 'POST', url: '/number/guesses', headers: { authorization }, payload });
  expect(mocks.play).toHaveBeenCalledWith('member', payload);
});
