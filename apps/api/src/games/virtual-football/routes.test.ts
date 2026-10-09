import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { errorHandler } from '../../middleware/error-handler.js';
import { footballRoutes } from './routes.js';

const mocks = vi.hoisted(() => ({ actor: vi.fn(), snapshot: vi.fn(), admit: vi.fn() }));
vi.mock('@socialplay/database', () => ({ prisma: { user: { findUnique: mocks.actor } } }));
vi.mock('./service.js', () => ({ createFootballService: () => mocks }));

let app: ReturnType<typeof Fastify>, authorization: string;
const valid = {
  idempotencyKey: 'a1b2c3d4e5f6a7b8c9d0',
  matchweekId: 'vf-s1-w01',
  rulesId: 'virtual-football-3d-practice-v1',
  lines: [
    {
      kind: 'SINGLE',
      stake: 10,
      legs: [{ fixtureId: 'vf-s1-w01-f01', selection: 'FT:1', oddsCents: 200 }],
    },
  ],
};
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('VIRTUAL_FOOTBALL_PRACTICE_ENABLED', 'true');
  mocks.actor.mockResolvedValue({ status: 'ACTIVE' });
  mocks.snapshot.mockResolvedValue({ balance: 1000 });
  mocks.admit.mockResolvedValue({ accepted: true, isReplay: false });
  app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(jwt, { secret: 'disposable-football-route-test-key' });
  await app.register(footballRoutes, { prefix: '/vf' });
  await app.ready();
  authorization = `Bearer ${app.jwt.sign({ sub: 'member', roles: ['USER'] })}`;
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});
const post = (payload: unknown, headers: Record<string, string> = { authorization }) =>
  app.inject({ method: 'POST', url: '/vf/tickets', headers, payload: payload as never });

it('requires authentication for snapshots and admission', async () => {
  expect((await app.inject('/vf')).statusCode).toBe(401);
  expect((await post(valid, {})).statusCode).toBe(401);
  expect(mocks.snapshot).not.toHaveBeenCalled();
  expect(mocks.admit).not.toHaveBeenCalled();
});

it.each([undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true '])(
  'fails closed for flag %j on every route',
  async (flag) => {
    if (flag === undefined) vi.unstubAllEnvs();
    else vi.stubEnv('VIRTUAL_FOOTBALL_PRACTICE_ENABLED', flag);
    expect((await app.inject({ url: '/vf', headers: { authorization } })).statusCode).toBe(403);
    expect((await post(valid)).statusCode).toBe(403);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.admit).not.toHaveBeenCalled();
  }
);

it('is not enabled by the Derby flag', async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('THUNDER_DERBY_PRACTICE_ENABLED', 'true');
  expect((await app.inject({ url: '/vf', headers: { authorization } })).statusCode).toBe(403);
});

it.each(['SUSPENDED', 'BANNED', 'DELETED'])(
  'denies %s members holding an existing token',
  async (status) => {
    mocks.actor.mockResolvedValue({ status });
    expect((await app.inject({ url: '/vf', headers: { authorization } })).statusCode).toBe(403);
    expect((await post(valid)).statusCode).toBe(403);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.admit).not.toHaveBeenCalled();
  }
);

it('marks every private response no-store', async () => {
  const response = await app.inject({ url: '/vf', headers: { authorization } });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect((await post(valid)).headers['cache-control']).toBe('private, no-store');
});

it('takes identity only from authentication and forwards the body untouched for strict validation', async () => {
  const tampered = { ...valid, userId: 'someone-else', payout: 999999, balance: 1e9 };
  const response = await post(tampered);
  expect(response.statusCode).toBe(200);
  // Unknown fields must reach parseTicketInput (which refuses them) rather than be stripped here.
  expect(mocks.admit).toHaveBeenCalledWith('member', tampered);
});

it('accepts week navigation only as a complete, bounded season/week pair', async () => {
  const get = (query: string) => app.inject({ url: `/vf${query}`, headers: { authorization } });
  expect((await get('?seasonNo=3&weekNo=12')).statusCode).toBe(200);
  expect(mocks.snapshot).toHaveBeenLastCalledWith('member', { seasonNo: 3, weekNo: 12 });
  expect((await get('')).statusCode).toBe(200);
  expect(mocks.snapshot).toHaveBeenLastCalledWith('member', undefined);
  for (const bad of [
    '?seasonNo=3',
    '?weekNo=3',
    '?seasonNo=0&weekNo=1',
    '?seasonNo=1&weekNo=39',
    '?seasonNo=1&weekNo=0',
    '?seasonNo=x&weekNo=1',
    '?seasonNo=1000000&weekNo=1',
    '?seasonNo=1.5&weekNo=1',
  ])
    expect((await get(bad)).statusCode, bad).toBe(400);
  expect(mocks.snapshot).toHaveBeenCalledTimes(2);
});

it('rejects non-object and oversized ticket bodies before admission', async () => {
  expect((await post([valid])).statusCode).toBe(400);
  expect(
    (await post('"text"', { authorization, 'content-type': 'application/json' })).statusCode
  ).toBe(400);
  const huge = { ...valid, lines: Array.from({ length: 400 }, () => valid.lines[0]) };
  expect((await post(huge)).statusCode).toBe(413);
  expect(mocks.admit).not.toHaveBeenCalled();
});

it('surfaces service refusals with their reason and status', async () => {
  const { ApiError } = await import('../../middleware/api-error.js');
  mocks.admit.mockRejectedValue(ApiError.conflict('Price moved', { reason: 'PRICE_CHANGED' }));
  const response = await post(valid);
  expect(response.statusCode).toBe(409);
  expect(response.json().error.details).toEqual({ reason: 'PRICE_CHANGED' });
});
