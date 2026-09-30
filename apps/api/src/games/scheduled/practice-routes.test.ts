import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { registerPracticeRoutes } from './practice-routes.js';
import type { RoundDatabase } from './round-store.js';
// Only config is replaced; JWT authentication and the route/service are real.
vi.mock('@socialplay/config', () => ({ config: {} }));
const app = Fastify();
const calls: Array<{ sql: string; values: unknown[] }> = [];
const db: RoundDatabase = {
  query: async <T extends object>(sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT id FROM public.users')) return [{ id: 'alice' }] as unknown as T[];
    return [];
  },
  transaction: (run) => run(db),
};
let token: string;
beforeAll(async () => {
  await app.register(jwt, { secret: 'disposable-practice-route-test-secret' });
  await app.register(rateLimit, { global: false });
  registerPracticeRoutes(app, db);
  await app.ready();
  token = app.jwt.sign({ sub: 'alice', roles: ['USER'] });
});
beforeEach(() => {
  calls.length = 0;
});
afterAll(async () => {
  await app.close();
});
describe('scheduled practice HTTP boundary', () => {
  it('rejects unauthenticated reads and writes before reaching storage', async () => {
    expect((await app.inject({ method: 'GET', url: '/scheduled/spin-win' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/scheduled/spin-win/tickets',
          payload: { roundId: 'spin-win-practice-v1:0', bets: [{ marketId: 'red', amount: 40 }] },
        })
      ).statusCode
    ).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it('keeps reads non-cacheable and scopes the SELECT to the JWT subject', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/scheduled/spin-win?userId=bob',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403); // fake store has no active stream
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(['spin-win-practice-v1', 'alice']);
    expect(calls[0].sql.trim().startsWith('SELECT')).toBe(true);
  });
  it('preserves Authorization through body validation and never accepts a client actor', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/scheduled/spin-win/tickets',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        userId: 'bob',
        roundId: 'spin-win-practice-v1:0',
        bets: [{ marketId: 'red', amount: 40 }],
      },
    });
    expect(response.statusCode).toBe(404);
    expect(calls.find((c) => c.sql.startsWith('SELECT id FROM public.users'))?.values).toEqual([
      'alice',
    ]);
    expect(calls.some((c) => c.values.includes('bob'))).toBe(false);
  });
  it('rejects malformed entries without querying storage', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/scheduled/spin-win/tickets',
      headers: { authorization: `Bearer ${token}` },
      payload: { roundId: 'spin-win-practice-v1:0', bets: [{ marketId: 'red', amount: 40.5 }] },
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
