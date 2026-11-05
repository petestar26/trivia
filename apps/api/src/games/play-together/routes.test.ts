import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { errorHandler } from '../../middleware/error-handler.js';
import { togetherRoutes } from './routes.js';
const m = vi.hoisted(() => ({
  actor: vi.fn(),
  lobby: vi.fn(),
  activity: vi.fn(),
  snapshot: vi.fn(),
  enter: vi.fn(),
  withdraw: vi.fn(),
  settings: vi.fn(),
  recover: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: { user: { findUnique: m.actor } } }));
vi.mock('./service.js', () => ({ createTogetherService: () => m }));
let app: ReturnType<typeof Fastify>, authorization: string;
const roundId = randomUUID(),
  entryId = randomUUID();
beforeEach(async () => {
  vi.clearAllMocks();
  m.actor.mockResolvedValue({ status: 'ACTIVE', role: 'USER', tokenVersion: 0 });
  m.enter.mockResolvedValue({ accepted: true, entryId });
  m.settings.mockResolvedValue({});
  app = Fastify({ ajv: { customOptions: { removeAdditional: 'all' } } });
  app.setErrorHandler(errorHandler);
  await app.register(jwt, { secret: 'group-route-test-secret-000000000000' });
  await app.register(togetherRoutes, { prefix: '/play-together' });
  await app.ready();
  authorization = 'Bearer ' + app.jwt.sign({ sub: 'actor', roles: ['ADMIN'], tokenVersion: 0 });
});
afterEach(() => app.close());
const confirm = (
  payload: object = { requestId: randomUUID(), termsHash: 'a'.repeat(64), selection: [] }
) =>
  app.inject({
    method: 'POST',
    url: '/play-together/rounds/' + roundId + '/entries',
    headers: { authorization },
    payload,
  });
it('requires current authentication and makes every response non-cacheable', async () => {
  const r = await app.inject('/play-together/');
  expect(r.statusCode).toBe(401);
  expect(r.headers['cache-control']).toBe('private, no-store');
  expect(m.lobby).not.toHaveBeenCalled();
});
it('requires authentication before reading a group activity banner', async () => {
  const response = await app.inject('/play-together/groups/' + randomUUID() + '/activity');
  expect(response.statusCode).toBe(401);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(m.activity).not.toHaveBeenCalled();
});
it('reads group activity as the authenticated member and rejects an invalid group ID', async () => {
  const groupId = randomUUID();
  m.activity.mockResolvedValue({ serverTime: 12345, activeRound: null, latestResult: null });
  const response = await app.inject({
    url: '/play-together/groups/' + groupId + '/activity',
    headers: { authorization },
  });
  expect(response.statusCode).toBe(200);
  expect(m.activity).toHaveBeenCalledWith('actor', groupId);
  expect(response.json().data).toEqual({
    serverTime: 12345,
    activeRound: null,
    latestResult: null,
  });
  expect(response.headers['cache-control']).toBe('private, no-store');
  m.activity.mockClear();
  expect(
    (
      await app.inject({
        url: '/play-together/groups/not-a-group-id/activity',
        headers: { authorization },
      })
    ).statusCode
  ).toBe(400);
  expect(m.activity).not.toHaveBeenCalled();
});
it('rejects suspended accounts before reading group activity', async () => {
  m.actor.mockResolvedValue({ status: 'SUSPENDED', role: 'USER', tokenVersion: 0 });
  expect(
    (
      await app.inject({
        url: '/play-together/groups/' + randomUUID() + '/activity',
        headers: { authorization },
      })
    ).statusCode
  ).toBe(403);
  expect(m.activity).not.toHaveBeenCalled();
});
it('accepts only the authenticated member as the entry owner', async () => {
  const body = { requestId: randomUUID(), termsHash: 'a'.repeat(64), selection: [] };
  expect((await confirm(body)).statusCode).toBe(200);
  expect(m.enter).toHaveBeenCalledWith('actor', roundId, body);
});
it('discards attempts to add an owner or payout and uses only authenticated identity', async () => {
  expect(
    (
      await confirm({
        requestId: randomUUID(),
        termsHash: 'a'.repeat(64),
        selection: [],
        userId: 'victim',
        payout: 10000,
      })
    ).statusCode
  ).toBe(200);
  expect(m.enter).toHaveBeenCalledWith(
    'actor',
    roundId,
    expect.not.objectContaining({ userId: 'victim' })
  );
  expect(m.enter.mock.calls[0][2]).not.toHaveProperty('payout');
});
it('does not trust administrator claims in an old token', async () => {
  expect(
    (await app.inject({ url: '/play-together/admin/settings', headers: { authorization } }))
      .statusCode
  ).toBe(403);
  expect(m.settings).not.toHaveBeenCalled();
});
it('requires current administrator status before retrying a saved round', async () => {
  const url = '/play-together/admin/rounds/' + roundId + '/retry';
  expect((await app.inject({ method: 'POST', url, headers: { authorization } })).statusCode).toBe(
    403
  );
  m.actor.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE', tokenVersion: 0 });
  expect((await app.inject({ method: 'POST', url, headers: { authorization } })).statusCode).toBe(
    200
  );
  expect(m.recover).toHaveBeenCalledWith(roundId);
});
it('rejects suspended-account entries while permitting only their own funds-return route', async () => {
  m.actor.mockResolvedValue({ role: 'USER', status: 'SUSPENDED', tokenVersion: 0 });
  expect((await confirm()).statusCode).toBe(403);
  const r = await app.inject({
    method: 'POST',
    url: '/play-together/rounds/' + roundId + '/entries/' + entryId + '/refund',
    headers: { authorization },
  });
  expect(r.statusCode).toBe(200);
  expect(m.withdraw).toHaveBeenCalledWith('actor', roundId, entryId);
});
it('requires login again after a password reset revokes the token', async () => {
  m.actor.mockResolvedValue({ role: 'USER', status: 'ACTIVE', tokenVersion: 1 });
  expect((await confirm()).statusCode).toBe(401);
  expect(m.enter).not.toHaveBeenCalled();
});
